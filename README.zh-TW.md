# Jev Gate

[English](README.md) · **繁體中文**

## 這個 repo 裝了三件不同的東西

| | 是什麼 | 進入點 | 狀態 |
|---|---|---|---|
| **Prune plugin** | Claude Code plugin，在模型讀到之前縮短過長的 tool output | `hooks/jev.js` | 已上線，實測驗證過 |
| **Decision Gateway** | 本機 MCP server，只暴露兩支受治理的決策工具 | `gateway/src/stdio.js` | 以 **local stdio plugin** 上線；policies 全部 shadow |
| **Agent glue** | 五種 Jev 用法共用一個核心，Claude Code 與 Codex 各有薄 adapter | `agent-glue/src/` | 已上線；policies 未校準前**純 advisory** |

三者只共用 repo 與 provider key，其他無關。本頁其餘部分講 prune plugin；
gateway 有自己的 [README](gateway/README.md)，glue 看
[`docs/agent-glue.md`](docs/agent-glue.md)。

## Prune plugin

Claude Code plugin，用 Jev（System One）的 keep/drop 判斷，在 tool output
**進入模型 context 之前**先剪掉。

狀態：已上線。三個 function hook（Bash、Grep、Read），端到端實測過。

## 它做什麼

`hooks/jev.js` 對 `Bash`、`Grep`、`Read` 掛 `tool.call`。它先跑 `next(e)`，
若結果中的長字串超過該工具門檻，就依行邊界切塊，每塊問 Jev 一次 Choice：
這塊對使用者當下的請求有沒有幫助。被判 drop 的塊換成
`[jev-prune: dropped N lines]`；留下的文字逐字通過，絕不改寫。

| 工具 | 剪哪個欄位 | 門檻 | drop 準則 |
|---|---|---|---|
| `Bash` | `stdout` | 4,000 字元 | 雜訊、樣板、與任務無關的東西 |
| `Grep` | `content`（content mode） | 4,000 字元 | vendored／generated／fixture 檔案的命中 |
| `Read` | `file.content`（text 分支） | 12,000 字元 | 只剪機械性堆量——minified code、base64、lock 檔內容 |

Read 故意最保守：Bash 或 Grep 的結果是**關於**檔案的報告，而 Read 的結果
**就是**模型指名要的那個檔案，所以它的 drop 準則只剪讀起來沒有意義的堆量，
並明寫「不確定就留」。門檻設 12,000 而不是更大，是因為 core 在 hook 看到之前
就已經對 Read 做 token cap——實測 207 KB 的 log 只送到 8,000 字元、114 KB 的
base64 送到 16,571。門檻若高過那個 cap，就是一個永遠不會觸發的 hook，而
fail-open 會把這件事藏起來。

模型實際收到多少，真實 session 端到端量測：

| | 沒有 plugin | 有 plugin |
|---|---|---|
| Bash，19,543 字元吵雜 log，其中一行是錯誤 | 19,543 | 30 |
| Read，114 KB base64 | 16,571（core 的 cap） | ~60 |
| Grep，48 KB vendored minified 命中 | ~13,000 | 138 |
| Read，`node_modules/send/index.js`，20 KB 真原始碼 | 整檔 | 整檔（對照組） |

一次 Jev 呼叫約 343 in／33 out token、$0.0000144、約 550 ms。

### 為什麼用 function hook 而不是 PostToolUse hook

settings 裡的 `command` hook 掛 `PostToolUse` **改不動 tool result**：它跑的時候
core 已經把模型要讀的內容記下來了。`tool.call` 可以——它 await `next(e)`，
然後用自己的 `{ result }` 回答（且不帶 `ref`，讓 core 重新 map 剪過的紀錄，
而不是沿用它自己的 messages）。

需要 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` 與 Claude Code ≥ 2.1.274。

### 刻意 fail-open

key 不見、4xx、schema 壞掉、judge 丟例外——每一種都回 `keep`，原始 output
原封不動通過。hook 超出預算被引擎跳過，效果一樣。

這也正是會藏 bug 的失敗模式：曾經一個寫錯的 model id 讓每次呼叫都 400，
但三個階段的測試照樣「綠」。所以 live 測試做**正向**斷言——output 必須量得到
變小，而一塊純雜訊必須回 `drop`。把 `typesafe/jev-1.13.0` 放回 `hooks/jev.js`，
它們就會紅。

### 觀測：ledger

`$.ui.log` 只到 TUI 不落檔，所以在無頭機上，hook 唯一的持久紀錄是寫到
`/Users/51mini/.openclaw/state/jev-prune.log` 的 ledger（`$` 沒有 append，
所以是 read-then-write；時間戳用 `$.clock.now`）。ledger 記錄**每一筆被判定為
可剪的呼叫**，keep 也記，不是只記 drop。它以前只在成功 drop 之後才寫、而且吞掉
自己的寫入錯誤，於是一個有觸發但全部判 keep 的 hook 會零痕跡，跟根本沒載入
分不出來。`appendLedger()` 永不丟例外，壞掉的 ledger 不會擋住 prune 本身。
一行 ledger 是 hook 有觸發的證據，**不是校準結果**——在有標註評估語料之前，
`calibration_status` 一律是 `uncalibrated`。

### 註冊是攤開寫的，不是跑迴圈

`register` 把 `Bash`、`Grep`、`Read` 各寫一行，每個 hook 槽是 function literal，
因為 `claude plugin validate` 是**靜態**讀原始碼的：用迴圈變數它會報
`tool.call{tool=tool}`，hook 槽裡放 factory call 它會直接拒收整個模組。
有一個測試斷言註冊的三個名字與 `TARGETS` 表一致——那正是迴圈本來要買到的東西。

## 安裝

```sh
npm install
claude plugin validate .
node --test              # 'live' 測試需要 ~/.creds/kv/OPENROUTER_API_KEY.txt
```

然後在 `~/.claude/settings.json` 註冊成 local marketplace：

```json
"extraKnownMarketplaces": {
  "jev-gate": { "source": { "source": "directory", "path": "/path/to/jev-gate-mcp" } }
},
"enabledPlugins": { "jev-gate@jev-gate": true }
```

或單一 session 載入：`claude --plugin-dir /path/to/jev-gate-mcp`。

Provider 設定在 `hooks/jev.js` 最上面：endpoint
`https://openrouter.ai/api/v1/systemone`（正式路徑 `POST /api/alpha/decisions`）、
model `typesafe/jev-1.13`、key 讀 `~/.creds/kv/OPENROUTER_API_KEY.txt`。

## Agent glue：五種 Jev 用法、兩個 host

`agent-glue/src/` 放一個可測的核心，兩個 host 逐字共用：

| | 判斷什麼 | 契約 |
|---|---|---|
| route | 這一 turn 交給哪個 candidate | 只能從給定 candidates 挑；都不合就 `no_match`；失敗保持現有模型 |
| triage | 一趟請求三個答案（`difficulty`／`kind`／`costly_mistake`），有 catalog 時再加一支 advisory `skill` Choice，映射成 cheap→medium→hard | 一次 Jev 呼叫全包；skill 騎同一趟請求（不另開）；危險詞掃**整段原文**不是切片；risky／低信心／大 context 永不降級；transport 失敗保持現狀 |
| compact | 哪個 tool call／result 可以刪或截 | user/assistant 文字逐字通過；call 與 result 成對；首尾 turn 釘住 |
| verify | 對完工宣稱給 `pass`／`fail`／`unknown` | `pass` 需要可稽核的指令／log 證據；沒有執行證據就是 `unknown`，絕不是 `pass` |
| review | staged diff review | risk 篩 → file profile → evidence → mechanism → severity → reviewer route |

`route` 與 `triage` 兩條 glue 路徑已完整接到 `agent-glue/cli.mjs` 與
`agent-glue/claude/bridge.mjs`（舊的 `cli-no-model` route stub 已刪）：
沒有 live Jev model 時 `route` 自己 fail-open 到 `no_match`，
candidate list 缺漏或為空會被 catch 成有界的 `no-candidates` 結果（exit 0）。
skill 選擇騎同一趟 triage 請求，永不多開一次 Jev。

**route 會自己去磁碟把 candidate 的描述讀出來。** 讓 Jev 對一堆裸 id
（`graphify`、`to-issues`、`diagnose`）做 Choice 就是在猜：實測 2/4；同樣四題，
每個 candidate 補一句話就是 4/4。那句話本來就存在——skill 的 SKILL.md
frontmatter 裡的 `description:`——所以 `agent-glue/src/catalog.js` 去讀它，
兩個 CLI 進入點會替呼叫端沒描述的 candidate 自動補上 `descriptions`。
呼叫端照舊只傳 id，route 不必再猜。明確給的 `descriptions` 永遠優先，
給 `null` 強制用裸標籤，查不到文件的 id 就維持裸的。搜尋路徑：
`./skills`、`./.claude/skills`、`~/.claude/skills`、`~/.claude/plugins/*/skills`
——用 `JEV_ROUTE_CATALOG_DIRS`（冒號分隔）覆寫。

撐住整件事的是兩條規則：

- **任何 judge 失敗都是整趟 fail-open**，不是只有丟例外的那一對。壞掉的 judge
  只能讓 context 留著，不能悄悄剪掉一半。縮減未達 `minReductionChars` 也一樣：
  host 拿回**原始** messages。
- **Jev 不移動 deterministic 結果。** `deterministicSeverity()` 字面上就是
  `void jevOpinion`。Jev 的意見只是掛在結果上進 ledger；severity 與 reviewer route
  單由 diff profile 算出。五個 policy 還是 `shadow` + `uncalibrated` 的期間，
  未校準的判斷不得授權或阻擋任何事。`tests/agent-glue/policy-shadow.test.js`
  在有人翻掉這條時會變紅。

Host 差異是照實寫出來、不是抹平：Claude 的 function hook 可以在模型讀到之前
換掉 tool result，也可以取代內建壓縮；Codex 只能在 `PreToolUse` 擋，它的壓縮側
是**還原層**（`PreCompact` snapshot + `PostCompact` additionalContext），不是取代。
Manifest 分檔放——Claude 用 `hooks/hooks.json`，Codex 用 `.codex/hooks.json`／
`.codex-plugin/hooks.json`。

### Triage 層（省錢判斷）

`triage` 一趟 Jev 同時問好幾題——`difficulty`（Score）、`kind`（Choice）、
`costly_mistake`（Noul），有 skill catalog 時再加一支 advisory `skill`
（Choice，criteria＝catalog＋`no_match`）——再由 deterministic code 映射到
cheap→medium→hard tier。skill 的挑選騎同一趟請求，不多花一次 Jev 呼叫，
而且純 advisory（絕不改變模型選擇）。

**它依情境自動啟用，不靠開關，而且 ladder 已內建。** 只要任一 tier model 有設，
`triageEnabled()` 就是 true；而 `DEFAULT_TIER_MODELS` 開箱就把三層都設好：

| tier | 預設模型 | 什麼會落在這層 |
|---|---|---|
| `cheap` | `haiku` | 機械性工作：改名、找檔案、讀狀態 |
| `medium` | `sonnet` | 一般實作：寫程式、改程式、除錯 |
| `hard` | `opus` | 架構決策、跨檔深度分析、任何有風險的 |

這跟社群 model-routing hook 收斂出來的分法一樣
（[tzachbon/claude-model-router-hook](https://github.com/tzachbon/claude-model-router-hook)、
[AqueGen/model-routing](https://github.com/AqueGen/model-routing)），差別在於
tier 是一趟 Jev 判斷出來的，不是本地關鍵字啟發式。要覆寫就用
`JEV_TRIAGE_MODEL_CHEAP/MEDIUM/HARD`；填字面值 `off` 讓該層退回父層模型，
三層都 `off` 依同一條規則把 hook 關掉。`JEV_TRIAGE_ENABLED=1` 強制開，
`=0` 是逃生門。

這層以前出貨時 map 是空的，於是自動規則在每台機器上都解析成「關」——
一個看起來啟用、但不管 Jev 答什麼都動不了模型的 hook。是預設值把它接上線的。

- **Claude**：`agent-glue/claude/spawn-hook.mjs` 註冊 `agent.spawn`，依 tier 設
  subagent 的 `model`。transport 由 hook 自己注入（`agent-glue/src/live.js`）；
  沒有 provider key 時 transport 是 `null`，triage fail-open 回現狀，什麼都不改。
- **Codex**：`UserPromptSubmit` 跑同一套 triage，但 Codex 換不了模型，
  所以只吐一行 advisory `additionalContext` notice，並在 `codex-route.log`
  寫一行 bounded 記錄。

所有省錢閘都在 Jev 呼叫之前跑完：空 turn／pinned／沒設 tier 直接保留現狀，
一次請求都不打；危險詞表用 regex 掃**整段原文**（不是切片）；過長文本切成
開頭 1/4＋結尾 3/4（`ask_chars`）；decision cache 的 key 含 **context bucket**，
小 context 的答案不會被大 context 命中；`features` 隱私模式（敏感 profile 強制開）
只送統計特徵，原文不出機器。每筆決策記一行 bounded ledger。fail-open 貫徹到底：
transport 任何失敗都保持現狀，絕不往上或往下猜。

### 快速壓縮（`session.compact` + `turn.complete`）

`agent-glue/claude/compact-hook.mjs` 把 fast-jev-compaction 的能力併進本 plugin。
「快」是兩件事：壓縮在 **context 百分比**（`JEV_COMPACT_AT_PERCENT`，預設 60）
就觸發，不是撞牆才做；每個 tool call／result 對只問一次 System One
（約 350 in／35 out token、約 500 ms）決定去留——**沒有摘要 pass**，
所以留下來的是**逐字原文**。

| 旋鈕 | env | 預設 |
|---|---|---|
| 觸發點 | `JEV_COMPACT_AT_PERCENT` | 60（% context） |
| 縮減門檻 | `JEV_COMPACT_MIN_REDUCTION` | 4,000 字元 |
| 釘住最近 turn | `JEV_COMPACT_PIN_LAST` | 6 |
| 給 judge 看的 payload 開頭 | `JEV_COMPACT_ASK_CHARS` | 1,200 |
| 關閉 | `JEV_COMPACT_ENABLED=0` | 預設開 |

契約在 `agent-glue/src/compact.js`，是契約不是調參：user/assistant 文字
永不被刪或截斷；被刪的 call 與它的 result 一起走；首尾 turn 釘住；
judge 失敗或縮減未達門檻就把**原始** messages 還給 host 走內建壓縮。
這裡的 fail-open 方向是「保留 context」。

`compactMessages` 預設只給 judge 看工具名與大小（`judgeHeadChars: 0`）；
hook 明確 opt-in 一段有界開頭，因為「這段 `npm ls` 輸出還需要嗎」
光看工具名答不出來。

**不要同時跑本版與獨立的 fast-jev-compaction plugin。** 兩個
`session.compact` 註冊回同一個事件是 undefined。本版會讓路：`session.start`
讀 `~/.claude/settings.json`，若 `fast-jev-compaction@…` 仍 enabled 就 stand down，
並在 `~/.openclaw/state/jev-compact.log` 寫明。停用獨立 plugin，本版才會跑。

```sh
npm run agents:acceptance   # plugin validate、全測試、build、gateway、兩個 host smoke
```

## 實測數據

`scripts/live-probe.mjs` 把每項能力對真 provider 跑一遍，每列報三件事：
到底有沒有**打到** Jev（fail-open 從外面看跟成功長得一模一樣）、
對了幾題、以及把結果改變了多少。最近一次，2026-09-22：

| 能力 | 有打到 | 正確 | ms | 量到的程度 |
|---|---|---|---|---|
| prune（`hooks/jev.js`） | 是 | 2/2 | 468 | 混合塊 39,418 → 16,028（剪 59%，訊號行保住）；純雜訊 39,379 → 92（剪 100%） |
| route（裸標籤） | 是 | 2/4 | 2383 | 光有標籤不夠 |
| route（＋descriptions） | 是 | 4/4 | 2773 | 手寫一張 `descriptions` 表就 4/4 |
| route（裸 skill id） | 是 | 2/4 | 2141 | 換成真的 skill id、沒 catalog，一樣卡在 2/4 |
| route（自動 catalog） | 是 | 4/4 | 2453 | 4/4 個 id 直接從 SKILL.md 讀到描述——呼叫端零改動，2/4 → 4/4 |
| triage | 是 | 3/3 | 1592 | 3/3 tier 正確、0/3 退回現狀、cache 有進資料 |
| spawn hook（環境原樣） | 是 | 3/3 | 1283 | 3/3 次 spawn 的模型都被改掉：`cheap→haiku`、`hard→opus`、危險題 `hard→opus` |
| compact | 是 | 1/1 | 727 | 29,117 → 1,407 字元（95%），文字逐字保留 |
| verify | 是 | 3/3 | 348 | 判決仍由 deterministic 決定，Jev 只是 advisory |
| review | 是 | 1/1 | 415 | severity `medium`／route `peer`，而 Jev 說 `high`——deterministic 沒被移動 |
| gateway `jev_evaluate` | 是 | 2/2 | 343 | coverage `complete`，382 in／66 out token |
| gateway `jev_apply_policy` | 是 | 5/5 | 1869 | 五個 policy 都會答，全部釘在 `shadow` + `uncalibrated` |

`spawn hook（環境原樣）`那列才是「這層真的開著」的證據：沒有注入 transport、
沒有強制旗標，只用環境原樣——跟現在真的 spawn 一個 subagent 拿到的一樣。
在 tier ladder 出貨之前，這列讀出來是 `3/3 status-quo／inherit`。

這支 probe 正是三個接線缺陷被修掉而不是繼續潛伏的原因：gateway transport
用陣列索引當 key，導致 `triage` 從來沒看到答案；`makeScorer` 送給 Jev 的是
`criteria: null` 的裸標籤；spawn hook 根本沒注入 transport。三個都通過了各自的
單元測試——因為 fake transport 的形狀跟真的不一樣。

```sh
node scripts/live-probe.mjs   # 需要 provider key，花幾美分
```

## 也在這個 repo，但沒掛上

`plugin/` 放 Node 側的實驗：`lib/judge.js`、`lib/route.js`
（deterministic 預篩 + 一次 open-world Jev Choice）、`lib/gate.js` 與
`hooks/gate.js`（shadow 模式的 Stop/PreToolUse ghost-loop gate）。
都有測試，但刻意沒接線——原因見 `docs/NEXT.md`。

## 文件

- [Gateway README](gateway/README.md) — Decision Gateway MCP server（v2 SDK、兩支工具、只走 stdio）
- [Companion agent instructions](docs/agent-instructions.md) — agent 什麼時候該呼叫這些工具
- [Host Adapter 契約](docs/host-adapter.md) — 強制的、由 host 執行的 lifecycle gating
- [產品需求](docs/prd/jev-decision-gateway.md)
- [領域脈絡](CONTEXT.md)
- [架構決策](docs/adr/0001-governed-two-tool-mcp-boundary.md)
- [接下來做什麼](docs/NEXT.md)
- [繁中接線與 Codex 快速指南](docs/zh-TW/README.md) — 把 gateway 接到 Claude Code／Codex
- [Handoff 2026-09-21（繁中）](docs/HANDOFF-20260921.md) — **沒有前情提要就從這裡開始**
- [Jev 十步操作手冊（繁中）](docs/zh-TW/PLAYBOOK.md) — 十步手冊對應到這個 repo，含缺口
- [Agent glue（繁中）](docs/agent-glue.md) — 各 host 的安裝／停用／觀測，以及四項有效性指標
- [Agent skill](skills/jev-agent/SKILL.md) — 兩個 host 共用的操作規則
- [開發日誌](docs/DEVLOG.md) — 怎麼做出來的，以及踩過哪些坑
