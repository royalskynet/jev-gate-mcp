#!/usr/bin/env python3
"""真訓練：用 teacher corpus 微調 Laya 的 decision head（encoder 凍結）。

這取代 laya-label-corpus.mjs 的「只比對不學習」。設計取捨都釘在 corpus 規模上：
官方 RLCD 配方（docs/finetune.md）建議 ~30k questions、校準切片上限 400 items，
我們只有數百個 question，所以：

  * encoder 全凍（306.9M），訓 type_emb + scorer + act_head + head（14.97M）。
    原本怕 14.2M 的 head 配 521 筆會過擬合所以預設凍住，cross-fit 否證了：
    只訓 0.79M 得到 OOF 40.9%（配對 +2.9pp，CI 跨 0，等於沒進步），解開 head
    得到 69.5%（+32.2pp，CI [+26.5, +38.1]）。瓶頸是容量不是資料量。
    `--no-train-head` 保留那個比較基線。
  * 不留固定 validation split。數百筆切 20% 只剩幾十筆估溫度，T 的變異
    會大到讓校準本身不可信（Kumar et al. 2019，scaling 類需 O(1/ε²)）。
    改用 grouped K-fold cross-fit，拿 out-of-fold logits 擬一個溫度。
  * 不跑官方的 policy-gradient 項，只用 soft cross-entropy。PG 項要四組
    採樣噪聲，在這個樣本量下只是加方差。
  * 不導出 ONNX。產物是 safetensors + 溫度，推論端要不要換是另一件事。

唯一真正的產物是「信心閾值 → 覆蓋率 / 準確率」曲線：它決定能不能讓 Laya
接手、以及接手門檻定在哪。所有指標都附 bootstrap 信賴區間，否則數百筆
算出來的漂亮閾值不可複現。

  laya-train.py --selftest              # 不碰模型，只驗資料轉換
  laya-train.py --dry-run               # 建 items、報規模，不訓練
  laya-train.py                         # cross-fit 訓練 + 校準 + 報告
  laya-train.py --promote               # 達標才寫出權重（nightly 用）
"""
import argparse
import json
import math
import os
import random
import re
import sys
import time
from pathlib import Path

HOME = Path.home()
CORPUS = Path(os.environ.get("JEV_TEACHER_CORPUS", HOME / ".jevgate" / "teacher-corpus.jsonl"))
BASE_DIR = Path(os.environ.get("JEV_LAYA_FP_DIR", HOME / ".jevgate" / "laya-fp"))
OUT_DIR = Path(os.environ.get("JEV_LAYA_TRAINED_DIR", HOME / ".jevgate" / "laya-trained"))
REPORT = Path(os.environ.get("JEV_LAYA_TRAIN_REPORT", HOME / ".jevgate" / "laya-train-report.json"))
SEED = 20261001


# ---------------------------------------------------------------- gold 轉換
# corpus 存的是 teacher 的原生答案，官方 trainer 要的是每個選項的機率分佈
# （docs/finetune.md：「RLCD trains on the benchmark's gold distributions」）。
# choice 直接有 probabilities；noul 只有一個機率；score 只有一個連續值。

def gold_probs(question, answer):
    """→ (list[float] 已正規化, n_options)；無法轉換回 None。"""
    qtype = question.get("type")
    crit = question.get("criteria")
    if answer is None or answer.get("type") != qtype:
        return None

    if qtype == "choice":
        if not isinstance(crit, dict):
            return None
        keys = list(crit.keys())
        probs = answer.get("probabilities")
        if isinstance(probs, dict):
            target = [float(probs.get(k, 0.0)) for k in keys]
        elif answer.get("choice") in keys:
            # 沒給分佈就退化成 one-hot：資訊比丟掉這筆多。
            target = [1.0 if k == answer["choice"] else 0.0 for k in keys]
        else:
            return None

    elif qtype == "noul":
        p = answer.get("noul")
        if p is None:
            return None
        # 官方 build_training_item 的順序是 [false, true]。
        target = [1.0 - float(p), float(p)]

    elif qtype == "score":
        if not isinstance(crit, list) or len(crit) < 2:
            return None
        n = len(crit)
        s = answer.get("score")
        if s is None:
            return None
        # teacher 回連續分數（例 1.28），rubric 是離散等級。相鄰兩級線性內插
        # 保住期望值，等於把「1.28」讀成「72% 像 level 1、28% 像 level 2」，
        # 比 round() 成硬標籤少丟一截訊號。
        s = max(0.0, min(float(s), n - 1.0))
        lo = int(math.floor(s))
        hi = min(lo + 1, n - 1)
        w = s - lo
        target = [0.0] * n
        target[lo] += 1.0 - w
        target[hi] += w
    else:
        return None

    total = sum(target)
    if total <= 0:
        target = [1.0 / len(target)] * len(target)
    else:
        target = [x / total for x in target]
    return target, len(target)


def teacher_hard(question, answer):
    """teacher 的硬答案，語意對齊 laya-label-corpus.mjs 的 sameOne()。"""
    qtype = question.get("type")
    if qtype == "choice":
        crit = question.get("criteria") or {}
        keys = list(crit.keys()) if isinstance(crit, dict) else []
        c = answer.get("choice")
        return keys.index(c) if c in keys else None
    if qtype == "score":
        s = answer.get("score")
        return None if s is None else int(round(float(s)))
    if qtype == "noul":
        p = answer.get("noul")
        return None if p is None else float(p)
    return None


# gateway/src/laya-routing.js 的 shortStandaloneState 鏡像。正本在那邊，這裡只為
# 離線模擬線上覆蓋率；兩邊漂移會讓模擬數字說謊，改那邊時這裡要跟著改。
_BAD_STATE = re.compile(
    r"[\r\n]|不要|別|别|不是|並且|并且|然後|然后|先.*再|剛才|刚才|上述|前面|照.*說|照.*说"
    r"|刪除|删除|部署|付款|密碼|密码"
    r"|\b(not|don't|never|then|previous|delete|deploy|password|payment)\b", re.I)


def short_standalone_state(state):
    text = state
    if isinstance(state, dict):
        if any(k not in ("user_request", "char_bucket") for k in state):
            return False
        if state.get("char_bucket") not in (None, "s"):
            return False
        text = state.get("user_request")
    if not isinstance(text, str) or not text.strip() or len(text) > 320:
        return False
    return not _BAD_STATE.search(text)


def pred_matches(qtype, pred_idx, probs, truth):
    """預測是否算對；三種題型各自的判準與 sameOne() 一致。"""
    if truth is None:
        return None
    if qtype in ("choice", "score"):
        return int(pred_idx) == int(truth)
    if qtype == "noul":
        return abs(probs[1] - truth) < 0.2
    return None


# ---------------------------------------------------------------- corpus
def load_cases(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # 半截的最後一行；跳過不是失敗
    return rows


def build_units(rows):
    """展平成「一題一筆」，並記住它來自哪個 record（分組切 fold 用）。"""
    units, skipped = [], 0
    for rec_i, r in enumerate(rows):
        questions = r.get("questions") or {}
        teacher = r.get("teacher_answer") or {}
        local = r.get("local_answer") or {}
        for qid, q in questions.items():
            g = gold_probs(q, teacher.get(qid))
            if g is None:
                skipped += 1
                continue
            target, n_opt = g
            units.append({
                "rec": rec_i,
                "qid": qid,
                "digest": str(r.get("question_digest", ""))[:12],
                "qtype": q["type"],
                "question": q,
                "state": r.get("state"),
                "target": target,
                "n_opt": n_opt,
                "truth": teacher_hard(q, teacher.get(qid)),
                "baseline": local.get(qid),
            })
    return units, skipped


def baseline_correct(u):
    """現行 int8 ONNX 的對錯，當對照組。無 local_answer 回 None。"""
    b = u["baseline"]
    if not isinstance(b, dict) or u["truth"] is None:
        return None
    qtype = u["qtype"]
    if qtype == "choice":
        crit = u["question"].get("criteria") or {}
        keys = list(crit.keys())
        c = b.get("choice")
        return (keys.index(c) == u["truth"]) if c in keys else False
    if qtype == "score":
        s = b.get("score")
        return None if s is None else int(round(float(s))) == int(u["truth"])
    if qtype == "noul":
        p = b.get("noul")
        return None if p is None else abs(float(p) - u["truth"]) < 0.2
    return None


# ---------------------------------------------------------------- 指標
def ece(conf, correct, bins=10):
    """期望校準誤差。數百筆用 10 bin 已偏細，只當粗指標看。"""
    if not conf:
        return None
    total, acc = 0.0, 0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [i for i, c in enumerate(conf) if (c > lo or b == 0) and c <= hi]
        if not sel:
            continue
        avg_conf = sum(conf[i] for i in sel) / len(sel)
        avg_acc = sum(1 for i in sel if correct[i]) / len(sel)
        total += len(sel) / len(conf) * abs(avg_conf - avg_acc)
        acc += len(sel)
    return total if acc else None


def brier(probs, targets):
    if not probs:
        return None
    s = 0.0
    for p, t in zip(probs, targets):
        s += sum((pi - ti) ** 2 for pi, ti in zip(p, t))
    return s / len(probs)


def boot_ci(values, reps=2000, alpha=0.05, rng=None):
    """平均值的 bootstrap 百分位信賴區間。"""
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return None
    rng = rng or random.Random(SEED)
    n = len(vals)
    means = []
    for _ in range(reps):
        means.append(sum(vals[rng.randrange(n)] for _ in range(n)) / n)
    means.sort()
    return [means[int(alpha / 2 * reps)], means[int((1 - alpha / 2) * reps)]]


def coverage_curve(conf, correct, thresholds=None):
    """信心閾值 → 覆蓋率 / 準確率。這是整支腳本的產物。"""
    thresholds = thresholds or [0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
    rng = random.Random(SEED)
    out = []
    n = len(conf)
    for t in thresholds:
        sel = [i for i in range(n) if conf[i] >= t]
        if not sel:
            out.append({"threshold": t, "coverage": 0.0, "n": 0, "accuracy": None, "ci": None})
            continue
        hits = [1.0 if correct[i] else 0.0 for i in sel]
        out.append({
            "threshold": t,
            "coverage": len(sel) / n,
            "n": len(sel),
            "accuracy": sum(hits) / len(hits),
            "ci": boot_ci(hits, rng=rng),
        })
    return out


# ---------------------------------------------------------------- selftest
def selftest():
    """gold 轉換與判準的最小可跑檢查；不載模型。"""
    # choice：照 criteria 的鍵序，不是 probabilities 的鍵序
    q = {"type": "choice", "criteria": {"L0": "a", "L1": "b", "L2": "c"}}
    a = {"type": "choice", "choice": "L1", "probabilities": {"L2": 0.01, "L1": 0.74, "L0": 0.25}}
    t, n = gold_probs(q, a)
    assert n == 3 and abs(sum(t) - 1.0) < 1e-9, t
    assert abs(t[0] - 0.25) < 1e-9 and abs(t[1] - 0.74) < 1e-9, t
    assert teacher_hard(q, a) == 1

    # choice 沒給分佈 → one-hot
    t2, _ = gold_probs(q, {"type": "choice", "choice": "L2"})
    assert t2 == [0.0, 0.0, 1.0], t2

    # noul：順序必須是 [false, true]
    qn = {"type": "noul", "criteria": {"true": "y", "false": "n"}}
    t3, n3 = gold_probs(qn, {"type": "noul", "noul": 0.06})
    assert n3 == 2 and abs(t3[0] - 0.94) < 1e-9 and abs(t3[1] - 0.06) < 1e-9, t3
    assert pred_matches("noul", 0, [0.9, 0.1], 0.06) is True
    assert pred_matches("noul", 1, [0.2, 0.8], 0.06) is False

    # score：連續值線性內插，期望值要守住
    qs = {"type": "score", "criteria": ["a", "b", "c", "d"]}
    t4, n4 = gold_probs(qs, {"type": "score", "score": 1.28})
    assert n4 == 4, t4
    assert abs(t4[1] - 0.72) < 1e-9 and abs(t4[2] - 0.28) < 1e-9, t4
    ev = sum(i * p for i, p in enumerate(t4))
    assert abs(ev - 1.28) < 1e-9, ev
    assert teacher_hard(qs, {"type": "score", "score": 1.28}) == 1
    # 邊界：夾到最高級且不溢出
    t5, _ = gold_probs(qs, {"type": "score", "score": 9.0})
    assert abs(t5[3] - 1.0) < 1e-9, t5
    t6, _ = gold_probs(qs, {"type": "score", "score": -1.0})
    assert abs(t6[0] - 1.0) < 1e-9, t6

    # 型別不符 / 缺值要回 None，不要靜默塞預設
    assert gold_probs(q, {"type": "score", "score": 1.0}) is None
    assert gold_probs(qn, {"type": "noul"}) is None
    assert gold_probs(qs, {"type": "score", "score": None}) is None

    # 指標
    assert ece([1.0, 1.0], [True, True]) == 0.0
    assert abs(ece([1.0, 1.0], [True, False]) - 0.5) < 1e-9
    assert abs(brier([[1.0, 0.0]], [[1.0, 0.0]])) < 1e-9
    cur = coverage_curve([0.9, 0.4], [True, False])
    assert cur[0]["coverage"] == 1.0 and cur[0]["accuracy"] == 0.5
    hi = [c for c in cur if c["threshold"] == 0.8][0]
    assert hi["n"] == 1 and hi["accuracy"] == 1.0, hi
    # short_standalone_state：鏡像 laya-routing.js，行為與漂移都要驗
    assert short_standalone_state("幫我跑一下測試") is True
    assert short_standalone_state("要不要先跑測試") is False     # 含「不要」，正本會擋
    assert short_standalone_state({"user_request": "跑測試", "char_bucket": "s"}) is True
    assert short_standalone_state({"user_request": "跑測試", "char_bucket": "l"}) is False
    assert short_standalone_state({"user_request": "x", "phase": "plan"}) is False
    assert short_standalone_state("不要刪除那個檔") is False      # 否定詞
    assert short_standalone_state("deploy it now") is False       # 英文高風險詞
    assert short_standalone_state("a" * 321) is False             # 超長
    assert short_standalone_state("") is False
    assert short_standalone_state(None) is False
    # 漂移守衛：JS 正本的 regex 若改了而這裡沒跟上，模擬數字就會說謊。
    js = Path(__file__).resolve().parent.parent / "gateway" / "src" / "laya-routing.js"
    if js.exists():
        m = re.search(r"return !/(.+?)/i\.test\(text\);", js.read_text())
        assert m, "laya-routing.js 的 shortStandaloneState regex 找不到，鏡像無法比對"
        assert m.group(1) == _BAD_STATE.pattern.replace("\\b(", "\\b("), \
            f"regex 漂移：\nJS={m.group(1)}\nPY={_BAD_STATE.pattern}"

    print("selftest PASS")


# ---------------------------------------------------------------- 訓練
def head_logits(model, h, attention_mask, marker_pos, marker_mask, qtype, torch):
    """DecisionModel.forward 的 encoder 之後那一段，吃快取的 h。

    逐行對齊 laya.common.DecisionModel.forward（laya 0.3.22）。encoder 凍結時
    它的輸出每個 epoch 都一樣，重跑 306.9M 參數只是燒電；但這份複製會隨上游
    漂移，所以 --verify-parity 會拿完整 forward 比對一次。
    """
    h = h + model.type_emb(qtype)[:, None, :]
    if model.head is not None:
        pad = ~attention_mask.bool()
        for layer in model.head.layers:
            h = layer(h, src_key_padding_mask=pad)
    idx = marker_pos.clamp(min=0)[:, :, None].expand(-1, -1, h.size(-1))
    m = torch.gather(h, 1, idx)
    logits = model.scorer(m).squeeze(-1).float()
    return logits.masked_fill(~marker_mask, -1e4)


def fit_temperature(logit_rows, target_rows, torch):
    """官方 mps.py fit_temperature 的同一做法：單參數、LBFGS、夾在 [0.1, 10]。"""
    if not logit_rows:
        return 1.0
    width = max(len(r) for r in logit_rows)
    logits = torch.full((len(logit_rows), width), -1e4)
    targets = torch.zeros((len(logit_rows), width))
    for i, (lg, tg) in enumerate(zip(logit_rows, target_rows)):
        logits[i, : len(lg)] = torch.tensor(lg)
        targets[i, : len(tg)] = torch.tensor(tg)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(targets * torch.log_softmax(logits / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss

    opt.step(closure)
    return float(torch.clamp(log_t.exp(), 0.1, 10.0).item())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true", help="只驗資料轉換，不載模型")
    ap.add_argument("--dry-run", action="store_true", help="建 items 報規模就停")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--train-head", action=argparse.BooleanOptionalAction, default=True,
                    help="連 14.2M 的 head 一起訓（預設開；--no-train-head 只訓 0.79M）")
    ap.add_argument("--device", choices=["auto", "mps", "cpu"], default="auto")
    ap.add_argument("--promote", action="store_true", help="達標才寫出權重")
    ap.add_argument("--min-gain", type=float, default=0.05, help="OOF 準確率要比 int8 基線高多少才算達標")
    ap.add_argument("--verify-parity", action="store_true", help="拿完整 forward 比對快取路徑")
    ap.add_argument("--base-dir", default=str(BASE_DIR))
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    ap.add_argument("--report", default=str(REPORT))
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return 0

    if not CORPUS.exists():
        print(f"no corpus at {CORPUS}", file=sys.stderr)
        return 1
    rows = load_cases(CORPUS)
    units, skipped = build_units(rows)
    by_type = {}
    for u in units:
        by_type[u["qtype"]] = by_type.get(u["qtype"], 0) + 1
    n_rec = len({u["rec"] for u in units})
    print(f"corpus={len(rows)} units={len(units)} records={n_rec} skipped={skipped} by_type={by_type}")

    base_hits = [c for c in (baseline_correct(u) for u in units) if c is not None]
    base_acc = (sum(base_hits) / len(base_hits)) if base_hits else None
    if base_acc is not None:
        print(f"int8 baseline: {sum(base_hits)}/{len(base_hits)} = {base_acc * 100:.1f}%")
    else:
        print("int8 baseline: 無（corpus 還沒有 local_answer）")

    if len(units) < args.folds * 2:
        print(f"units={len(units)} 少於 folds*2，無法 cross-fit", file=sys.stderr)
        return 1
    if args.dry_run:
        print("dry-run：不訓練")
        return 0

    import torch
    from safetensors.torch import load_file, save_file
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_sequence, build_model, render_options

    torch.manual_seed(SEED)
    base = Path(args.base_dir)
    cfg = json.loads((base / "rl_agent_config.json").read_text())
    device = torch.device("mps" if (args.device in ("auto", "mps") and torch.backends.mps.is_available())
                          else "cpu")
    print(f"device={device} base={base}")

    _fix_tokenizer_config(str(base))
    tok = AutoTokenizer.from_pretrained(base / "tokenizer")
    model = build_model(cfg, encoder_dir=str(base / "encoder"))
    state_dict = load_file(str(base / "model.safetensors"))
    model.load_state_dict(state_dict, strict=True)
    model.to(device).eval()

    # ---- tokenize + 一次性 encoder 前向（凍結 → 可快取）
    t0 = time.time()
    kept = []
    for u in units:
        q = {"t": u["qtype"], "ins": u["question"]["instructions"], "crit": u["question"].get("criteria")}
        try:
            seq, markers = build_sequence(tok, u["state"], q, cfg["max_len"], cfg["head_max_len"])
        except Exception as e:
            print(f"  skip {u['digest']}/{u['qid']}: build_sequence {e}")
            continue
        if len(markers) != len(render_options(q)) or len(markers) != u["n_opt"]:
            # marker 數與選項數不符就不是同一個標籤空間，硬訓會對錯欄位。
            print(f"  skip {u['digest']}/{u['qid']}: markers={len(markers)} n_opt={u['n_opt']}")
            continue
        u["ids"], u["markers"] = seq, markers
        kept.append(u)
    units = kept
    print(f"tokenized units={len(units)} ({time.time() - t0:.1f}s)")
    if len(units) < args.folds * 2:
        print("可用 units 太少", file=sys.stderr)
        return 1

    from laya.common import QTYPES

    def collate(batch, cache=None):
        L = max(len(b["ids"]) for b in batch)
        K = max(len(b["markers"]) for b in batch)
        ids = torch.zeros((len(batch), L), dtype=torch.long)
        am = torch.zeros((len(batch), L), dtype=torch.long)
        mp = torch.zeros((len(batch), K), dtype=torch.long)
        mm = torch.zeros((len(batch), K), dtype=torch.bool)
        qt = torch.zeros((len(batch),), dtype=torch.long)
        tgt = torch.zeros((len(batch), K))
        for i, b in enumerate(batch):
            n = len(b["ids"])
            ids[i, :n] = torch.tensor(b["ids"], dtype=torch.long)
            am[i, :n] = 1
            k = len(b["markers"])
            mp[i, :k] = torch.tensor(b["markers"], dtype=torch.long)
            mm[i, :k] = True
            qt[i] = QTYPES[b["qtype"]]
            tgt[i, : len(b["target"])] = torch.tensor(b["target"])
        out = [ids, am, mp, mm, qt, tgt]
        if cache is not None:
            h = torch.zeros((len(batch), L, cache[batch[0]["_i"]].size(-1)))
            for i, b in enumerate(batch):
                hv = cache[b["_i"]]
                h[i, : hv.size(0)] = hv.float()
            out.append(h)
        return out

    for i, u in enumerate(units):
        u["_i"] = i
    t0 = time.time()
    h_cache = []
    with torch.no_grad():
        for s in range(0, len(units), args.batch):
            batch = units[s:s + args.batch]
            ids, am, mp, mm, qt, _ = collate(batch)
            h = model.encoder(input_ids=ids.to(device), attention_mask=am.to(device)).last_hidden_state
            for i, b in enumerate(batch):
                h_cache.append(h[i, : len(b["ids"])].detach().to("cpu", torch.float16))
    print(f"encoder cached {len(h_cache)} units ({time.time() - t0:.1f}s)")

    if args.verify_parity:
        batch = units[: min(4, len(units))]
        ids, am, mp, mm, qt, _tg, h = collate(batch, h_cache)
        with torch.no_grad():
            full, _ = model(ids.to(device), am.to(device), mp.to(device), mm.to(device), qt.to(device))
            cached = head_logits(model, h.to(device), am.to(device), mp.to(device),
                                 mm.to(device), qt.to(device), torch)
        gap = (full - cached).abs().max().item()
        print(f"parity max|Δlogit| = {gap:.3e} (fp16 快取的預期量級 ~1e-2)")
        if gap > 0.1:
            print("parity 失敗：快取路徑與完整 forward 不一致", file=sys.stderr)
            return 1

    trainable_names = ["type_emb", "scorer", "act_head"] + (["head"] if args.train_head else [])
    pristine = {k: v.clone() for k, v in model.state_dict().items()}
    n_train = sum(p.numel() for n, p in model.named_parameters()
                  if n.split(".")[0] in trainable_names)
    print(f"trainable={'+'.join(trainable_names)} ({n_train / 1e6:.2f}M params, {len(units)} units)")

    # ---- grouped K-fold：同一 record 的題目不跨 fold，否則同一請求的
    # 答案會同時出現在訓練與驗證兩邊，OOF 準確率會虛高。
    recs = sorted({u["rec"] for u in units})
    random.Random(SEED).shuffle(recs)
    fold_of = {r: i % args.folds for i, r in enumerate(recs)}

    oof = {}
    for f in range(args.folds):
        tr = [u for u in units if fold_of[u["rec"]] != f]
        va = [u for u in units if fold_of[u["rec"]] == f]
        if not tr or not va:
            continue
        model.load_state_dict(pristine, strict=True)
        for n, p in model.named_parameters():
            p.requires_grad_(n.split(".")[0] in trainable_names)
        params = [p for p in model.parameters() if p.requires_grad]
        opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
        order = list(range(len(tr)))
        rng = random.Random(SEED + f)
        model.train()
        last = None
        for ep in range(args.epochs):
            rng.shuffle(order)
            tot, nb = 0.0, 0
            for s in range(0, len(order), args.batch):
                batch = [tr[i] for i in order[s:s + args.batch]]
                ids, am, mp, mm, qt, tgt, h = collate(batch, h_cache)
                logits = head_logits(model, h.to(device), am.to(device), mp.to(device),
                                     mm.to(device), qt.to(device), torch)
                loss = -(tgt.to(device) * torch.log_softmax(logits, -1)).sum(-1).mean()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                opt.zero_grad()
                tot += float(loss.detach())
                nb += 1
            last = tot / max(nb, 1)
        model.eval()
        with torch.no_grad():
            for s in range(0, len(va), args.batch):
                batch = va[s:s + args.batch]
                ids, am, mp, mm, qt, tgt, h = collate(batch, h_cache)
                logits = head_logits(model, h.to(device), am.to(device), mp.to(device),
                                     mm.to(device), qt.to(device), torch)
                for i, b in enumerate(batch):
                    oof[b["_i"]] = logits[i, : b["n_opt"]].detach().cpu().tolist()
        print(f"  fold {f}: train={len(tr)} val={len(va)} loss={last:.4f}")

    # ---- cross-fit 的 OOF logits 擬溫度（每個 qtype 一個）
    temps = {}
    for qtype in sorted(by_type):
        rows_l = [oof[u["_i"]] for u in units if u["qtype"] == qtype and u["_i"] in oof]
        rows_t = [u["target"] for u in units if u["qtype"] == qtype and u["_i"] in oof]
        temps[qtype] = fit_temperature(rows_l, rows_t, torch)
    print("temperatures:", {k: round(v, 3) for k, v in temps.items()})

    # ---- 評估：OOF vs int8 基線，同一批 units、同一判準
    conf, correct, probs, targets, per_type = [], [], [], [], {}
    paired_new, paired_old = [], []
    # 路由決策只能看 OOF。把逐題結果落盤，否則只能拿「模型跑自己訓練資料」
    # 的 in-sample 數字去定閾值，那會高估（本次實測 in-sample 72.4% vs OOF 67.4%）。
    oof_rows = []
    for u in units:
        if u["_i"] not in oof:
            continue
        lg = torch.tensor(oof[u["_i"]]) / temps[u["qtype"]]
        p = torch.softmax(lg, -1).tolist()
        pi = int(max(range(len(p)), key=lambda i: p[i]))
        ok = pred_matches(u["qtype"], pi, p, u["truth"])
        if ok is None:
            continue
        conf.append(max(p))
        correct.append(bool(ok))
        probs.append(p)
        targets.append(u["target"])
        d = per_type.setdefault(u["qtype"], [0, 0])
        d[0] += 1
        d[1] += bool(ok)
        b = baseline_correct(u)
        if b is not None:
            paired_new.append(1.0 if ok else 0.0)
            paired_old.append(1.0 if b else 0.0)
        # rec 是必要的：雲端計費按「請求」而非按題，所以只有整筆 record 的題
        # 全留本機才真的省一次呼叫。少了它只能算出偏樂觀的逐題覆蓋率。
        oof_rows.append({"rec": u["rec"], "qtype": u["qtype"], "conf": max(p),
                         "correct": bool(ok), "state_ok": short_standalone_state(u["state"])})

    oof_acc = sum(correct) / len(correct) if correct else None
    curve = coverage_curve(conf, correct)
    delta = [a - b for a, b in zip(paired_new, paired_old)]
    report = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "corpus": len(rows),
        "units": len(units),
        "records": n_rec,
        "by_type": by_type,
        "trainable": trainable_names,
        "trainable_params": n_train,
        "folds": args.folds,
        "epochs": args.epochs,
        "oof_accuracy": oof_acc,
        "oof_accuracy_ci": boot_ci([1.0 if c else 0.0 for c in correct]),
        "per_type": {k: {"n": v[0], "agree": v[1], "rate": v[1] / v[0]} for k, v in per_type.items()},
        "int8_baseline_accuracy": base_acc,
        "paired_n": len(delta),
        "paired_delta": (sum(delta) / len(delta)) if delta else None,
        "paired_delta_ci": boot_ci(delta),
        "temperatures": temps,
        "ece": ece(conf, correct),
        "brier": brier(probs, targets),
        "coverage_curve": curve,
        "oof_rows": oof_rows,
    }
    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    os.chmod(args.report, 0o600)

    print(f"\nOOF accuracy: {oof_acc * 100:.1f}%" if oof_acc is not None else "\nOOF accuracy: n/a")
    if report["paired_delta"] is not None:
        ci = report["paired_delta_ci"]
        print(f"vs int8 基線（配對，n={len(delta)}）: {report['paired_delta'] * 100:+.1f}pp"
              + (f"，95% CI [{ci[0] * 100:+.1f}, {ci[1] * 100:+.1f}]pp" if ci else ""))
    print("覆蓋率曲線（信心閾值 → 覆蓋率 / 準確率 [95% CI]）:")
    for c in curve:
        if c["n"] == 0:
            print(f"  T={c['threshold']:.2f}  coverage=  0.0%  n=  0  —")
            continue
        ci = c["ci"]
        tail = f"  [{ci[0] * 100:.1f}, {ci[1] * 100:.1f}]" if ci else ""
        print(f"  T={c['threshold']:.2f}  coverage={c['coverage'] * 100:5.1f}%  n={c['n']:3d}"
              f"  accuracy={c['accuracy'] * 100:5.1f}%{tail}")
    print(f"ECE={report['ece']:.4f}  Brier={report['brier']:.4f}" if report["ece"] is not None else "")
    print(f"report → {args.report}")

    # ---- 升級閘：只有 OOF 配對增益達標才寫權重
    gain = report["paired_delta"]
    ci = report["paired_delta_ci"]
    promoted = False
    if args.promote:
        if gain is None or base_acc is None:
            print("promote 跳過：沒有可配對的 int8 基線")
        elif gain < args.min_gain:
            print(f"promote 跳過：增益 {gain * 100:+.1f}pp < 門檻 {args.min_gain * 100:.1f}pp")
        elif ci and ci[0] <= 0:
            # 配對增益的下界碰到 0 就代表「可能沒有進步」，數百筆最常見的結局。
            print(f"promote 跳過：95% CI 下界 {ci[0] * 100:+.1f}pp 未離開 0")
        else:
            out = Path(args.out_dir)
            out.mkdir(parents=True, exist_ok=True)
            # 全模型重訓最後一次（不留 holdout），因為閘已經用 OOF 判過了
            model.load_state_dict(pristine, strict=True)
            for n, p in model.named_parameters():
                p.requires_grad_(n.split(".")[0] in trainable_names)
            params = [p for p in model.parameters() if p.requires_grad]
            opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
            order = list(range(len(units)))
            rng = random.Random(SEED)
            model.train()
            for ep in range(args.epochs):
                rng.shuffle(order)
                for s in range(0, len(order), args.batch):
                    batch = [units[i] for i in order[s:s + args.batch]]
                    ids, am, mp, mm, qt, tgt, h = collate(batch, h_cache)
                    logits = head_logits(model, h.to(device), am.to(device), mp.to(device),
                                         mm.to(device), qt.to(device), torch)
                    loss = -(tgt.to(device) * torch.log_softmax(logits, -1)).sum(-1).mean()
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(params, 1.0)
                    opt.step()
                    opt.zero_grad()
            model.eval()
            save_file({k: v.detach().cpu().contiguous() for k, v in model.state_dict().items()},
                      str(out / "model.safetensors"))
            new_cfg = dict(cfg)
            new_cfg["temperature"] = [temps.get("choice", 1.0), temps.get("score", 1.0),
                                      temps.get("noul", 1.0)]
            new_cfg["trained_from"] = str(base)
            new_cfg["trained_units"] = len(units)
            (out / "rl_agent_config.json").write_text(json.dumps(new_cfg, indent=2) + "\n")
            print(f"promoted → {out}")
            promoted = True
    report["promoted"] = promoted
    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
