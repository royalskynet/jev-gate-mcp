#!/usr/bin/env python3
"""Laya 接手白名單校準：每個 (caller, 題族) 求一個本機可接手的信心門檻。

資料：routing-samples.jsonl 的 shadow 列（laya-routing.js 在雲端題旁跑本機推論，
同一筆記下本機答案、信心與老師答案）。這是唯一從「本機 lane 真的會收的流量」抽的
樣本；訓練 OOF 是夜訓抽樣（難題優先、每族封頂），不代表上線流量。

判準（Jung et al. "Trust or Escalate" 的 fixed-sequence testing）：
  門檻格 0.99 → 0.50 由高往低，每格取信心 ≥ t 的列，one-sided Clopper–Pearson
  下界（信心 1-δ）≥ 1-α 才算過；**首敗即停**，之後的格子再過也不准開；樣本不足就是
  失敗，不跳過。固定順序逐一檢定，整條序列的錯誤率仍控制在 δ，不需多重比較校正。
  另要求 ≥ MIN_REQUESTS 筆不同 request：同一 request 的題目相關（compact 一次 80 題），
  逐題計數的 CP 會高估有效樣本。
  ponytail: 逐題 CP＋request 下限是近似；要嚴謹改成以 request 為群的 cluster bootstrap 下界。

正確與否用 laya-train.py 的 baseline_correct（noul 容差 0.2、choice/score 比硬答案），
與夜訓、同卷配對閘同一套判準。

輸出 ~/.jevgate/laya-whitelist.json；router 只在 JEV_LAYA_WHITELIST=live 時讀它。
  laya-calibrate.py [--samples PATH] [--out PATH] [--days 14]
  laya-calibrate.py --selftest
"""
import argparse
import importlib.util
import json
import math
import os
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


def certify(rows, alpha=ALPHA, delta=DELTA, min_requests=MIN_REQUESTS, grid=GRID):
    """rows: [(conf, correct, request_id)]。回 (threshold or None, 最後一格的統計)。"""
    best, last = None, None
    for t in grid:
        kept = [r for r in rows if r[0] >= t]
        n, k = len(kept), sum(1 for r in kept if r[1])
        reqs = len({r[2] for r in kept})
        lb = cp_lower(k, n, delta)
        last = {"threshold": t, "n": n, "correct": k, "requests": reqs, "lb": round(lb, 4)}
        if reqs < min_requests or lb < 1 - alpha:
            last["reason"] = "requests" if reqs < min_requests else "lb"
            break
        best = dict(last)
    return (best["threshold"] if best else None), (best or last)


def load_rows(path, days, now, T):
    """shadow 列 → {(caller, family): {"qtype", "rows": [(conf, correct, request_id)]}}。"""
    since = now - timedelta(days=days)
    groups, skipped = {}, 0
    for r in T.load_cases(path):
        if not r.get("shadow") or not r.get("caller"):
            continue
        try:
            ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        except (KeyError, ValueError, AttributeError):
            skipped += 1
            continue
        if ts < since:
            continue
        q, conf = r.get("question") or {}, r.get("local_confidence")
        teacher = r.get("teacher_answer")
        truth = T.teacher_hard(q, teacher) if isinstance(teacher, dict) else None
        ok = T.baseline_correct({"baseline": r.get("local_answer"), "truth": truth,
                                 "qtype": q.get("type"), "question": q})
        if ok is None or not isinstance(conf, (int, float)):
            skipped += 1
            continue
        g = groups.setdefault((r["caller"], r.get("family") or T._family(r.get("question_id"))),
                              {"qtype": q.get("type"), "rows": []})
        g["rows"].append((float(conf), bool(ok), r.get("request_id") or r.get("id")))
    return groups, skipped


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
    groups, skipped = load_rows(a.samples, a.days, now, T) if Path(a.samples).exists() else ({}, 0)
    entries, rejected = [], []
    for (caller, fam), g in sorted(groups.items()):
        thr, stat = certify(g["rows"])
        rec = {"caller": caller, "family": fam, "qtype": g["qtype"], "units": len(g["rows"]), **stat}
        (entries if thr is not None else rejected).append(rec)
    out = {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "alpha": ALPHA, "delta": DELTA,
           "min_requests": MIN_REQUESTS, "window_days": a.days, "skipped": skipped,
           "entries": entries, "rejected": rejected}
    tmp = Path(a.out + ".tmp")
    tmp.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(a.out)
    print(f"whitelist {len(entries)} 族／未過 {len(rejected)} 族／略過 {skipped} 列 → {a.out}")
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
    # 首敗即停：0.99 這格只有 5 筆（小樣本＝失敗），就算低門檻有大量全對也不准開。
    thr, st = certify(rows([(0.995, 5, 0), (0.85, 300, 0)]), grid=[0.99, 0.9, 0.8])
    assert thr is None and st["threshold"] == 0.99 and st["reason"] == "requests", st
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
    assert g[("cascade:compact", "result_t#")]["rows"] == [(0.9, True, "a"), (0.9, False, "b")], g
    print("selftest ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
