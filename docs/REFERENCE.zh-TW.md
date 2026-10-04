# Jev Gate 技術參考

[回到首頁](../README.md) · [English](REFERENCE.en.md)

這裡保留原 README 的實作細節、設定與歷次量測。
第一次接觸請先看首頁。下方數字是特定情境的紀錄，不代表保證節省或目前模型準確率。

## 這個 repo 裝了三件不同的東西

| | 是什麼 | 進入點 | 狀態 |
|---|---|---|---|
| **Prune plugin** | Claude Code plugin，在模型讀到之前縮短過長的 tool output | `hooks/jev.js` | 已上線，實測驗證過 |
| **Decision Gateway** | 本機 MCP server，只暴露兩支受治理的決策工具 | `gateway/src/stdio.js` | 以 **local stdio plugin** 上線；policies 全部 shadow |
| **Agent glue** | 五種 Jev 用法共用一個核心，Claude Code 與 Codex 各有薄 adapter | `agent-glue/src/` | 已上線；policies 未校準前**純 advisory** |

三者只共用 repo 與 provider key，其他無關。本頁其餘部分講 prune plugin；
gateway 有自己的 [README](../gateway/README.md)，glue 看
[`docs/agent-glue.md`](agent-glue.md)。

<a id="laya-routing"></a>

## LAYA＋Jev：有限範圍的本機分類試行

設定 `JEV_PROVIDER=laya` 後，**Decision Gateway** 只把核准的簡短固定選項分類
交給現有 LAYA 模型，其餘判斷交給 Jev。這不會把獨立的 prune／壓縮 hook 改成本機 LAYA。

| 請求 | 分工 |
|---|---|
| 完整符合 `TASK_KIND`／`MESSAGE_TOPIC` 題型、最多 320 字元的合格獨立短文 | 先由 LAYA 分類 |
| 本機錯誤、格式不合法、`no_match`，或任務類型為 `general` | Jev 接手 |
| 其他題型、明確指定模型、長文／額外上下文、難度、風險、驗證、審查、關聯度及所有 policy | Jev |

固定題型從 [`classification-profiles.js`](../gateway/src/classification-profiles.js) 匯入。
比對完整題型，不能只改題目名稱就走本機。明顯否定、多步驟或依賴前文的語句會排除，
但規則不能辨識所有模糊情況。混合批次只把合格分類題送給 LAYA；其餘題目與本機
fallback 合併一次 Jev 請求，本機成功的題目不重問。

設定範例見 [`.env.example`](../.env.example)：使用 `JEV_PROVIDER=laya`，
`JEV_LAYA_MODEL_DIR` 指向**已下載**的模型，`JEV_API_KEY_FILE` 指向 Jev 金鑰檔。
檔名包含 `TYPESAFE` 時使用 TypeSafe 原生接口，否則分流使用 OpenRouter。
`JEV_MODEL` 設定雲端模型。沒有雲端金鑰時，需 Jev 的工作會報錯，不會擴大本機用途。
程式不自動下載權重。現有 INT8 模型磁碟約 540 MB，先前量到載入峰值約 1.2–1.9 GB RSS，
仍有記憶體成本。首次使用才載入，`JEV_LAYA_IDLE_MS` 控制閒置卸載，預設十分鐘。

**費用：**純分類且本機成功時，可省下一次 Jev 呼叫。混合題仍需 Jev，本機失敗也可能
由 Jev 接手。尚未量到整體淨節省；不為蒐集教師答案額外呼叫雲端。

**資料：**本機分類嘗試預設寫入私有 `~/.jevgate/routing-samples.jsonl`，權限 `0600`，
包含輸入文字。設 `JEV_ROUTING_LOG=off` 可停用。檔案不應提交 Git，使用前需人工
檢查與去識別。Jev fallback 答案只是教師參考，`label` 固定為 `null`，
`training_eligible` 為 `false`。**目前不自動評分、不自動訓練**；後續需人工正解、
去重、獨立訓練／測試集。尚未逐筆記錄 bundle 指紋，換模型、tokenizer 或 runtime
前要封存資料並記錄版本，不能混用後宣稱正確率。

**驗證與限制：**離線測試 273 通過、2 跳過，build 與 gateway acceptance 通過。
8 題合成中文題答對 7 題（任務類型 4/4、主題 3/4），不是通用準確率。
不可信的 `rl_agent` 原始 action logits 已移除，不轉成看似有效的機率。
policy 維持既有 advisory／shadow 設定。更新 checkout 後必須重啟 MCP；獨立安裝的
plugin cache 需另外更新。本次未驗證真實雲端與重啟後流量。
語意品質後續追蹤見 [Issue #10](https://github.com/royalskynet/jev-gate-mcp/issues/10)，
完整離線命令及證據見 [DEV LOG §25](DEVLOG.md)。

## Prune plugin

Claude Code plugin，用 Jev（System One）的 keep/drop 判斷，在 tool output
**進入模型 context 之前**先剪掉。

狀態：已上線。三個 function hook（Bash、Grep、Read），端到端實測過。

## 它做什麼

`hooks/jev.js` 對 `Bash`、`Grep`、`Read` 掛 `tool.call`。它先跑 `next(e)`，
若結果中的長字串超過該工具門檻，就依行邊界切塊，問 Jev 每塊對使用者當下的請求
有沒有幫助——**所有塊在同一個 request 裡**，一塊一個 Choice 問題，因為對同一份
state 的獨立問題該一次問完。被判 drop 的塊換成 `[jev-prune: dropped N lines]`；
留下的文字逐字通過，絕不改寫。單次呼叫最多判 `CONFIG.maxJudgedChunks`（8）塊、
約 128 KB；超過的部分不判，也**不截斷**，所以再大的輸出都不會因此掉東西。

只有答案自己的 `probabilities.drop` 過得了 `CONFIG.minDropProbability`（0.7），
而且沒被下面那條 deterministic 關鍵字否決，才真的剪。門檻掛在機率上，不是掛在
Choice `confidence`：批次會把分布攤開，同一塊
噪音單問時是 `drop` 0.98／confidence 0.96，跟另一塊一起問就變 `drop` 0.63／
confidence 0.25——門檻掛 confidence 會否決掉每一個真 drop，看起來跟「hook 根本沒
載入」一模一樣。被否決的 drop 會記進 ledger（`N unsure drops vetoed`），讓門檻
訂太高這件事是看得見的，而不是無聲把剪裁關掉。

0.7 是量出來的，不是挑出來的：`node scripts/calibrate-prune.mjs <corpus.jsonl>`
把人工標過的本機 tool output 用 hook 實際送的同一份 request 重放一次，再對標籤掃
門檻（8 cases／17 chunks／一輪約 $0.006）。明顯該丟的回 0.86–1.00，但貴的是另一
種：整塊幾乎都是雜訊、答案埋在裡面。真實 16 KB 的那塊——200 行 heartbeat 夾一行
`ERROR`——跨多輪落在 0.47–0.62。0.6 省 48.5% 的位元組但運氣差就把答案剪掉；0.7 省
29.3%，一次都沒剪錯。答案被剪掉比留著一坨 dump 貴。

有兩條規則寫在程式裡、擋在模型前面，因為模型自己被量出來會錯：

* **沒有 request 就不剪。** 每一條 criteria 都是相對使用者的任務寫的，沒有任務就
  沒有判斷基準，`pruneCommand` 回 `no-request` 而不是用猜的。Hermes middleware 以前
  拿 tool 自己的 shell 指令頂替：用 `cat log` 當基準去判，一個整個任務都在講它的
  40 KB 檔案被判 99.8% 該丟。現在 Hermes 會把該回合真正的請求綁進 middleware
  context，欄位叫 `user_request`——不是 `request`，因為 `_run_execution_chain` 把
  `request` kwarg 當成 dispatch **payload**，傳 `request=` 會讓 tool 拿到使用者那
  句話去當參數。子代理執行緒的 context 是空的，於是拒判，而不是拿主代理的任務當
  基準去剪。
* **關鍵字否決**（`vetoOnTerms`）。塊裡含有請求中**有鑑別力**的詞——有些塊有、不是
  每塊都有——就把 `drop` 壓成 `unsure`。每塊都有的詞說不出該留哪塊，忽略；只有一塊
  時任何命中都算。這條專治模型唯一可重現的盲點（問「哪幾個 commit 改過這條路徑」，
  `git log --stat` 那塊回 `drop` 0.92／confidence 0.84）。

| 工具 | 剪哪個欄位 | 門檻 | drop 準則 |
|---|---|---|---|
| `Bash` | `stdout` | 16,000 字元 | 雜訊、樣板、與任務無關的東西 |
| `Grep` | `content`（content mode） | 16,000 字元 | vendored／generated／fixture 檔案的命中 |
| `Read` | `file.content`（text 分支） | 16,000 字元 | 只剪機械性堆量——minified code、base64、lock 檔內容 |

三個門檻都是 `CONFIG.chunkChars`，這是 ledger 量出來的，不是湊整數。
`~/.openclaw/state/jev-prune.log` 有 19 次真實呼叫，其中**只有 1 次**剪掉東西
——一包 44 KB 的 Bash 輸出，省下全部 28,015 字元；其餘 18 次（含三次 12–13 KB 的
Read）一行都沒剪。低於一個 chunk 時，題目變成「整包丟掉還是整包留著」，而塞得進
一個 chunk 的輸出通常就是有答案，判 keep 是對的。拿那些真實大小重跑：

| 門檻 | 呼叫次數 | 省下字元 |
|---|---|---|
| 4,000 | 19 | 28,015 |
| 12,000 | 8 | 28,015 |
| **16,000** | **3** | **28,015** |
| 32,000 | 1 | 28,015 |

16,000 換到的是 Jev 呼叫 −84%、實測節省 −0%。32,000 在這份語料上一樣省，但它
只有一次呼叫寬，沒有 margin——下次輸出落在 16–32 KB 就整個失效；所以門檻放在
**結構邊界**：一個 chunk 是「部分丟棄」這件事能存在的最小單位。
`tests/jev.test.mjs` 釘住 `thresholdChars >= chunkChars`。

ledger 定下來的是那個**關係**——門檻等於一個 chunk——不是那個數字。
`chunkChars: 16000` 從第一個 commit 就是這個值，本身沒有單獨掃過；動它會把三個
門檻一起帶著動，所以那是 `scripts/calibrate-prune.mjs` 的問題，不是改一行的事。

這次抬門檻放棄掉一段：8–16 KB 的輸出，以前會判、現在不判。那些呼叫按定義不留痕跡，
所以 `prune` 臨時對「過半個 chunk 但未達門檻」的輸出寫一行 `jev-skip`，
`node scripts/prune-verdict.mjs` 以上線時間切開 ledger，印前後命中率與那些被跳過
的大小（chunk 相對 band）。命中率是算術——把從來沒剪到東西的呼叫拿掉，它自己就會
漲——所以證據在 band：厚就該回 12,000，薄就是 16,000 站得住。判完這段 logging
跟這段說明一起拆掉。

Read 仍然最保守：Bash 或 Grep 的結果是**關於**檔案的報告，而 Read 的結果
**就是**模型指名要的那個檔案，所以它的 drop 準則只剪讀起來沒有意義的堆量，
並明寫「不確定就留」。它現在被兩邊夾成一條窄帶：下限是一個 chunk，上限是 core
自己的 token cap——實測 207 KB 的 log 只送到 8,000 字元、114 KB 的 base64 送到
16,571。門檻若高過那個 cap，就是一個永遠不會觸發的 hook，而 fail-open 會把這件事
藏起來，所以 `tests/hook.live.test.js` 兩個邊界都釘。

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

需要 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` 與 Claude Code ≥ 2.1.274——指的是**實際跑這個 session 的那支 binary**（`$CLAUDE_CODE_EXECPATH`）的版本，不一定是 `PATH` 上的 `claude`。低於 2.1.274 時模組不是被拒收，是根本沒載入，而這個 repo 裡沒有任何東西會告訴你；見下方「ledger 是空的」。

### 刻意 fail-open

key 不見、4xx、schema 壞掉、judge 丟例外——每一種都回 `keep`，原始 output
原封不動通過。hook 超出預算被引擎跳過，效果一樣。

這也正是會藏 bug 的失敗模式：曾經一個寫錯的 model id 讓每次呼叫都 400，
但三個階段的測試照樣「綠」。所以 live 測試做**正向**斷言——output 必須量得到
變小，而一塊純雜訊必須回 `drop`。把 `typesafe/jev-1.13.0` 放回 `hooks/jev.js`，
它們就會紅。

### 觀測：ledger

`$.ui.log` 只到 TUI 不落檔，所以在無頭機上，hook 唯一的持久紀錄是寫到
`~/.openclaw/state/jev-prune.log` 的 ledger（`$` 沒有 append，
所以是 read-then-write；時間戳用 `$.clock.now`）。ledger 記錄**每一筆被判定為
可剪的呼叫**，keep 也記，不是只記 drop。它以前只在成功 drop 之後才寫、而且吞掉
自己的寫入錯誤，於是一個有觸發但全部判 keep 的 hook 會零痕跡，跟根本沒載入
分不出來。`appendLedger()` 永不丟例外，壞掉的 ledger 不會擋住 prune 本身。
一行 ledger 是 hook 有觸發的證據，**不是校準結果**——在有標註評估語料之前，
`calibration_status` 一律是 `uncalibrated`。

### ledger 是空的：一個症狀，六個根因

ledger 一行都沒多，六種原因從外面看一模一樣。照這個順序查，
每步一條指令，而且每步都能排掉它之前的全部。`npm run probe:ledger:e2e` 一條
指令把整條路走完：寫 fixture、用 `claude -p --debug --plugin-dir .` 無頭跑一次、
再 diff ledger——不必有人去重開一個互動 session 才知道結果。

1. **宿主不是你以為的那支 binary。**`claude --version` 報的是 `PATH` 上的那支，
   不是正在跑這個 session 的那支。包一層的客戶端（Happy、IDE 外掛、任何 SDK
   embed）自帶一份：`$CLAUDE_CODE_EXECPATH` 指到它，
   `"$CLAUDE_CODE_EXECPATH" --version` 才是算數的那個。本機實測：包裡是
   2.1.263、`PATH` 上是 2.1.278，兩天的空 ledger 被讀成門檻問題。
2. **模組被拒收了，而 `validate` 說它過了。**`hooks/index.js` 是單一聚合器：
   底下任何一處靜態分析錯誤就拒收整個模組，prune hook 一起陪葬。而
   `claude plugin validate .` 只要看到 `marketplace.json` 就走 marketplace 分支，
   **完全不看 hooks module**——那個 `✔` 是在講型錄。改用
   `npm run validate:hooks`，它會把該檔暫移開、結束時自動放回。本機實測：
   兩支 agent-glue hook 裡的 `$.ui?.log?.()` 讓模組被拒收了好幾天，前面卻一直
   掛著綠色的 marketplace `✔`（`$.ui` 被當值讀；`$` 一律只能寫成
   `$.noun.event(...)`，所以壞的是那個 optional chaining，不是那個呼叫）。
   還要確認**在跑的是哪一份複本**：從 marketplace 裝的 plugin 住在
   `~/.claude/plugins/cache/<name>/<name>/<version>/`，以版本號為 key，所以改
   source repo 什麼也不會變，而且版本沒 bump 之前 `plugin update` 會回
   「already at the latest version」。`settings.json` 裡那筆走本機 `path` 的
   plugin 則直接從 repo 跑，沒有這份複本。
3. **模組在載入時就炸了，而所有問「裝好了沒」的檢查都答得出「有」。**
   hooks module 沒有 Node：`process` 在那裡是 `ReferenceError`，而
   `hooks/index.js` 是單一聚合器，所以 module scope 上一處 `process.env`
   會在任何 hook 註冊之前就把七個 hook 全帶走。`validate` 照樣過——它讀的是
   `$` 呼叫的形狀，不是原始碼還提到了什麼。唯一會說的儀器是 `claude --debug`，
   在 `~/.claude/debug/<uuid>.txt` 裡的一行：

   ```
   [ERROR] hooks module jev-gate@inline failed to load:
           ReferenceError: process is not defined
   ```

   本機實測：兩天的空 ledger，期間 binary、旗標、key 檔、`validate:hooks`
   全部答「有」。現在所有環境變數讀取都走 `agent-glue/claude/env.mjs`——`ENV`
   在 Node 下就是 `process.env`，在 hook 裡是空物件，由各模組自己的
   `hydrate($)` 第一次用到時以 `$.env.get('NAME')` 填進去。
   `tests/no-node-globals.test.mjs` 會在載入鏈上任何檔案又提到 Node global 時變紅。
4. **function hooks 沒開。**`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` 要在**那支
   binary 的環境**裡，不是只寫在它沒 source 過的 shell profile。
5. **輸出根本沒到門檻。**core 把超過約 8 KB 的 Bash / Grep 結果落檔到
   `tool-results/<id>.txt`，代以約 2 KB 的 preview，所以 179 KB 的指令以前會以
   2 KB 抵達 hook，TARGETS 三個門檻在這兩支工具上都碰不到。`resolvePersisted()`
   現在會先把那個檔讀回來再判，而回寫上限是一個 chunk——超過就代表 core 那份
   盲截斷比較小，保留它。那個包裝的形狀是 core 的事、不是契約，所以探針還是
   走 `Read`：Read 整份遞達（實測 18,060 字元），不依賴這個解析還成立。
6. **key 檔讀不到。**那 ledger 會說，每個 session 一行
   `jev-nokey(<tool>)`。沒這種行就不是這個原因。

還有第七個，CLI 那條路：**CLI 從來不寫 hook 的 ledger。**跑一次
`cli.mjs prune` 寫的是它自己的 `~/.openclaw/state/jev-prune-cli.log`（標記
`jev-cli(...)`，可用 `JEV_CLI_LEDGER` 改道）——這是刻意的，所以 hook 的存活探針
把一次 CLI 執行讀成「什麼都沒發生」。CLI 跑得動只證明 judge 載入了，**不證明
hook 載入了**。hook ledger 空著、CLI ledger 很忙，正是「hook 從沒載入」的訊號，
不是健康狀態。

1 到 4 按定義在任何地方都不留痕，所以排最前面：這個 repo 裡每一個儀器都
裝在一個**從未載入的 hook 裡面**。debug log 是唯一的例外——它是引擎寫的、
不是 plugin 寫的，所以模組根本沒跑起來時它還會說話。

### 註冊是攤開寫的，不是跑迴圈

`register` 把 `Bash`、`Grep`、`Read` 各寫一行，每個 hook 槽是 function literal，
因為 `claude plugin validate` 是**靜態**讀原始碼的：用迴圈變數它會報
`tool.call{tool=tool}`，hook 槽裡放 factory call 它會直接拒收整個模組。
有一個測試斷言註冊的三個名字與 `TARGETS` 表一致——那正是迴圈本來要買到的東西。

## 安裝

```sh
npm install
claude plugin validate .
node --test              # 'live' 測試需要 ~/.creds/kv/OPENROUTER_SECOND_API_KEY.txt
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
`https://opencode.ai/zen/v1/systemone`（OpenCode Zen 免費層）、
model `jev-1.13-free`、key 讀 `~/.creds/kv/OPENCODE_ZEN_API_KEY.txt`。改走 OpenRouter 就設
`JEV_ENDPOINT=https://openrouter.ai/api/v1/systemone`、`JEV_MODEL=typesafe/jev-1.13`
與 `JEV_API_KEY_FILE`。

Zen 免費層有額度（2026-09-30 實測：429 `FreeUsageLimitError`，retry-after 倒數到 UTC 00:00）。
官方文件沒寫上限；維護者說免費量隨容量動態調整（anomalyco/opencode#28055），
社群回報限流器以 IP 計、非官方 client 只拿到很小的保底量（#33318、earendil-works/pi#2824）。
據此換 Zen key 或加值 Zen 餘額都不解除（未實測）；OpenCode Go 訂閱不含 Jev（`/zen/go/v1/models` 無 jev）。
不要偽造官方 client header 繞過。
Zen 一失敗就把 `cooldown_until` 寫進 `~/.jevgate/zen-free-status.json`（429 取
retry-after，其他錯誤 5 分鐘）；冷卻期間 gateway、Stop gate、prune、compact 都改問
OpenRouter（`~/.creds/kv/OPENROUTER_SECOND_API_KEY.txt`，gateway 可用
`JEV_ZEN_BACKUP_KEY_FILE` 改），到期自動回 Zen。沒有 OpenRouter key 就維持 fail closed。
顯式設了 `JEV_ENDPOINT`／`JEV_MODEL`／`JEV_API_KEY_FILE` 的 hook 不跟隨切換。
`scripts/zen-free-probe.mjs` 回 0＝Zen 主用、2＝冷卻中由備援頂、1＝失效且無備援。

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

**shadow 模式現在會自己收「離開 shadow 所需的證據」。** shadow 只有在樣本能被
評分時才有意義，所以語料 sink 出貨即開：每次 `apply_policy` 都往
`~/.openclaw/state/jev-calibration/<policy>.jsonl` 追加一行 JSONL——**一個 policy 一個檔**，
因為 `calibrate.mjs` 要求整份檔的 provenance 一致，而 `policy` 就是其中一欄，
共用單檔不論收多少真流量都評不了分（`JEV_CALIBRATION_LOG=<path>`
改路徑，字面值 `off` 關掉）。每筆同時帶原始 `gate` 與被 shadow 蓋住的
`public_outcome`，外加 `label: null` 等人填 —— `gateway/scripts/calibrate.mjs`
會拒收未標註的檔，所以沒人動過的語料絕不會被誤當成證據。樣本的
`dataset_version` 是 `live-<policy>-v1`：先前這裡蓋的是 spec 的
`synthetic-harness-*` fixture 版號，害 `harnessOnly()` 把每筆真實紀錄都判成
永久不合格，等於收了也走不到任何地方。

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
| 絕對上限（先到先觸發） | `JEV_COMPACT_AT_TOKENS` | 200000 tokens（0＝關） |
| 縮減門檻 | `JEV_COMPACT_MIN_REDUCTION` | 4,000 字元 |
| 釘住最近 turn | `JEV_COMPACT_PIN_LAST` | 6 |
| 給 judge 看的 payload 開頭 | `JEV_COMPACT_ASK_CHARS` | 1,200 |
| 關閉 | `JEV_COMPACT_ENABLED=0` | 預設開 |
| 後端 | `JEV_COMPACT_BACKEND` | `auto`；可固定 `anthropic`／`openai` |
| 保留機率門檻 | `JEV_COMPACT_KEEP_THRESHOLD` | 0.5（低於此機率的 call／result 刪掉） |
| state token 上限 | `JEV_COMPACT_MAX_STATE_TOKENS` | 25,000 |
| 單次請求 token 上限 | `JEV_COMPACT_MAX_REQUEST_TOKENS` | 30,000（state＋questions） |
| 被刪 result 保留的開頭 | `JEV_COMPACT_TRUNCATE_HEAD` | 300 字元（0＝只留註記） |
| judge 端點／模型 | `JEV_ENDPOINT`／`JEV_MODEL`（與 prune 共用） | 與 `hooks/jev.js` 同一組：`https://opencode.ai/zen/v1/systemone`／`jev-1.13-free`；非 OpenRouter 端點移除 `provider` 欄位 |
| 工作階段顯示結果訊息 | `JEV_UI_LOG=1` | 預設關閉；持久紀錄見 `~/.openclaw/state/jev-*.log` |

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

## 其他 host：openclaw 與 Hermes

兩邊都已實裝上線。能不能移植不看能力本身，看該 host 的 hook 契約允許 plugin
**改動**什麼：

| 能力 | Claude Code | openclaw | Hermes |
|---|---|---|---|
| prune（改寫 tool 結果） | `tool.call` | ✗ — `tool_result_persist` 是同步的（async handler 的回傳被記 log 然後丟掉），`after_tool_call` 只能觀察 | `tool_execution` middleware |
| 快速壓縮 | `session.compact` | `api.registerCompactionProvider()`（2026.9 起），需設 `agents.defaults.compaction.provider = "jev-compact"` 才啟用；任何例外都退回內建摘要器 | 未接（未來可用 `llm_request` middleware） |
| triage（模型路由） | `agent.spawn` | `before_model_resolve` → `providerOverride` / `modelOverride` | 未接（`llm_request`） |
| gate（阻斷呼叫） | `PreToolUse` | `before_tool_call` | `pre_tool_call` — 阻斷與 shadow 模式矛盾，故不接 |

### openclaw：`integrations/openclaw/`（plugin id `jev-gate`）

每輪一次 triage，掛在 `before_model_resolve`，**只降不升**：model map 只接
`cheap` 那一階，所以 `medium`／`hard` 判決會落到 `no-model-map` → 維持原狀。
降錯只賠一個弱答案；升錯會在每個模稜兩可的回合無聲計費貴模型。

```sh
openclaw plugins install --link ./integrations/openclaw --force --accept-capabilities
openclaw plugins enable jev-gate --accept-capabilities
# 非 bundled plugin 在授權前碰不到 conversation hook：
openclaw config set plugins.entries.jev-gate.hooks.allowConversationAccess true
openclaw plugins inspect jev-gate --runtime --json   # hookCount 要是 1，不是 0
```

例外：plugin config 設了 `triage: false` 時，`hookCount` 是 0 才正確（`register()` 直接跳過
hook，只留 compaction provider）。主模型已是最便宜一階（例如 `openrouter/free`），或沒設
`cheapModel` 時，就該關 triage；開了只會把對話導到不存在的 provider。

逃生開關 `JEV_OPENCLAW_TRIAGE=off`。每次決策——不論有沒有改——都往
`~/.openclaw/logs/jev-gate.jsonl` 寫一行。

Hermes 裁剪與 OpenClaw 路由的統一觀測報表：

```sh
node scripts/savings-report-hermes-jev-prune.mjs
node scripts/savings-report-hermes-jev-prune.mjs --json
```

報表並列兩種機制，不把裁剪字元與降級次數硬加成虛假的總數。OpenClaw ledger
目前沒有 token 與模型價格，所以只報 triage／降級命中率，淨成本節省標為 unknown。

### Hermes：`integrations/hermes/jev-prune/`

`tool_execution` middleware：包住真正的 tool 呼叫，回傳修剪過的結果。judge 沒有
在 Python 重寫一份，而是 shell out 到 `agent-glue/cli.mjs prune`——Claude Code
hook 用的同一個 judge。

```sh
ln -s "$PWD/integrations/hermes/jev-prune" ~/.hermes/profiles/<profile>/plugins/jev-prune
hermes -p <profile> plugins enable jev-prune
hermes plugins doctor ./integrations/hermes/jev-prune
python3 integrations/hermes/live-probe.py    # 真 loader ＋ 真 middleware chain
```

plugin 放在**該 profile 的 home** 底下（`~/.hermes/profiles/<profile>/plugins`），
不是 `~/.hermes/plugins`；預設 profile 看 `~/.hermes/active_profile`。manifest 刻意
不寫 `provides_hooks`：middleware 跟 `VALID_HOOKS` 是兩個不同介面，當成 hook 宣告
會讓 `plugins doctor` 直接報錯。Ledger：`<profile home>/logs/jev-prune.jsonl`。

## Skills：什麼情境拉進哪套規則

兩個 skill 隨 plugin 放在 `skills/`，並 symlink 到 `.claude/skills/`，所以直接在
這個 repo 裡工作時也會以 project scope 載入。

| Skill | 何時觸發 |
|---|---|
| `skills/jev-agent` | 路由、壓縮、宣告完成、挑 review profile、改 `agent-glue/src/*`，或呼叫 `jev_evaluate`／`jev_apply_policy` MCP tool |
| `skills/typesafe-ai` | 設計或修改任何 Jev 問題——措辭、批次、criteria、門檻、confidence 政策——或改 `hooks/jev.js` 與 host 整合 |

`skills/typesafe-ai/SKILL.md` 是 TypeSafe 官方 skill 的 vendored 版（MIT，上游
[typesafe-ai/skills](https://github.com/typesafe-ai/skills)），只在 `description`
多加兩行觸發情境，並在檔尾附一段明確標示的本地 addendum，把它的 pattern 對應到這個
repo。之所以 vendor：`claude plugin marketplace add typesafe-ai/skills` 在這台機器
跑不了——沙箱擋 `~/.claude/plugins` 的寫入——而這個 repo **本身就是** plugin 的安裝
位置，skill 放進來等於到同一個地方。另外沙箱的 shell 連不到 `docs.typesafe.ai`，
WebFetch 可以，addendum 有寫。

frontmatter 才是 skill 能被找到的前提。`skills/jev-agent/SKILL.md` 原本完全沒有，
所以永遠不可能被任何情境命中；現在 `tests/integrations.test.mjs` 有測試斷言每個
`SKILL.md` 都有 `name` 與 `description`。

## 也在這個 repo，但沒掛上

`plugin/` 放 Node 側的實驗：`lib/judge.js`、`lib/route.js`
（deterministic 預篩 + 一次 open-world Jev Choice）、`lib/gate.js` 與
`hooks/gate.js`（shadow 模式的 Stop/PreToolUse ghost-loop gate）。
都有測試，但刻意沒接線——原因見 `docs/NEXT.md`。

## 文件

- [Gateway README](../gateway/README.md) — Decision Gateway MCP server（v2 SDK、兩支工具、只走 stdio）
- [Companion agent instructions](agent-instructions.md) — agent 什麼時候該呼叫這些工具
- [Host Adapter 契約](host-adapter.md) — 強制的、由 host 執行的 lifecycle gating
- [產品需求](prd/jev-decision-gateway.md)
- [領域脈絡](../CONTEXT.md)
- [架構決策](adr/0001-governed-two-tool-mcp-boundary.md)
- [接下來做什麼](NEXT.md)
- [繁中接線與 Codex 快速指南](zh-TW/README.md) — 把 gateway 接到 Claude Code／Codex
- [Handoff 2026-09-21（繁中）](HANDOFF-20260921.md) — **沒有前情提要就從這裡開始**
- [Jev 十步操作手冊（繁中）](zh-TW/PLAYBOOK.md) — 十步手冊對應到這個 repo，含缺口
- [TypeSafe skill](../skills/typesafe-ai/SKILL.md) — vendored 上游 skill（MIT）＋對應到本 repo 的 addendum
- [Agent glue（繁中）](agent-glue.md) — 各 host 的安裝／停用／觀測，以及四項有效性指標
- [Agent skill](../skills/jev-agent/SKILL.md) — 兩個 host 共用的操作規則
- [開發日誌](DEVLOG.md) — 怎麼做出來的，以及踩過哪些坑
