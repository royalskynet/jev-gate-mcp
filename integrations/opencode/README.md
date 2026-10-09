# jev-laya opencode plugin

在 opencode 的 `tool.execute.after` hook 縮短工具輸出，不分用哪個模型：

1. L0 剪裁（去 ANSI、收合 progress、收合重複行），本機確定性，免費。
2. 剪完仍 ≥16KB 的 `bash`／`read`／`grep`／`glob`／`webfetch` 輸出，交 Jev 依「最新一則使用者訊息」逐 chunk 判斷 keep/drop（同 `agent-glue/src/prune.js`，被丟的段落留 `[jev-prune: dropped N lines]`）。`edit`／`write` 等輸出不送。

3. **compaction**（`experimental.chat.messages.transform`）：歷史裡的工具輸出累積 ≥80K 字時，把最新 4 則以外、≥2KB 的舊工具輸出（工具名＋參數＋前 800 字）每 8 段一批交 Jev 判 keep/drop，drop 的換成 `[jev-compact: dropped N chars; …]`。使用者與模型的文字一律原文保留。判決按 callID 記住，同一段只判一次；丟過的之後每輪照丟，prompt cache 前綴只在每次 pass 變一次。`JEV_COMPACT_ENABLED=0` 關閉。

4. **推理強度**（`chat.message`＋`chat.params`）：每則使用者訊息交 `agent-glue/src/triage.js` 判一次難度。文字從 `chat.message` 取，因為 `chat.params` 拿到的訊息沒有 parts。判成 `cheap` 時只往下調模型已設的 `reasoningEffort`（→ `low`）、`thinking.budgetTokens`／`thinkingConfig.thinkingBudget`（→ 4000），從不調高，模型沒有這些參數就不動。**預設只記 log**（`~/.jevgate/opencode-effort.log`，欄位 `tier`／`knobs`／`would_lower`），在背景判、不卡住這一輪。`JEV_EFFORT_APPLY=1` 才真的改參數，此時等判斷最多 1.5 秒，逾時就維持原狀。`JEV_EFFORT_ENABLED=0` 整段關閉。

零 token 去重（同一工具同參數重跑只留最新、失敗呼叫的大參數過幾輪清掉）不在這裡，放 Genie：`genie-harness/opencode/genie-dedup.js`。

任何錯誤 fail-open：最差就是 L0 結果／原樣歷史，絕不比原輸出少資訊。

## 安裝

```sh
ln -s /Users/51mini/dev/jev-gate-mcp/integrations/opencode/jev-laya.js ~/.config/opencode/plugins/jev-laya.js
```

M2：`bash scripts/m2-opencode-jev-install.sh`（含煙霧測試；找得到 Genie repo 時一併 pull 並接上 `genie-dedup.js`）。

## Jev 端點

沿用 `hooks/jev.js` 的 `JEV_ENDPOINT`／`JEV_MODEL`／`JEV_API_KEY_FILE`。三者都沒設、但有 `~/.creds/kv/TYPESAFE_API_KEY.txt` 時自動改走 TypeSafe 直連（M2 的情況）。usage caller＝`prune:opencode`。

## 注意

- 不要和 opencode-dynamic-context-pruning（DCP）同時裝：兩者都改同一段歷史（fix 9587 同型）。

- `opencode run --pure` 不載 plugin，dc 不受影響。
- `jev-laya.js` 只能匯出 plugin 本身：opencode 會把每個匯出的函式當 plugin 呼叫，輔助函式放 `prune-core.js`。
