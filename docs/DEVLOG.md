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
