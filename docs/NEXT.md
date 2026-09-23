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

## 下一個槓桿：`session.compact`（2026-09-21 已評估並落地）

**結論：不自己寫，裝 `ingebyd/fast-jev-compaction-openrouter`。** 它已經處理掉
tool_use/tool_result 配對、最新 N 則釘住、state 裝不下時分階段壓縮與失敗退回內建摘要，
而且每個 request 固定帶 `{"provider":{"zdr":true,"data_collection":"deny"}}` 不可關閉——
compaction 送出去的是**整段對話**，這個 ZDR 條件不是可選項。細節見 `docs/DEVLOG.md` §6。

待決的 key 來源問題已解：vendored 到 `~/dev/fast-jev-compaction-openrouter`，在
`getApiKey` 補一條讀金鑰**檔案**的 fallback，`settings.json` 不留第二份副本。
活線驗收 17,557→220 字元、32 測試全過，見 `docs/DEVLOG.md` §8。

## context 到底被什麼吃掉（2026-09-21 實測，修正先前誤判）

只統計 transcript 裡帶 `message` 的記錄（＝真的送進 API 的部分）：
`tool_result` **46.6%**、`user:text` 21.0%、`tool_use:Bash` 16.6%、`Write` 8.6%。

先前 DEVLOG §7 把「hook 驗證錯誤佔 transcript 檔 25%」講成佔 context，是錯的：
那些 `{"type":"attachment"}` 記錄沒有 `message` 欄位，472 次裡只有 4 次真的進 API。
`hook_success` 那 15% 同理，注入量 0，不是洞。修 hook 仍然對，但省的是磁碟與重放。

## 仍未解

- claude.ai connectors `Gmail` / `Google_Calendar` / `Claude_Docs`：30 天 0 真實呼叫，
  但斷開是 `/mcp` 的 GUI 動作，無頭機無法程式化執行。

## 第二台機（m2）：prune ledger 不存在（2026-09-23 已定位，待 m2 執行）

m2 裝完 plugin + Gateway MCP 全綠，唯一沒驗成功的是 `~/.openclaw/state/jev-prune.log`
不存在。m2 的假設是「core 落檔只遞 2 KB preview，輸出低於 16000 門檻 → hook 永不觸發」。

**那個假設是真的，但不是 m2 的根因。** 本機 2026-09-23 用 Read 探針排掉它：
Read 18,060 字元整份遞達（超過 16000 門檻），ledger 仍零新行——門檻過了，hook 沒跑。
往上一層才是真的：**跑 session 的 binary 是 wrapper 自帶的那支**
（`$CLAUDE_CODE_EXECPATH` → Happy 的 `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`，
2.1.263），而 `PATH` 上的 `claude` 是 2.1.278。function hooks 要 ≥ 2.1.274，
低於就**不載入也不報錯**。本機 ledger 最後一行 `2026-09-21T14:19:40`，
`~/.claude/debug/` 最後一份 log `2026-09-21 14:52`——同一天斷掉，不是巧合。

判讀流程的全文在 README「An empty ledger is a symptom with four causes」／
README.zh-TW「ledger 是空的：一個症狀，四個根因」，這裡不重抄。

### m2 要跑的（全部非互動）

1. **量宿主版本**，不是 `PATH` 上的：
   `"$CLAUDE_CODE_EXECPATH" --version`。< 2.1.274 就到第 2 步，≥ 就跳到第 4 步。
2. **升級那支 binary**。如果是 Happy：`npm i -g happy@latest`（1.2.3 → 1.2.5 把
   `@anthropic-ai/claude-agent-sdk` 從 0.3.263 拉到 0.3.280 ＝ CLI 2.1.280）。
   別的 wrapper 同理——升的是 wrapper 自己那份，不是 `PATH` 上的 `claude`。
3. **重開 session**，hook 模組在 session 啟動時載入，升級不影響已跑的那個。
4. `git pull`（要 `3dcdd39`：`if (!key)` 不再是靜默出口，`apiKey` 只 memoize 命中）。
5. **確認 key 檔可讀**——`ls -l` 看 metadata 就好，不要 cat。讀不到的話 ledger
   自己會寫 `jev-nokey`，不用猜。
6. **驗收探針一律走 Read，不要走 Bash**：造一個 > 16000 字元的檔再 Read 它。
   Bash 與 Grep 的大輸出會被 core 落檔成 `tool-results/<id>.txt` 只遞 preview，
   用它們探等於在測 core 的落檔門檻，不是在測 hook。

### 驗收

`wc -l ~/.openclaw/state/jev-prune.log` 在 Read 探針之後應該多一行
`jev-prune(Read): ... chars` 或 `jev-nokey(Read): ...`。兩種都算 hook 活著；
零新行代表還卡在第 1–3 步，回頭量 `$CLAUDE_CODE_EXECPATH --version`。

### 順帶

`~/.openclaw/state/jev-calibration.jsonl` 尾巴那些 `provider:"unknown"` /
`model: typesafe/jev-1.13-20260917` 是 `npm run gateway:acceptance` 自己寫的
fixture，不是真實決策語料，別拿去校準。

### 本機（m1）同病，2026-09-23 已修

m1 的 ledger 從 `2026-09-21T14:19:40` 就停了，根因一樣：Happy 1.2.3 自帶
`@anthropic-ai/claude-agent-sdk` 0.3.263 ＝ Claude Code 2.1.263，`PATH` 上的
`claude` 卻是 2.1.278。修法是把 wrapper 自己那份升上去：

    npm i -g --prefix ~/.local happy@latest

（`/opt/homebrew` 沙箱不可寫，所以裝進 `~/.local`——它在 `PATH` 最前面，
會蓋過 `/opt/homebrew/bin/happy`。）happy 1.2.5 起改用 native installer 的
`~/.local/bin/claude` 2.1.278，不再用自帶那份：`happy --version` 會印
`Using Claude Code v2.1.278 from native installer`。

**升級不影響已經在跑的 session**（hook 模組在 session 啟動時載入），
要新開一個才生效。
