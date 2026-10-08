# PLAN 2026-10-08：Laya 優先的分層判斷（L0→Laya→Zen free→OpenRouter）

## 前提（使用者 10-08 定案，不再重議）

- Jev 不是免費的。Zen `jev-1.13-free` 額度很薄、很快燒完，主體是付費 OpenRouter jev。**Jev 呼叫數＝成本**。
- Laya（本機 ONNX）是唯一真免費的判斷層，能力有限，只接 champion／agreement 過閘的題型，其餘交雲端。
- 涵蓋 Claude Code、Codex；Laya 另接 opencode／openclaw／hermes；M2 跑純 Laya（不碰雲端 Jev）。

## 現況（10-08 盤點，數字出處見各行）

| 事實 | 數字 | 出處 |
|---|---|---|
| Laya 實際接到的流量 | 7 天 3 次（只有 Claude Code MCP 設 `JEV_PROVIDER=laya`） | MCP 行程 env、usage.jsonl |
| 最大量呼叫點 | Stop gate 約 150 次／天，**不在 usage ledger** | `~/.jev-gate/gate.log` |
| 最燒 token | claude-compact 4.78M／3.7 天 | usage.jsonl |
| 雲端直打、繞過 Laya | hooks/jev.js、compact-hook、plugin judge、openclaw、hermes cli、Codex MCP（`JEV_PROVIDER=zen`） | 各檔 |
| openclaw compact | 196 次全 429，沒在運作 | usage.jsonl |
| 402（OR 沒錢）處理 | 整個 repo 沒有 | grep |
| zen-watch probe | 每小時 1 次，82 次中 37 次 429，自己也吃額度 | usage.jsonl |
| Laya 記憶體 | 每個 MCP 行程各載一份 ONNX；hook 的 `$.http.fetch` 載不了 | adapters.js:166 |
| Laya 能接的 state | 只有 `{user_request, char_bucket}` 且 ≤320 字（`laya-routing.js:56`）→ prune／compact／jev-route 一律雲端 | laya-routing.js |
| 夜訓卡住原因 | 10-04、10-05 int8 量化 parity 翻 1 題被擋導出；10-07 被 SIGTERM；champion 停在 10-02 | laya-nightly.err.log |

## 設計：一個本機 cascade daemon，所有宿主只換 base URL

`gateway/src/cascade-server.js`，launchd 常駐，`127.0.0.1:8793`，路由形狀＝官方 `POST /v1/systemone`（https://docs.typesafe.ai/api.md），端點規格借鏡 `laya-serve`（NandhaKishorM/laya）。

```
請求 → [快取 sha256(mode+state+questions)，24h]
     → L1 Laya（makeLayaRouter：champion 題型＋conf gate）
     → L2 Zen jev-1.13-free（429 FreeUsageLimitError → 寫冷卻檔，全機共用）
     → L3 OpenRouter jev（withDailyBudget 日上限＋withPaymentStop：402 → 停 1h＋hpush）
     → 任一層都失敗 → 非 200，客戶端照舊 fail-open
標頭 x-jev-mode: laya-only → 只走快取＋L1，Laya 不接就回 503 LayaAbstain（給 opencode／openclaw／hermes／M2）
標頭 x-jev-caller: <名稱> → 每次寫 usage ledger（Stop gate 從此看得見）
```

好處一次拿到：
1. 所有宿主共用一份 ONNX（fp32 1.7GB 也養得起，夜訓 int8 parity 問題可改導 fp32）。
2. 成本帳集中：每次呼叫都記 caller／層級／是否命中快取。
3. 402、日上限、冷卻只寫一處。zen-watch probe 可退役。
4. 宿主端零邏輯：jevwire、`$.http.fetch`、Python requests 都只改 baseUrl。

L0（零模型、全宿主可用、M2 也有）：`agent-glue/src/l0-prune.js` 確定性剪裁（ANSI、`\r` 進度條、連續重複行）。先剪 L0 再問模型，chunk 變少＝呼叫變少。

## 分期

### P1（本次派 dcq，三個 worktree 併發）

| 工單 | worktree | 產物 |
|---|---|---|
| WO-20261008a budget | `~/dev/jev-gate-mcp-wt/cascade` | `gateway/src/budget.js`＋測試 |
| WO-20261008b cascade-server | 同上（a 之後） | `gateway/src/cascade-server.js`＋測試＋plist 範本 |
| WO-20261008c l0-prune | `~/dev/jev-gate-mcp-wt/l0` | `agent-glue/src/l0-prune.js`＋測試 |
| WO-20261008d opencode plugin | 同上（c 之後） | `integrations/opencode/jev-laya.js`（L0 剪裁）＋測試＋README |

主 session 收件：每張 `wo-verify` 重跑、看 `git diff`、merge 回 main、`npm test` 全綠。

### P2（P1 merge 後；主 session 做接線，dc 做程式）

- 主：載入 launchd `com.51mini.jev-cascade`，`curl /health`，確認只有一份 ONNX。**10-08 23:30 已載入。**
- **P2a（10-08 完成，觀察到 10-09 23:45）**：只有 Stop gate 走 daemon（`stopCascadeUrl`，帶 `x-jev-caller: stop-gate`；daemon 連不上就直連 Zen/OR，不會靜默失效）。plugin prune 仍直連。報告 `scripts/cascade-stopgate-report.mjs`，一次性 launchd `com.51mini.jev-cascade-report-1009` 推播。預期 Laya 接手 0：verify 的 state 是 claim＋evidence，過不了 `shortStandaloneState`，這期要看的是記帳、快取、OR 日上限，不是 Laya 比例。ledger 每筆雲端呼叫有兩列（`gateway:cascade-server` 是上游、`cascade:<caller>` 是宿主），加總時只取其一。
- 主：plugin `config.default.json` baseUrl → daemon；`settings.json` 的 `JEV_ENDPOINT` → daemon（hooks/jev.js）；Codex `~/.codex/config.toml` 與 Claude MCP 改指 daemon。
- dc：`compact-hook.mjs`、openclaw `compact-provider.mjs`、hermes `cli.mjs` 改打 daemon（帶 `x-jev-caller`）；hermes 改 HTTP，不再每次開 node subprocess。
- dc：夜訓 int8 parity 失敗時改導 fp32（daemon 單份記憶體，養得起），不再整晚白跑。
- 主：退役 `com.51mini.jev-zen-watch`（daemon 已處理冷卻）。
- 主：查 10-07 夜訓 SIGTERM 來源。

### P3（擴大 Laya 地盤，資料驅動）

- daemon 加 shadow：雲端答的題，背景再讓 Laya 答一次，寫 agreement 樣本（不增加 Jev 呼叫，解掉 §32「本機 lane 長不出語料」的結構上限）。
- prune／compact 的 keep/drop：shadow 兩週，agreement 過夜訓閘（地板 0.95、`MIN_N` 30、McNemar）才下放。Laya encoder 長度上限未驗，shadow 會量到。
- jev-route：照 §36 改寫三類題（新能力、只看接下來要做的事、免費額度不算付費）→ 第三批 holdout → 接線；拆成 noul 後同步 shadow Laya。`route` 那題併進 regex 後刪除（Laya agreement 10–13%、advisory 符合率不值一題）。這段要判斷力且耗付費呼叫，主 session 做。
- Stop gate：看 P2 ledger 再決定 prefilter（只在最後訊息含完成宣告時才問 Jev）。

### P4（Laya-only 宿主與 M2）

- opencode plugin 加 Laya shadow／接線（P3 keep/drop 過閘後）。
- openclaw：`before_prompt_build`＋`tool_result_persist`，打 daemon laya-only。
- hermes：`pre_llm_call`＋`transform_tool_result`，短 timeout、失敗放行。
- M2：`scripts/m2-laya-only-install.sh`（daemon 用 `JEV_CASCADE_MODE=laya-only` 起；不得在本機執行）。

## 評估後不做

- 出口 content grader（三題）：每份產出多一次雲端呼叫，與「省呼叫」目標相反；Laya 沒語料。等 P3 shadow 機制在，再當新題型 shadow。
- 入站資料流 triage：同上，排 P4 之後以 shadow 起步。
- 採用 LiteLLM／cockatiel：三段線性串接手寫比依賴少；LiteLLM 不懂 `/systemone`。

## 驗收（整體）

- P1：四張工單 `wo-verify` rc=0，merge 後 `npm test` fail 0。
- P2：`curl -s 127.0.0.1:8793/health` 回 ok；一天後 ledger 每個 caller 都有列；`ps` 只見一個載 ONNX 的行程。
- P3：Laya 實際接手比例（ledger `layer=laya` ÷ 全部）從 ~0% 往上，每週報。
