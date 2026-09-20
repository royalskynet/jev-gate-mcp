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
| 1 | ✅ 上線（function hook，Bash/Grep/Read） | e2e：Bash 19543→30、Read blob 16571→~60、Grep 48KB→138；對照組真實原始碼 20KB 原封不動 |
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

## 4. Read/Grep 加掛（2026-09-21）

`Bash`/`Grep`/`Read` 各一條 `tool.call`，門檻與 criteria 分開（表見 README）。

兩個實測發現，都是 fail-open 會藏住的那種：

1. **core 在 hook 之前就對 Read 做 token cap**。實測 207KB 日誌只送 8000 字元、
   114KB base64 blob 送 16571 字元。原本 Read 門檻寫 20000 ＝ 那條 hook 永遠不會觸發，
   而且因為 fail-open，看起來跟「Jev 都判 keep」一模一樣。降到 12000，並補一條測試
   `TARGETS.Read.thresholdChars < 16000` 卡住這個回歸。
2. **`claude plugin validate` 是靜態讀原始碼**。用 `for...of` 迴圈註冊會印成
   `tool.call{tool=tool}`；hook 位置放工廠呼叫（`prune('Bash')`）直接整個 module 被拒
   （`the hook is not a function literal or the name of one`）。所以三條寫死，
   由測試斷言註冊名單 == `TARGETS` 鍵。

e2e 用 `claude -p` 子 session 實測（子 session 需 `--settings '{"sandbox":{"enabled":false}}'`，
否則 EPERM 開不了 socket）。注意 `-p` 模式預設沒有 `Grep` 工具，會退回 `grep -rn`；
要驗 Grep 路徑必須加 `--allowedTools Grep`。

## 下一個槓桿：`session.compact`（2026-09-21 已評估）

**結論：不自己寫，裝 `ingebyd/fast-jev-compaction-openrouter`。** 它已經處理掉
tool_use/tool_result 配對、最新 N 則釘住、state 裝不下時分階段壓縮與失敗退回內建摘要，
而且每個 request 固定帶 `{"provider":{"zdr":true,"data_collection":"deny"}}` 不可關閉——
compaction 送出去的是**整段對話**，這個 ZDR 條件不是可選項。細節與待決的 key 來源問題見
`docs/DEVLOG.md` §6。

## 仍未解

- claude.ai connectors `Gmail` / `Google_Calendar` / `Claude_Docs`：30 天 0 真實呼叫，
  但斷開是 `/mcp` 的 GUI 動作，無頭機無法程式化執行。
