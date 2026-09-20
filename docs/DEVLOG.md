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

## 7. 順帶挖到的大洞：自己的 hook 在灌 context

分析本 session 的 transcript（2,711 列、約 4.9MB）時發現組成：

| 類別 | 列數 | 字元 | 佔比 |
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
引擎每次拒收，然後把完整的錯誤訊息＋期望 schema 塞回 transcript，**每次 Bash 呼叫一份**。

修法是各刪一行「沒東西就完全不印 stdout」。驗收：餵一筆 PostToolUse payload 進去，
stdout 必須是空的（用 `xxd` 確認，因為「看起來沒輸出」和「輸出了空字串」在終端上長一樣）。

順序上這件事比 compaction 值錢得多：省下來的是同一個量級的 token，改動是兩行，成本是零。

---

## 接續建議

1. 裝 `fast-jev-compaction`（先解 key 來源那題）。
2. 幾天後看 `$.ui.log` 的 `jev-prune(...)` 命中率，再決定三個門檻要不要動。
3. `hook_success` 那 15%（`PreToolUse:Bash` 689 列）還沒查過，可能是下一個同類型的洞。
