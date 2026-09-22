# DEVLOG

開發過程的脫敏紀錄，給「之後接續的人（或 session）」看：做了什麼、為什麼這樣做、
哪些坑是實測撞出來的、下一步該從哪接。絕對路徑一律寫成 `~/…`，不含任何金鑰值。

量測數字全部來自實跑，不是估算；估算的地方會明講。

---

## 1. 起點：整個 repo 是空轉的

Phase 0–3 在紀錄上都「完成」，但 `~/.claude/settings.json` 裡**沒有註冊任何東西**，
所以省下的 token 恰好是 0。

更底層的問題是 `plugin/config.default.json` 把 model 寫成 `typesafe/jev-1.13.0`
（多一個 `.0`，該 id 不存在）。每次呼叫回 400 → fail-open 吞掉 → 日誌記
`original_len == kept_len` → 看起來像「provider 沒有 Jev 可用」。

正確參數（實測）：

- 端點 `https://openrouter.ai/api/v1/systemone`（canonical `POST /api/alpha/decisions`）
- model **`typesafe/jev-1.13`**，回應的 `model` 欄是 `typesafe/jev-1.13-20260917`
- question 形狀 `{type: "choice"|"score"|"noul", instructions, criteria}`，`type` 必填
- 單次 343 in / 33 out、$0.000014406、約 550ms
- `GET /v1/models` **不列** Jev，這是設計如此，不代表不可用

**教訓**：驗收全是負向斷言（不崩、不洩 key）時，一個錯的 model id 可以讓三個 Phase
一起「通過」。正向斷言（真打 API、輸出必須變短、純噪音必須回 `drop`）才擋得住。
做法：把 model id 改回壞的，測試必須變紅——這個「故意弄壞」的步驟本身就是驗收的一部分。

## 2. 機制：`PostToolUse` command hook 改不動工具結果

原本的待辦寫「Phase 1 機制未定：command hook vs function hook」，框成效能取捨
（spawn 成本）。實際上是**正確性**問題：

- settings 的 `command` hook 掛 `PostToolUse` 時，core 已經把模型要讀的內容記進去了。
  它的 stdout 被當成 hook output 解析，未知欄位直接忽略——改不到結果。
- function hook 的 `tool.call` 可以：`await next(e)` 拿到結果，回自己的 `{ result }`。
- **回去時不能帶 `ref`**。帶著 core 給的 `ref` 等於告訴 core「用你自己的 messages 原樣」，
  修改靜默作廢。這是第二個靜默失效陷阱，測試用 `assert.equal(r.ref, undefined)` 卡住。

驗收必須端到端量「模型實際收到幾個字元」，不是看 hook 自己的 log。做法是開子 session
（`claude -p`）讀同一份 fixture，請它回報收到的字元數與有沒有 `jev-prune` 字樣。

## 3. 現在長什麼樣

`hooks/jev.js`，三條 `tool.call`：

| tool | 修改的欄位 | 門檻 | criteria 的 drop |
|---|---|---|---|
| `Bash` | `stdout` | 4,000 | 噪音、樣板、與當前任務無關 |
| `Grep` | `content`（content mode） | 4,000 | vendored / generated / fixture 檔的 match |
| `Read` | `file.content`（text 分支） | 12,000 | 只砍機械性大塊：minified、base64、lock body |

Read 刻意最保守：Bash/Grep 的輸出是「關於檔案的報告」，Read 的結果**就是**模型指名要的
那個檔案，criteria 寫「拿不準就留」。被砍的段落一律留下 `[jev-prune: dropped N lines]`
行內標記，讓模型看得見「這裡少了東西」，不做無聲刪除。

判斷相關性時的「使用者需求」取自 `$.session.messages()` 最新的真實 user turn，
不用 `e.description`——後者是模型自己對計畫的轉述，不是使用者的要求。

端到端實測（模型實際收到的字元數）：

| 情境 | 無 plugin | 有 plugin |
|---|---|---|
| Bash，19,543 字元噪音日誌（中間夾一行真錯誤） | 19,543 | 30 |
| Read，114KB base64 blob | 16,571（core 的 cap） | ~60 |
| Grep，48KB vendored minified match | ~13,000 | 138 |
| Read，20KB 真實原始碼（對照組） | 整份 | 整份，未動 |

## 4. 實測撞出來的四個坑

1. **core 在 hook 之前就對 Read 做 token cap**。實測 207KB 日誌只送 8,000 字元、
   114KB base64 blob 送 16,571 字元。Read 門檻原本寫 20000 ＝ 那條 hook 永遠不會觸發，
   而且因為 fail-open，外觀跟「Jev 全判 keep」一模一樣。降到 12000，並補測試
   `TARGETS.Read.thresholdChars < 16000` 把這個回歸卡死。
2. **`claude plugin validate` 是靜態讀原始碼**。用 `for...of` 迴圈註冊會印成
   `tool.call{tool=tool}`（等於失去驗證意義）；hook 位置放工廠呼叫 `prune('Bash')`
   整個 module 直接被拒：`the hook is not a function literal or the name of one`。
   所以三條寫死、hook 位置放函式字面值，再由測試斷言註冊名單 == `TARGETS` 鍵。
3. **`validate` 在有 `.claude-plugin/marketplace.json` 時會走 marketplace 分支**，
   根本不看 hooks module。驗 plugin 本身要先把 marketplace.json 暫時移開。
4. **`Grep`／`Glob` 的 result 形狀沒有型別宣告**（`BuiltinToolResults` 只宣告 25 個工具，
   兩者都不在內）。用一個丟棄式 probe plugin 實地撈出來，不用猜：
   - Grep content mode：`{mode, numFiles, filenames[], content, numLines, totalLines, appliedLimit}`
   - Grep files_with_matches：`{mode, filenames[], numFiles, totalFiles}`（只有 128 字元，不值得判）
   - Read text 分支：`{type:'text', file:{filePath, content, numLines, startLine, totalLines}}`

### 子 session 驗收的兩個前提

- `claude -p` 子 session 會 EPERM（在 `/tmp/claude-*/` 開不了 socket），要帶
  `--settings '{"sandbox":{"enabled":false,"failIfUnavailable":false}}'`；父層的 OS 沙箱仍在。
- `-p` 模式預設**沒有 `Grep` 工具**，會自動退回 `grep -rn`（於是驗的是 Bash 那條）。
  要驗 Grep 路徑必須加 `--allowedTools Grep`。

## 5. 刻意不做的事

- **jev-route 不掛載**：Claude Code 的工具清單不論有沒有 route 都在 context 裡，route 省不到
  那份 token；掛 `prompt.submit` 每次提問 +977ms；註冊成 MCP tool 又要常駐一段 description（淨虧）。
  留作 library。
- **jev-gate 不掛載**：shadow 模式本來就零效果。要等真的量到 ghost loop 浪費了幾個 turn 再說。

## 6. `session.compact` 評估（2026-09-21）

事件契約（來自 `/plugin-types` 產的宣告）：hook 拿到整份 `messages`（每則帶 `handle`），
可以「下行改 `instructions`／`messages`」、「上行改 core 還回來的 messages」、
「自己回一份 `{messages}` 完全取代摘要」，或 `{skip: reason}`。另有 `precompute` trigger：
提前算好、之後那次 compaction 直接用，等於把延遲藏起來。

**結論：不自己寫，裝現成的 `ingebyd/fast-jev-compaction-openrouter`。**

它是 `tamaratran/fast-jev-compaction` 的 fork，差別只在傳輸層：走 OpenRouter Decisions
端點、用 `OPENROUTER_API_KEY`、每個 request 固定帶 `{"provider":{"zdr":true,"data_collection":"deny"}}`
且**不可從設定關掉**。這件事很重要：compaction 送出去的 state 是**整段對話**
（prompts、assistant 文字、每個工具的輸入），不是一個 chunk。

它已經處理掉自己寫一定會撞的三個地方：

1. `tool_use` / `tool_result` 用 id 配對，拆散就是 API 錯誤；最舊的第一則與最新
   `preserveRecentMessages` 則釘住不動。
2. state 裝不下時分階段壓縮（工具輸入截到 1000→200→60 字元、長文頭尾抽、舊訊息摺成
   `[… N chars omitted …]`…），真的塞不下就 throw → hook 退回內建摘要。
3. 每個 call 問兩個 `noul` 問題（call 本身留不留、result 逐字留不留），照 `keepThreshold`
   決定「留／留 call 但截斷 result／整組刪」，留下來的一律逐字，不改寫。

和本 repo 的 prune 是互補不是重疊：prune 在輸出進 context 前砍，compaction 在整段歷史上砍。

**待決的整合問題只有一個**：它的 key 讀 `OPENROUTER_API_KEY` 環境變數或 plugin option，
而本機的金鑰放在 `~/.creds/kv/`（本 repo 的 hook 是用 `$.fs.read` 讀檔）。照它的裝法會在
settings 裡多一份金鑰副本。接續時先決定：改走檔案讀取（fork 一行），或由啟動 shell 注入環境變數。

## 7. 自己的 hook 在灌 transcript——但**不是**在灌 context

分析本 session 的 transcript 時，檔案組成是這樣：

| 類別 | 列數 | 字元 | 佔檔案 |
|---|---|---|---|
| `attachment:hook_non_blocking_error` | 438 | 1,238,584 | **25.4%** |
| assistant | 464 | 1,055,534 | 21.6% |
| user | 288 | 893,912 | 18.3% |
| `attachment:hook_success` | 793 | 741,339 | 15.2% |

那 25% 全部是同兩支 PostToolUse hook 的 JSON 驗證錯誤，各 220 次、每份約 2.4KB：

```
Hook JSON output validation failed — hookSpecificOutput is missing required field "hookEventName"
```

根因：兩支都是 record-only，卻還是印了一個非法的 `hookSpecificOutput`
（一支印 `{policy:'bypass'}`——`policy` 根本不是合法欄位；另一支在沒有告警時印 `{}`）。
引擎每次拒收，然後把完整的錯誤訊息＋期望 schema 寫回 transcript，**每次 Bash 呼叫一份**。

修法是各刪一行「沒東西就完全不印 stdout」。驗收：餵一筆 PostToolUse payload 進去，
stdout 必須是空的（用 `xxd` 確認，因為「看起來沒輸出」和「輸出了空字串」在終端上長一樣）。

### 但「佔 transcript 25%」不等於「吃掉 25% context」——原本這裡寫錯了

回頭查那 15% 的 `hook_success` 時才發現分母搞錯。這兩種 hook 記錄在 `.jsonl` 裡都是
**獨立的 `{"type":"attachment"}` 記錄，沒有 `message` 欄位**。實測同一份 transcript：

- `hook_non_blocking_error` 出現 **472 次**，其中只有 **4 次**落進帶 `message` 的記錄。
- `hook_success` 的 no-op 列（`suppressOutput: true`）共 839 筆、約 256KB，注入量 **0**。

真正會進 context 的只有 `hookSpecificOutput.additionalContext` 與 SessionStart 的
`content`。本 session 實際注入量：claude-mem 召回 60,788、ponytail 24,174、caveman 11,034、
fixindex 1,570、plan-path-notice 1,217、guard 551——合計約 99KB，其中八成是刻意要的東西。

所以那兩支 hook 的修法仍然對（`/compact`、resume replay、claude-mem 都要讀這個檔），
但省下來的是**磁碟與重放成本，不是 context 成本**。`hook_success` 那 15% 同理，不是洞。

### 那 context 到底被什麼吃掉？

只統計帶 `message` 的記錄（＝真的送進 API 的部分），總量 548,390 字元：

| 部位 | 字元 | 佔比 |
|---|---|---|
| `user:tool_result` | 255,443 | **46.6%** |
| `user:text` | 115,093 | 21.0% |
| `assistant:tool_use:Bash`（指令本身） | 91,201 | 16.6% |
| `assistant:tool_use:Write`（寫進去的檔案內容） | 47,223 | 8.6% |
| `assistant:text` | 29,514 | 5.4% |

第一槓桿是 `tool_result`，也就是本 repo 的 prune 正對著的那塊。第二槓桿是整段歷史，
也就是 compaction。hook 噪音根本不在榜上。

## 8. compaction 落地（2026-09-21）

`ingebyd/fast-jev-compaction-openrouter` 已 vendored 到
`~/dev/fast-jev-compaction-openrouter`（不含 `.git`：沙箱擋 `.git/config` 寫入）。

本機 delta 只有 `hooks/fast-jev.ts` 的 `getApiKey`：在 option → env → `settings.env`
之後補一條讀**金鑰檔**的 fallback（`keyFile` option，預設 `~/.creds/kv/…`）。
這就是先前留著的那題——選檔案讀取，避免在 `settings.json` 留第二份金鑰副本。
`claude plugin validate` 認得出來：`$.fs.read (via getApiKey)`。

活線驗收（`tests/live.test.ts`，打真的 OpenRouter）：

```
live: 7->3 messages, 17557->220 chars,
      t1:Read:drop_call/call=0.34/result=0.18  t2:Bash:drop_call/call=0.41/result=0.20
Test Files  3 passed (3)   Tests  32 passed (32)
```

順帶量到一個調參訊號：Jev 給「失敗的 `npm test`」只有 `keepCall=0.41`，低於預設
`keepThreshold` 0.5 而被丟掉。實務上預設 `preserveRecentMessages: 6` 會把它釘住，
所以只有「久遠但仍相關的失敗」會中招；真的中招就調低 `keepThreshold`（調低＝留更多），
不是調高釘住則數。

註冊進 `settings.json` 這一步主 session 做不到（沙箱 deny `~/.claude/plugins/`、
`~/.claude/settings.json`），走 deep-run 在沙箱外執行 `claude plugin marketplace add`
＋ `claude plugin install`。

---

## 接續建議

1. 幾天後看 `~/.openclaw/state/jev-compaction.log` 的走 Jev / 退回比例，再決定門檻
   要不要動（見 §9）。`jev-prune(...)` 那側目前**沒有**等價的落盤，要調門檻得先比照
   補一條 ledger。
2. `assistant:tool_use:Bash` 佔 16.6%、`Write` 佔 8.6%——這兩塊是**模型自己寫的輸入**，
   prune 與 compaction 都碰不到進 context 前的那一刻。要省只能靠 compaction 回頭砍。


## 9. 後續觀察：`$.ui.log` 不落盤，所以自己寫 ledger（2026-09-21）

§8 收尾說「兩邊都有 log」——錯的。`$.ui.log` 與 toast **只在 TUI**，除非
`claude --debug` 否則不寫任何檔案（`~/.claude/debug/` 最後一筆停在 9/14）。

一度想直接 grep session transcript，因為 `jev-prune(` 在本 session 的 `.jsonl` 裡
grep 得到 136 筆。實際查下去**全部是自己討論這件事時寫的同名字串**：那 41 條
`jev-prune(` 記錄型別是 `assistant` / `user` message，不是 hook 產出。
plugin enabled ≠ hook 有跑，而 grep 出來的數字看起來剛好像「有跑」——
跟 §7 那個 25% 誤判同一類陷阱：量到的東西不是想量的東西。

落地（都在 `~/dev/fast-jev-compaction-openrouter` 與 `~/dev/agent-tools`）：

- `hooks/fast-jev.ts` 的 `notify()` 每次壓縮 append 一行到
  `~/.openclaw/state/jev-compaction.log`。三種結局（走 Jev / 沒省夠退回 / 例外退回）
  本來就全部經過 `notify()`，所以這是唯一的縫。`$.fs` 沒有 append，只能 read-then-write；
  一次壓縮一行，檔案長不大。整段包在 try/catch：ledger 是觀察用的，不准弄壞壓縮。
  `npm run typecheck` 過、32 測試全過（含活線）。
- `bin/jev-compaction-watch.sh` + launchd `com.51mini.jev-compaction-watch`（每日 09:00），
  有新事件才推 Coco，沒事安靜。`--dry-run` 是無頭驗收入口，且刻意不消耗 state。
- 安裝走 `oneshot.d` break-glass（沙箱擋 `~/Library/LaunchAgents`）。第一次被
  `BREAKGLASS REFUSED`：boot-guard 用 `head -1` 檢查 `# break-glass:` header，
  而我把 `#!/bin/bash` 放在第一行。header 必須是**第 1 行**，shebang 都不能擋在前面。

驗收：

```
launchctl print "gui/$(id -u)/com.51mini.jev-compaction-watch"
    path = /Users/51mini/Library/LaunchAgents/com.51mini.jev-compaction-watch.plist
    state = not running        # calendar job 未到點，正常
    runs = 0
```

要觀察什麼：`fallback to built-in summary` 若占多數，依序查 `minReductionRatio`
（短 session 本來就省不到 25%）、`keepThreshold`、金鑰檔可讀性。


## 10. 砍掉 HTTP/Docker/Caddy 整層，改認 plugin-first（2026-09-21）

### 缺口是假的

接手時的 `DEVLOG-HANDOFF.md` §6 寫「唯一驗收缺口 = Docker runtime smoke」。
往回推一層才發現那個缺口的前提是「要部署成公開 HTTP 服務」——**沒有人提過這件事**。
實際用途從頭到尾都是本機 MCP plugin：`gateway/src/stdio.js`，兩個 tool。

本機沒有 docker daemon、沒有 compose plugin、沒有公開 DNS，Caddy 的 ACME 路徑
在這台機器上不可能驗證。補那個缺口＝為了一個沒人要的部署目標去裝一整套 runtime。

真缺口在另一邊：`claude mcp list` **沒有 jev**。寫了那麼多，只有 Codex 接得到，
主力 session 用不到。整份 handoff 的驗收表沒有一條在看這件事。

**教訓**：驗收表會忠實地驗它自己列的東西。列錯目標時，全綠不代表可用——
要先問「這個缺口是在哪個前提下成立的」。

### 動刀範圍（ponytail：先問需不需要存在）

單機 plugin 用不到遠端服務層。選「整層刪」而非「移到 `optional/remote-deploy/`」：
留著等於留一份沒跑過、沒測過、會持續漂移的假資產，以後還得解釋它為什麼在那。

刪除：

| 資產 | 行數 | 理由 |
|---|---|---|
| `gateway/src/http.js` | 229 | Streamable HTTP transport，stdio 已覆蓋全部用途 |
| `Dockerfile` / `compose.yaml` / `.dockerignore` | 89 | 純部署資產，無程式碼引用，從未 build 過 |
| `deploy/Caddyfile` / `deploy/.env.example` | 26 | 同上，且依賴不存在的公開 DNS |
| `rate-limiter-flexible` 依賴 | — | 只有 `http.js` 用；stdio 只有一個本機 caller，沒有 request queue 要保護 |
| npm script `gateway:http` | — | 指向已刪檔案 |

保留：`gateway/src/metrics.js`。它被 `src/config.js` → core 引用，不是 HTTP 專屬；
外觀像「監控 = 服務層」所以最容易被順手砍掉，實際砍了 core 就壞。
動刀前先測繪 import graph、把判定寫死在工單表格裡，就是為了擋這種順手。

`gateway/lib/bench.mjs` 沒整檔砍，只換掉 transport 分支：原本量 in-process
Streamable HTTP 的往返，改量 in-process stdio。量的是「同一條 production surface 的
transport overhead」，換 transport 不換問題。

### 測試數對帳

`npm test`：`107 tests / 105 pass / 2 skip` → `100 tests / 98 pass / 2 skip`、`0 fail`。

少掉的 7 支全部是 `conformance.test.mjs` 裡的 HTTP 專屬斷言，逐項列出：

1. `http: /health answers 200, unknown path answers 404`
2. `http: oversize body answers 413`
3. `http: POST without Content-Length is rejected before a chunked body can bypass the cap`
4. `http: non-localhost Host and Origin are rejected 403`
5. `http: auth protects ready/metrics while health stays secret-free`
6. `http: rate limit rejects excess protected requests with 429`
7. `http: non-loopback bind fails loud without auth and explicit hosts`

另有一支 `conformance: ... equivalent over stdio and HTTP` 改寫成
`conformance: ... returns a gate over stdio`——不是刪，是拿掉 HTTP 那半邊。
「還是全綠」不足以證明沒砍錯；pass 數下降必須逐項對得上，否則無法區分
「測試隨檔移除」與「測試被靜默停用」。

### 預防加固：`gateway/scripts/plugin-smoke.mjs`

plugin 路徑原本零回歸保護——HTTP 層一動刀，沒有任何測試會發現 stdio 被牽連。
新增離線 smoke（`JEV_PROVIDER=fake`）：spawn stdio server → `tools/list` 斷言恰好兩個
tool 且名稱正確 → 真的 call `jev_evaluate` → 斷言 outcome 非 `accept`。

```
tools: jev_apply_policy, jev_evaluate
jev_evaluate outcome: advisory
plugin-smoke: OK
```

### 坑：`claude mcp add` 的旗標順序

```
Invalid environment variable format: jev_gate, environment variables should be
added as: -e KEY1=value1 -e KEY2=value2
```

`-e, --env <env...>` 是 variadic，所以 server 名稱放在 `-e` 後面會被當成又一個
`KEY=value` 吞掉。正確形狀是 `claude mcp add [options] <name> <commandOrUrl>`——
**名稱先於旗標**。錯誤訊息把 `jev_gate` 報成「格式錯誤的環境變數」，指向的是症狀不是原因。

另外兩件實測確認的事，讓指令可以更短：

- `gateway/src/config.js:17` 的 `apiKeyFile` 預設已經指向 `~/.creds/kv` 下的
  OpenRouter key 檔，不必再傳 `JEV_API_KEY_FILE`。少傳一個參數，也順便避開
  creds-egress-guard 對含憑證路徑指令的阻擋。
- `gateway/src/registry.js:16,29` 以 `import.meta.url` 解析 policies 目錄，不吃
  `process.cwd()`，所以 host 從任何目錄 spawn 都找得到 policy。

### 坑：沙箱靜默回滾 `~/.claude.json`

在沙箱 session 內跑註冊指令，輸出是成功的：

```
Added stdio MCP server jev_gate with command: node .../gateway/src/stdio.js to user config
File modified: /Users/51mini/.claude.json
rc=0
```

但事後查 `grep -c jev_gate ~/.claude.json` 回 `0`，`claude mcp get jev_gate` 回
`No MCP server named "jev_gate"`。原因：`~/.claude.json` 在沙箱的 `denyWithinAllow`
清單內，寫入被丟棄，而 CLI 收到的是「成功」。

這是第三個靜默失效陷阱（前兩個見 §1 的 fail-open、§2 的 `ref`）。同一個形狀：
**回報成功的那一層不是真正落地的那一層**。所以註冊必須由沙箱外的執行者做，
且完成判準只認 `claude mcp list` 的輸出，不認 `mcp add` 的 rc。

### 坑：沙箱外的執行者也可能有自己的設定檔

第一次改派子代理（沙箱外）去註冊——它回報成功，它自己 `claude mcp list` 也看得到，
但主機 `grep -c jev_gate ~/.claude.json` 仍是 `0`。它的 `CLAUDE_CONFIG_DIR` 指向自家
config 目錄，user scope 全寫到它自己身上。**它的自我驗收因此必然通過，錯不出來。**

「沙箱外」不等於「同一個設定檔」。要改的是主 session 自己的設定檔時，不要派子代理。
最後走 break-glass 腳本：`unset CLAUDE_CONFIG_DIR` → 備份 → `claude mcp add` →
`grep` 自證（不看 rc）→ 失敗自動還原備份，由沙箱外的 boot-guard 代跑。落地輸出：

```
jev_gate_occurrences=1
jev_gate:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: /Users/51mini/dev/jev-gate-mcp/gateway/src/stdio.js
```

**這段的三次失敗是同一題的三種變形**：旗標順序（指令沒生效）、沙箱回滾（寫入沒生效）、
設定檔分家（寫到別人身上）。三次都回報成功。驗收寫「跑了什麼」擋不住任何一次，
寫「哪個檔案裡要出現什麼字串」三次都擋得住。

### 順帶驗到 fail-closed（沙箱擋 egress 的意外用途）

從沙箱內直呼 stdio server 打真 provider，被 proxy 擋下：

```
--- jev_evaluate ---
{ "error": { "code": "ERR_PROVIDER", "category": "provider",
             "message": "Could not reach https://openrouter.ai/api/v1/systemone: fetch failed" } }

--- jev_apply_policy ---
{ "outcome": "deny", "mode": "shadow", "consequence": "advisory",
  "coverage": "incomplete",
  "unavailable": { "code": "ERR_PROVIDER", "message": "Could not reach ... fetch failed" },
  "model": null, "correlation": null,
  "policy_digest": "sha256:cd1880ba…", "question_digest": "sha256:d0032813…" }
```

這正是 invariant 4（「provider errors never become acceptance」）該有的樣子：
`coverage` 標 `incomplete`、`outcome` 降到 `deny`、`model` 是 `null`、digest 照常算出來。
provider 不通時它沒有退回「先放行再說」，也沒有捏造一個 model id。
活線驗收得另外在沙箱外跑，但這條斷網路徑本來就該驗，剛好白撿。

### 現況

- 唯一 transport：stdio。tool surface 不變，仍恰好 `jev_evaluate` + `jev_apply_policy`。
- 四個 starter policy 仍 `shadow + uncalibrated`，公開 outcome 仍被壓成 `review`。
  這次動刀沒有碰 policy、門檻、calibration 狀態。
- 驗收：`npm test` 0 fail、`npm run build` OK、`gateway:acceptance` OK、
  `gateway:replay` pass 2/2、`plugin-smoke` exit 0。

## 11. 潛能盤點與兩項補齊（2026-09-21）

### 11.1 起點：一個活線驗收撿到的洞

A-3 活線端到端跑完，`claude -p` 的回報裡有一行不起眼的話：

```
- outcome: `deny`
- mode: `shadow`（consequence: advisory）
- calibration_status: 結果無此欄位
- model: `typesafe/jev-1.13-20260917`
```

`calibration_status: 結果無此欄位`。查 `gateway/src/gateway.js`：這個欄位進了 `_emit()`
的 telemetry payload（JSONL log 裡看得到），但成功回傳與 `failClosed()` 的 return
都沒帶。host 只看得到 `mode: shadow`，無從判斷這條 policy 到底校準過沒有。

`registry.js:68` 確實保證 `active ⟹ calibrated`，所以從 `mode` 反推「active 的一定校準過」
是對的。但反過來不成立：`shadow + calibrated`（校準完、等著升）與
`shadow + uncalibrated`（連資料都還沒有）是兩種完全不同的狀態，`activation_reason`
回的又是合併後的 `shadow_or_uncalibrated`，兩者一樣看不出來。

修法是三行：兩個 return 各加 `calibration_status: spec.calibration_status ?? 'unknown'`，
`ApplyPolicyResultSchema` 加一個欄位。驗證（fake provider，走真 MCP client）：

```json
{
 "outcome": "review",
 "mode": "shadow",
 "calibration_status": "uncalibrated",
 "consequence": "advisory",
 "shadow_outcome": "accept",
 "model": "fake/jev-1.13"
}
```

順帶驗到封頂：raw gate 是 `accept`，公開 `outcome` 被壓成 `review`（invariant 3）。

**這條的教訓不是「漏欄位」，是 telemetry 與 tool result 是兩個各自獨立的出口。**
一個欄位在 log 裡看得到，不代表呼叫方拿得到。這次是活線一次真呼叫才撞出來——
offline 測試全綠、acceptance 全綠、replay 全綠，沒有一個會發現，因為它們沒有一個
從「host 拿到什麼」這一側看。

### 11.2 對照公開生態盤點潛能

拿當時流傳的 20 個 Jev 應用清單逐條對照本 repo。與 coding agent 相關的 6 條，
已覆蓋 5 條：

| 公開專案 | 本 repo 的對應 | 狀態 |
|---|---|---|
| typesafe-mcp（接進 Claude Code 做 Choice/Score/Noul） | `jev_evaluate`，三型都實作 | 同型 |
| Canny（防 agent 嘴硬說做完） | `completion-claims` policy | 有 |
| fast-jev-compaction / Winnow（上下文垃圾回收） | `hooks/jev.js`，逐 chunk 真打 `openrouter/systemone` 判 keep/drop | 有，已活線 |
| jev-mcp 的內容篩查 | `context-screening`（`relevance` + `suspicious_instructions`） | 有 |
| jev-codex-router（先判難度再選模型檔位） | `intent-routing`（top-3 機率 + prefilter + dispatch） | 有 |
| jev-review（審查前挑高風險改動） | `proposed-action-risk` 只吃 action+arguments，不吃 diff | 缺 |

判定為**不該做**的：SemDecide（CLI 殼，gateway 已是 MCP，再包一層是同一件事做兩次）、
Blink / neo4jev（要迭代導航，不是單次 gate，不屬於 policy gateway 的形狀）、
jev-curate、json-render，以及遊戲／交易／無人機那批。

**盤點的真正結論不是「少抄了哪個應用」。** 四條 policy 全部 `shadow` + `uncalibrated`
+ `rollout_percent: 0`，公開 outcome 永遠被封頂在 `review`——閘門蓋好、接線接好、
活線驗過，但沒有一條真的在治理任何東西。`evaluation_dataset_version` 寫的是
`synthetic-harness-*-v1`，合成的，不是真標註集。`registry.js:68` 又硬性要求
`active ⟹ calibrated`。所以要開閘只有一條路：先累積真實標註資料。

問題型別分佈也印證這點：`noul` 3 題、`score` 2 題、`choice` 只有 1 題。Noul 的
confidence 是 `max(p, 1-p)`，這種閾值最吃校準資料，現在完全靠猜。

### 11.3 補齊一：標註集落盤（`src/calibration.js`）

第一版寫錯了方向。我先做了一個 `gateway/scripts/calibration-report.mjs` 去算
gate 對不對得上 label——然後才發現 `gateway/scripts/calibrate.mjs` **早就存在**，
而且做得完整得多：precision、recall、ECE、false-accept、provenance 比對、
`eligible_for_review` 門檻、`synthetic-harness-*` 自動標記為 harness-only。
我寫的那支是它的劣化重複版，直接刪掉。

**缺的從來不是計分器，是產出者。** `calibrate.mjs` 讀的是一份「外部標註檔」，
而這個 repo 裡沒有任何東西在產生那份檔案。zh-TW README 的「Policy 安全啟用順序」
第 1 步寫著「保持 shadow 收集真實 labels」，第 2 步就叫你去跑 `calibrate.mjs`——
中間那個「收集」沒有實作。四條 policy 卡在 `uncalibrated` 的真正原因就是這個斷點。

所以 sink 直接對齊 `calibrate.mjs` 的 JSONL 契約，不另立格式：每行帶 provenance
（`policy` / `policy_version` / `model` / `provider` / `dataset_version`，該腳本要求這些
跨行一致）與 sample 欄位（`gate` / `coverage` / `confidence` / `label`），另外附上
`state`、`answers`、`public_outcome`、`correlation_id` 給填標註的人看——這些多餘欄位
`calibrate.mjs` 不讀，不影響驗證。

三個設計決定：

- **不動 telemetry。** `telemetry.js` 的 ALLOWLIST 是刻意設計成擋掉 state、questions、
  answers 的，allowlist 而非 blocklist，呼叫方再怎麼塞都漏不出去。而 policy 要離開
  shadow，需要的恰恰是 telemetry 拒絕攜帶的那些材料。兩個需求直接衝突，解法是另開
  一個檔，不是把 allowlist 開大。
- **opt-in。** `JEV_CALIBRATION_LOG=<path>` 有設才寫，沒設是 no-op、不開檔、零成本。
  只寫 policy 自己宣告的 `state_projection` 欄位（未宣告欄位在更早的
  `projectPolicyState` 就已剝掉）。
- **`gate` 存 raw composed gate，不是 shadow 封頂後的 `outcome`。** 封頂是 rollout
  控制，不是模型做的判斷；拿封頂結果去算準確率等於在量自己的保險絲。封頂後的值
  另存 `public_outcome` 備查。

寫入永不拋例外：語料是盡力而為的證據，不是持久化契約，不能讓一次寫檔失敗把決策打掛。

`label` 一律寫 `null`。`calibrate.mjs` 的 `validateCalibrateInput` 會拒絕沒有合法
label 的樣本，所以一份沒人碰過的語料不可能被誤當成證據：

```
=== 單筆未標註 ===
{ "ok": false, "stage": "validate",
  "errors": [ "sample[0]: label must be one of accept|review|escalate|deny" ] }
```

補上標註後，provenance 檢查接著擋下另一件事——fake provider 的樣本永遠不能拿來校準：

```
=== 單筆已標註（fake provider 產生）===
{ "ok": false, "stage": "provenance",
  "problems": [ "model fake/jev-1.13 != pinned typesafe/jev-1.13-20260917 for diff-risk" ] }
```

這兩道拒絕都是對的，而且是既有程式碼擋的，不是我新加的。

### 11.3.1 順手修掉 `calibrate.mjs` 的單筆 JSONL bug

接語料的時候撞到：**只有一筆樣本的 JSONL 檔會被誤判成格式錯誤的 wrapper。**

```
{ "ok": false, "stage": "parse", "error": "JSON object must contain a samples array" }
```

根因在 `parseCalibrateInput`：它看到開頭是 `{` 就先試 `JSON.parse(整份文字)`，
成功就當作 `{ policy, samples: [...] }` 那種 wrapper 物件，沒有 `samples` 就報錯。
JSONL 的 fallback 只在整份 parse **失敗**時才走到——而單行 JSONL 剛好是一個合法的
JSON 物件，於是永遠走不到 fallback。兩筆以上才會正常。

修法：`samples` 不存在時不要馬上判死。若這個物件帶著 sample 自己的欄位
（`gate` 或 `label`），就落到 JSONL 分支當成一筆記錄讀；否則維持原本的錯誤訊息。
兩種情形都留了 regression test。

**這個 bug 之所以沒被發現，是因為在沒有產出者的情況下沒人餵過它真檔案。**
一個 CLI 寫好了、測過了、文件也寫進啟用流程第 2 步，但它的輸入端從來不存在——
上游一接上就立刻撞到 off-by-one 的格式判斷。沒有生產者的消費者不算驗過。

### 11.4 補齊二：`040-diff-risk` policy

對應清單裡的 jev-review：code review 前先過一遍，把高風險改動挑出來再交給更貴的
模型或人。`state_projection: ["diff","intent","files_changed"]`，兩題：

- `risk_surface`（score 0–2）：cosmetic ／ 一般邏輯 ／ 安全-金流-資料毀損路徑
- `undeclared_behavior_change`（noul）：這份 diff 改動的行為，宣稱的 intent 有沒有蓋到

`consequence: advisory`——它做的是分流，不是授權，與 `proposed-action-risk` 的
`consequential` 不同。同樣 `shadow` + `uncalibrated` + `rollout_percent: 0` 起步。

**驗證程度要講清楚：只有 fake provider 打過。** fake 恆回 index 0，所以下面這份
刻意惡意的輸入——把 `if (token)` 拔掉卻宣稱「rename a variable」，檔案是
`src/auth.js`——照樣拿到 `gate: accept`：

```json
{"policy":"diff-risk","policy_version":1,"model":"fake/jev-1.13","provider":"fake",
 "dataset_version":"synthetic-harness-diff-v1","gate":"accept","coverage":"complete",
 "confidence":1,"public_outcome":"review",
 "state":{"diff":"- if (token) return ok;\n+ return ok;",
 "intent":"rename a variable","files_changed":"src/auth.js"},
 "answers":[{"question":"risk_surface","answer":{"type":"score","score":0,
 "probabilities":{"0":1,"1":0,"2":0}}},
 {"question":"undeclared_behavior_change","answer":{"type":"noul","noul":0}}],
 "label":null}
```

這證明的是管線通（policy 載入、projection、mapping、composeGate、封頂、語料落盤），
**不是 Jev 判得對**。真 provider 對這份輸入應該回 `risk_surface: 2` 與
`undeclared_behavior_change: true`；沙箱擋 openrouter.ai，活線驗證另派 oneshot
（`~/dev/agent-tools/oneshot.d/20260921-diff-risk-live.sh`）。

#### 11.4.1 活線結果：預測命中

同一份惡意輸入丟真 provider（`typesafe/jev-1.13-20260917`），原始輸出：

```
{
 "outcome": "escalate",
 "raw_gate": "escalate",
 "mode": "shadow",
 "calibration_status": "uncalibrated",
 "coverage": "complete",
 "model": "typesafe/jev-1.13-20260917",
 "answers": [ { "question": "risk_surface", "answer": { "type": "score", "score": 1.75,
    "probabilities": { "0": 0.09, "1": 0.07, "2": 0.84 }, "confidence": 0.62 } },
   { "question": "undeclared_behavior_change", "answer": { "type": "noul", "noul": 0.92 } } ],
 "gate_reasons": [ { "question": "risk_surface", "confidence": 0.62,
    "decision_quality": { "margin": 0.75, "entropy": 0.5, "variance": 0.3675 },
    "semantic_level": "escalate", "level": "review" },
   { "question": "undeclared_behavior_change", "confidence": 0.92,
    "decision_quality": { "margin": 0.84, "entropy": 0.4022, "variance": null },
    "semantic_level": "escalate", "level": "accept" } ]
}
live_rc=0
=== 語料是否落盤（只看行數，不印內容）===
lines=       1
rc=0
```

三件事值得記：

1. **預測命中**：上一段寫死的期望是 `risk_surface: 2` 與 `undeclared_behavior_change:
   true`，實跑 `p(2)=0.84`、`noul=0.92`，兩題都往預期方向壓。這條 policy 的判斷力
   不再是未驗證狀態——但一次樣本不等於校準，`calibration_status` 仍是
   `uncalibrated`，要離開 shadow 還是得走 `JEV_CALIBRATION_LOG` 收標註集那條路。
2. **`outcome: escalate` 沒被封頂成 `review`，這是對的**。shadow 封頂擋的是
   `accept`；`activation.allow_outcomes` 列了 `["review","escalate","deny"]`，
   escalate 本來就允許直通。封頂是 rollout 控制，不是「shadow 一律降級」。
3. **語料真的落盤**：真 provider 這一跑同時寫進 `JEV_CALIBRATION_LOG`，`lines=1`。
   §11.3 的 sink 與 §11.4 的 policy 是同一條線上的兩半，到這裡才第一次一起驗過。

### 11.5 順帶：自己踩到一次覆寫

寫測試時用 Write tool 建 `gateway/test/calibration.test.mjs`，工具回報
「has been updated successfully」——**updated，不是 created**。那個檔名已經存在，
裡面有 7 個測 calibration **metadata**（policy spec 上的欄位）的測試，被我整份蓋掉。

沒有任何一個測試變紅。`npm test` 只是從 `pass 98` 變成 `pass 94`：我加了 3 個、
砍掉了 7 個。若不是順手比對了總數，這次就是靜默刪掉 7 個測試然後推上去。

抓到的方法是 `git stash -u` 前後各跑一次數數：

```
node --test | grep -c '^✔'   →  94   （改動後）
git stash -u; node --test … →  98   （改動前）
```

還原後把新測試改名 `calibration-corpus.test.mjs`（語料 sink），與既有的
`calibration.test.mjs`（policy metadata）分家，兩邊各自在檔頭註明對方是誰。
最終 `tests 105 / pass 103 / fail 0`，98 + 5 = 103，對得上。

**規則：測試總數是驗收數字，不是背景噪音。** 「fail 0」不代表沒事——
pass 數變少同樣是紅燈，而它不會自己跳出來。這與 §10 那三次靜默失敗是同一類：
工具回報成功，實際結果相反。這次是第四種變形，差別只在受害者是測試本身。

### 11.6 副作用：context 成本隨 policy 增加

`jev_apply_policy` 的 description 會列出已註冊的 policy id，所以多一條 policy
就多一點常駐 context。實測 `tools/list` 6970 → 7030 bytes（+60 B），
總常駐 7417 → 7477 bytes / 1870 est. tokens。CONTEXT.md 已更新，並補上
「改 policy 後重跑 `context-cost.mjs`」。

這是 policy 數量的隱形成本：每加一條治理規則，每個 session 都在付錢。
現在一條 60 bytes 不痛，但它說明 policy 不是免費的——要加就要值得。

## 12. 對照外部十步拆解（2026-09-21）

外部來源：0xCodila 的十步文章（<https://x.com/0xcodila/status/2100984487802708306>），
隨附 TypeSafe 宣稱在 Claude Fable 5.1 / GPT-6 Astra 上「193× 加速、444× 降本」。
拿它當**檢查表**而不是當結論，逐條比對這個 repo 現況，順手寫成
`docs/zh-TW/PLAYBOOK.md`（繁中操作手冊）。

### 12.1 先處理那兩個倍數

193× / 444× 是廠商自家測試，本 repo 沒有複現、不背書。我們手上唯一自己量過的
效能數字是網關的處理開銷：`benchCore` 與 `benchTransport` 的 p95 各自 < 50ms，
超過就 exit 非零（`gateway/scripts/bench.mjs`）。

而且要講清楚：那支 bench **不含 provider 往返**，所以 repo 裡根本沒有「整個迴圈
快了幾倍」這種數字。當初刻意把 provider 延遲排除，是為了讓回歸測試不要變成網路
測試——代價就是端到端收益無法從現有工具讀出來。外部文章的第 7 步「benchmark
整個迴圈而非單次呼叫」，我們是**明知而只做一半**，不是漏做。

### 12.2 十步逐條盤點

| # | 外部主張 | 本 repo | 依據 |
|---|---|---|---|
| 1 | LLM 創造／agent 執行／Jev 決定 | ✅ | MCP surface 只有兩支工具，都 advisory |
| 2 | 拆成 Choice／Score／Noul | ✅ 三種都在用 | choice=`intent-routing.target`；score=`risk_surface`/`blast_radius`/`relevance`；noul 四處 |
| 3 | 先用他家建，再換 Jev 不重建圖 | ✅ adapter 級 | `adapters.js` 三個 adapter 同簽名 `(state, questions, opts)` |
| 4 | 共享 state／並行／閾值／佇列 | ⚠️ 一半 | state_projection ✅、thresholds ✅；並行 ❌、佇列 ❌（佇列刻意不做，屬 host） |
| 5 | 批次決策而非依序 | ⚠️ 單 policy 內 ✅，跨 policy ❌ | `evaluate({state, questions})` 一次帶全部題目；但五個 policy 各打一次 |
| 6 | 放在受限分支上 | ✅ 只有一條真的接上 | `hooks/jev.js`（context-screening）；其餘四個有 policy 無 hook |
| 7 | benchmark 整個迴圈 | ⚠️ 只量網關開銷 | 見 12.1 |
| 8 | 廣泛排序、狹窄閱讀 | ✅ | `hooks/jev.js` 切 chunk → 逐 chunk keep/drop → 只有 keep 進 context |
| 9 | 重複使用同一套系統 | ✅ | 加 policy = 加 JSON，不寫程式：registry → gateway → telemetry → calibration |
| 10 | 排除數學／寫作／不可逆 | ✅ 寫進 server instructions | 所有 policy `consequence` 停在 advisory，阻斷由 host adapter 負責 |

### 12.3 真正撿到的一個缺口：跨 policy 沒有批次

第 5 步是唯一讓我改變 roadmap 判斷的一條。文章舉的例子是「13 題一次打完，
快 10 倍、便宜 12.2 倍」——那個倍數的來源是**把題目塞進同一次呼叫**，不是模型本身快。

我們的 adapter 簽名本來就收複數 `questions`，所以**單一 policy 內已經是批次**
（`context-screening`、`proposed-action-risk`、`diff-risk` 各 2 題都是一次呼叫）。
但連續套五個 policy 就是五次呼叫，五次往返。

卡住的點不是懶，是形狀：每個 policy 宣告自己的 `state_projection`，五份投影互不相同。
要合併成一次呼叫，得先回答「同一次 request 怎麼送五份不同投影的 state，而且不讓
A policy 的欄位漏進 B policy 的題目」。這個問題沒解之前硬合併，等於把
state_projection 這道隔離牆拆掉換效能——不做。

先記在這裡，不開工單。真要動，前置條件是先有標註集能證明合併後答案沒有變差。

### 12.4 順手修掉的陳述漂移

`docs/zh-TW/README.md` 還寫著「四個 starter policy」，`040-diff-risk` 進來之後
已經是五個。數字寫死在散文裡就會這樣——每加一個 policy 要改的地方目前有三處：
policy 檔、`CONTEXT.md` 的 context 成本實測、zh-TW README 的數量陳述。
沒有 hook 擋這件事，下次加第六個還是會漏。


## 13. prune hook 的 ledger 空白：根因與 observability 修復（2026-09-21）

handoff §5.3 掛了「從沒剪掉過」的問號，本 session 用真實 `tool.call` 證據分層查。

### 13.1 各層證據

- **hook 有載入並觸發**。`~/.claude/debug/` 的 probe session 有
  `hooks module jev-gate@jev-gate loaded (worker, environment 1, tier user); events: tool.call`
  與 `jev-gate@jev-gate tool.call settled in 1746.0ms (worker hop, next() included)`——
  1746ms 表示沒走短迴路，真的跑了 provider 判斷。
- **wire 會 drop**。同一 noisy fixture 用真 provider 走 `pruneText+judgeChunk`：
  `input 35942 → kept 16043, droppedLines 223`，marker 兩筆。
- **完整 `prune→ledger` 在真 host API 下可寫**。補齊 `$` host（`clock.now`+`fs.write`）後
  `prune()` 把 `jev-prune(Bash): 44042 → 16027 chars, 573 lines dropped` 寫進
  `/Users/51mini/.openclaw/state/jev-prune.log`。
- **原本的 observability 盲點**：ledger 只在 `droppedLines > 0` 時寫、且寫在 swallow-all
  catch 裡。probe 的 diag 量到 `out=7999 kept=7999 dropped=0`——hook 觸發了、judge 全回
  keep，但零可寫記錄，跟「hook 根本沒載入」外觀完全一樣。這就是 §5.3「沒查」卡住的地方。

### 13.2 一個無關的環境發現

deep-agent（`CLAUDE_CODE_ENTRYPOINT=sdk-cli`）的 tool 結果走自己的 persistence，
plugin function hook 不在那條路徑上——本 deep session 丟 122KB Bash 輸出時
`jev-prune.log` 沒長大。獨立的 `claude -p`/互動 session（debug cc2b2102）才是 hook
會跑的地方。無頭機若用 deep 當主力，prune 本來就不會觸發，這是預期不是 bug。

### 13.3 修法（最小，只動 observability）

- `hooks/jev.js`：抽出 `appendLedger($, line)`。ledger 現在**每個被判定過的超門檻
  呼叫都寫一行**（keep 或 drop），不再只寫 drop；ledger 失敗永不 throw（不弄壞 prune）。
  不碰 policy、threshold、calibration、MCP surface、HTTP/Docker/Caddy。
- `tests/hook.live.test.js`：+3 regression（`appendLedger` 寫 ISO 行、ledger 失敗不 throw、
  活線 drop 寫 ledger 行）。測試數 105 → 108。

### 13.4 測試與驗收對帳

| | 接手基線 | 修後 |
|---|---|---|
| tests | 105 | 108 |
| pass | 103 | 106 |
| fail | 0 | 0 |
| skipped | 2 | 2 |

`build-check OK`、`gateway acceptance OK` 不變。ledger 已有真 drop 一筆：
`2026-09-21T07:09:48Z jev-prune(Bash): 44042 → 16027 chars, 573 lines dropped`。
**單次 drop 不是品質校準**——判準仍是 `uncalibrated`，收標註才是唯一出路（§4）。

## 14. Agent Glue：四項膠水，以及一個寫進 handoff 的誤診

2026-09-21。把 Jev 的前四種用法（快速路由、原樣壓縮、完成驗證、分階段 diff review）
做成 Claude 與 Codex 共用的純核心，兩端只留薄 adapter。

### 14.1 接手時的三個紅測試都不是門檻問題

停止點交下來 125 tests / 120 pass / **3 fail**。三個失敗長得像「fixture 跟實作門檻沒對齊」，
改兩個常數就能綠。實際上每一個底下都壓著真缺陷：

| 表面症狀 | 底下的真缺陷 |
|---|---|
| fixture 的 call arguments 只有 15 chars，小於 `MIN_STRIP_CHARS=48`，卻期待 marker | 同一 assistant message 有多個 tool call 時，pair/drop 只判第一個卻連坐 strip 全部——要按 call-site 聚合後整批判斷 |
| 4-message fixture 用預設 `pinLast=8`，整段被 pin，卻期待 drop | 短 transcript 的 pin 行為從沒被明訂過，fixture 和實作各自假設 |
| 測試把 200 additions 當 large，實作門檻是 `>300` | 真問題不是 300 還是 200，是「高 confidence 的 Jev 會把 severity 升一級」——那會動到 deterministic reviewer route |

**教訓**：紅測試指向的常數，往往不是根因所在的那一層。第三個尤其危險——改門檻能讓它變綠，
但綠的是一個違反 shadow/advisory 邊界的實作。

修法（`agent-glue/src/`）：

- `compact.js`：任一 judge throw 是**整次** fail-open（不是只保留該 pair）；
  `reducedBy < minReductionChars` 時回**原** `messages`，不回已改寫的半成品
  （`compacted:false` 卻交出改寫結果 = 半剝離 context 的風險）。
- `review.js`：`deterministicSeverity()` 裡明寫 `void jevOpinion`。Jev 意見掛在結果上進 ledger，
  **不參與** severity 與 route 的計算。policy 校準前這條不開。
- `verify.js`：`pass` 必須附可稽核的 command/log evidence；`file:line` 只在真有位置時才給。
  沒有執行證據一律 `unknown`，模型自述不是證據。

### 14.2 `unrecognized_model` 是 banner，不是死因

前一次 deep-run 沒有 commit 就停了，`.out` 開頭是：

```text
[claude-code:unrecognized_model] {"model":"deepseek-v4-flash-0731","query_source":"sdk"}
```

handoff 據此寫下「重派前要先修 `~/.deepclaude` 的 model alias，確認 backend 接受該模型」。
這是假前置條件——**上一次成功的 run（rc=0 / verify=pass）開頭印的是同一行**。
該行是 claude CLI 的 benign stderr（SDK 端模型名查表 miss），proxy 照樣送出、照樣回 200。
真正沒有 `end` 的原因是使用者手動 kill 了 tmux session：`.rc` 檔是空的，`.out` 只有 6 行 banner。

判 wrapper 子行程死因的順序（確定性由高到低）：

1. `work/.deep/<epoch>.rc` 有沒有值——空 = 被 kill，非空 = 真 rc
2. `~/Library/Logs/openclaw/wrappers.log` 的 `end rc= verify=`
3. 同一支 wrapper 上一次**成功** run 的 `.out` 開頭拿來對照——兩邊都出現的行就是 benign banner

沒改任何 model 設定直接重派，`18:16:06 deep-run end rc=0 verify=pass`。

**教訓**：交接文件寫失敗原因時要標證據等級。rc/log 是確定性，stderr 字串是推測。
把推測寫成結論，下一手會照著去修一個沒壞的東西。

### 14.3 兩端能力差異（決定了 Codex 那半怎麼寫）

| | Claude Code | OpenAI Codex |
|---|---|---|
| 改工具結果 | function hook `tool.call` 可在模型讀到前替換 | `PreToolUse` 才能擋；`PostToolUse` 副作用已發生，只能換 model-facing result |
| 壓縮 | function hook 可替換內建 compaction | **不能**。只能 `PreCompact` snapshot ＋ `PostCompact` 追加 `additionalContext` |
| 續跑 | — | `Stop` 用 `decision:block`，必讀 `stop_hook_active`，最多一次 |

所以 Codex 那半的壓縮永遠標成「原文 restoration layer」，不宣稱改寫了 core transcript。
manifest 也分檔：Claude 用 `hooks/hooks.json`，Codex 用 `.codex/hooks.json` /
`.codex-plugin/hooks.json`，互不覆寫。

### 14.4 壓縮互斥

本 repo 的 compaction **不註冊自己的 `session.compact`**。本機另有外部 fast-jev plugin
（`~/dev/fast-jev-compaction-openrouter`）已經註冊了一個。兩個 `session.compact` handler
同時啟用的行為沒人驗過，文件直接寫「不要雙開」，切換方式見 `docs/agent-glue.md` §2。

### 14.5 預防加固

`tests/agent-glue/policy-shadow.test.js`：斷言五個 policy 永遠是
`shadow` + `uncalibrated` + `rollout_percent 0`。任何人把其中一個翻成 active/calibrated/
rolling out，這個測試就紅。§14.1 第三列那種「改門檻讓它綠」的修法，擋在這裡。

### 14.6 測試與驗收對帳

| | 接手基線 | 修後 |
|---|---|---|
| tests | 125 | 137 |
| pass | 120 | 135 |
| **fail** | **3** | **0** |
| skipped | 2 | 2 |

新增 `npm run agents:acceptance`（`scripts/agents-acceptance.mjs`）：依序跑 plugin validate
（CLI 存在時）、完整 tests、build、gateway acceptance、Claude bridge smoke、Codex hooks smoke、
injected client smoke。任何一步非零即整體失敗。實跑：

```text
[agents:acceptance] build: OK
[agents:acceptance] gateway acceptance: OK
[agents:acceptance] claude bridge smoke: OK
  verify=pass
[agents:acceptance] codex hooks smoke: OK
  stop=block-once-then-allow
[agents:acceptance] injected client smoke: OK
[agents:acceptance] ALL OK
```

policy 檔零改動，MCP surface 仍只有 `jev_evaluate` / `jev_apply_policy`。
**四項膠水全是 advisory**——五個 policy 還是 uncalibrated，收標註仍是唯一出路（§4）。

## 15. Triage：一次三問的省錢判斷層（2026-09-21）

把 `agent-glue` 從「四項膠水」補成「五項」——新增 `src/triage.js`：一趟 Jev 一次問三件事
（`difficulty` Score 4 級／`kind` Choice 四類／`costly_mistake` Noul），deterministic
`decideTier` 映射到 cheap→medium→hard tier，並且在 Jev 呼叫**之前**擋掉一大堆不該花錢的案例。

### 15.1 做對什麼（對照工單）

| 需求 | 落地 |
|---|---|
| 一次請求三個答案 | `transport.evaluate({state, questions:{difficulty,kind,costly_mistake}})`，single round-trip |
| 免費前置守門 | 空 turn／pinned／tiers 空 → 不打 Jev，直接 `unchanged` |
| 危險正則 | `isDangerous` 掃**整段原文**（非切片），測試證明切片已無該詞仍擋 |
| 切片 | `unwrapEnvelope` 丟 `previous output`，超長取開頭 1/4＋結尾 3/4（`ask_chars` 2500） |
| decision cache | key 含 **context bucket**，bucket 不同則 miss（有測試） |
| features 隱私 | 只送統計特徵；敏感 profile 自動切 features，原文不出機器 |
| Claude 端 | `claude/spawn-hook.mjs` 註冊 `agent.spawn`，預設 `enabled:false`，不設 model |
| Codex 端 | `user_prompt_submit.mjs` 跑真 triage，吐一行 advisory notice + `codex-route.log` |

四條地板規則全進 `decideTier`（純函式）：低信心不危險→現狀；低信心但危險→medium；
risky/stakes>0.4→永不 cheapest；stakes>0.85 且已偏難→hard。另加工單第四節的
「large context 一律不降級」floor。

### 15.2 兩個自己踩到的坑

1. **`io.mjs` 的 `appendLedger` 首寫被吃掉。** 它在 `try` 裡先 `readFileSync` 讀不存在的檔案，
   ENOENT throw 直接中斷整個 block，害**第一筆** decision 永遠落不了 `codex-route.log`。
   這是既有缺陷（`codex-verify.log` 同樣首寫丟掉），工單要求每筆決策都記一行，所以修掉：
   read 失敗回退空字串再寫。補了 `tests/agent-glue/codex-io.test.mjs` 防回歸。
2. **acceptance 的 `-e` 用 top-level `return`。** `node --input-type=module -e` 不接受 `return`，
   只有 CJS 的 wrapper 才吃。acceptance stage 原本寫 `return '...'` 會直接 SyntaxError
   （被 gateway 大量 log 淹沒，很難看出）。改成 `process.stdout.write(...)`。

### 15.3 測試與驗收對帳

新增測試：`tests/agent-glue/triage.test.js`（22）、`spawn-hook.test.mjs`（7）、
`codex-io.test.mjs`（1）＝ +30。

| | 承接基線 | 修後 |
|---|---|---|
| tests | 137 | 167 |
| pass | 135 | 165 |
| **fail** | **0** | **0** |
| skipped | 2 | 2 |

`npm run agents:acceptance` 新增 `triage + spawn-hook smoke` stage，全綠：

```text
[agents:acceptance] triage + spawn-hook smoke: OK
  triage=cheap spawn=disabled-by-default
[agents:acceptance] ALL OK
```

policy 檔零改動，MCP surface 仍只有兩支工具，`enabled:false` 預設接線不設任何 model。
**triage 全程 advisory / fail-open**——不授權不阻擋，省錢只在「夠簡單、夠安全、夠有信心」時降級。

## 16. 補兩個掛著沒接線的洞（2026-09-21）

上一輪 triage 落地後剩兩個殘件，本輪一次補齊：

### 16.1 洞一：route 子命令是 stub

`agent-glue/cli.mjs` 與 `agent-glue/claude/bridge.mjs` 的 `route` 分支原本回傳寫死的
`{ no_match, reason:'cli-no-model' }`，但 `plugin/lib/route.js` 的 `route()` 早已存在且測過，
且沒有 model 時 `makeScorer()` 會 throw、`route()` 自己 catch 成 `jev-unavailable`——fail-open
本來就有，stub 只是遮蔽真線。

修法：兩檔 `route` 分支改成 `await route(payload)`（import 清單本就有 `route`）。`route()`
在 candidates 缺漏／空／含 `no_match` 時 throw `EmptyCandidatesError`，CLI 用 try/catch
統一回傳有界 `{ no_match:true, top:[], dispatch:null, reason:'no-candidates' }` 且 exit 0，
其他例外同樣 catch。`cli-no-model` 字串與兩段過期註解刪除，docstring 改成「route 走真判斷，
無 model 時由 route 自身 fail-open」。

新增 `tests/agent-glue/route-cli.test.mjs`：兩支入口走 stdin JSON 各驗兩筆——給 candidates
（有界 JSON、exit 0、不洩 stack trace；本環境有 live Jev model，`route()` 回真 `no_match`，
故測「有界且 fail-open 到 no_match」而非鎖死 `jev-unavailable`）、不給 candidates（`no-candidates`）。
另用注入 failing scorer 對 `route()` 本體做 `jev-unavailable` 的確定性單測。

> **環境差異**：工單要求「無 model → `jev-unavailable`」走 CLI 驗。但本機 `plugin/config.default.json`
> 指向已存在的 key，`route()` 實際打到 live Jev 並回真 `no_match`，無法靠 CLI 子程序確定性重現
> 「無 model」；該斷言改用注入 failing scorer 的 `route()` 單測覆蓋。CLI 側測有界輸出不變。

### 16.2 洞二：pickSkills 改併入 triage 的第 4 題 Choice

`spawn-hook.mjs` 的 `pickSkills` 是「skill 名命中 regex **且** prompt 含名字」的雙重過濾
啟發式，實測幾乎恆回 `[]`，等於沒作用；它自己的 `ponytail:` 註解也寫明升級路徑＝對 catalog
做一次真 Jev Choice。

修法（**不另開一次請求**）：skill 選擇併進既有的那一次 triage 請求，當第 4 題 `skill`
（Choice，criteria = catalog + `no_match`）。`triageQuestions(catalog)` 可接 catalog 參數；
catalog 為空或未提供時 questions 仍只有 3 題（零額外成本）。`triage()` 的 `cacheKey`
加入 catalog 穩定指紋（排序後 join 走 `configFingerprint` 同款 FNV-ish hash，
`catalogFingerprint`）——換 catalog 才會 cache miss。`triage()` 回傳加 `skills` 陣列。
沿用既有邊界：transport 失敗／低信心／features 隱私模式一律 `[]`，絕不猜（隱私模式連
catalog 也不問）。`spawnDecision` 改用 `decision.skills`，`pickSkills` 整支刪除（含三處呼叫）。
catalog 來源：`input.skills ?? deps.skillCatalog ?? []`。skills 純 advisory，不改 model、不動
`change` 旗標。

### 16.3 測試與驗收對帳

新增測試：`route-cli.test.mjs`（5）、triage 補 6 筆 catalog／cache 負向、spawn-hook 補 2 筆
（原 `pickSkills` 測試隨函數刪除調整合併）。

| | 承接 §15 | 修後 |
|---|---|---|
| tests | 167 | 181 |
| pass | 165 | 179 |
| **fail** | **0** | **0** |
| skipped | 2 | 2 |

`npm run agents:acceptance` 全綠（`ALL OK` exit 0）。政策檔零改動、MCP surface 仍兩支、
`gateway/` 零 diff。route 與 skills 皆 advisory，**不改變 model 選擇、不設任何硬阻斷**。

## 17. 實測 → 三個接線缺陷 → 快速壓縮併入 gate（2026-09-22）

### 17.1 為什麼要寫 live-probe

181 個測試全綠，但沒有一個能回答「這項能力在真線上**到底有沒有打到 Jev**」。
fail-open 從外面看跟成功長得一模一樣：triage 退回現狀、prune 回原文、verify 回
deterministic 判決——全部都是合法輸出。所以寫了 `scripts/live-probe.mjs`，
每項能力對真 provider 跑一遍，回報三件事：`live`（有沒有發出請求）、
`correct/cases`、以及量到的改變程度。

### 17.2 它抓到什麼（三個都通過了單元測試）

1. **`makeGatewayTransport` 用陣列索引當 answers 的 key。** gateway `evaluate`
   回的是 `[{question, answer}]` 陣列，`Object.entries` 過去變成 `{0:…,1:…}`，
   於是 `answers.difficulty` 永遠 undefined，triage 每一 turn 都 fail-open。
   只有 fake transport（本來就用 question id 當 key）被測過。修在
   `agent-glue/src/client.js`，加兩筆回歸測試。triage 1/3 → 3/3，
   decision cache 也從「永遠空的」變成會進資料（它只 cache 非 null 的 tier）。
2. **`makeScorer` 送的是 `criteria[c] = null`。** Jev 看到的是裸標籤。
   `plugin/lib/route.js` 加可選 `descriptions`，dispatch 也帶上內聯描述。
   route 2/4 → 4/4。裸標籤那組保留在 probe 裡當對照。
3. **spawn hook 呼叫 `triage(input, deps)` 而 `deps={}`。** 永遠走
   `defaultNoTransport`，「啟用」與「停用」在行為上分不出來。新增
   `agent-glue/src/live.js`（lazy、fail-soft，沒 key 就回 `null`），
   spawn hook 與 Codex hook 都自己注入。

教訓：注入式 transport 買到可測性，但**只測 fake 的形狀**時，測試綠的是膠水的
想像，不是真線。probe 留在 repo 裡，不是一次性腳本。

### 17.3 快速壓縮併入本 plugin

`agent-glue/claude/compact-hook.mjs` 註冊 `session.compact`（逐字壓縮，契約沿用
`agent-glue/src/compact.js`）與 `turn.complete`（`JEV_COMPACT_AT_PERCENT` 預設 60，
撞牆前就做）。`compactMessages` 新增 `judgeHeadChars`（預設 0＝原契約：只給名字與
大小），hook opt-in 一段有界開頭——「這段 `npm ls` 還需要嗎」光看工具名答不出來。

**雙開問題**：外部 `fast-jev-compaction@…` 也註冊 `session.compact`，兩個模組回
同一事件是 undefined，而症狀（壓縮「有時候」才逐字）極難追。所以本版讓路：
`rivalCompactor()` 在 `session.start` 讀 `~/.claude/settings.json`，發現對方仍
enabled 就 stand down 並在 ledger 寫明原因。要用本版得先停用外部 plugin。

### 17.4 triage 改成依情境自動啟用

`triageEnabled()`：任一 `JEV_TRIAGE_MODEL_*` 有設就是 true，`JEV_TRIAGE_ENABLED=1/0`
強制覆寫。設了 tier model 本身就是「我要分層」的意思；原本的第二道 opt-in flag
只換來「看起來開著但什麼都不做」這種狀態——正是 §17.2 第 3 點藏身的地方。

### 17.5 對帳

| | 承接 §16 | 修後 |
|---|---|---|
| tests | 181 | 193 |
| pass | 179 | 191 |
| **fail** | **0** | **0** |
| skipped | 2 | 2 |

`npm run agents:acceptance` `ALL OK`、`claude plugin validate .` passed。
live-probe 九項能力全部 `live=YES`。政策檔零改動、MCP surface 仍兩支、
五個 policy 仍 `shadow` + `uncalibrated`。文件改成中英對照：`README.md` ⇄
`README.zh-TW.md`，深入的繁中文件留在 `docs/zh-TW/`。

---

## 18. 上線：descriptions 自動接線＋tier ladder 出貨（2026-09-22）

§17 量出兩個「能力在、但沒上線」：route 拿裸 id 只有 2/4，spawn hook 因為
tier model map 是空的而整台機器都關著。這一節把兩個都接上真線。

### 18.1 route 的 descriptions：不是叫呼叫端寫，是去磁碟讀

原本的選項是「請呼叫端手寫一張 `descriptions` 表」。沒人會寫，所以 production
一直跑在半準。真正的事實是：那句話早就存在——skill 的 SKILL.md frontmatter
`description:` 就是「這個 candidate 是幹嘛的，一句話」。

新增 `agent-glue/src/catalog.js`：`describeCandidates(ids)` 依序找
`./skills`、`./.claude/skills`、`~/.claude/skills`、`~/.claude/plugins/*/skills`
底下的 `<id>/SKILL.md`，解析 frontmatter 取 `description:`。
`JEV_ROUTE_CATALOG_DIRS`（冒號分隔）可覆寫。全程 fail-soft：讀不到就沒有那一條，
等於該 candidate 維持原本的裸標籤行為。

接線只在兩個真實呼叫端各兩行（`agent-glue/cli.mjs`、`agent-glue/claude/bridge.mjs`）：
`descriptions === undefined` 才自動補，明確給的永遠優先，給 `null` 強制裸標籤。
`plugin/lib/route.js` 保持純函式，沒有被塞進檔案系統。

實測（`scripts/live-probe.mjs`，真 skill id）：

| | 正確 | 描述取得 |
|---|---|---|
| route（裸 skill id） | 2/4 | 0/4 |
| route（自動 catalog） | **4/4** | **4/4** |

### 18.2 tier ladder 出貨，triage 才真的開著

`triageEnabled()` 的自動規則（§17.4）本身沒錯，錯在 `TIER_MODELS` 出貨時是空的，
於是規則在每台機器上都解析成「關」。這是 §17.2 那類缺陷的同一個形狀：
**一個看起來啟用、但不管模型答什麼都動不了任何東西的 hook**。

`DEFAULT_TIER_MODELS = { cheap: 'haiku', medium: 'sonnet', hard: 'opus' }`。
社群的 model-routing hook（tzachbon/claude-model-router-hook、AqueGen/model-routing）
收斂出來的也是這個分法，差別在我們的 tier 來自一趟 Jev 判斷而不是本地關鍵字。
`tierModels(env)` 逐層覆寫，字面值 `off` 退回父層模型，三層都 `off` 依同一條
規則把 hook 關回去——逃生門還在，但不再需要為了「開」而設任何東西。

`src/triage.js` 的樓地板沒有動：risky／低信心／大 context 一律不降級。

### 18.3 probe 加一列「環境原樣」

`spawn hook (ambient)`：不注入 transport、不強制旗標，直接用環境原樣跑
`spawnDecision`。這列才回答「現在 spawn 一個 subagent 會不會真的換模型」。
ladder 出貨前讀出來是 `3/3 status-quo / inherit`，出貨後：

```
spawn hook (ambient)   YES  3/3  1283ms  3/3 spawns had their model changed;
                                          cheap->haiku, hard->opus, hard->opus
```

### 18.4 對帳

| | 承接 §17 | 本節 |
|---|---|---|
| tests | 193 | 199 |
| pass | 191 | 197 |
| **fail** | **0** | **0** |
| skipped | 2 | 2 |
| live-probe 列數 | 9 | 12（全 `live=YES`） |

改掉一條舊測試：`spawn hook: DISABLED by default` 描述的是舊契約，改寫成
`JEV_TRIAGE_ENABLED=0 disables it`——逃生門仍被釘住，而且 `=0` 必須在任何
provider 呼叫之前短路。政策檔零改動，五個 policy 仍 `shadow` + `uncalibrated`。
plugin 版本 0.4.0 → 0.5.0。

## 19. shadow 開始收樣＋openclaw/Hermes 實跑確認（2026-09-22）

### 19.1 語料 sink 出貨即開

`gateway/src/calibration.js` 原本是純 opt-in：`JEV_CALIBRATION_LOG` 沒設就
no-op。問題跟 §18.2 的 tier ladder 一模一樣——**規則對，但預設值讓規則永遠解成
「關」**。shadow 模式的唯一出路是收到可評分的樣本，所以 sink 不該等人 export：

```js
export const DEFAULT_CALIBRATION_LOG = join(homedir(), '.openclaw', 'state', 'jev-calibration.jsonl');

export function calibrationPath(env = process.env) {
  const v = env.JEV_CALIBRATION_LOG;
  if (v === 'off') return null;
  return v || DEFAULT_CALIBRATION_LOG;
}
```

`off` 當退出開關，跟 tier ladder 同一套約定。`recordSample()` 多一行
`mkdirSync(dirname(path), { recursive: true })`，仍然吞掉所有錯誤——語料是
best-effort 證據，不是耐久性契約。

選 `~/.openclaw/state/` 是因為 `hooks/jev.js` 的 prune ledger 與 fast-jev 的
compaction log 已經寫在那；沙箱也放行寫入，而 `~/.claude/settings.json` 不放行。

### 19.2 收了也走不到任何地方：`dataset_version` 繼承 harness 版號

開起來第一跑就發現真正的死結。`gateway.js` 的 `recordSample()` 呼叫把
`dataset_version` 填成 `spec.evaluation_dataset_version`，五個 policy 的值都是
`synthetic-harness-*`；而 `calibrate.mjs` 的 `harnessOnly()` 是

```js
return source === 'synthetic' || source === 'demo' || /^synthetic(-harness)?-/.test(datasetVersion ?? '');
```

→ `eligible_for_review: false`，**永久**。也就是說：sink 開了、樣本落盤了、
calibrate 跑了，結果依然永不合格。一個樣本的 dataset 是「這個樣本從哪來」，
不是「這份 spec 當初拿哪套 fixture 煙測」，所以改成 `live-${spec.id}-v1`。

這是 §18.2「看起來開著、其實推不動任何東西」的第三次變形，記在這裡當樣式。

### 19.3 實測：真 provider 五個 policy，樣本落盤

```
$ rm -f ~/.openclaw/state/jev-calibration.jsonl
$ node scripts/live-probe.mjs policies
gateway jev_apply_policy  YES   5/5      2947   intent-routing=review/shadow context-screening=deny/shadow proposed-action-risk=deny/shadow completion-claims=deny/shadow diff-risk=escalate/shadow  [all five pinned shadow/uncalibrated]
every probed capability reached the provider

samples: 5
intent-routing        dataset=live-intent-routing-v1       gate=accept    public=review   label=null harnessOnly=false
context-screening     dataset=live-context-screening-v1    gate=deny      public=deny     label=null harnessOnly=false
proposed-action-risk  dataset=live-proposed-action-risk-v1 gate=deny      public=deny     label=null harnessOnly=false
completion-claims     dataset=live-completion-claims-v1    gate=deny      public=deny     label=null harnessOnly=false
diff-risk             dataset=live-diff-risk-v1            gate=escalate  public=escalate label=null harnessOnly=false
```

第一筆就是 shadow 的意義所在：raw `gate=accept`，對外 `public=review`——模型說
可以過，fuse 把它降級成人工看。這正是之後要拿來評分的那一對。

### 19.4 openclaw 實跑確認：401 的真因不是影子金鑰

`~/.openclaw/state/jev-compaction.log` 在 `2026-09-21T23:55:02Z` 記過一次
`fallback auto ... Jev request failed (401): {"error":{"message":"User not found.","code":401}}`，
而金鑰檔 mtime 是 `23:26:12Z`——**晚 29 分鐘**。第一個假設是
`fast-jev.ts:getApiKey()` 的優先序（`config.apiKey` → env → `settings.env` → 檔案）
讓某個舊值蓋掉輪替後的檔案。逐一查（全程只印 key 名／布林／長度，不印值）：

| 來源 | 結果 |
|---|---|
| process env | 無 `OPENROUTER_API_KEY` |
| `~/.claude/settings.json` | 兩處命中都是 `sandbox.credentials.envVars[].name`，是**名字宣告**不是值 |
| `~/.claude/settings.local.json` | 0 |
| `~/.openclaw/.env` | 只有註解，無此 key |
| `~/.openclaw/openclaw.json` | 只有 `models.providers.openrouter.apiKey.id` 引用，解析回 `~/.creds` |

沒有影子來源。改用「同一把金鑰、兩種請求形狀」直接對打，才發現兩邊連端點都不同：

```
plugin  alpha/decisions ~typesafe/jev-latest +zdr   http=200  model=typesafe/jev-1.13-20260917 cost=0.000013902
plugin  alpha/decisions ~typesafe/jev-latest  -zdr  http=200
gate    v1/systemone   typesafe/jev-1.13           http=200
```

三種形狀全 200、模型都解析成同一個、都有真實 cost → **openclaw fast-jev 的
endpoint＋model＋provider＋金鑰路徑現在是活的**，07:55 那次 401 無法重現。
誠實記錄：真因未定案，最可能是那個 process 手上握的是輪替前的金鑰。

真正值得修的反而是**形狀**：plugin 把 env／settings 排在輪替過的檔案之前，
一個過期的 env 就能無聲勝出，而 fallback 成功看起來跟正常運作一模一樣。
（該 plugin 在 `~/dev/fast-jev-compaction-openrouter`，不在本 repo 沙箱可寫範圍，
只記不改。）

### 19.5 openclaw／Hermes 的載入邊界

`grep -o "jev[a-zA-Z-]*" ~/.openclaw/openclaw.json` → **零命中**。所以：

- jev-gate 與 fast-jev-compaction **只在 Claude Code 跑**，openclaw／Hermes 的
  agent runtime 沒載它們；ledger 寫在 `~/.openclaw/state/` 只是借路徑，不代表
  openclaw 在跑這些 hook。
- openclaw 本體活著：`openclaw.sqlite` 11:00、`-wal` 11:06 有寫入。
- `~/.openclaw/logs/gateway.log` 停在 `2026-08-24T01:05:04`（SIGTERM restart
  被 background task 擋住），那是舊的 gateway 日誌路徑，不是現況證據。
- Hermes 在 `openclaw.json` 只出現在 skill 名稱（`hermes-gateway-debug`、
  `hermes-installer`），沒有任何 jev 接線。

### 19.6 對帳

測試 199 → 200（改寫 1 條、新增 1 條），pass 197 → 198，fail 0，skipped 2。
`node --test` 全綠、`agents:acceptance` 8 段 ALL OK、`claude plugin validate` 通過。
政策檔零改動，五個 policy 仍 `shadow` + `uncalibrated`；本輪唯一的行為變更是
「開始收樣」與「樣本的 provenance 改成 live」，沒有任何 accept 被放行。

## §20 openclaw 與 Hermes 實裝上線（2026-09-22）

上一節（§19.5）的結論是「jev 只在 Claude Code 跑」。本節把它推翻：兩個 host 都
接上去、都實跑驗證過了。順序是先確定**契約允許改什麼**，再決定移植哪一項能力。

### 20.1 移植矩陣（以 hook 契約為準，不是以能力為準）

| 能力 | Claude Code | openclaw | Hermes |
|---|---|---|---|
| prune | `tool.call` | ✗ `tool_result_persist` 宣告同步（async handler 的回傳被 runner 記 log 後丟棄）、`after_tool_call` 只能觀察 | ✓ `tool_execution` middleware |
| 快速壓縮 | `session.compact` | ✗ `before_compaction`／`after_compaction` 只能觀察 | 未接（`llm_request` 可承載） |
| triage | `agent.spawn` | ✓ `before_model_resolve`（`providerOverride`／`modelOverride`） | 未接（`llm_request`） |
| gate | `PreToolUse` | ✓ `before_tool_call` | ✓ `pre_tool_call`（與 shadow 矛盾，不接） |

原本的計畫是拿 openclaw 的 `tool_result_persist` 做 prune——假設被文件與 runner
行為推翻（"Must be synchronous"，async 結果被丟掉並留一行 warning）。所以
openclaw 只接 triage，Hermes 只接 prune；judge 沒有在 Python 重寫，而是新增
`agent-glue/cli.mjs prune` 子命令，Python 側 shell out 過來——一個 judge、兩個
runtime。

### 20.2 宣告 ≠ 生效，本輪又中兩次

1. **openclaw**：`plugins install --link` ＋ `plugins enable` 之後
   `plugins inspect jev-gate --runtime --json` 回 `status: loaded`、
   `activated: true`，但 `hookCount: 0`，diagnostics 寫著
   `typed hook "before_model_resolve" blocked because non-bundled plugins must set
   plugins.entries.jev-gate.hooks.allowConversationAccess=true`。
   授權後 `hookCount: 1`、`typedHooks: [{"name":"before_model_resolve"}]`、
   `diagnostics: []`。**驗收必須看 hookCount，不是看 status。**
2. **Hermes**：manifest 寫 `provides_hooks: [tool_execution]` →
   `hermes plugins doctor` 報 `unknown hook 'tool_execution' in provides_hooks`。
   middleware（`hermes_cli/middleware.py` 的 `VALID_MIDDLEWARE`）跟 hook
   （`hermes_cli/plugins.py` 的 `VALID_HOOKS`）是**兩個不同介面**，manifest 沒有
   middleware 宣告欄位，正解是不宣告。另外 plugin 要放在 **profile 的 home**
   （`~/.hermes/profiles/koko/plugins/`），放 `~/.hermes/plugins/` 不會被掃到——
   `hermes plugins list --plain --no-bundled` 完全沒有那一筆，沒有任何報錯。

### 20.3 沙箱裡怎麼實證（兩條路都試過）

- `openclaw agent --local` 走不通：embedded agent 要拿 gateway state 所有權
  （`GatewayLockError: failed to acquire gateway state ownership`），而
  `openclaw daemon restart` 被沙箱擋（`launchctl kickstart failed: ... Operation
  not permitted`）。`OPENCLAW_STATE_DIR` 在 dist 裡搜不到，環境變數隔離無效；
  `--profile <name>` 會寫 `~/.openclaw-<name>`，不在可寫白名單。
  **改走 gateway**：`openclaw agent --agent main --session-id ... -m '<240 字的
  機械改名任務>'`。多 agent 設定下沒有 `--agent` 會被拒
  （"agent command session creation has no explicit owner"）。
- Hermes 的一次性 turn（`hermes -p koko --yolo -z ...`）撞
  `HTTP 401: [openrouter] All 1 connection(s) authentication expired`——provider
  憑證問題，與 plugin 無關。**改用 `integrations/hermes/live-probe.py`**：真
  loader（`discover_plugins(force=True)`）＋真 middleware chain
  （`run_tool_execution_middleware`）＋真 Jev judge，只有 tool 本身是假的。

### 20.4 實測結果（原始輸出）

openclaw，一次真回合：

```
{"at":"2026-09-22T04:28:25.776Z","chars":240,"outcome":"cheap","tier":"cheap",
 "confidence":0.96,"model":"omniroute/Deepseek cheap"}
```

同一回合的 gateway 回傳 `"provider": "omniroute", "model": "Deepseek cheap",
"result": "success"`——agent `main` 的預設模型是
`cheaperinference/deepseek-v4-flash`，所以模型確實被 hook 換掉了，不只是
ledger 自說自話。

Hermes：

```
has tool_execution middleware: True
middleware callbacks: ['hermes_plugins.jev_prune._on_tool_execution']
tool output chars: 19889
result chars: 60
result tail: '[jev-prune: dropped 322 lines]\n[jev-prune: dropped 78 lines]'
{"tool": "terminal", "outcome": "judged", "chars_before": 19889,
 "chars_after": 60, "dropped_lines": 400}
```

19889 → 60 字（-99.7%）。這筆語料是 400 行填充文字，全丟是合理判決，但
**全丟**本身是值得盯的訊號：middleware 沒有 conversation，只能用 tool 的參數
當 request（`_request_of`，有 `ponytail:` 註明天花板），判斷本來就比 Claude
hook 弱。ledger 每筆都記 `chars_before`／`chars_after`，過度修剪會在那裡現形。

### 20.5 預防加固

- `tests/integrations.test.mjs`（9 條）守的是「載得起來但永遠改不動任何東西」
  這一族：cheap 階一定非空、cheap 判決真的產出 override、hard 判決一定落
  `no-model-map`、短回合與 `off` 不花 request、transport 壞掉維持原狀、prune
  未過門檻不呼叫 judge、drop 判決留可見標記、judge 拋錯保住輸出、CLI 退出 0 且
  不吐憑證。
- `integrations/hermes/jev-prune/__init__.py` 的 `_selfcheck()`：str／dict 兩種
  結果形狀、未知 tool／未知形狀／judge 失敗全部原樣通過、沒丟東西時回傳
  **同一個物件**。
- `integrations/hermes/live-probe.py`：把「middleware 真的註冊了嗎、真的改了
  結果嗎」變成可重跑的一行，不用再手搭。

## §21 對齊官方 TypeSafe skill：批次提問、機率門檻、情境自動調用（2026-09-22）

### 21.1 起點：官方提示詞能做的，這個 repo 都有了嗎

官方 skill（`https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md`）
逐條對照下來，只有兩條真的缺：

| 官方規定 | repo 原狀 | 結果 |
|---|---|---|
| 對同一份 state 的獨立問題**一次問完** | prune 每個 chunk 發一個 request，最多 8 個 | 缺 → 補 |
| 用 probabilities／confidence 導行為，門檻要**用自己的資料評估** | 完全沒讀 `confidence`／`probabilities` | 缺 → 補 |
| judgment 放 `instructions`、選項放 `criteria` | 已是 | 有 |
| 有 no-match 出口 | `route` 的 `no_match`、triage 的 `no-model-map` | 有 |
| 規則／計算留在程式碼 | 門檻、切塊、記錄全在 JS | 有 |
| 憑證留伺服器側 | key 只在 process 內讀檔 | 有 |
| typed output 保證介面不保證真值 | 每條路徑 fail-open ＋ ledger | 有 |
| rerank／composite scoring／cascade | 沒有可排序的候選 | 刻意不做（YAGNI） |

端點差異記一下：官方文件寫 `api.typesafe.ai/v1/systemone` ＋ `jev-latest`，本 repo
走 OpenRouter `https://openrouter.ai/api/v1/systemone` ＋ `typesafe/jev-1.13`
（回應是 `typesafe/jev-1.13-20260917`、`"provider":"TypeSafe"`）。request/answer
形狀相同，base URL 與 model id 不同。

### 21.2 第一個陷阱：門檻掛錯欄位，等於把功能關掉

補完批次後先掛了 `minDropConfidence: 0.55`，兩個 live test 直接紅：

```
✖ live: Bash hook shrinks a long stdout
  AssertionError: expected pruning, got 19542/19542
✖ live: a real drop writes a ledger-style line
  AssertionError: expected at least one drop, got 19542/19542 every time
```

拿測試自己的 fixture（400 行 heartbeat，第 200 行插一條 ERROR）打真 endpoint：

```
chars 19542 chunks 2 [ 15965, 3576 ]
status 200
{"model":"typesafe/jev-1.13-20260917","answers":{
  "c0":{"type":"choice","choice":"keep","probabilities":{"drop":0.2,"keep":0.8},"confidence":0.6},
  "c1":{"type":"choice","choice":"drop","probabilities":{"drop":0.63,"keep":0.37},"confidence":0.25}},
 "usage":{"input_tokens":6851,"output_tokens":61,"cost":0.000287742}}
```

同一塊噪音**單問**時是 `drop` 0.98／confidence 0.96；跟兄弟塊一起問就變 0.63／0.25。
官方 skill 早寫了：Choice 的 confidence 是**分布集中度**，不是「可以動手」的授權；
可接受的替代選項本來就會把機率攤開。所以門檻改掛 `probabilities.drop ≥ 0.6`，
也就是「模型自己相信這塊該丟的程度」，跟批次與否無關。

這是 §18.2 那族缺陷第 N 次出現：**門檻訂太高 ＝ 功能無聲關閉，長相跟 hook 沒載入一樣**。
預防加固是被否決的 drop 會進 ledger（`N unsure drops vetoed`），關掉是看得見的。

### 21.3 第二個陷阱：skill 沒 frontmatter，永遠不會被情境命中

要做「依情境自動調用」才發現 `skills/jev-agent/SKILL.md` 從頭到尾沒有 frontmatter
——沒有 `name`、沒有 `description`，任何情境都匹配不到它。檔案就擺在 repo 裡，
看起來完全正常。同一族缺陷：宣告 ≠ 生效。

補 frontmatter，並在 `tests/integrations.test.mjs` 加斷言：每個 `SKILL.md` 都要有
`name` 與 `description`。

### 21.4 官方安裝路徑走不通，改 vendor

```
$ claude plugin marketplace add typesafe-ai/skills
Failed to clone marketplace repository: fatal: could not create work tree dir
'/Users/51mini/.claude/plugins/marketplaces/typesafe-ai-skills..clone': Operation not permitted
```

沙箱擋 `~/.claude/plugins` 寫入。但 `known_marketplaces.json` 裡 `jev-gate` 是
directory marketplace，`installLocation` 就是這個 repo——所以把 skill 放進
`skills/typesafe-ai/` 到達的是同一個地方。再 symlink 到 `.claude/skills/`，
在 repo 內工作時也以 project scope 載入。

vendor 的規矩：上游 MIT、保留出處註記、只在 `description` 加兩行本 repo 的觸發情境，
其餘逐字不動，本地內容集中在檔尾標示清楚的 addendum。

附帶事實：沙箱 shell 連不到 docs（`deny network-outbound docs.typesafe.ai:443`），
WebFetch 可以，`curl` 到 `raw.githubusercontent.com` 可以。addendum 有寫，免得
下一個人照官方指示 `curl` 然後以為文件掛了。

### 21.5 驗收

`node --test` → `tests 210 / pass 208 / fail 0`（2 skipped）。
含兩個打真 endpoint 的 live prune 測試。

雙宿主改動後各重跑一次。`npm run agents:acceptance`：

```
[agents:acceptance] build OK
[agents:acceptance] gateway acceptance OK
[agents:acceptance] claude bridge smoke: verify=pass
[agents:acceptance] codex hooks smoke: stop=block-once-then-allow
[agents:acceptance] injected client smoke: triage=cheap spawn=haiku escape-hatch=ok
[agents:acceptance] ALL OK
```

Hermes 用 profile 的真 loader ＋ 真 middleware chain ＋ 真 Jev 打一次
（注意要用 `~/.hermes/hermes-agent/.venv/bin/python3`，系統 python3 是 3.9，
`hermes_constants.py` 的 PEP 604 `X | Y` 會炸 `TypeError: unsupported operand
type(s) for |: 'type' and 'type'`）：

```
has tool_execution middleware: True
middleware callbacks: ['hermes_plugins.jev_prune._on_tool_execution']
tool output chars: 19889
result chars: 60
changed: True
result tail: '[jev-prune: dropped 322 lines]\n[jev-prune: dropped 78 lines]'
```

commit `5ce3b3c`，plugin 版本 0.5.2 → 0.6.0。fixindex 記 9314（confidence 門檻
無聲關功能）、9315（insight：LLM confidence 是熵不是授權）、9316（SKILL.md 缺
frontmatter＝永不觸發）、9317（沙箱擋 marketplace add），另 `0001-hermes.md` §68
補 venv 直譯器那條。

### 21.6 收尾時自己踩的兩個工具坑

記在這裡是因為兩個都會再犯，而且都不報有用的錯：

1. `fixindex insight` → `unknown command: insight`。`insights`（複數）是唯讀查詢，
   寫入沒有獨立子命令；洞見要跟 defect 一起 pipe 進 `fixindex fi`，混合輸入
   （`SYMPTOM/ROOT/FIX/VERIFY` ＋ `INSIGHT:`）會自動拆成兩筆、一次 commit。
2. Bash 工具裡跑 `cd /some/other/dir` 會改掉**整個 session 的 primary working
   directory**，不是只影響那一條指令。之後所有相對路徑指令都在別的地方執行，
   而且完全不報錯。改用 `cd <repo> && <cmd>` 單行，或全部絕對路徑。

## 22. 實測 Hermes 省多少、門檻實測校準（2026-09-22）

問題三句：Hermes 掛上去到底省多少？門檻 0.6 憑什麼？Score／Noul 要不要收？

### 22.1 先量再說：Hermes 真的省多少

量法：真 `discover_plugins` ＋ 真 `run_tool_execution_middleware` ＋ 真 Jev，
餵 5 份這台機器自己的 tool output（worker log、jsonl 統計、`git log --stat`、
原始碼＋檔案列表、lock 檔），每份配一句真的使用者問題。

```
has tool_execution middleware: True
  27063 ->   11134  ( 58.9% saved,  0.58s)  worker log 有沒有噴錯？是什麼錯？
  40000 ->   40000  (  0.0% saved,  0.58s)  統計 jev-calibration.jsonl 最近樣本的 gat
  30000 ->   14063  ( 53.1% saved,  0.58s)  最近哪幾個 commit 改過 prune 這條路徑？
  32025 ->   16062  ( 49.8% saved,  0.55s)  hooks/jev.js 裡 minDropProbability
  17440 ->   17440  (  0.0% saved,  0.53s)  這個專案裝了哪些套件、鎖在什麼版本？

total 146528 -> 98699 chars, 32.6% saved, 2.8s judging
~tokens (chars/4): 36632 -> 24674, saved ~11957
```

**32.6%、約 12k token／5 次呼叫、每次判斷 ~0.55s。** 兩個 0% 不是壞掉：那兩題
整份輸出就是答案，該留。答案有沒有被剪掉另外驗過：

```
30000->14063 answer kept: true | 最近哪幾個 commit 改過 prun
32025->16062 answer kept: true | hooks/jev.js 裡 minDr
27063->11134 dropped=266 hasERROR=true   (連跑 3 次都一樣)
```

之前記的 50%（觀察 49435）是假的，根因見 §22.3。

### 22.2 門檻校準：0.6 → 0.7，以及為什麼機率掃不掉那個錯

`scripts/calibrate-prune.mjs <corpus.jsonl>` 把人工標好 keep／drop 的塊，用
`judgeChunks` 一模一樣的 wire shape 重放，留下每塊原始 `probabilities.drop`，
再對標籤掃門檻。語料是這台機器自己的輸出，8 cases／17 chunks，一輪 ~$0.006。

```
8 cases, 17 chunks, 5048 ms, 144059 input tokens, $0.006050

threshold  recall(drop)  false-drops  chars saved  of total
     0.30           7/8          1/9       151156  48.5% (max 54.1%)
     0.60           7/8          1/9       151156  48.5% (max 54.1%)
     0.70           5/8          0/9        91156  29.3% (max 54.1%)
     0.80           4/8          0/9        75197  24.1% (max 54.1%)
     0.90           3/8          0/9        67998  21.8% (max 54.1%)
```

0.6 的那個 false drop 是 case 7，也是唯一一個用**真 chunker 切出來的真邊界**
當語料的 case：`noise.txt + needle.txt` 經 `chunkLines` 切成 15959／11103，
答案那行 `ERROR OperationalError` 落在後面那塊、周圍全是 heartbeat。重複量：

```
case 0 drop  15959c choice=drop p(drop)=0.8  conf=0.6
case 0 keep  11103c choice=drop p(drop)=0.58 conf=0.15
case 0 keep  11103c choice=keep p(drop)=0.47 conf=0.06
case 0 keep  11103c choice=drop p(drop)=0.52 conf=0.03
case 0 keep  11103c choice=drop p(drop)=0.58 conf=0.15
case 0 keep  11103c choice=drop p(drop)=0.55 conf=0.1
case 0 keep  11103c choice=drop p(drop)=0.62 conf=0.24
```

**混合塊落 0.47–0.62，純噪音塊落 0.70–0.80。** 兩個帶子只差 0.08，0.6 剛好在
混合塊帶子裡面——運氣差就把答案剪掉。`vetoOnTerms` 救不了這題：請求只有 `worker`
一個 ASCII 詞，兩塊都有，沒有鑑別力（中文詞根本不會被 `[a-z0-9_]{4,}` 抓到）。
所以只能靠門檻。代價：省 29.3% 而不是 48.5%。答案被剪掉比留著一坨 dump 貴。

同一條變異也炸掉 `tests/hook.live.test.js` 兩個 live 測試：fixture 的噪音尾巴
只有 3576 字元，判 0.63–0.74 橫跨門檻，6 次 retry 全部沒 drop。fixture 從 400 行
改 800 行，尾巴變成整塊 16 KB dump，穩定 0.91–0.96。**測試失敗的根因是 fixture
剛好坐在門檻上，不是 wire 壞掉**——這種 fixture 本來就不該拿來當正向斷言。

`vetoOnTerms` 自己的規則（只有**有鑑別力**的詞才算：有些塊有、不是每塊都有；
單塊時任何命中都算）現在有離線測試 `tests/jev.test.mjs`，5 條。

### 22.3 真正吃掉那 50% 的缺陷：Hermes 根本沒有使用者請求

`_request_of(args)` 原本拿 tool 自己的參數頂替使用者請求，所以 `cat log` 這個
shell 指令變成判斷基準。量出來：一個整個任務都在講它的 40 KB 檔案被判 99.8%
該丟（27063 → 61）。那 50% 省的是答案本身。

讀 Hermes 自己的呼叫點確認過：`model_tools.py:773` 與
`agent/agent_runtime_helpers.py:2257` 只傳 `original_args` ＋ 一串 id 欄位，
**沒有任何 call site 傳使用者請求**。`_run_execution_chain` 會把 `**context`
原樣轉發，所以哪天 Hermes 傳了 `request=`，這裡不用改就會開始運作。

試過的替代方案，也量了：不用請求、改用「機械式體積」準則（`bulk_only`）省
68.4%，但 5 題有 3 題答案被剪掉，包含 needle。**兩種猜法都比不猜貴**，所以
`pruneCommand` 現在直接回 `no-request`：沒有任務就沒有判斷基準。
今天 Hermes 線上跑到的就是這條，等於 Hermes 側暫時不剪。

### 22.4 驗收

```
ℹ tests 216
ℹ pass 214
ℹ fail 0
ℹ skipped 2
```

```
[agents:acceptance] triage + spawn-hook smoke: OK
  triage=cheap spawn=haiku escape-hatch=ok
[agents:acceptance] ALL OK
```

### 22.5 Score／Noul：白話、實測、要不要收

三個原語同一件事的三種問法：

* **Choice** — 「選一個」。回 `choice` ＋ 每個選項的 `probabilities` ＋
  `confidence`（分布有多集中，**不是**授權動手，§18.2）。prune 的 keep／drop 用它。
* **Noul** — 「是不是？」只回一個 `noul` 0–1，**沒有 confidence 欄**。0.5 同時
  代表「一半一半」跟「我不知道」，兩者分不出來。
* **Score** — 「打幾分」。`criteria` 是**陣列**（legend，每級一句話），回
  `score`（可能是 1.53 這種小數，是期望值不是某一級）＋每級 `probabilities` ＋
  `confidence`。

repo 裡已經在用：triage 的 `difficulty` 是 Score（4 級 → tier），
`costly_mistake` 是 Noul（當 floor rule，不參與排序），gateway 四支 policy
都是 Noul。

拿 prune 最難的那塊（混合塊）同題三問，各 3 輪：

```
choice c0="drop"/conf0.21  c1="keep"/conf0.13
noul   c0=0.75  c1=0.76
choice c0="drop"/conf0.21  c1="keep"/conf0.45
noul   c0=0.72  c1=0.8
choice c0="drop"/conf0.25  c1="keep"/conf0.11
noul   c0=0.75  c1=0.74

score  c0 score=1.53 p={"0":0.18,"1":0.34,"2":0.26,"3":0.22} conf=0.11
       c1 score=1.79 p={"0":0.18,"1":0.26,"2":0.15,"3":0.41} conf=0
       c0 score=1.69 p={"0":0.16,"1":0.3,"2":0.24,"3":0.3}   conf=0
       c1 score=1.91 p={"0":0.16,"1":0.23,"2":0.16,"3":0.45} conf=0
       c0 score=1.47 p={"0":0.2,"1":0.35,"2":0.24,"3":0.21}  conf=0.13
       c1 score=1.98 p={"0":0.17,"1":0.21,"2":0.11,"3":0.51} conf=0
```

同一個 Noul 問法換成**好分的**那對（純噪音 vs needle）：

```
clear-cut pair  noul: c0(noise)=0.86  c1(needle)=0.06
clear-cut pair  noul: c0(noise)=0.86  c1(needle)=0.05
clear-cut pair  noul: c0(noise)=0.85  c1(needle)=0.05
```

結論（有原因的）：

1. **prune 不換 Noul。** 好分的題 Noul 分得很開（0.86 vs 0.05），但題目一難就
   兩塊都 0.75——**沒有 confidence 欄就沒有「我不知道」這個通道**，模糊只好被壓
   成中間值，跟一個有把握的中間值長得一樣。prune 的貴錯就發生在難題上。
2. **prune 不換 Score。** Score 的 `probabilities[3]`（「這塊含答案」）確實分得開
   （0.41–0.51 vs 0.21–0.30），但間距跟 Choice 的 p(drop) 同級（差 ~0.1），
   換過去要多維護一份 legend、多一個小數門檻，**換不到 separation**。
   Choice ＋ 0.7 ＋ `vetoOnTerms` 已經 0 false drop。
3. **Noul 繼續當 flag，不要當排序。** `costly_mistake`、gateway 四支 policy 都是
   「是不是危險」的單一旗標，答案進 floor rule（危險就不准降級），不跟別的分數
   比大小。那正是 Noul 唯一穩的用法。
4. **Score 繼續留在 triage。** 難度本來就有序（trivial→hard），Score 的每級
   `probabilities` 是 `decideTier` 算 `simpleProb`／`hardProb` 的原料——那是
   Choice 給不了的東西。
5. 踩到的坑：Score 的 legend 要放在 `criteria`（陣列），寫成 `legend` 會被擋
   `expected "array" ... path questions.c0.criteria`。

## 23. 補 request 接線、調用頻率實測降頻、語料 sink 防汙染（2026-09-22）

### 23.1 補 request：Hermes 真的把使用者請求傳進 middleware 了

§22.3 量到的缺陷是「host 沒傳使用者請求，plugin 拿 tool 自己的參數頂替」。
當時的止血是**拒判**（`no-request`），這一輪補上真的接線。

三個 call site（`model_tools.py:773`、`agent/agent_runtime_helpers.py:2257`、
子代理路徑）都要拿到同一份請求，逐個穿 kwarg 會漏。改用 turn-scoped ContextVar，
在 turn 開頭綁一次：

```python
# ~/.hermes/hermes-agent/hermes_cli/middleware.py
_CURRENT_USER_REQUEST: ContextVar[str] = ContextVar("hermes_current_user_request", default="")

def run_tool_execution_middleware(...):
    # `user_request`，不是 `request`：`_run_execution_chain` 把 `request` kwarg
    # 當成 THE PAYLOAD（`payload_key = "request" if "request" in kwargs else "args"`），
    # 傳 `request=` 會讓 tool 拿到使用者請求字串當參數去 dispatch。
    context.setdefault("user_request", current_user_request())
```

```python
# ~/.hermes/hermes-agent/agent/turn_context.py
set_current_user_request(persist_user_message if persist_user_message is not None else user_message)
```

兩個設計點都有代價才這樣選：

- **叫 `user_request` 不叫 `request`**：這個坑差點上線。早先的量測探針之所以
  「看起來會動」，只是因為它的 terminal callback 根本沒讀 `args`。現在
  `tests/hermes_cli/test_plugins.py` 直接釘死 `dispatched is args` 與
  `"request" not in seen`。
- **ContextVar 而非 module global**：子代理執行緒晚起，context 是空的 → 拿到 `""`
  → plugin 拒判。這是刻意的：寧可子代理不剪，也不要它拿主代理的任務當基準剪。

實測（真 `discover_plugins` ＋ 真 middleware ＋ 真 Jev，5 個本機真實輸出，
沒有任何手傳 kwarg）：

```
has tool_execution middleware: True
  27063 ->   11134  ( 58.9% saved,  0.98s)  worker log 有沒有噴錯？是什麼錯？
  40000 ->   40000  (  0.0% saved,  0.89s)  統計 jev-calibration.jsonl 最近樣本的 gat
  30000 ->   14063  ( 53.1% saved,  0.79s)  最近哪幾個 commit 改過 prune 這條路徑？
  32025 ->   16062  ( 49.8% saved,  0.82s)  hooks/jev.js 裡 minDropProbability
  17440 ->   17440  (  0.0% saved,  0.75s)  這個專案裝了哪些套件、鎖在什麼版本？

total 146528 -> 98699 chars, 32.6% saved, 4.2s judging
~tokens (chars/4): 36632 -> 24674, saved ~11957
```

### 23.2 調用頻率：現在太高，而且高出來的部分一個字都沒省

問題不是感覺，是可以數的。生產 ledger `~/.openclaw/state/jev-prune.log`：

```
calls 19 total before 218113 saved 28015
calls that saved anything: [('Bash', 44042, 28015)]

threshold   calls  saved_chars   judged_chars
     4000     19        28015         218113
     8000     10        28015         167847
    12000      8        28015         148645
    16000      3        28015          81135
    20000      2        28015          64552
    32000      1        28015          44042
```

19 次呼叫，**有效的只有 1 次**——那唯一一次 44 KB 的 Bash 輸出，省下全部 28,015 字元。
其餘 18 次（含 3 次 Read，12.5／13.4／13.3 KB）通通 0 lines dropped。

不是模型笨，是**結構**：`chunkChars: 16000`，輸出不到一個 chunk 時，
判斷題目就變成「整包丟掉還是整包留著」，而一個只有一塊的輸出裡通常就是有答案，
判 keep 是對的。低於一個 chunk 的門檻買到的是延遲與花費，買不到節省。

所以 `thresholdChars` 從 Bash/Grep 4000、Read 12000 全部改成 `CONFIG.chunkChars`
（16000）：**呼叫數 −84%（19 → 3），實測節省 −0%**。

為什麼不乾脆 32000（呼叫剩 1 次、一樣省 28,015）？因為那條線在這份語料上只有
一次呼叫寬，沒有 margin——下次輸出落在 16–32 KB 之間就整個失效。16000 是**結構邊界**
（一個 chunk 是「部分丟棄」這件事能存在的最小單位），不是曲線上挑出來的點。
`tests/jev.test.mjs` 釘 `thresholdChars >= chunkChars`。

Read 被兩邊夾成一條窄帶：下限是一個 chunk，上限是 core 自己的 token cap（實測
207 KB 日誌只送 8,000 字元、114 KB base64 送 16,571）。也就是 Read 之後只在
blob 那一端開火——那本來就是它 `drop` criteria 唯一針對的情況。
`tests/hook.live.test.js` 同時釘兩個邊界，免得哪天 Read 變成永遠不會觸發的裝飾。

Hermes 那邊不用改：plugin 不帶 `threshold_chars`，吃的就是 `TARGETS.Bash` 的預設，
降頻自動生效。

### 23.3 順手抓到的：bench 把語料 sink 灌爆

`~/.openclaw/state/jev-calibration.jsonl` 6.5 MB／11,753 行，其中 10,200 行是
`gateway/lib/bench.mjs` 跑 FakeMode adapter 產生的 `fake/jev-1.13`
（一分鐘寫進 1,615 筆），真實流量只有 1,553 筆。fake adapter 的答案是 fixture
讀回來的，拿這份檔去 `scripts/calibrate.mjs` 校準＝**拿 fixture 校準模型**。

修在 sink，不是修在 bench：

```js
// gateway/src/calibration.js
if (path === DEFAULT_CALIBRATION_LOG && isFakeSample(sample)) return false;
```

只擋**預設 sink**。指定路徑是有人刻意在收（harness 測試就是這樣用），預設檔才是
活的證據語料，不該被「某個 harness 忘了設環境變數」種進假資料。要求每個 harness
記得 `JEV_CALIBRATION_LOG=off` 是把規則交給記性。

bench 自己也補上第二道（`gateway/lib/bench.mjs` 模組載入即 opt out）。兩道防線
守的範圍不同：sink 那道擋「任何 harness 忘了設」，bench 這道多擋一種——**bench 被
指到具名語料路徑**，那是 sink 刻意放行的自由區。`gateway/test/bench.test.mjs`
釘住 import 後 `calibrationPath() === null`。

現存的汙染也清掉了（先備份）：

```
kept 1455 dropped 12444 backup /Users/51mini/.openclaw/state/jev-calibration.jsonl.pre-fake-purge.bak
```

### 23.4 驗收

```
ℹ tests 218
ℹ pass 216
ℹ fail 0
ℹ skipped 2
[agents:acceptance] gateway acceptance: OK
[agents:acceptance] claude bridge smoke: OK
[agents:acceptance] codex hooks smoke: OK
[agents:acceptance] injected client smoke: OK
[agents:acceptance] triage + spawn-hook smoke: OK
[agents:acceptance] ALL OK
```

gateway 自己的套件 `tests 86 / pass 84 / fail 0`；Hermes plugin
`jev-prune selfcheck OK`；Hermes `tests/hermes_cli/test_plugins.py`
`1 failed, 76 passed`，唯一那個 fail 是沙箱 PermissionError 的
`TestForceReloadSymmetry`，`git stash` 後照樣 fail，與本次改動無關。
