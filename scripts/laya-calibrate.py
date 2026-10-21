#!/usr/bin/env python3
"""Laya 接手白名單校準：每個 (caller, 題族) 求一個本機可接手的信心門檻。

資料：routing-samples.jsonl 的 shadow 列（laya-routing.js 在雲端題旁跑本機推論，
同一筆記下本機答案、信心與老師答案）。這是唯一從「本機 lane 真的會收的流量」抽的
樣本；訓練 OOF 是夜訓抽樣（難題優先、每族封頂），不代表上線流量。

判準（Jung et al. "Trust or Escalate" 的 fixed-sequence testing，LTT 多起點版）：
  門檻格 0.99 → 0.50 由高往低，每格取信心 ≥ t 的列，one-sided Clopper–Pearson
  下界 ≥ 1-α 才算過；**首敗即停**，之後的格子再過也不准開；樣本不足就是失敗，不跳過。
  起點 STARTS 事先固定（不看資料），每個起點各走一條序列、各用 δ/|STARTS|，
  取所有起點中過的最低門檻；整體錯誤率仍控制在 δ（Angelopoulos et al. 2021
  "Learn then Test" §fixed sequence, multi-start）。單一起點 0.99 時，溫度校準後信心
  幾乎不到 0.75，0.99 那格永遠 n=0 → 首格即停，白名單結構上永遠空（10-14 實測三族全卡）。
  另要求 ≥ MIN_REQUESTS 筆不同 request：同一 request 的題目相關（compact 一次 80 題），
  逐題計數的 CP 會高估有效樣本。
  ponytail: 逐題 CP＋request 下限是近似；要嚴謹改成以 request 為群的 cluster bootstrap 下界。

正確與否：choice/score 用 laya-train.py 的 baseline_correct 比硬答案；noul 看本機與老師
是否落在決策線（DECISION_LINE）同側，不用容差 0.2（老師近常數時會假過閘，10-20）。

輸出 ~/.jevgate/laya-whitelist.json；router 只在 JEV_LAYA_WHITELIST=live 時讀它。
  laya-calibrate.py [--samples PATH] [--out PATH] [--days 14]
  laya-calibrate.py --selftest
"""
import argparse
import importlib.util
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path.home()
ALPHA = 0.10           # 容許錯誤率：本機接手題與老師不一致的比例上限
DELTA = 0.05           # CP 下界的單側信心 1-δ
MIN_REQUESTS = 20
GRID = [round(0.99 - i * 0.01, 2) for i in range(50)]  # 0.99 … 0.50
STARTS = (0.99, 0.80, 0.65)  # 事先固定的序列起點；改動要在看新一輪資料之前
# noul 的對錯看決策線兩側，不看數值差：老師 noul 幾乎是常數時（result_t# 中位 0.12、
# wrong_reading_costly 0.25），|差|<0.2 讓「一律答常數」準確率 0.99+，本機假過閘（10-20 實測）。
# 線＝caller 實際的決策門檻（route-judge.mjs:209 `noul > 0.5`）；不同的按 (caller, 族) 覆寫。
DECISION_LINE = {"default": 0.5}
CHAMP = HOME / ".jevgate" / "laya-champion.json"
# 進化速度：每晚各題族 lb 追加一行；未過閘的族連 STALL_NIGHTS 晚沒漲過 STALL_EPS 就列 stalled，
# laya-train.py 的接手配額會把它降成底量、名額讓給還在漲的族。
# ponytail: 換 champion 後窗口重算，lb 可能整體下跌，會誤判一次停滯；要精準就按 since_champion 分段比。
HISTORY = Path(os.environ.get("JEV_LAYA_LB_HISTORY", str(HOME / ".jevgate" / "laya-lb-history.jsonl")))
STALL_NIGHTS = 3
STALL_EPS = 0.005
# 斷流：Jev 用量裡呼叫多、卻 DARK_DAYS 天沒有任何 shadow／replay 列的 caller——它的流量從沒進
# Laya，白名單永遠給不出 lb（10-20 route-judge 一週 753 次 Jev、0 列，沒人發現）。
# 略過：探針、測試，以及 cascade-server 對 Jev 的二次計量（同一呼叫已記成 cascade:<caller>）。
USAGE = Path(os.environ.get("JEV_USAGE_LOG", str(HOME / ".jevgate" / "usage.jsonl")))
DARK_DAYS = 7
DARK_MIN_CALLS = 100
# 同一條流量的舊名：route-judge 10-20 前直打（gateway:）、重放列也用舊名；B 起走 cascade。
# 讀列與斷流檢查都先換成新名，lb 合併算，舊用量也不會被當成斷流。不改歷史檔。
CALLER_ALIAS = {"gateway:route-judge": "cascade:route-judge"}
DARK_IGNORE = re.compile(os.environ.get("JEV_LAYA_DARK_IGNORE", r"probe|\.test$|^gateway:cascade-server$|^gateway:zen-"))


def _train():
    spec = importlib.util.spec_from_file_location("laya_train", HERE / "laya-train.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _log_binom_pmf(i, n, p):
    return (math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1)
            + i * math.log(p) + (n - i) * math.log1p(-p))


def binom_sf(k, n, p):
    """P(X ≥ k), X ~ Bin(n, p)。"""
    if k <= 0:
        return 1.0
    if p <= 0:
        return 0.0
    if p >= 1:
        return 1.0
    return min(1.0, sum(math.exp(_log_binom_pmf(i, n, p)) for i in range(k, n + 1)))


def cp_lower(k, n, delta=DELTA):
    """one-sided Clopper–Pearson 下界：使 P(X ≥ k | p) = δ 的 p（= Beta(δ; k, n-k+1)）。"""
    if n == 0 or k == 0:
        return 0.0
    lo, hi = 0.0, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if binom_sf(k, n, mid) < delta:
            lo = mid
        else:
            hi = mid
    return lo


def certify(rows, alpha=ALPHA, delta=DELTA, min_requests=MIN_REQUESTS, grid=GRID, starts=STARTS):
    """rows: [(conf, correct, request_id[, label])]。回 (threshold or None, 過的那格或最後起點的失敗統計)。

    有 label（老師的硬答案）時另要求 lb > 同一批 kept 列「一律答最多數 label」的準確率：
    下界贏不過常數，代表本機沒帶來資訊，接手等於回常數。"""
    starts = [s for s in starts if s in grid] or [grid[0]]
    d = delta / len(starts)
    best, last = None, None
    for s in starts:
        for t in grid[grid.index(s):]:
            kept = [r for r in rows if r[0] >= t]
            n, k = len(kept), sum(1 for r in kept if r[1])
            reqs = len({r[2] for r in kept})
            lb = cp_lower(k, n, d)
            labels = [r[3] for r in kept if len(r) > 3 and r[3] is not None]
            const = max(labels.count(x) for x in set(labels)) / len(labels) if labels else 0.0
            last = {"threshold": t, "n": n, "correct": k, "requests": reqs, "lb": round(lb, 4),
                    "constant": round(const, 4)}
            if reqs < min_requests or lb < 1 - alpha or lb <= const:
                last["reason"] = "requests" if reqs < min_requests else "lb" if lb < 1 - alpha else "constant"
                break
            if best is None or t < best["threshold"]:
                best = dict(last)
    return (best["threshold"] if best else None), (best or last)


def decision_line(caller, fam):
    return DECISION_LINE.get((caller, fam), DECISION_LINE["default"])


def noul_side(local, truth, line):
    """noul 對錯＝本機與老師落在決策線同側（caller 用 `noul > line` 做決定）。回 (ok, 老師側)。"""
    p = local.get("noul") if isinstance(local, dict) else None
    if p is None or truth is None:
        return None, None
    return (float(p) > line) == (truth > line), truth > line


def load_rows(path, days, now, T, not_before=None, seen=None):
    """shadow 列 → {(caller, family): {"qtype", "rows": [(conf, correct, request_id)]}}。

    not_before＝現役 bundle 上線時間：換版後溫度與權重都變，舊 bundle 的信心不能拿來
    校準新 bundle（shadow 列的 local_model 只寫 "laya"，沒有指紋，只能用時間切）。
    seen（dict）：不管窗口，記每個 caller 最後一筆 shadow 列的時間，給斷流檢查用。"""
    since = now - timedelta(days=days)
    if not_before and not_before > since:
        since = not_before
    groups, skipped = {}, 0
    for r in T.load_cases(path):
        if not r.get("shadow") or not r.get("caller"):
            continue
        r["caller"] = CALLER_ALIAS.get(r["caller"], r["caller"])
        try:
            ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        except (KeyError, ValueError, AttributeError):
            skipped += 1
            continue
        if seen is not None and (r["caller"] not in seen or ts > seen[r["caller"]]):
            seen[r["caller"]] = ts
        if ts < since:
            continue
        q, conf = r.get("question") or {}, r.get("local_confidence")
        teacher = r.get("teacher_answer")
        fam = r.get("family") or T._family(r.get("question_id"))
        truth = T.teacher_hard(q, teacher) if isinstance(teacher, dict) else None
        if q.get("type") == "noul":
            ok, label = noul_side(r.get("local_answer"), truth, decision_line(r["caller"], fam))
        else:
            ok = T.baseline_correct({"baseline": r.get("local_answer"), "truth": truth,
                                     "qtype": q.get("type"), "question": q})
            label = truth
        if ok is None or not isinstance(conf, (int, float)):
            skipped += 1
            continue
        g = groups.setdefault((r["caller"], fam), {"qtype": q.get("type"), "rows": []})
        g["rows"].append((float(conf), bool(ok), r.get("request_id") or r.get("id"), label))
    return groups, skipped


def champion_promoted_at(path=None):
    try:
        s = json.loads(Path(path or os.environ.get("JEV_LAYA_CHAMPION", CHAMP)).read_text())["promoted_at"]
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def fam_summary(entries, rejected):
    """{題族: {lb, requests, ok}}：同族多個 caller 時 requests 加總、lb 取 requests 最多那筆。"""
    out = {}
    for ok, recs in ((True, entries), (False, rejected)):
        for r in recs:
            f = out.setdefault(r["family"], {"lb": None, "requests": 0, "ok": False, "_top": -1})
            f["requests"] += r.get("requests") or 0
            f["ok"] = f["ok"] or ok
            if (r.get("requests") or 0) > f["_top"]:
                f["_top"], f["lb"] = r.get("requests") or 0, r.get("lb")
    for f in out.values():
        f.pop("_top")
    return out


def stalled(history, nights=STALL_NIGHTS, eps=STALL_EPS):
    """最近 nights+1 晚都有紀錄、仍未過閘、lb 沒比 nights 晚前高 eps 以上的題族。紀錄不足不判。"""
    if len(history) < nights + 1:
        return []
    old, new = history[-nights - 1]["families"], history[-1]["families"]
    out = []
    for fam, f in new.items():
        o = old.get(fam)
        if f.get("ok") or o is None or f.get("lb") is None or o.get("lb") is None:
            continue
        if all(fam in h["families"] for h in history[-nights - 1:]) and f["lb"] < o["lb"] + eps:
            out.append(fam)
    return sorted(out)


def dark_callers(seen, now, usage=None, days=DARK_DAYS, min_calls=DARK_MIN_CALLS, ignore=DARK_IGNORE):
    """近 days 天打 Jev ≥ min_calls 次、同期沒有任何 shadow 列的 caller（排序）。"""
    since = now - timedelta(days=days)
    calls = {}
    path = Path(usage or USAGE)
    if not path.exists():
        return []
    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line)
                ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
            except (ValueError, KeyError, AttributeError, TypeError):
                continue
            c = CALLER_ALIAS.get(r.get("caller"), r.get("caller"))
            if c and ts >= since and not ignore.search(c):
                calls[c] = calls.get(c, 0) + 1
    return sorted(c for c, n in calls.items() if n >= min_calls and not (seen.get(c) and seen[c] >= since))


def read_history(path=None):
    path = Path(path or HISTORY)
    rows = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default=os.environ.get("JEV_ROUTING_LOG", str(HOME / ".jevgate" / "routing-samples.jsonl")))
    ap.add_argument("--out", default=os.environ.get("JEV_LAYA_WHITELIST_FILE", str(HOME / ".jevgate" / "laya-whitelist.json")))
    ap.add_argument("--days", type=int, default=int(os.environ.get("JEV_LAYA_CALIB_DAYS", "14")))
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    T = _train()
    now = datetime.now(timezone.utc)
    champ_at = champion_promoted_at()
    seen = {}
    groups, skipped = load_rows(a.samples, a.days, now, T, champ_at, seen) if Path(a.samples).exists() else ({}, 0)
    entries, rejected = [], []
    for (caller, fam), g in sorted(groups.items()):
        thr, stat = certify(g["rows"])
        rec = {"caller": caller, "family": fam, "qtype": g["qtype"], "units": len(g["rows"]), **stat}
        (entries if thr is not None else rejected).append(rec)
    out = {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "alpha": ALPHA, "delta": DELTA,
           "min_requests": MIN_REQUESTS, "window_days": a.days, "skipped": skipped,
           "starts": list(STARTS), "since_champion": champ_at.strftime("%Y-%m-%dT%H:%M:%SZ") if champ_at else None,
           "entries": entries, "rejected": rejected}
    hist = read_history() + [{"generated": out["generated"], "families": fam_summary(entries, rejected)}]
    out["stalled"] = stalled(hist)
    out["dark"] = dark_callers(seen, now)
    with open(HISTORY, "a") as f:
        f.write(json.dumps(hist[-1], ensure_ascii=False) + "\n")
    tmp = Path(a.out + ".tmp")
    tmp.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(a.out)
    print(f"whitelist {len(entries)} 族／未過 {len(rejected)} 族／略過 {skipped} 列 → {a.out}")
    for fam, f in sorted(hist[-1]["families"].items()):
        if not f["ok"]:
            trend = [h["families"].get(fam, {}).get("lb") for h in hist[-STALL_NIGHTS - 1:]]
            print(f"lb {fam}: " + " → ".join("-" if x is None else f"{x:.3f}" for x in trend))
    if out["stalled"]:
        print(f"停滯 {STALL_NIGHTS} 晚未漲：{', '.join(out['stalled'])}（接手配額降為底量）")
    if out["dark"]:
        print(f"斷流 {DARK_DAYS} 天無 shadow 列：{', '.join(out['dark'])}（流量沒進 Laya，白名單給不出 lb）")
    return 0


def selftest():
    # CP：k=n 時下界有封閉解 δ^(1/n)；29/29 是 δ=0.05、α=0.10 下最少要幾筆全對。
    assert abs(cp_lower(29, 29) - 0.05 ** (1 / 29)) < 1e-6
    assert cp_lower(28, 28) < 0.90 <= cp_lower(29, 29)
    try:
        from scipy.stats import beta
        for k, n in [(97, 100), (385, 385), (50, 60), (1, 3)]:
            assert abs(cp_lower(k, n) - beta.ppf(DELTA, k, n - k + 1)) < 1e-6, (k, n)
    except ImportError:
        pass

    def rows(spec):
        # spec: [(conf, n_correct, n_wrong)]，每列一個獨立 request
        out, i = [], 0
        for conf, good, bad in spec:
            for ok in [True] * good + [False] * bad:
                out.append((conf, ok, f"r{i}"))
                i += 1
        return out

    # 全對且量足：一路過到最低格。
    thr, st = certify(rows([(0.995, 200, 0)]), grid=[0.99, 0.9, 0.8])
    assert thr == 0.8 and st["lb"] >= 0.9, (thr, st)
    # 首敗即停（單起點）：0.99 這格只有 5 筆（小樣本＝失敗），低門檻全對也不准開。
    thr, st = certify(rows([(0.995, 5, 0), (0.85, 300, 0)]), grid=[0.99, 0.9, 0.8], starts=(0.99,))
    assert thr is None and st["threshold"] == 0.99 and st["reason"] == "requests", st
    # 多起點：0.80 起點自己走一條序列（δ/2），可以過；0.99 那條仍然首格即停。
    thr, st = certify(rows([(0.995, 5, 0), (0.85, 300, 0)]), grid=[0.99, 0.9, 0.8], starts=(0.99, 0.80))
    assert thr == 0.8 and st["n"] == 305, (thr, st)
    # 多起點不放寬下界：δ 被均分，29/29 單起點剛好過、雙起點就不過。
    assert certify(rows([(0.7, 29, 0)]), grid=[0.7], min_requests=1, starts=(0.7,))[0] == 0.7
    assert certify(rows([(0.7, 29, 0)]), grid=[0.99, 0.7], min_requests=1, starts=(0.99, 0.7))[0] is None
    # 現實分佈：信心全在 0.5–0.7、量足且全對 → 預設起點要能過（10-14 前結構上永遠空）。
    thr, st = certify(rows([(0.66, 150, 0)]))
    assert thr == 0.5, (thr, st)
    # 高門檻過、往下混進錯題後下界跌破 → 停在最後一格過的門檻。
    thr, st = certify(rows([(0.995, 100, 0), (0.85, 20, 40)]), grid=[0.99, 0.9, 0.8])
    assert thr == 0.9, (thr, st)
    # 正確率 92% 但下界不到 0.90：不過（不是拿點估計判）。
    thr, st = certify(rows([(0.995, 46, 4)]), grid=[0.99])
    assert thr is None and st["reason"] == "lb", st
    # request 數不足：60 題全對但只來自 3 個 request（compact 一次多題）→ 不過。
    same = [(0.995, True, f"r{i % 3}") for i in range(60)]
    thr, st = certify(same, grid=[0.99])
    assert thr is None and st["reason"] == "requests", st
    # 常數對照：老師 200 題全 false、本機也全答 false → 下界 <1＝常數準確率，不過（10-20 result_t#）。
    flat = [(0.9, True, f"r{i}", False) for i in range(200)]
    thr, st = certify(flat, grid=[0.9])
    assert thr is None and st["reason"] == "constant" and st["constant"] == 1.0, st
    # 老師 true/false 各半、本機全對 → 下界遠高於常數 0.5，過。
    mixed = [(0.9, True, f"r{i}", i % 2 == 0) for i in range(200)]
    thr, st = certify(mixed, grid=[0.9])
    assert thr == 0.9 and st["constant"] == 0.5, st
    # noul 判準看決策線兩側：老師 0.12、本機 0.40 同側算對；老師 0.6、本機 0.45 不同側算錯。
    assert noul_side({"noul": 0.40}, 0.12, 0.5) == (True, False)
    assert noul_side({"noul": 0.45}, 0.6, 0.5) == (False, True)
    assert noul_side({"noul": 0.45}, None, 0.5) == (None, None)

    # load_rows：只收 shadow＋有 caller、窗外丟、判準走 baseline_correct。
    import tempfile
    T = _train()
    now = datetime(2026, 10, 20, tzinfo=timezone.utc)
    nq = {"type": "noul", "instructions": "x"}
    lines = [
        {"shadow": True, "caller": "cascade:compact", "family": "result_t#", "question": nq, "request_id": "a",
         "ts": "2026-10-19T00:00:00Z", "local_confidence": 0.9, "local_answer": {"type": "noul", "noul": 0.9},
         "teacher_answer": {"type": "noul", "noul": 0.8}},
        {"shadow": True, "caller": "cascade:compact", "family": "result_t#", "question": nq, "request_id": "b",
         "ts": "2026-10-19T00:00:00Z", "local_confidence": 0.9, "local_answer": {"type": "noul", "noul": 0.9},
         "teacher_answer": {"type": "noul", "noul": 0.1}},
        {"shadow": True, "caller": "cascade:compact", "family": "result_t#", "question": nq, "request_id": "c",
         "ts": "2026-09-01T00:00:00Z", "local_confidence": 0.9, "local_answer": {"type": "noul", "noul": 0.9},
         "teacher_answer": {"type": "noul", "noul": 0.9}},
        {"caller": "cascade:compact", "question": nq, "ts": "2026-10-19T00:00:00Z",
         "local_confidence": 0.9, "local_answer": {"type": "noul", "noul": 0.9}, "teacher_answer": {"type": "noul", "noul": 0.9}},
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(x) for x in lines) + "\n")
    g, _ = load_rows(f.name, 14, now, T)
    os.unlink(f.name)
    assert list(g) == [("cascade:compact", "result_t#")], g
    assert g[("cascade:compact", "result_t#")]["rows"] == [(0.9, True, "a", True), (0.9, False, "b", False)], g
    # 換版後只收新 bundle 的列：not_before 晚於窗口起點就以它為準。
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(x) for x in lines) + "\n")
    g, _ = load_rows(f.name, 14, now, T, datetime(2026, 10, 19, 12, tzinfo=timezone.utc))
    os.unlink(f.name)
    assert g == {}, g
    # 進化速度：同族多 caller 合併；連 3 晚沒漲＝停滯，有漲、已過閘、紀錄不足都不算
    fs = fam_summary([{"family": "a", "requests": 5, "lb": 0.95}],
                     [{"family": "b", "requests": 1, "lb": 0.5}, {"family": "b", "requests": 9, "lb": 0.8}])
    assert fs == {"a": {"lb": 0.95, "requests": 5, "ok": True}, "b": {"lb": 0.8, "requests": 10, "ok": False}}, fs
    h = lambda lb_b, lb_c: {"families": {"a": {"lb": 0.95, "ok": True}, "b": {"lb": lb_b, "ok": False},
                                         "c": {"lb": lb_c, "ok": False}}}
    hs = [h(0.80, 0.40), h(0.81, 0.40), h(0.80, 0.44), h(0.802, 0.46)]
    assert stalled(hs) == ["b"], stalled(hs)
    assert stalled(hs[1:]) == [], "紀錄不足不判"
    # 斷流：量大且 7 天無 shadow 列才報；有新列、量小、在略過名單、只有舊列（超過 7 天）各自分開驗。
    use = [{"caller": c, "ts": "2026-10-19T00:00:00Z"} for c, n in
           [("gateway:route-judge", 120), ("cascade:compact", 120), ("cli:x", 5),
            ("gateway:cascade-server", 500), ("gateway:old", 150)] for _ in range(n)]
    use.append({"caller": "gateway:route-judge", "ts": "bad"})
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(x) for x in use) + "\n")
    seen = {"cascade:compact": datetime(2026, 10, 18, tzinfo=timezone.utc),
            "gateway:old": datetime(2026, 10, 1, tzinfo=timezone.utc)}
    assert dark_callers(seen, now, f.name) == ["cascade:route-judge", "gateway:old"], dark_callers(seen, now, f.name)
    # 舊名用量算到新名頭上：新名有近期 shadow 列就不是斷流。
    seen["cascade:route-judge"] = datetime(2026, 10, 18, tzinfo=timezone.utc)
    assert dark_callers(seen, now, f.name) == ["gateway:old"], dark_callers(seen, now, f.name)
    os.unlink(f.name)
    # load_rows 的 seen 不受窗口限制：窗外的列也記到（c 在 09-01，窗外）。
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(x) for x in lines) + "\n")
    seen = {}
    load_rows(f.name, 14, now, T, seen=seen)
    os.unlink(f.name)
    assert seen == {"cascade:compact": datetime(2026, 10, 19, tzinfo=timezone.utc)}, seen
    # 別名：重放舊名與線上新名進同一組。
    rj = [dict(lines[0], caller=c, family="tier", request_id=c) for c in ("gateway:route-judge", "cascade:route-judge")]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(x) for x in rj) + "\n")
    g, _ = load_rows(f.name, 14, now, T)
    os.unlink(f.name)
    assert list(g) == [("cascade:route-judge", "tier")] and len(g[("cascade:route-judge", "tier")]["rows"]) == 2, g
    print("selftest ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
