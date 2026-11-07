# jev-laya opencode plugin

在 opencode 的 `tool.execute.after` hook 縮短工具輸出，不分用哪個模型：

1. L0 剪裁（去 ANSI、收合 progress、收合重複行），本機確定性，免費。
2. 剪完仍 ≥16KB 的 `bash`／`read`／`grep`／`glob`／`webfetch` 輸出，交 Jev 依「最新一則使用者訊息」逐 chunk 判斷 keep/drop（同 `agent-glue/src/prune.js`，被丟的段落留 `[jev-prune: dropped N lines]`）。`edit`／`write` 等輸出不送。

3. **compaction**（`experimental.chat.messages.transform`）：歷史裡的工具輸出累積 ≥80K 字時，把最新 4 則以外、≥2KB 的舊工具輸出（工具名＋參數＋前 800 字）每 8 段一批交 Jev 判 keep/drop，drop 的換成 `[jev-compact: dropped N chars of <tool> <參數>; re-run the tool to see it]`。只有 `read`／`grep`／`glob` 的唯讀輸出可 drop；`bash`／`webfetch` 及其他工具一律 keep。使用者與模型的文字一律原文保留。判決按 callID + 最新使用者訊息 sha1 記住；換新使用者訊息會重判；drop 的原文只留記憶體，後續判 keep 可還原。`JEV_COMPACT_ENABLED=0` 關閉。

4. **推理強度**（`chat.message`＋`chat.params`）：每則使用者訊息交 `agent-glue/src/triage.js` 判一次難度。文字從 `chat.message` 取，因為 `chat.params` 拿到的訊息沒有 parts。判成 `cheap` 時只往下調模型已設的 `reasoningEffort`（→ `low`）、`thinking.budgetTokens`／`thinkingConfig.thinkingBudget`（→ 4000），從不調高，模型沒有這些參數就不動。**只在有 Laya cascade 時才跑**：`~/.jevgate/cascade-callers.json` 設了 `effort`（指向 `:8793` daemon）才判；沒設或 daemon 打不通就整段跳過，不退回付費的行程內 Jev，所以 M2 這類沒裝 Laya 的機器自動關閉，`JEV_EFFORT_ENABLED=1` 才強制開。**預設直接生效**：等判斷最多 1.5 秒，逾時就維持原狀，結果記在 `~/.jevgate/opencode-effort.log`（欄位 `tier`／`knobs`／`lowered`）。`JEV_EFFORT_APPLY=0` 改成只記 log（欄位 `would_lower`），在背景判、不卡住這一輪。`JEV_EFFORT_ENABLED=0` 整段關閉。

零 token 去重（同一工具同參數重跑只留最新、失敗呼叫的大參數過幾輪清掉）不在這裡，放 Genie：`genie-harness/opencode/genie-dedup.js`。

任何錯誤 fail-open：最差就是 L0 結果／原樣歷史，絕不比原輸出少資訊。

## 安裝

```sh
# 在 repo 根目錄執行
ln -s "$PWD/integrations/opencode/jev-laya.js" ~/.config/opencode/plugin/jev-laya.js
```

M2：`bash scripts/m2-opencode-jev-install.sh`（含煙霧測試；找得到 Genie repo 時一併 pull 並接上 `genie-dedup.js`）。

## Jev 端點

沿用 `hooks/jev.js` 的 `JEV_ENDPOINT`／`JEV_MODEL`／`JEV_API_KEY_FILE`。三者都沒設、但有 `~/.creds/kv/TYPESAFE_API_KEY.txt` 時自動改走 TypeSafe 直連（M2 的情況）。usage caller＝`prune:opencode`／`compact:opencode`。壓縮與剪裁只走 `compact`／`prune` 對應的 cascade（由 `~/.jevgate/cascade-callers.json` 決定）；沒有 cascade 就跳過，不直打 Jev 端點。雲端 cascade 外送前經 `http://127.0.0.1:4102/scrub`（`JEV_CASCADE_SCRUB_URL` 可覆寫）遮蔽字串葉節點；遮蔽失敗、逾時或長度不符則不送原文並 fail-open。Laya 本機判斷拿原文。每次 cascade 判斷預設 8 秒 deadline（`JEV_COMPACT_TIMEOUT_MS` 可覆寫），連續 3 次失敗本行程停用壓縮，log 寫 `~/.jevgate/opencode-compact.log`。

## 注意

- 不要和 opencode-dynamic-context-pruning（DCP）同時裝：兩者都改同一段歷史（fix 9587 同型）。

- `opencode run --pure` 不載 plugin，dc 不受影響。
- `jev-laya.js` 只能匯出 plugin 本身：opencode 會把每個匯出的函式當 plugin 呼叫，輔助函式放 `prune-core.js`。
