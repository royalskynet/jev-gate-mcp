#!/usr/bin/env python3
"""評估一個 ONNX bundle 在 teacher corpus 上的表現，含覆蓋率曲線。

laya-export-onnx.py 的 parity 只看 argmax 有沒有翻，那不夠：溫度是在 torch
logits 上擬的，int8 動態量化會把 logit 尺度整體搬動，argmax 沒變但信心會錯，
而這個 bundle 唯一的用途就是「高信心時讓 Laya 接手」。所以要直接量化後的
bundle 自己跑一次覆蓋率曲線，拿它跟訓練時的 OOF 曲線比。

注意這裡的數字跟 laya-train.py 的 OOF 不同口徑：OOF 是每筆都由沒看過它的
fold 預測，這裡是同一份資料餵給「看過全部資料」的最終模型，所以會偏樂觀。
用途是比較「量化前 vs 量化後」的相對落差，不是宣告泛化能力。

  laya-eval-onnx.py                          # 評估預設導出目錄
  laya-eval-onnx.py --bundle <dir>
  laya-eval-onnx.py --bundle <dir> --limit 100
"""
import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

HOME = Path.home()
HERE = Path(__file__).resolve().parent


def load_train_module():
    """scripts/laya-train.py 檔名帶 dash，不能直接 import。"""
    spec = importlib.util.spec_from_file_location("laya_train", HERE / "laya-train.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bundle", default=os.environ.get(
        "JEV_LAYA_EXPORT_DIR", str(HOME / ".jevgate" / "laya-trained-onnx")))
    ap.add_argument("--src-dir", default=str(HOME / ".jevgate" / "laya-fp"),
                    help="取 tokenizer 修補用（_fix_tokenizer_config）")
    ap.add_argument("--corpus", default=os.environ.get(
        "JEV_TEACHER_CORPUS", str(HOME / ".jevgate" / "teacher-corpus.jsonl")))
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 題（0=全部）")
    args = ap.parse_args()

    bundle = Path(args.bundle)
    onnx_path = bundle / "laya.onnx"
    if not onnx_path.exists():
        print(f"缺 {onnx_path}", file=sys.stderr)
        return 1

    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_sequence, render_options, QTYPES

    T = load_train_module()
    cfg = json.loads((bundle / "laya_config.json").read_text())
    temps = cfg.get("temperature") or [1.0, 1.0, 1.0]
    # config 裡的 temperature 是 list，順序對齊 QTYPES 的索引。
    temp_by_qtype = {q: float(temps[i]) for q, i in QTYPES.items() if i < len(temps)}
    print(f"bundle {bundle.name}  {onnx_path.stat().st_size / 1e6:.0f}MB  temps={temp_by_qtype}")

    _fix_tokenizer_config(args.src_dir)
    tk = AutoTokenizer.from_pretrained(bundle / "tokenizer")
    units, skipped = T.build_units(T.load_cases(args.corpus))
    if args.limit:
        units = units[:args.limit]
    print(f"units={len(units)} skipped={skipped}")

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    conf, correct, pairs = [], [], []
    per_type = {}
    for u in units:
        q = u["question"]
        qq = {"t": q["type"], "ins": q["instructions"], "crit": q.get("criteria")}
        try:
            seq, markers = build_sequence(tk, u["state"], qq, cfg["max_len"], cfg["head_max_len"])
        except Exception:
            continue
        if len(markers) != len(render_options(qq)):
            continue
        ids = np.array([seq], dtype=np.int64)
        logits = sess.run(["logits"], {
            "input_ids": ids,
            "attention_mask": np.ones_like(ids),
            "marker_pos": np.array([markers], dtype=np.int64),
            "marker_mask": np.ones((1, len(markers)), dtype=bool),
            "qtype": np.array([QTYPES[q["type"]]], dtype=np.int64),
        })[0][0]
        lg = logits / temp_by_qtype.get(u["qtype"], 1.0)
        lg = lg - lg.max()
        p = np.exp(lg)
        p = (p / p.sum()).tolist()
        ok = T.pred_matches(u["qtype"], int(np.argmax(p)), p, u["truth"])
        if ok is None:
            continue
        conf.append(max(p))
        correct.append(bool(ok))
        d = per_type.setdefault(u["qtype"], [0, 0])
        d[0] += bool(ok)
        d[1] += 1
        b = T.baseline_correct(u)
        if b is not None:
            pairs.append(bool(ok) - bool(b))

    if not correct:
        print("無可評估題目", file=sys.stderr)
        return 1
    acc = sum(correct) / len(correct)
    print(f"\naccuracy {acc * 100:.1f}%  (n={len(correct)})")
    for qt, (c, n) in sorted(per_type.items()):
        print(f"  {qt:6s} {c}/{n} = {c / n * 100:.1f}%")
    if pairs:
        lo, hi = T.boot_ci(pairs)
        print(f"vs int8 基線（配對，n={len(pairs)}）: "
              f"{sum(pairs) / len(pairs) * 100:+.1f}pp, 95% CI [{lo * 100:+.1f}, {hi * 100:+.1f}]pp")
    print(f"ECE {T.ece(conf, correct):.3f}")
    for row in T.coverage_curve(conf, correct):
        if row["accuracy"] is None:
            print(f"T={row['threshold']:.2f}  coverage=  0.0%  n=   0  accuracy=   n/a")
            continue
        lo, hi = row["ci"]
        print(f"T={row['threshold']:.2f}  coverage={row['coverage'] * 100:5.1f}%  n={row['n']:4d}  "
              f"accuracy={row['accuracy'] * 100:5.1f}%  [{lo * 100:.1f}, {hi * 100:.1f}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
