# HANDOFF 2026-09-29 — Laya 唯一來源 + 三缺口（進行中，未驗收）

> **已結案（2026-09-29）**：A–D 段與落點全部完成並實測，改用 int8 bundle；結果與坑見 `docs/DEVLOG.md` §24。本文以下為歷史狀態。

> 本文記錄截至 2026-09-29 的**實際落盤狀態**。核心決策：jev 唯一來源由 OpenRouter
> 切到**本地 Laya**（多語言 checkpoint），OpenRouter jev 降為 fallback。派 deep 實作，
> 因中途叫停，以下「已完成」＝程式碼已改且 `npm test` 全綠，但 **A 段唯一驗收
> （跑一次中文 systemOne 貼原始輸出）尚未執行**——模型已下載落地、尚未證實可 load 跑通，
> 視同「空白未啟用」。任何接續者不得把 `npm test` 全綠當作完成。

## 狀態總表

| 區段 | 內容 | 狀態 |
|---|---|---|
| A | `makeLayaAdapter` + config `laya` 雙通道 | ✅ 程式碼落盤 |
| A | 模型檔落地 `~/.jevgate/laya-multilingual/` | ✅ 已下載（未驗證） |
| A | 中文 systemOne 實測原始輸出 | ❌ 未跑（唯一驗收） |
| B | `agent-glue/src/retriever.js` | ✅ 新增落盤 |
| C | `triage.js` difficulty/kind 走本機 Laya | ✅ 程式碼落盤 |
| D | `verify.js` 加 Laya `noul` 題 | ❌ 未做 |
| 落點 | `.claude.json` env 切 `JEV_PROVIDER=laya` | ❌ 未做 |
| 落點 | `.env.example` 加 `JEV_PROVIDER=laya` + `JEV_LAYA_MODEL_DIR` | ❌ 未做 |

## 已落盤的改動（10 檔）

### A 段 — 模型來源修正
- `gateway/src/adapters.js`：新增 `makeLayaAdapter({ modelDir })`，`Laya.load({ modelDir })`
  指向 `process.env.JEV_LAYA_MODEL_DIR || ~/.jevgate/laya-multilingual`；load 失敗
  clear 快取可重試；`deadline()` 包 load + systemOne。`opts` 忽略（本地權重無 model override）。
- `gateway/src/config.js`：新增 `cfg.provider === 'laya'` 分支——Laya 首選，任何失敗
  （load timeout／throw／breaker open）切 OpenRouter fallback 重試一次；fallback key 缺
  則 Laya 為唯一通道，失敗照常 fail-closed。
- `package.json` + `package-lock.json`：新增 `@receptron/laya@^0.1.2`。

### B 段 — 缺口 1 語意檢索
- `agent-glue/src/retriever.js`（新增）：`retrieve(query, opts)` = `fixindex find --json`
  拿候選 → 本機 Laya `score` 重排 → 前 N。全程 advisory fail-open：fixindex 掛 → `[]`；
  Laya 不可用 → 原序前 N。lazy load，只在需重排時才載模型。

### C 段 — 缺口 2 低賭注本地化
- `agent-glue/src/live.js`：新增 `localLayaJudge()`（lazy fail-soft，無模型目錄／載入
  失敗 → null，呼叫端保留雲端答案）；`resetLive()` 一併清 layaJudgeCache。
- `agent-glue/src/triage.js`：注入 `deps.localJudge` 時，difficulty/kind 走本機 Laya、
  其餘（含 costly_mistake）留雲端 jev；本地 judge 失敗 catch 回雲端答案。`decideTier`
  地板規則 verbatim 未動。cacheKey 加入 `Boolean(deps.localJudge)`。
- `agent-glue/claude/spawn-hook.mjs`、`agent-glue/codex/user_prompt_submit.mjs`：triage 呼叫
  端透傳 `localJudge`（C 段連動，非順手重構）。
- `agent-glue/src/index.js`：`export * from './retriever.js'`。

## 模型落地位置（repo 外，不進 git）

```
~/.jevgate/laya-multilingual/
├── laya.onnx                 646,982,318 bytes（killkli laya_fp16.onnx，完整）
├── laya_config.json            115 bytes（max_len 1024 / head_max_len 256 / temperature [1,1,1]）
└── tokenizer/
    ├── tokenizer.json       18,477,960 bytes
    └── tokenizer_config.json     524 bytes
```

- 符合 receptron `BUNDLE_FILES` 契約（`laya.onnx` + `laya_config.json` + `tokenizer/`）——
  無 external-data，`.onnx.data` 可缺。
- **未驗證**：尚未執行 `Laya.load({ modelDir })` → `systemOne`，fp16 於 onnxruntime-node CPU
  是否可載未知（任務檔明定「實測為準」，本輪未實測）。
- 來源：`killkli/open-jev-laya-multilingual-onnx` 的 `onnx/laya_fp16.onnx`，tokenizer/config
  自該倉平鋪檔搬入 `tokenizer/` 子目錄。

## 未完成項（接續者要做，按序）

1. **A 段唯一驗收**（不做視同未完成）：
   ```sh
   cd ~/jev-gate-mcp && node -e '
     const { Laya } = await import("@receptron/laya");
     const laya = await Laya.load({ modelDir: process.env.JEV_LAYA_MODEL_DIR || (await import("node:os")).homedir()+"/.jevgate/laya-multilingual" });
     const r = await laya.systemOne("請把這個路由到 L1", { kind: { type:"choice", instructions:"分類", criteria:{coding:"coding",writing:"writing"} } });
     console.log(JSON.stringify(r.answers, null, 2));
   '
   ```
   貼原始輸出；fp16 載入失敗 → 退 `onnx/laya.onnx` fp32（1230MB）。
2. **D 段**：`agent-glue/src/verify.js` 增一題 Laya `noul`（deep 回傳可信／夾帶指令），
   advisory、不阻斷。
3. **落點**：`.claude.json` 的 `mcpServers.jev_gate.env` 改 `JEV_PROVIDER=laya`（保留
   `JEV_MODEL`/`JEV_API_KEY_FILE` 供 fallback）；`.env.example` 加 `JEV_PROVIDER=laya`
   + `JEV_LAYA_MODEL_DIR` 說明。
4. 驗收五條 grep 斷言（見派工任務檔 `~/.deepclaude/work/deep/jev-laya-provider.md`）。

## 風險與禁止

- **不得**把 `npm test` 全綠當完成信號：`verify=pass` 只證明斷言，不證明模型能跑。
- **不得** `git add` 模型權重（`~/.jevgate/` 在 repo 外，本 repo 不受影響）。
- 不碰 `~/.claude/hooks/jev-route.mjs`（接線由主 session 做）、`hooks/`、`docs/**`。
- 落點改 `.claude.json` 屬 MCP 設定，改完需重啟 session 才生效。
