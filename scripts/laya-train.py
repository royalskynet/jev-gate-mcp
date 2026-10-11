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
  laya-train.py --lora --report X.json  # 實驗：encoder 掛 LoRA 一起訓，對照只訓 head

`--lora` 借鏡 Unsloth decision model（Clef head）的做法：encoder 不再全凍，掛 LoRA
（ModernBERT 的 Wqkv／Wo／Wi）跟 head 一起訓。encoder 要反傳就不能快取，慢很多。
ponytail: 只做 cross-fit 對照，不支援 --promote；要上線得先 merge_and_unload 回原始
state_dict 鍵名，再過 laya-export-onnx.py 的 parity。
"""
import argparse
import glob
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
# 外部語料（scripts/laya-external-corpus.mjs 的產物，label_source=external:*）。
# 只進訓練 fold、不進 OOF／溫度／live_gated，否則「退步不導出」的閘量到的就不是線上那批題。
# ponytail: 單一全域權重（預設 0.2，=0 或 JEV_LAYA_EXTERNAL_CORPUS=off 即關）。外部題只佔訓練
# 量的一部分時夠用；要分來源調權重再改成 label_source→weight 的表。上限：外部標註與 teacher
# 判準不同源，權重拉到 ~0.5 以上前要先看外部考卷與線上 lane 有沒有被拖下水。
EXTERNAL = os.environ.get("JEV_LAYA_EXTERNAL_CORPUS", str(HOME / ".jevgate" / "external" / "train-*.jsonl"))
EXTERNAL_WEIGHT = float(os.environ.get("JEV_LAYA_EXTERNAL_WEIGHT", "0.2"))


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


def is_external(row):
    return str(row.get("label_source") or "").startswith("external:")


def load_external(spec=None, weight=None):
    """讀外部訓練列。只收 external:* 且 split=='train'——考卷（split=='eval'）就算被
    glob 到也不會混進訓練。權重 <= 0 或 spec=off 回空。"""
    spec = EXTERNAL if spec is None else spec
    weight = EXTERNAL_WEIGHT if weight is None else weight
    if weight <= 0 or not spec or spec == "off":
        return []
    rows = []
    for pat in filter(None, (s.strip() for s in spec.split(","))):
        for p in sorted(glob.glob(os.path.expanduser(pat))):
            rows += [r for r in load_cases(p) if is_external(r) and r.get("split") == "train"]
    return rows


def cv_splits(units, folds):
    """grouped K-fold：同一 record 的題目不跨 fold。外部題永遠只在訓練側，
    所以 OOF logits、溫度與 live_gated 全部只來自線上語料。"""
    recs = sorted({u["rec"] for u in units if not u["external"]})
    random.Random(SEED).shuffle(recs)
    fold_of = {r: i % folds for i, r in enumerate(recs)}
    ext = [u for u in units if u["external"]]
    out = []
    for f in range(folds):
        own = [u for u in units if not u["external"]]
        out.append(([u for u in own if fold_of[u["rec"]] != f] + ext,
                    [u for u in own if fold_of[u["rec"]] == f]))
    return out


def build_units(rows, external_weight=None):
    """展平成「一題一筆」，並記住它來自哪個 record（分組切 fold 用）。"""
    external_weight = EXTERNAL_WEIGHT if external_weight is None else external_weight
    units, skipped = [], 0
    for rec_i, r in enumerate(rows):
        ext = is_external(r)
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
                "external": ext,
                "weight": external_weight if ext else 1.0,
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


# laya-routing.js 的兩條 lane 的鏡像：pilot 題型吃信心閘，其餘題型吃 state 過濾。
# coverage_curve 是「所有題型一起設閘」的假想情境，和線上配置對不上——拿它當
# 升級地板會把不設閘的 choice 算進去，量到的不是線上那個點（ADR-0002）。
QTYPE_PILOT = frozenset(
    s.strip() for s in os.environ.get("JEV_LAYA_QTYPE_PILOT", "score,noul").split(",") if s.strip())
def parse_conf_min(spec):
    """單一數字＝所有題型共用；`score=0.65,noul=0.70`＝分題型。未列的題型無校準過的
    地板，所以回 inf（過不了閘）。膝點因題型而異，見 ADR-0002。"""
    try:
        flat = float(spec)
    except ValueError:
        pass
    else:
        return lambda _qtype: flat
    by_type = {}
    for pair in filter(None, spec.split(",")):
        qtype, floor = pair.split("=")
        by_type[qtype.strip()] = float(floor)
    return lambda qtype: by_type.get(qtype, math.inf)


CONF_MIN_SPEC = os.environ.get("JEV_LAYA_CONF_MIN", "score=0.65,noul=0.70")


def live_gated(rows, pilot=QTYPE_PILOT, conf_min_spec=CONF_MIN_SPEC):
    """線上實際會留在本機的那些題的 n 與準確率。升級閘要看的就是這個數字。

    `qids` 是這批題的題目名單。兩條 lane 的閘都不看題目身分——信心閘看 qtype，
    state 閘看 state 的 key 形狀——而 key 形狀只是「這是哪個題組」的代理指標。
    所以 caller 改了自己的 state（少帶一個欄位）或新 caller 接進來，都會讓一批
    從未量測過的題目無聲進入本機 lane。名單外顯，nightly 才攔得到（見 ADR 0002）。
    """
    floor = parse_conf_min(conf_min_spec)
    # 鏡像 laya-routing.js：`eligible = shortStandaloneState(state)` 先套在每一題上，pilot 題型
    # 再加信心閘。state 閘不過的題整批送雲端，信心再高也不會本機答。
    # ponytail: 非 pilot 題一律當 profile 題（不吃信心閘）；JS 只放行 TASK_KIND/MESSAGE_TOPIC，
    # 目前 state 過得了的非 pilot 題只有 kind。新增非 profile 的 choice caller 時要補 profile 欄位。
    live = [r for r in rows
            if r.get("state_ok") and (r["qtype"] not in pilot or r["conf"] >= floor(r["qtype"]))]
    meta = {"conf_min": conf_min_spec, "pilot": sorted(pilot),
            "qids": sorted({r["qid"] for r in live if r.get("qid")})}
    if not live:
        return {"n": 0, "accuracy": None, **meta}
    return {"n": len(live),
            "accuracy": sum(1 for r in live if r["correct"]) / len(live), **meta}


def teacher_self_agreement(rows, qids):
    """Jev 對同一份 (state, questions) 再答一次，跟上一次答案相同的比例（只算 qids）。

    老師自己會變卦的題，學生對老師的一致率天花板就是這個數，nightly 的地板取
    min(地板, 這個數)，只會放寬不會變嚴（使用者 10-10 核准）。判準同 pred_matches：
    choice／score 比硬答案、noul 差 < 0.2。重複來源多半是同一段重放，n 小時 nightly 不採用。
    """
    want, last, n, agree = set(qids), {}, 0, 0
    for r in rows:
        if is_external(r):
            continue
        qs, ans = r.get("questions") or {}, r.get("teacher_answer") or {}
        key = json.dumps([r.get("state"), qs], sort_keys=True, ensure_ascii=False)
        for qid in want & qs.keys():
            a = ans.get(qid)
            t = teacher_hard(qs[qid], a) if isinstance(a, dict) else None
            if t is None:
                continue
            prev = last.get((key, qid))
            if prev is not None:
                n += 1
                agree += (abs(t - prev) < 0.2) if qs[qid].get("type") == "noul" else (t == prev)
            last[(key, qid)] = t
    return {"n": n, "agreement": agree / n if n else None, "qids": sorted(want)}


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


CACHE_BUDGET_GB = float(os.environ.get("JEV_LAYA_CACHE_BUDGET_GB", "4"))


def fit_cache_budget(units, hidden, budget_bytes, seed=SEED):
    """encoder 凍結時每個 unit 的 h 以 fp16 留在 CPU（len×hidden×2 bytes），語料一長就爆。
    10-06 是 1552 units，峰值 8.2GB；10-10 長到 15994 units／801 萬 token＝快取 11.5GiB，
    加上模型與 MPS 會被 ram_guard 砍。超過預算就逐 unit 以固定 seed 均勻抽樣：
    每題保留的比例期望相同，題目分布不變，只是每晚看到的子集少一點。
    回 (保留的 units, 丟掉幾個)。budget_bytes<=0 關閉。
    ponytail: 均勻抽樣；某題資料太少、抽完不夠校準時，改成按 qid 分層並保底。"""
    total = sum(len(u["ids"]) for u in units) * hidden * 2
    if budget_bytes <= 0 or total <= budget_bytes:
        return units, 0
    keep = budget_bytes / total
    rng = random.Random(seed)
    kept = [u for u in units if rng.random() < keep]
    return kept, len(units) - len(kept)


def open_disk_cache(path, lengths, hidden):
    """--cache-dir 用：把整份 h 快取放進磁碟上的單一 fp16 .npy（numpy open_memmap），
    unit i 的列是 rows[offs[i]:offs[i+1]]。RAM 只留 OS 頁快取，不再受 CACHE_BUDGET_GB 抽樣，
    10-10 那種 11.5GiB 的量也不用丟資料。回 (memmap, offs)。
    ponytail: 每晚整份重算；要省 encoder 時間再改成按 digest 增量。"""
    import numpy as np
    offs = [0]
    for n in lengths:
        offs.append(offs[-1] + n)
    mm = np.lib.format.open_memmap(str(path), mode="w+", dtype=np.float16, shape=(max(offs[-1], 1), hidden))
    return mm, offs


MAX_PER_QID = int(os.environ.get("JEV_LAYA_MAX_PER_QID", "300"))


def cap_per_qid(units, cap, seed=SEED):
    """10-10 語料 17152 units，tier/route/ambiguous/wrong_reading_costly 各 2500+，訓練跑 2h40m
    沒跑完被砍。快取預算在 tokenize 之後才抽、且是全體均勻抽，大題照樣佔大半。這裡在 tokenize
    前逐題封頂：小題全留，大題以固定 seed 抽 cap 筆。尾碼數字只是序號的題併成一族一起封頂
    （call_t1..call_t66、result_t*、claim_* 共 259 題、4397 units，逐題封頂碰不到），
    否則 cap 調到 50 也還剩 5597 units；併族後 cap=300 是 2341。
    外部題不算在內（只進訓練側、數量固定）。保留原順序。回 (保留的 units, 丟掉幾個)。cap<=0 關閉。
    ponytail: 族內均勻抽，罕見序號可能整個抽掉；要保底時改成族內再按 qid 分層。"""
    if cap <= 0:
        return units, 0
    by_qid = {}
    for i, u in enumerate(units):
        if not u["external"]:
            by_qid.setdefault(re.sub(r"\d+$", "#", u["qid"]), []).append(i)
    rng = random.Random(seed)
    drop = set()
    for idx in by_qid.values():
        if len(idx) > cap:
            drop.update(set(idx) - set(rng.sample(idx, cap)))
    return [u for i, u in enumerate(units) if i not in drop], len(drop)


DEDUP_COS = float(os.environ.get("JEV_LAYA_DEDUP_COS", "0.95"))
DEDUP_MODEL = os.environ.get("JEV_LAYA_DEDUP_MODEL", "minishlab/potion-multilingual-128M")


def _same_answer(a, b):
    """兩筆老師答案算不算同一個。判準照 pred_matches：noul 差 < 0.2，其餘要相等。
    不用量化分格：0.29／0.31 會被切在格線兩側。"""
    if a["truth"] is None or b["truth"] is None:
        return a["truth"] is b["truth"]
    if a["qtype"] == "noul":
        return abs(a["truth"] - b["truth"]) < 0.2
    return a["truth"] == b["truth"]


def dedup_exact(units):
    """同題、同 state、同題目的 units 只留一筆。老師答案不一致＝矛盾標註：多數決留多數那筆，
    平票整組丟（拿互相矛盾的目標訓練比少一筆更糟）。10-11 實測 24215 → 20991，矛盾 453 組、平票 332。
    多數決對每一筆數「跟它同答案的有幾筆」，最多的那筆勝出。外部題不動。回 (保留的 units, 統計)。"""
    groups = {}
    for i, u in enumerate(units):
        if not u["external"]:
            key = (u["qid"], json.dumps([u["state"], u["question"]], sort_keys=True, ensure_ascii=False))
            groups.setdefault(key, []).append(i)
    drop, conflicts, ties = set(), 0, 0
    for idx in groups.values():
        if len(idx) == 1:
            continue
        support = {i: sum(_same_answer(units[i], units[j]) for j in idx) for i in idx}
        best = max(support.values())
        if best < len(idx):
            conflicts += 1
            winners = [i for i in idx if support[i] == best]
            # 平票＝最高票的那幾筆彼此不是同一個答案
            if any(not _same_answer(units[winners[0]], units[w]) for w in winners[1:]):
                ties += 1
                drop.update(idx)
                continue
        keep = next(i for i in idx if support[i] == best)
        drop.update(set(idx) - {keep})
    kept = [u for i, u in enumerate(units) if i not in drop]
    return kept, {"dropped": len(drop), "conflict_groups": conflicts, "tie_groups": ties}


def m2v_embed(texts):
    """model2vec 靜態向量（CPU、無 torch）。載入約 2.0GB、batch 64 編碼不再長；用完即丟。
    HF_HUB_OFFLINE=1 時模型必須已在快取，否則直接失敗（夜訓每晚都要經過去重，不靜默略過）。"""
    from model2vec import StaticModel
    m = StaticModel.from_pretrained(DEDUP_MODEL)
    try:
        return m.encode(texts, batch_size=64, max_length=256)
    finally:
        del m
        import gc
        gc.collect()


def dedup_near(units, threshold, embed=m2v_embed):
    """同一題內 state 的 cosine ≥ threshold，**而且老師答案相同**才併（星狀，先到先留）。
    只比 state：題目說明在同一題每筆都一樣，整段一起嵌入會讓不同請求也算出 0.99（10-11 實測誤刪 82%）。
    答案不同不併：只比 state 時被併掉的有 15% 老師答案不同（例如只差 phase），那是訊號不是重複。
    按 qid 不按族分組：同一筆 record 的 call_t1／call_t2 共用 state，按族會互相吃掉。
    外部題不動。threshold<=0 關閉。回 (保留的 units, 丟掉幾個)。"""
    if threshold <= 0:
        return units, 0
    import numpy as np
    own = [i for i, u in enumerate(units) if not u["external"]]
    keys = [json.dumps(units[i]["state"], sort_keys=True, ensure_ascii=False) for i in own]
    uniq = list(dict.fromkeys(keys))
    row = {k: j for j, k in enumerate(uniq)}
    emb = np.asarray(embed(uniq), dtype=np.float32)
    emb /= np.maximum(np.linalg.norm(emb, axis=1, keepdims=True), 1e-9)
    by_qid = {}
    for i, k in zip(own, keys):
        by_qid.setdefault(units[i]["qid"], []).append((i, row[k]))
    drop = set()
    for members in by_qid.values():
        reps = []  # (unit 索引, 向量列)
        for i, r in members:
            if reps:
                sims = emb[[rr for _, rr in reps]] @ emb[r]
                if any(_same_answer(units[reps[j][0]], units[i]) for j in np.nonzero(sims >= threshold)[0]):
                    drop.add(i)
                    continue
            reps.append((i, r))
    return [u for i, u in enumerate(units) if i not in drop], len(drop)


def is_trainable(name, trainable_names, lora):
    """頂層模組在名單裡，或（--lora 時）是 encoder 裡的 LoRA 參數。encoder 原權重永遠凍結。"""
    return name.split(".")[0] in trainable_names or (lora and "lora_" in name)


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
        src = js.read_text()
        jp = re.search(r"JEV_LAYA_QTYPE_PILOT \?\? '([^']*)'", src)
        jc = re.search(r"JEV_LAYA_CONF_MIN \?\? '([^']*)'", src)
        assert jp and jc, "laya-routing.js 的 QTYPE_PILOT／CONF_MIN 預設值找不到"
        assert frozenset(s.strip() for s in jp.group(1).split(",")) == QTYPE_PILOT, \
            f"pilot 題型漂移：JS={jp.group(1)} PY={sorted(QTYPE_PILOT)}"
        assert jc.group(1) == CONF_MIN_SPEC, f"CONF_MIN 漂移：JS={jc.group(1)} PY={CONF_MIN_SPEC}"
        # 分題型地板逐一比，不只比字串：JS 與 PY 的 parser 必須對同一題型給同一個數字
        js_floor, py_floor = parse_conf_min(jc.group(1)), parse_conf_min(CONF_MIN_SPEC)
        for _q in sorted(QTYPE_PILOT):
            assert js_floor(_q) == py_floor(_q), f"{_q} 地板漂移"

    # parse_conf_min：單一數字共用，分題型各自吃自己的，未列的題型過不了閘
    assert parse_conf_min("0.7")("anything") == 0.7
    _f = parse_conf_min("score=0.65,noul=0.70")
    assert (_f("score"), _f("noul")) == (0.65, 0.70)
    assert _f("choice") == math.inf, "未列的題型不該有地板，否則會無聲放行"

    # live_gated：state 閘套全部題型，pilot 題型再加信心閘
    _r = [{"qtype": "score", "qid": "difficulty", "conf": 0.9, "correct": True, "state_ok": True},
          {"qtype": "score", "qid": "tier", "conf": 0.5, "correct": False, "state_ok": True},
          {"qtype": "choice", "qid": "kind", "conf": 0.1, "correct": True, "state_ok": True},
          {"qtype": "choice", "qid": "route", "conf": 0.99, "correct": False, "state_ok": False},
          # 2026-10-02 的鏡像錯誤：pilot 高信心但 state 不過，線上送雲端，不能算進本機
          {"qtype": "noul", "qid": "ask_first", "conf": 0.9, "correct": False, "state_ok": False}]
    assert live_gated(_r)["n"] == 2, live_gated(_r)
    assert live_gated(_r)["accuracy"] == 1.0, live_gated(_r)
    assert live_gated([])["accuracy"] is None
    # qids 只收真的留在本機那些題；被閘掉的不能出現，否則 nightly 的人口閘會放行
    assert live_gated(_r)["qids"] == ["difficulty", "kind"], live_gated(_r)["qids"]
    assert live_gated([])["qids"] == []
    # 分題型地板真的分開套：noul 的 0.68 過不了 0.70，score 的 0.66 過得了 0.65
    _r2 = [{"qtype": "noul", "conf": 0.68, "correct": False, "state_ok": True},
           {"qtype": "score", "conf": 0.66, "correct": True, "state_ok": True}]
    assert live_gated(_r2, conf_min_spec="score=0.65,noul=0.70")["n"] == 1, "分題型地板沒分開套"

    # 外部語料：只進訓練側。fold 若把外部題分進驗證側，OOF／溫度／live_gated 就混進
    # 非線上的題目，nightly 的「退步不導出」閘量到的就不是線上那批。
    _rows = [{"questions": {"d": qs}, "teacher_answer": {"d": {"type": "score", "score": 1}},
              "state": {"user_request": f"r{i}"}} for i in range(10)]
    _rows += [{"questions": {"d": qs}, "teacher_answer": {"d": {"type": "score", "score": 2}},
               "state": {"user_request": f"x{i}"}, "label_source": "external:t", "split": "train"}
              for i in range(4)]
    _u, _ = build_units(_rows, external_weight=0.2)
    assert [u["weight"] for u in _u if u["external"]] == [0.2] * 4
    assert all(u["weight"] == 1.0 for u in _u if not u["external"])
    for _tr, _va in cv_splits(_u, 5):
        assert not any(u["external"] for u in _va), "外部題進了驗證 fold"
        assert sum(u["external"] for u in _tr) == 4, "外部題沒進訓練 fold"
    # 線上列的 fold 分配不因接上外部列而改變（rec 索引不變）
    _base = [[u["rec"] for u in va] for _, va in cv_splits(build_units(_rows[:10])[0], 5)]
    assert _base == [[u["rec"] for u in va] for _, va in cv_splits(_u, 5)]

    # teacher_self：只數「同 state 同題再問」的那一次；第一次出現不算，外部語料不算
    _q = {"k": {"type": "choice", "criteria": {"a": "", "b": ""}},
          "p": {"type": "noul", "criteria": {"true": "", "false": ""}}}
    _a = lambda c, p: {"k": {"type": "choice", "choice": c}, "p": {"type": "noul", "noul": p}}
    _ts = [{"state": {"u": 1}, "questions": _q, "teacher_answer": _a("a", 0.9)},
           {"state": {"u": 1}, "questions": _q, "teacher_answer": _a("a", 0.8)},   # 同：k 同、p 差 0.1
           {"state": {"u": 1}, "questions": _q, "teacher_answer": _a("b", 0.3)},   # 變卦：k 換、p 差 0.5
           {"state": {"u": 2}, "questions": _q, "teacher_answer": _a("b", 0.1)},   # 新 state，不算
           {"state": {"u": 2}, "questions": _q, "teacher_answer": _a("a", 0.1),
            "label_source": "external:t"}]
    assert teacher_self_agreement(_ts, ["k"]) == {"n": 2, "agreement": 0.5, "qids": ["k"]}
    assert teacher_self_agreement(_ts, ["k", "p"])["n"] == 4
    assert teacher_self_agreement(_ts, ["k", "p"])["agreement"] == 0.5
    assert teacher_self_agreement(_ts, [])["agreement"] is None, "沒有 gated 題就不該給數字"

    # --lora：只放行 LoRA 參數，encoder 原權重不能被一起解凍（那就成了全量微調）
    _tn = ["type_emb", "scorer", "act_head", "head"]
    assert is_trainable("encoder.layers.0.attn.Wqkv.lora_A.default.weight", _tn, True)
    assert not is_trainable("encoder.layers.0.attn.Wqkv.base_layer.weight", _tn, True)
    assert not is_trainable("encoder.layers.0.attn.Wqkv.lora_A.default.weight", _tn, False)
    assert is_trainable("head.layers.0.linear1.weight", _tn, False)

    # 快取預算：沒超過原樣返回；超過時抽到預算附近、可重現、每題都還在
    _cu = [{"ids": [0] * 100, "qid": q} for q in ("a", "b") for _ in range(500)]  # 1000×100×4×2=800KB
    assert fit_cache_budget(_cu, 4, 10**6) == (_cu, 0)
    assert fit_cache_budget(_cu, 4, 0) == (_cu, 0), "預算 0 要關閉"
    _k, _d = fit_cache_budget(_cu, 4, 200_000)  # 預算是 1/4
    assert 180 <= len(_k) <= 320 and _d == 1000 - len(_k), len(_k)
    assert {u["qid"] for u in _k} == {"a", "b"}, "均勻抽樣不該整題抽光"
    assert fit_cache_budget(_cu, 4, 200_000)[0] == _k, "同 seed 要抽到同一批"

    # 逐題封頂：大題砍到 cap、小題與外部題全留、可重現、0 關閉
    _pu = ([{"qid": "big", "external": False, "n": i} for i in range(50)]
           + [{"qid": "small", "external": False, "n": i} for i in range(5)]
           + [{"qid": "big", "external": True, "n": i} for i in range(7)])
    _k, _d = cap_per_qid(_pu, 10)
    assert _d == 40 and len(_k) == 22, (_d, len(_k))
    assert sum(1 for u in _k if u["qid"] == "small") == 5, "小題不該被抽"
    assert sum(1 for u in _k if u["external"]) == 7, "外部題不算在封頂內"
    assert cap_per_qid(_pu, 10)[0] == _k, "同 seed 要抽到同一批"
    assert cap_per_qid(_pu, 0) == (_pu, 0), "cap 0 要關閉"
    _fu = [{"qid": f"call_t{i % 20}", "external": False} for i in range(40)]  # 20 題各 2 筆＝同一族
    assert len(cap_per_qid(_fu, 10)[0]) == 10, "尾碼序號要併族封頂"

    # 完全重複：同答案留一筆；2:1 矛盾留多數那筆；平票整組丟；外部題不動
    def _du(qid, s, truth, ext=False, qtype="choice"):
        return {"qid": qid, "state": {"s": s}, "question": {"q": qid}, "truth": truth,
                "qtype": qtype, "external": ext}
    _eu = ([_du("a", 1, 0)] * 3 + [_du("b", 1, 0), _du("b", 1, 1), _du("b", 1, 1)]
           + [_du("c", 1, 0), _du("c", 1, 1)] + [_du("a", 1, 0, ext=True)] * 2
           + [_du("n", 1, 0.31, qtype="noul"), _du("n", 1, 0.29, qtype="noul")])
    _k, _s = dedup_exact(_eu)
    assert sum(1 for u in _k if u["qid"] == "a" and not u["external"]) == 1, "同答案只留一筆"
    assert [u["truth"] for u in _k if u["qid"] == "b"] == [1], "矛盾要留多數答案"
    assert not any(u["qid"] == "c" for u in _k), "平票要整組丟"
    assert sum(1 for u in _k if u["external"]) == 2, "外部題不去重"
    assert sum(1 for u in _k if u["qid"] == "n") == 1, "noul 差 < 0.2 算同答案"
    assert _s == {"dropped": 7, "conflict_groups": 2, "tie_groups": 1}, _s

    # 近似重複：向量相同＋答案相同才併；答案不同、不同題、外部題、門檻 0 都不併
    try:
        import numpy as np  # noqa: F401
    except ImportError:
        print("  (無 numpy，略過近似重複檢查)")
    else:
        _vec = {'{"s": 1}': [1.0, 0.0], '{"s": 2}': [0.999, 0.04], '{"s": 3}': [0.0, 1.0]}
        _emb = lambda texts: [_vec[t] for t in texts]
        _nu = [_du("a", 1, 0), _du("a", 2, 0), _du("a", 2, 1), _du("a", 3, 0),
               _du("b", 1, 0), _du("a", 2, 0, ext=True)]
        _k, _d = dedup_near(_nu, 0.95, _emb)
        assert _d == 1 and _nu[1] not in _k, "近似且同答案要併"
        assert _nu[2] in _k, "近似但答案不同是訊號，不能併"
        assert _nu[3] in _k and _nu[4] in _k and _nu[5] in _k, "不相似／不同題／外部題都留"
        assert dedup_near(_nu, 0, _emb) == (_nu, 0), "門檻 0 要關閉"

    # 磁碟快取：寫進去的每個 unit 讀回來要是同一段列，偏移錯一格就是拿別題的 h 訓練
    try:
        import numpy as np
    except ImportError:
        print("  (無 numpy，略過磁碟快取檢查)")
    else:
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "h.npy"
            mm, offs = open_disk_cache(p, [2, 3, 1], 4)
            for i in range(3):
                mm[offs[i]:offs[i + 1]] = i + 1
            mm.flush()
            del mm
            back = np.load(p, mmap_mode="r")
            assert offs == [0, 2, 5, 6], offs
            for i in range(3):
                seg = back[offs[i]:offs[i + 1]]
                assert seg.shape == ([2, 3, 1][i], 4) and (seg == i + 1).all(), (i, seg)
            del back

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
            if model.head_checkpointing and model.training and torch.is_grad_enabled():
                # 上游同一分支：反傳時重算，不存 L=1024 的注意力 activation，壓單步峰值。
                # 數學不變（預設保留 RNG，dropout 一致）。
                from torch.utils.checkpoint import checkpoint
                h = checkpoint(layer, h, src_key_padding_mask=pad, use_reentrant=False)
            else:
                h = layer(h, src_key_padding_mask=pad)
    idx = marker_pos.clamp(min=0)[:, :, None].expand(-1, -1, h.size(-1))
    m = torch.gather(h, 1, idx)
    logits = model.scorer(m).squeeze(-1).float()
    return logits.masked_fill(~marker_mask, -1e4)


def weighted_ce(logits, tgt, w, torch):
    """soft cross-entropy 乘逐題權重再取平均；權重全 1 時等於原本的 .mean()。"""
    return (-(tgt * torch.log_softmax(logits, -1)).sum(-1) * w).mean()


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
    ap.add_argument("--lora", action="store_true", help="encoder 掛 LoRA 一起訓（實驗，不能配 --promote）")
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--device", choices=["auto", "mps", "cpu"], default="auto")
    ap.add_argument("--promote", action="store_true", help="達標才寫出權重")
    ap.add_argument("--min-gain", type=float, default=0.05, help="OOF 準確率要比 int8 基線高多少才算達標")
    ap.add_argument("--verify-parity", action="store_true", help="拿完整 forward 比對快取路徑")
    ap.add_argument("--base-dir", default=str(BASE_DIR))
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    ap.add_argument("--report", default=str(REPORT))
    ap.add_argument("--cache-dir", help="h 快取寫到這個目錄的 memmap，快取完卸掉 encoder（低記憶體模式）")
    ap.add_argument("--limit", type=int, default=0, help="只取 N 個 units（固定 seed 抽樣），量峰值用")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return 0
    if args.lora and args.promote:
        print("--lora 不支援 --promote（見檔頭 ponytail）", file=sys.stderr)
        return 2
    if args.lora and args.cache_dir:
        print("--lora 要反傳過 encoder，不能配 --cache-dir", file=sys.stderr)
        return 2

    if not CORPUS.exists():
        print(f"no corpus at {CORPUS}", file=sys.stderr)
        return 1
    rows = load_cases(CORPUS)
    n_own = len(rows)
    rows += load_external()  # 接在後面：線上列的 rec 索引不變，fold 分配也就不變
    units, skipped = build_units(rows)
    by_type = {}
    for u in units:
        by_type[u["qtype"]] = by_type.get(u["qtype"], 0) + 1
    n_rec = len({u["rec"] for u in units})
    ext_by_source = {}
    for u in units:
        if u["external"]:
            src = rows[u["rec"]].get("label_source")
            ext_by_source[src] = ext_by_source.get(src, 0) + 1
    print(f"corpus={n_own} units={len(units)} records={n_rec} skipped={skipped} by_type={by_type}")
    # 去重在封頂前：封頂只是抽樣，先把重複與矛盾拿掉，抽到的 300 筆才彼此不同。
    units, dedup_stats = dedup_exact(units)
    t0 = time.time()
    units, dedup_stats["near_dropped"] = dedup_near(units, DEDUP_COS)
    dedup_stats["cos"] = DEDUP_COS
    print(f"去重：完全重複丟 {dedup_stats['dropped']}（矛盾 {dedup_stats['conflict_groups']} 組、"
          f"平票整組丟 {dedup_stats['tie_groups']}），cosine≥{DEDUP_COS} 同答案丟 "
          f"{dedup_stats['near_dropped']}（{time.time() - t0:.0f}s），剩 {len(units)} units")
    units, capped = cap_per_qid(units, MAX_PER_QID)
    if capped:
        print(f"每題上限 {MAX_PER_QID}：保留 {len(units)} units，丟 {capped}")
    if args.limit and len(units) > args.limit:
        units = random.Random(SEED).sample(units, args.limit)
        print(f"--limit {args.limit}：抽樣保留 {len(units)} units")
    if ext_by_source:
        print(f"external（只進訓練 fold，weight={EXTERNAL_WEIGHT}）: {ext_by_source}")

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
    del state_dict  # 不放掉的話 1.2GB 的出廠權重整趟陪跑
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
    if not args.lora and not args.cache_dir:  # --lora 不快取；--cache-dir 在磁碟，不用 RAM 預算
        hidden = model.encoder.config.hidden_size
        units, dropped = fit_cache_budget(units, hidden, int(CACHE_BUDGET_GB * 2**30))
        if dropped:
            print(f"cache budget {CACHE_BUDGET_GB}GiB：抽樣保留 {len(units)} units，丟 {dropped}")
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

    def batch_logits(batch, cache):
        """cache=None 時 encoder 現跑（--lora 要反傳過 encoder）；否則吃快取的 h。"""
        if cache is None:
            ids, am, mp, mm, qt, tgt = collate(batch)
            am = am.to(device)
            h = model.encoder(input_ids=ids.to(device), attention_mask=am).last_hidden_state
        else:
            ids, am, mp, mm, qt, tgt, h = collate(batch, cache)
            am, h = am.to(device), h.to(device)
        return head_logits(model, h, am, mp.to(device), mm.to(device), qt.to(device), torch), tgt

    if args.lora:
        from peft import LoraConfig, inject_adapter_in_model
        # lora_B 初始為 0，掛上去的當下輸出不變，所以 pristine 仍等於出廠權重
        model.encoder = inject_adapter_in_model(LoraConfig(
            r=args.lora_r, lora_alpha=2 * args.lora_r, lora_dropout=0.05,
            target_modules=["Wqkv", "Wo", "Wi"]), model.encoder)
        # 反傳過 1024 長度的 encoder，不 checkpoint 的 activation 會撞 ram_guard（fixindex 10256）
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.to(device)
        h_cache = None
        print(f"lora r={args.lora_r} on encoder Wqkv/Wo/Wi；不快取 encoder")
    elif args.cache_dir:
        import numpy as np
        t0 = time.time()
        Path(args.cache_dir).mkdir(parents=True, exist_ok=True)
        disk, offs = open_disk_cache(Path(args.cache_dir) / "h.npy", [len(u["ids"]) for u in units],
                                     model.encoder.config.hidden_size)
        with torch.no_grad():
            for s in range(0, len(units), args.batch):
                batch = units[s:s + args.batch]
                ids, am, mp, mm, qt, _ = collate(batch)
                h = model.encoder(input_ids=ids.to(device), attention_mask=am.to(device)).last_hidden_state
                for i, b in enumerate(batch):
                    disk[offs[b["_i"]]:offs[b["_i"] + 1]] = h[i, : len(b["ids"])].to("cpu", torch.float16).numpy()
                del h
                if device.type == "mps":
                    torch.mps.empty_cache()
        disk.flush()

        class DiskCache:
            def __getitem__(self, i):
                return torch.from_numpy(np.array(disk[offs[i]:offs[i + 1]]))

        h_cache = DiskCache()
        print(f"encoder cached {len(units)} units → {args.cache_dir}/h.npy "
              f"({offs[-1]} tokens, {time.time() - t0:.1f}s)")
    else:
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

    if args.verify_parity and h_cache is not None:
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

    if args.cache_dir:
        # 之後只吃磁碟上的 h；encoder 卸掉，pristine 也就不再複製它（又省一份 1.2GB）。
        # promote 存檔時再從出廠檔補回 encoder 權重（凍結，必與出廠相同）。
        import gc
        model.encoder = None
        gc.collect()
        if device.type == "mps":
            torch.mps.empty_cache()
        print("encoder 已卸載（--cache-dir）")

    trainable_names = ["type_emb", "scorer", "act_head"] + (["head"] if args.train_head else [])
    pristine ={k: v.clone() for k, v in model.state_dict().items()}
    n_train = sum(p.numel() for n, p in model.named_parameters()
                  if is_trainable(n, trainable_names, args.lora))
    print(f"trainable={'+'.join(trainable_names)} ({n_train / 1e6:.2f}M params, {len(units)} units)")

    # ---- grouped K-fold：同一 record 的題目不跨 fold，否則同一請求的
    # 答案會同時出現在訓練與驗證兩邊，OOF 準確率會虛高。
    oof = {}
    for f, (tr, va) in enumerate(cv_splits(units, args.folds)):
        if not tr or not va:
            continue
        model.load_state_dict(pristine, strict=True)
        for n, p in model.named_parameters():
            p.requires_grad_(is_trainable(n, trainable_names, args.lora))
        params = [p for p in model.parameters() if p.requires_grad]
        opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
        order = list(range(len(tr)))
        rng = random.Random(SEED + f)
        model.head_checkpointing = True
        model.train()
        last = None
        for ep in range(args.epochs):
            rng.shuffle(order)
            tot, nb = 0.0, 0
            for s in range(0, len(order), args.batch):
                batch = [tr[i] for i in order[s:s + args.batch]]
                logits, tgt = batch_logits(batch, h_cache)
                w = torch.tensor([b["weight"] for b in batch], device=device)
                loss = weighted_ce(logits, tgt.to(device), w, torch)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                opt.zero_grad()
                if device.type == "mps":
                    torch.mps.empty_cache()  # 每批 L 不同，MPS 替每種長度囤快取；不清的話 driver 一路長到 15GB
                tot += float(loss.detach())
                nb += 1
            last = tot / max(nb, 1)
            print(f"    fold {f} epoch {ep + 1}/{args.epochs} loss={last:.4f} ({time.time() - t0:.0f}s)")
        model.eval()
        with torch.no_grad():
            for s in range(0, len(va), args.batch):
                batch = va[s:s + args.batch]
                logits, _ = batch_logits(batch, h_cache)
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
        oof_rows.append({"rec": u["rec"], "qid": u["qid"], "qtype": u["qtype"], "conf": max(p),
                         "correct": bool(ok), "state_ok": short_standalone_state(u["state"])})

    oof_acc = sum(correct) / len(correct) if correct else None
    curve = coverage_curve(conf, correct)
    delta = [a - b for a, b in zip(paired_new, paired_old)]
    report = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "corpus": n_own,
        # units 只算線上語料，跟歷史報告與 champion 同口徑；外部另列
        "units": sum(1 for u in units if not u["external"]),
        "dedup": dedup_stats,
        "external_units": {src: sum(1 for u in units if u["external"] and rows[u["rec"]].get("label_source") == src)
                           for src in ext_by_source},
        "external_weight": EXTERNAL_WEIGHT if ext_by_source else None,
        "records": n_rec,
        "by_type": by_type,
        "trainable": trainable_names,
        "trainable_params": n_train,
        "lora": {"r": args.lora_r, "targets": ["Wqkv", "Wo", "Wi"]} if args.lora else None,
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
        "live_gated": live_gated(oof_rows),
        "teacher_self": teacher_self_agreement(rows, live_gated(oof_rows)["qids"]),
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
                    w = torch.tensor([b["weight"] for b in batch], device=device)
                    loss = weighted_ce(logits, tgt.to(device), w, torch)
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(params, 1.0)
                    opt.step()
                    opt.zero_grad()
                    if device.type == "mps":
                        torch.mps.empty_cache()  # 每批 L 不同，MPS 替每種長度囤快取；不清的話 driver 一路長到 15GB
            model.eval()
            sd = {k: v.detach().cpu().contiguous() for k, v in model.state_dict().items()}
            if model.encoder is None:
                sd.update({k: v for k, v in load_file(str(base / "model.safetensors")).items()
                           if k.startswith("encoder.")})
            save_file(sd, str(out / "model.safetensors"))
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
