# NEXT：卡點與待辦

## ~~卡點~~ 已解除：provider 可用（2026-09-20）

早先結論「OpenRouter 沒有 Jev model」**是錯的**。真正根因是 `plugin/config.default.json`
把 model 寫成 `typesafe/jev-1.13.0`（多一個 `.0`，該 id 不存在）。所有呼叫回 400，
fail-open 靜靜吞掉，prune.log 記 `original_len == kept_len`，看起來像「provider 沒 Jev」。

實測可用參數：

- 端點 `https://openrouter.ai/api/v1/systemone`（canonical：`POST /api/alpha/decisions`）
- model **`typesafe/jev-1.13`**，回應的 `model` 欄為 `typesafe/jev-1.13-20260917`
- auth：OpenRouter key，`Authorization: Bearer`
- question 形狀：`{type: "choice"|"score"|"noul", instructions, criteria}`，`type` 為必填 discriminator
- 單次 343 in / 33 out、$0.000014406、約 550ms
- `GET /v1/models` 不列 Jev，這是設計如此（Decisions 為獨立 endpoint），不代表不可用

驗證：`node plugin/hooks/prune.js < tests/fixtures/long-bash.json` → `59889 → 119`。

**教訓**：驗收只有負向斷言（fail-open 不崩、不洩 key）時，一個壞 model id 可以讓三個
Phase 全部「通過」。`tests/live.test.js` 補上正向斷言（真打 API，長輸出必須變短），
把 model 改回 `jev-1.13.0` 該測試即紅。

> 未改 provider adapter：`jevwire` 匯出（`JevDecisionModel`、`runEvaluate`/`runVerify`/`runNextStep`）直接當依賴使用。

## Phase 0 未完成項

- claude.ai connectors `Gmail` / `Google_Calendar` / `Claude_Docs`：30 天 0 真實呼叫。
  它們**不在** `/Users/51mini/.claude.json`（該檔無對應鍵），斷開是 claude.ai `/mcp` 的
  GUI 動作，無頭機無法程式化執行。需手動在 `/mcp` 關閉。其餘（headroom/graphify/skillspector/markitdown/repomix/mem0）已移至 `_mcpServersDisabled`。

## Phase 3：刻意停在 shadow

`plugin/hooks/gate.js` 已寫好且 `shadow=true`（只記錄不阻擋），單元測試全過，
但**不註冊**進 `/Users/51mini/.claude/settings.json`——理由見下方決策 3。
真要上線時，必須追加在既有 `hooks.PreToolUse` / `hooks.Stop` 項目**之後**，
任何情況不覆蓋既有 deny（`creds-egress-guard.js` / `launchd-domain-guard.js` / `fi-reminder.sh`）。

## 各 Phase 現況

| Phase | 狀態 | 驗證 |
|---|---|---|
| 0 | ✅ 完成 | 背份＋移出 disabled，驗證指令全過 |
| 1 | ✅ 上線（function hook） | e2e：19543→30 chars 進 context；無 plugin 對照 7999 chars 無 marker |
| 2 | ⏸ 刻意不掛載 | route-bench resolved=9 no_match=1 unavailable=0 avg 977ms；見下方決策 2 |
| 3 | ⏸ 刻意不掛載 | coexist test 過；shadow=true；見下方決策 3 |

## 決策（2026-09-20 實裝後）

1. **Phase 1 走 function hook，不是效能選擇，是唯一可行解**。
   settings 的 `command` hook 掛 `PostToolUse` **改不動工具結果**：它跑的時候 core 已經
   把模型要讀的內容記進去了。`tool.call` 可以——`await next(e)` 後回自己的 `{ result }`，
   且**不帶 `ref`**，core 才會拿修改後的 record 重新映射給模型。帶著 `ref` 回去等於
   「core 用它自己的 messages 原樣」＝改了也沒用，又一個靜默失效陷阱。
   落地：`hooks/jev.js` + `hooks/hooks.json` + `.claude-plugin/plugin.json`，
   以 `extraKnownMarketplaces` (source: directory) + `enabledPlugins` 註冊。

2. **jev-route 不掛載**。Claude Code 的工具清單不論有沒有 route 都在 context 裡，
   route 省不到那份 token；掛 `prompt.submit` 反而每次提問 +977ms，註冊成 MCP tool
   又要常駐一段 tool description（淨虧）。留作 library，要用時明確呼叫。
   因此「同義句落點不一致」降級為非阻斷項。

3. **jev-gate 不掛載**。shadow 模式本來就零效果；要等真的量到 ghost loop 浪費了幾個
   turn，再決定值不值得每次 Stop 多一次 Jev 呼叫。

## 下一個槓桿

引擎有 `session.compact` 事件——compaction 時用 Jev 決定哪些段落留下，省的是整個
context window，量級比單次工具輸出大。等 prune 跑兩週、`$.ui.log` 累積實際命中率後再評估
（`fast-jev-compaction` 是同一個位置的第三方實作）。

## 仍未解

- claude.ai connectors `Gmail` / `Google_Calendar` / `Claude_Docs`：30 天 0 真實呼叫，
  但斷開是 `/mcp` 的 GUI 動作，無頭機無法程式化執行。
- prune 目前只掛 `Bash`。Read/Grep 的長輸出要不要一起判，等 log 說話。
