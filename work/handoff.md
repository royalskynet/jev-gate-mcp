# LAYA／JEV 分工交接

更新：2026-09-29。使用者暫停後已說「繼續」，本次實作及離線驗證已完成。

## 決定與完成內容

- 使用者授權「記錄 DEV LOG，先這樣分工實裝」，並要求累積評分／訓練資料。
- LAYA 只試行固定題型的短文字任務／主題分類；其他判斷和所有 policy 交給 JEV。
  本機無匹配、錯誤、格式不合法才 fallback；不新增教師請求。
- 移除 triage 的本機覆蓋旁路；verify 與 fix store 關聯度改走 JEV。
  本機 `rl_agent` 原始 action logits 不再作為機率暴露。
- 新增私有待標註 JSONL，人工正解為 null、training_eligible=false，不自動訓練。
- 審查修正：逾時後不啟動新的 JEV 請求；policy 健康狀態使用自己的 breaker；
  verify 單元測試注入假 judge，避免新增真實 JEV 呼叫。
- 完整說明、研究連結、資料限制與重跑命令：`docs/DEVLOG.md` §25。

## 工作區與驗證

- checkout：`/Users/m2/jev-gate-mcp`。
- 分支：`fix/laya-jev-task-routing`；基底：`b024d49bc531680946ba6adc766432b1c3b741aa`。
- 使用者已授權 commit、push、合併主分支與處理相關 PR／Issue，並要求 GitHub 中英說明。
  PR #9、#11 已合併至 main（#11 merge commit `f72c070`），本工作區已切回 main。
  Issue #10 已補中英處理紀錄，保留模型品質追蹤；沒有同步其他 checkout 的既有修改。
- 首頁後續改為繁中白話導覽；英文 `README.en.md`，原完整內容在 `docs/REFERENCE.*.md`。
- 重點測試 41/41；完整離線 275 項，273 通過、0 失敗、2 跳過；build、gateway acceptance、
  diff whitespace 檢查通過。真實 JEV 連線未驗證。
- 完整測試使用不存在的 key 路徑、停用資料紀錄，排除既有 live 測試；不要直接裸跑
  `npm test`，既有測試可能偵測本機 key 而呼叫雲端。
- 本機 smoke：8 題合成中文題答對 7 題，主題題「營業時間」誤判 billing。
  不能當正式準確率；沿用現有 540MB INT8 權重，沒有下載模型。
- 本次日誌（暫存檔可能被系統清除）：`/tmp/jev-review-green.tap`、
  `/tmp/jev-routing-final-offline.tap`、`/tmp/jev-routing-build.log`、
  `/tmp/jev-routing-acceptance.log`、`/tmp/jev-routing-local-smoke.json`。

## 啟用狀態與下一步

1. Claude `jev_gate` MCP 已指向本 checkout 的 `gateway/src/stdio.js`，provider=laya。
   既有 MCP 程序仍需重新啟動以載入修改；尚未驗證重啟後的流量。
2. Codex plugin cache `/Users/m2/.codex/plugins/cache/jev-gate/jev-gate/local` 是另一份
   checkout，含既有 shape B hook 實驗修改。本次沒有同步，也沒有改全域 hooks／設定。
   若後續要求部署到這一份，先檢查差異，不能整包覆蓋。
3. 自然使用後檢查私有 `~/.jevgate/routing-samples.jsonl` 是否產生分類樣本；
   不為取樣額外呼叫 JEV。停止蒐集可設 `JEV_ROUTING_LOG=off`。
4. 下一階段另做人工標註、去識別、去重、獨立測試集和逐題型評分；評分／批次訓練
   工具尚未實作。JEV 教師答案不等於人工正解，不把未標註資料直接拿去訓練。

## 保留限制

- 簡單分類仍可能高信心錯答；沒有憑信心閾值放行的重要操作。
- 外層逾時不會主動取消已開始的 ONNX／雲端工作，但不會再新增逾時後的雲端呼叫。
- corpus 未逐筆寫 bundle 指紋；當前權重 SHA 已記在 DEVLOG。換權重／tokenizer／runtime
  前先封存分組並記來源，不能混用資料宣稱跨版本正確率。
- policy shadow、uncalibrated、rollout 0、授權及執行證據規則保留。
