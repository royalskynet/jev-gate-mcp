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
import atexit
import gc
import json
import multiprocessing
import os
import pickle
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from laya_state import laya_state  # noqa: E402  逐題裁切，鏡像 gateway/src/laya-state.js

HOME = Path.home()
DEFAULT_IN = Path(os.environ.get("JEV_LAYA_TRAINED_DIR", HOME / ".jevgate" / "laya-trained"))
DEFAULT_SRC = Path(os.environ.get("JEV_LAYA_FP_DIR", HOME / ".jevgate" / "laya-fp"))
DEFAULT_TOK = Path(os.environ.get("JEV_LAYA_MODEL_DIR", HOME / ".jevgate" / "laya-multilingual-int8"))
DEFAULT_OUT = Path(os.environ.get("JEV_LAYA_EXPORT_DIR", HOME / ".jevgate" / "laya-trained-onnx"))
CORPUS = Path(os.environ.get("JEV_TEACHER_CORPUS", HOME / ".jevgate" / "teacher-corpus.jsonl"))


def _torch_stage(in_dir, src, tmp_path, refs_path, do_parity, parity_n, keep_qids):
    """子行程：載 torch 模型、導出 fp32 ONNX、算 parity 參考 logits（pickle 到 refs_path）。"""
    import torch
    from safetensors.torch import load_file
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model, build_sequence, render_options, QTYPES

    in_dir, src, tmp_path = Path(in_dir), Path(src), Path(tmp_path)
    cfg = json.loads((in_dir / "rl_agent_config.json").read_text())
    model = build_model(cfg, encoder_dir=str(src / "encoder"))
    model.load_state_dict(load_file(str(in_dir / "model.safetensors")), strict=True)
    model.eval()
    # 導出一律在 CPU 上做：MPS 後端在 torch.onnx.export 的 tracing 下
    # 對部分算子會退回 CPU，混著跑只會讓 parity 數字難解釋。
    print(f"loaded {in_dir}  trained_units={cfg.get('trained_units')}", flush=True)

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
    print(f"exported fp32 {tmp_path.stat().st_size / 1e6:.0f}MB ({time.time() - t0:.0f}s)", flush=True)

    refs = []
    if do_parity:
        _fix_tokenizer_config(str(src))
        tk = AutoTokenizer.from_pretrained(src / "tokenizer")
        with open(CORPUS) as f:  # 逐行讀、夠題就停，不把整份 corpus 載進來
            for line in f:
                if len(refs) >= parity_n:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for qid, q in (r.get("questions") or {}).items():
                    if keep_qids and qid not in keep_qids:
                        continue
                    qq = {"t": q["type"], "ins": q["instructions"], "crit": q.get("criteria")}
                    try:
                        seq, markers = build_sequence(tk, laya_state(r.get("state"), qid), qq, cfg["max_len"], cfg["head_max_len"])
                    except Exception:
                        continue
                    if len(markers) != len(render_options(qq)):
                        continue
                    ids = torch.tensor([seq], dtype=torch.long)
                    am = torch.ones_like(ids)
                    mp = torch.tensor([markers], dtype=torch.long)
                    mm = torch.ones((1, len(markers)), dtype=torch.bool)
                    qtv = torch.tensor([QTYPES[q["type"]]], dtype=torch.long)
                    with torch.no_grad():
                        t_logits, _ = model(ids, am, mp, mm, qtv)
                    refs.append(({"input_ids": ids.numpy(), "attention_mask": am.numpy(),
                                  "marker_pos": mp.numpy(), "marker_mask": mm.numpy(),
                                  "qtype": qtv.numpy()}, t_logits.numpy()))
                    if len(refs) >= parity_n:
                        break
    with open(refs_path, "wb") as f:
        pickle.dump(refs, f)


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
    # 本機只答 live_gated 那幾題，其餘題（如 jev-route 的 tier/route）一律交雲端。
    # 拿那些題比 argmax 等於替不會上線的決策把關：10-03、10-05 都因此被 1/32 翻轉擋下導出。
    ap.add_argument("--parity-warn-only", action="store_true",
                    help="翻轉超過容許只警告照樣導出；呼叫端必須另有對老師答案的閘（nightly 的同卷配對）")
    ap.add_argument("--parity-qids", default="", help="只拿這些題目（逗號分隔）比對；空字串=全部題")
    args = ap.parse_args()

    in_dir, src, out = Path(args.in_dir), Path(args.src_dir), Path(args.out_dir)
    for p in (in_dir / "model.safetensors", in_dir / "rl_agent_config.json", src / "encoder"):
        if not p.exists():
            print(f"缺 {p}", file=sys.stderr)
            return 1

    cfg = json.loads((in_dir / "rl_agent_config.json").read_text())

    # 導出一律建在 staging，最後才換進 out。out 是 gateway 上線讀的目錄，
    # 原地覆蓋的話中途被砍（SIGTERM 發生過一次）會留下半截 laya.onnx，
    # 或是 tokenizer/ 已刪未補的 bundle，直接讓 gateway 載不起來。
    staging = out.with_name(out.name + ".new")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    # 任何沒走到 commit() 的出口（parity 失敗、缺 tokenizer、例外）都要清掉 staging，
    # 否則 548MB 的半成品會一直留在磁碟上（10-06 parity 翻 1 題留下 laya-trained-onnx.new）。
    # commit() 會把 staging rename 走，這裡就變成 no-op。
    atexit.register(shutil.rmtree, staging, ignore_errors=True)
    onnx_path = staging / "laya.onnx"
    tmp_path = staging / "laya.fp32.onnx"
    refs_path = staging / "parity-refs.pkl"

    # torch 段（載模型、導出 fp32、算 parity 的 torch 參考答案）放子行程跑。
    # 10-13 實測：同一行程裡 del model 之後 RSS 仍卡在 ~4.5GB（torch／tracing 殘留，
    # 配置器不還給系統），量化再疊 ~2.7GB，footprint 10.9GB，超過夜訓 8GB 約束。
    # 子行程結束記憶體整份歸還，主行程從頭到尾不載 torch。
    do_parity = args.parity_n > 0 and CORPUS.exists()
    keep_qids = {q for q in args.parity_qids.split(",") if q}
    proc = multiprocessing.get_context("spawn").Process(
        target=_torch_stage,
        args=(str(in_dir), str(src), str(tmp_path), str(refs_path), do_parity, args.parity_n, keep_qids))
    proc.start()
    proc.join()
    if proc.exitcode != 0:
        print(f"torch 導出段失敗 exitcode={proc.exitcode}", file=sys.stderr)
        return 1
    refs = []
    if do_parity:
        with open(refs_path, "rb") as f:
            refs = pickle.load(f)
        refs_path.unlink()
        if not refs:
            print("parity 無可用題目", file=sys.stderr)
            return 1

    import numpy as np

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
        del g  # 只用來列節點名；權重是內嵌的，不放掉就跟 quantize_dynamic 自己讀的那份疊成兩份 1.3GB
        gc.collect()
        quantize_dynamic(str(tmp_path), str(onnx_path), weight_type=QuantType.QInt8,
                         nodes_to_exclude=exclude)
        print(f"quantized int8 {onnx_path.stat().st_size / 1e6:.0f}MB ({time.time() - t0:.0f}s)")
        tmp_path.unlink()

    tok_src = Path(args.tokenizer_dir) / "tokenizer"
    if not tok_src.is_dir():
        print(f"缺 tokenizer 來源 {tok_src}", file=sys.stderr)
        return 1
    shutil.copytree(tok_src, staging / "tokenizer")

    # temperature 的順序必須對上 QTYPES 的索引，不是字典序。
    temps = cfg.get("temperature") or [1.0, 1.0, 1.0]
    (staging / "laya_config.json").write_text(json.dumps({
        "max_len": cfg["max_len"],
        "head_max_len": cfg["head_max_len"],
        "temperature": temps,
        "temperature_by_options": cfg.get("temperature_by_options", {}),
        # laya-train.py 一律用 laya_state 裁過的 state 訓練；gateway 只對帶這個旗標的 bundle 裁切
        "state_crop": True,
    }, indent=1) + "\n")

    def commit():
        """把 staging 換進 out。只在 parity 通過後呼叫——換上線前先證明它等價。"""
        # ponytail: 兩次 rename 之間有個微秒級的窗口，out 會短暫不存在。
        # 真正要消掉的是「導出跑十分鐘、全程原地覆蓋」那個窗口，這樣已經夠；
        # 要完全無窗口就得改成 symlink 指向帶版本號的目錄，再改 gateway 的讀法。
        prev = out.with_name(out.name + ".prev")
        shutil.rmtree(prev, ignore_errors=True)
        if out.exists():
            out.rename(prev)
        staging.rename(out)
        print(f"bundle → {out}（上一版留在 {prev.name}）")

    # ---- parity：torch vs ONNX，拿真實 corpus 題目
    if not do_parity:
        print("跳過 parity（--parity-n 0 或無 corpus）")
        commit()
        return 0
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    max_gap, flips = 0.0, []
    for i, (feeds, t_logits) in enumerate(refs):
        o_logits = sess.run(["logits"], feeds)[0]
        gap = float(np.abs(t_logits - o_logits).max())
        max_gap = max(max_gap, gap)
        if int(t_logits.argmax()) != int(o_logits.argmax()):
            flips.append(i)

    print(f"parity qids={','.join(sorted(keep_qids)) or '全部'}")
    print(f"parity n={len(refs)}  max|Δlogit|={max_gap:.4f}  argmax 翻掉={len(flips)}/{len(refs)}")
    if len(flips) > args.max_argmax_flips and args.parity_warn_only:
        # 翻轉＝跟 torch 不一致，不等於答錯；對錯交給 nightly 的同卷配對閘拿老師答案判（使用者 10-09 核准）
        print(f"parity 警告（不擋）：argmax 翻掉 {len(flips)} 題 > 容許 {args.max_argmax_flips}（題號 {flips[:10]}）")
    elif len(flips) > args.max_argmax_flips:
        print(f"parity 失敗：argmax 翻掉 {len(flips)} 題 > 容許 {args.max_argmax_flips}（題號 {flips[:10]}）",
              file=sys.stderr)
        print("量化改了決策。用 --no-quantize 導 fp32，或提高 --max-argmax-flips 並說明理由。",
              file=sys.stderr)
        return 1
    else:
        print("parity OK")
    commit()
    print(f"\n要切過去：export JEV_LAYA_MODEL_DIR={out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
