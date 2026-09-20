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

## Phase 3 剩餘：live 掛載

`plugin/hooks/gate.js` 已寫好且 shadow=true（只記錄不阻擋），單元測試全過；
但**尚未**註冊進 `/Users/51mini/.claude/settings.json`（系統檔，跨 repo，且 Phase 3 採
shadow 兩週）。待：
1. provider 解鎖（見上）。
2. 在 settings.json 的 `hooks.PreToolUse` 與 `hooks.Stop` **既有項目之後**追加 gate.js，
   並確認 `hooks` 順序排最後、任何情況不覆蓋既有 deny。
3. 兩週 shadow 紀錄無誤後才把 `plugin/config.default.json` 的 `shadow` 改 false。

## 各 Phase 現況

| Phase | 狀態 | 驗證 |
|---|---|---|
| 0 | ✅ 完成 | 背份＋移出 disabled，驗證指令全過 |
| 1 | ✅ 完成（真跑通） | npm test 10 過含 live；long-bash 59889→119；short 未動；log 無 key |
| 2 | ✅ 完成（真跑通） | route-bench resolved=9 no_match=1 unavailable=0 avg 977ms；empty 拋錯 |
| 3 | ⚠ shadow 結構完成、未 live | coexist test 過；shadow=true；未註冊進 settings.json |

## 待辦（2026-09-20 重跑後新增）

1. **route 判斷不一致**：「把一段 Python 除錯」→ `no_match`，「找一段程式的 bug」→ `diagnose`。
   同義句應同落點，candidate description 要調。
2. **route 延遲 avg 977ms**：掛 `prompt.submit` 等於每次提問 +1s。要嘛只在候選 >N 時才跑，
   要嘛接受這個延遲，需先決策。
3. **Phase 1 機制未定**：目前是 command hook（每次 spawn node）。function hooks 旗標已開
   （CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1，2.1.278），改 in-process 可省 spawn 成本。未決。
