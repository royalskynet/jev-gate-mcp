# Jev Gate

**繁體中文** · [English](README.en.md)

**幫 AI 助手少讀雜訊，把簡單的分類交給本機處理。**

寫程式時，AI 常會讀到大段日誌、搜尋結果和工具輸出。
Jev Gate 會判斷哪些內容與眼前工作有關，減少送進對話的無關文字。
它也能替 Claude Code、Codex 提供任務分類和審查建議。

## 它能幫你做什麼？

| 你遇到的情況 | Jev Gate 做的事 |
|---|---|
| 工具回傳一大串日誌 | 在支援的環境中，保留相關段落，裁掉雜訊 |
| 對話越來越長 | 在支援的環境中縮短工具紀錄，留下的內容維持原文 |
| 想分配任務、檢查是否完成 | 提供分類與審查意見；完成判斷仍要看實際執行證據 |

例如，你要找一個錯誤，工具卻回傳幾百行重複訊息。
Jev Gate 的目標是留下錯誤線索，讓 AI 少讀那些重複內容。
它可能判錯，所以不能把它的意見當成操作授權。

不需要本機模型的話，可以用精簡版 [jev-gate-lite](https://github.com/royalskynet/jev-gate-lite)：只用雲端 JEV，壓縮與裁剪功能相同。

## 對話太長時怎麼壓縮？

在 Claude Code 裡，對話用到 context 的 60%，或達到 200K token，哪個先到就自動壓縮：

1. JEV 先刪舊的工具紀錄，對話文字原樣保留。
2. 省不到 30%、上次壓完還剩超過 60K token，或 JEV 出錯時，改用 Claude Code 內建的摘要壓縮。

這個「先刪工具紀錄、晚一點才摘要」的組合，依據的是 JetBrains Research 的論文 [The Complexity Trap](https://arxiv.org/abs/2508.21433)（arXiv 2508.21433）。論文發現只刪舊工具輸出，效果和 LLM 摘要差不多，成本少一半；兩者混用，成本比只刪再少 7%，比只摘要少 11%。門檻與實測數字見 [ADR 0004](docs/adr/0004-jev-then-builtin-reset.md)。

## LAYA 和 JEV 怎麼分工？

LAYA 是跑在你電腦上的小模型，JEV 是雲端判斷服務。
啟用 `JEV_PROVIDER=laya` 後，兩者這樣合作：

| 工作 | 交給誰 |
|---|---|
| 符合固定題型的簡短分類，例如任務類型、訊息主題 | LAYA 先做 |
| 難度、風險、完成驗證，以及其他判斷 | JEV |
| LAYA 出錯、答案格式不對，或沒有匹配分類 | JEV 接手 |

**LAYA 目前只適合有限範圍的試行。**它仍可能把主題分錯。
裁剪日誌和壓縮對話也繼續用 JEV，不交給 LAYA。

只有簡單分類、而且 LAYA 成功處理時，可以省下一次雲端呼叫。
混合任務仍可能需要 JEV；整體能省多少，還沒有實測結論。

## 使用前先知道

- **費用：**本機分類不用雲端費用，JEV 呼叫仍可能計費；這不是全免費模式。
- **硬體：**目前使用的本機模型約 540 MB，載入時曾量到約 1.2–1.9 GB 記憶體用量。
- **資料：**本機分類預設會留存文字與答案，供之後人工檢查；不會自動訓練。設 `JEV_ROUTING_LOG=off` 可停止留存。

## 怎麼開始？

你需要 Node.js 22 或 24，以及已設定的 JEV 金鑰。若要用 LAYA，也需要先備妥本機模型；程式不會自動下載。

```sh
git clone https://github.com/royalskynet/jev-gate-mcp.git
cd jev-gate-mcp
npm install
```

接著依你使用的工具設定：

- **Claude Code：**看[連接步驟](docs/zh-TW/README.md#claude-code-接線)。若要啟用裁剪與壓縮，另看[插件安裝](docs/REFERENCE.zh-TW.md#安裝)。
- **Codex：**看[連接步驟](docs/zh-TW/README.md#codex-直接適配)。Codex 與 Claude Code 的可用功能不同。
- **已經裝過：**更新你實際使用的那份專案或插件，再重啟對應的 MCP／工作階段。MCP 就是讓 AI 助手連接這套工具的橋梁。

LAYA 的設定和資料留存方式見[分工與設定詳解](docs/REFERENCE.zh-TW.md#laya-routing)。

## 想看細節？

| 想找什麼 | 從這裡開始 |
|---|---|
| 各工具支援哪些功能、怎麼設定 | [連接指南](docs/zh-TW/README.md) |
| 模型分工、資料留存、進階設定 | [技術參考](docs/REFERENCE.zh-TW.md) |
| MCP 接口與開發方式 | [Gateway 文件](gateway/README.md) |
| 做過哪些測試、遇過哪些問題 | [開發日誌](docs/DEVLOG.md) |
| 回報問題或查看進度 | [GitHub Issues](https://github.com/royalskynet/jev-gate-mcp/issues) |

目前的本機模型品質限制，持續記錄在 [Issue #10](https://github.com/royalskynet/jev-gate-mcp/issues/10)。
