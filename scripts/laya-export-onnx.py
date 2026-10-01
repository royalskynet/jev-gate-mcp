#!/usr/bin/env python3
"""把 laya-train.py 訓好的 safetensors 導成 @receptron/laya 吃得下的 bundle。

訓練產物是 PyTorch 權重，推論端（gateway/src/laya-loader.js）只讀 ONNX bundle，
所以不導出就等於沒生效。產出的目錄形狀照 fetch-laya-bundle.mjs 組的那一份：

  <out>/laya.onnx           單一融合圖，輸出命名 logits / act_probs
  <out>/laya_config.json    max_len / head_max_len / temperature（填訓練擬出的溫度）
  <out>/tokenizer/          直接從來源 bundle 複製，不改

`act_probs` 這個名字是沿用上游：fetch-laya-bundle.mjs 對 int8 圖做的是純改名
（位元組長度不變，round-trip 驗證過），所以它裝的就是原始 act_logits，不是機率。
這裡直接把輸出命名成 act_probs，不加 sigmoid，否則語意會跟現行 bundle 不一致。

量化預設開（跟現行 bundle 一致，540MB vs fp32 1.3GB）。量化會動 logits，所以
一定要跑 parity：拿 corpus 的真實題目比對 torch 與 ONNX 的 logits，以及更重要的
argmax 是否一致——bundle 的用途是決策，差個 1e-2 不要緊，翻了選項才要緊。

  laya-export-onnx.py                 # 導出 + 量化 + parity
  laya-export-onnx.py --no-quantize   # 留 fp32，排除量化造成的差異
  laya-export-onnx.py --parity-n 64   # 多比幾題
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

HOME = Path.home()
DEFAULT_IN = Path(os.environ.get("JEV_LAYA_TRAINED_DIR", HOME / ".jevgate" / "laya-trained"))
DEFAULT_SRC = Path(os.environ.get("JEV_LAYA_FP_DIR", HOME / ".jevgate" / "laya-fp"))
DEFAULT_TOK = Path(os.environ.get("JEV_LAYA_MODEL_DIR", HOME / ".jevgate" / "laya-multilingual-int8"))
DEFAULT_OUT = Path(os.environ.get("JEV_LAYA_EXPORT_DIR", HOME / ".jevgate" / "laya-trained-onnx"))
CORPUS = Path(os.environ.get("JEV_TEACHER_CORPUS", HOME / ".jevgate" / "teacher-corpus.jsonl"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in-dir", default=str(DEFAULT_IN), help="laya-train.py --promote 的輸出")
    ap.add_argument("--src-dir", default=str(DEFAULT_SRC), help="官方 fp bundle（取 encoder 結構與 config）")
    ap.add_argument("--tokenizer-dir", default=str(DEFAULT_TOK), help="從哪個 bundle 複製 tokenizer/")
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--no-quantize", action="store_true", help="留 fp32，不做 int8 動態量化")
    ap.add_argument("--keep-fp32", default="layers.0,layers.1,scorer,act_head",
                    help="這些節點前綴留 fp32（決策層，量化會毀掉校準）；空字串=全量化")
    ap.add_argument("--parity-n", type=int, default=32, help="用幾題真實 corpus 比對 torch vs ONNX")
    ap.add_argument("--max-argmax-flips", type=int, default=0, help="容許幾題 argmax 翻掉（預設 0）")
    args = ap.parse_args()

    in_dir, src, out = Path(args.in_dir), Path(args.src_dir), Path(args.out_dir)
    for p in (in_dir / "model.safetensors", in_dir / "rl_agent_config.json", src / "encoder"):
        if not p.exists():
            print(f"缺 {p}", file=sys.stderr)
            return 1

    import numpy as np
    import torch
    from safetensors.torch import load_file
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model, build_sequence, render_options, QTYPES

    cfg = json.loads((in_dir / "rl_agent_config.json").read_text())
    model = build_model(cfg, encoder_dir=str(src / "encoder"))
    model.load_state_dict(load_file(str(in_dir / "model.safetensors")), strict=True)
    model.eval()
    # 導出一律在 CPU 上做：MPS 後端在 torch.onnx.export 的 tracing 下
    # 對部分算子會退回 CPU，混著跑只會讓 parity 數字難解釋。
    print(f"loaded {in_dir}  trained_units={cfg.get('trained_units')}")

    out.mkdir(parents=True, exist_ok=True)
    onnx_path = out / "laya.onnx"
    tmp_path = out / "laya.fp32.onnx"

    # 樣本輸入的形狀只決定 tracing，實際長度由 dynamic_axes 放開。
    B, L, K = 1, 32, 4
    sample = (
        torch.ones((B, L), dtype=torch.long),
        torch.ones((B, L), dtype=torch.long),
        torch.zeros((B, K), dtype=torch.long),
        torch.ones((B, K), dtype=torch.bool),
        torch.zeros((B,), dtype=torch.long),
    )
    t0 = time.time()
    torch.onnx.export(
        model, sample, str(tmp_path),
        input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"],
        # act_probs 是沿用上游的名字，裝的是 act_logits，不要在這裡加 sigmoid。
        output_names=["logits", "act_probs"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "marker_pos": {0: "batch", 1: "options"},
            "marker_mask": {0: "batch", 1: "options"},
            "qtype": {0: "batch"},
            "logits": {0: "batch", 1: "options"},
            "act_probs": {0: "batch"},
        },
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    print(f"exported fp32 {tmp_path.stat().st_size / 1e6:.0f}MB ({time.time() - t0:.0f}s)")

    if args.no_quantize:
        tmp_path.rename(onnx_path)
    else:
        import onnx
        from onnxruntime.quantization import quantize_dynamic, QuantType
        t0 = time.time()
        # 全圖 int8 量過一次，實測把閘門毀掉：T=0.80 的覆蓋率從 23.2% 掉到 9.2%、
        # 準確率 99.2%→93.9%。原因是決策層（head 兩層 + scorer + act_head，共 15M 參數）
        # 的 logit 尺度被量化搬動，而溫度是在 fp32 logits 上擬的。
        # 選擇性量化：體積幾乎全在 encoder（306.9M，133 個可量節點），
        # 決策層只有 20 個節點，留 fp32 幾乎不佔體積卻保住校準。
        g = onnx.load(str(tmp_path), load_external_data=False).graph
        keep = tuple(p for p in args.keep_fp32.split(",") if p)
        exclude = [n.name for n in g.node
                   if n.name and keep and any(s.startswith(keep) for s in n.name.split("/") if s)]
        print(f"留 fp32 的節點 {len(exclude)} 個（前綴 {','.join(keep) or '無'}）")
        quantize_dynamic(str(tmp_path), str(onnx_path), weight_type=QuantType.QInt8,
                         nodes_to_exclude=exclude)
        print(f"quantized int8 {onnx_path.stat().st_size / 1e6:.0f}MB ({time.time() - t0:.0f}s)")
        tmp_path.unlink()

    tok_src = Path(args.tokenizer_dir) / "tokenizer"
    if not tok_src.is_dir():
        print(f"缺 tokenizer 來源 {tok_src}", file=sys.stderr)
        return 1
    shutil.rmtree(out / "tokenizer", ignore_errors=True)
    shutil.copytree(tok_src, out / "tokenizer")

    # temperature 的順序必須對上 QTYPES 的索引，不是字典序。
    temps = cfg.get("temperature") or [1.0, 1.0, 1.0]
    (out / "laya_config.json").write_text(json.dumps({
        "max_len": cfg["max_len"],
        "head_max_len": cfg["head_max_len"],
        "temperature": temps,
        "temperature_by_options": cfg.get("temperature_by_options", {}),
    }, indent=1) + "\n")
    print(f"bundle → {out}")

    # ---- parity：torch vs ONNX，拿真實 corpus 題目
    if args.parity_n <= 0 or not CORPUS.exists():
        print("跳過 parity（--parity-n 0 或無 corpus）")
        return 0
    import onnxruntime as ort

    _fix_tokenizer_config(str(src))
    tk = AutoTokenizer.from_pretrained(src / "tokenizer")
    rows = []
    with open(CORPUS) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    items = []
    for r in rows:
        for qid, q in (r.get("questions") or {}).items():
            qq = {"t": q["type"], "ins": q["instructions"], "crit": q.get("criteria")}
            try:
                seq, markers = build_sequence(tk, r.get("state"), qq, cfg["max_len"], cfg["head_max_len"])
            except Exception:
                continue
            if len(markers) != len(render_options(qq)):
                continue
            items.append((seq, markers, QTYPES[q["type"]]))
            if len(items) >= args.parity_n:
                break
        if len(items) >= args.parity_n:
            break
    if not items:
        print("parity 無可用題目", file=sys.stderr)
        return 1

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    max_gap, flips = 0.0, []
    for i, (seq, markers, qt) in enumerate(items):
        ids = torch.tensor([seq], dtype=torch.long)
        am = torch.ones_like(ids)
        mp = torch.tensor([markers], dtype=torch.long)
        mm = torch.ones((1, len(markers)), dtype=torch.bool)
        qtv = torch.tensor([qt], dtype=torch.long)
        with torch.no_grad():
            t_logits, _ = model(ids, am, mp, mm, qtv)
        o_logits = sess.run(["logits"], {
            "input_ids": ids.numpy(), "attention_mask": am.numpy(),
            "marker_pos": mp.numpy(), "marker_mask": mm.numpy(),
            "qtype": qtv.numpy(),
        })[0]
        gap = float(np.abs(t_logits.numpy() - o_logits).max())
        max_gap = max(max_gap, gap)
        if int(t_logits.argmax()) != int(o_logits.argmax()):
            flips.append(i)

    print(f"parity n={len(items)}  max|Δlogit|={max_gap:.4f}  argmax 翻掉={len(flips)}/{len(items)}")
    if len(flips) > args.max_argmax_flips:
        print(f"parity 失敗：argmax 翻掉 {len(flips)} 題 > 容許 {args.max_argmax_flips}（題號 {flips[:10]}）",
              file=sys.stderr)
        print("量化改了決策。用 --no-quantize 導 fp32，或提高 --max-argmax-flips 並說明理由。",
              file=sys.stderr)
        return 1
    print("parity OK")
    print(f"\n要切過去：export JEV_LAYA_MODEL_DIR={out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
