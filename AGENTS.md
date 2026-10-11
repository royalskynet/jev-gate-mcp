# Agent instructions

- 一律使用繁體中文溝通與撰寫產品文件；程式碼、API 欄位及專有名詞保留原文。
- 先讀 `CONTEXT.md` 與相關 `docs/adr/`，再修改產品或架構。
- 保持 MCP surface 小而穩定；新增工具前先確認不能用 policy pack 解決。
- Jev 只負責 typed judgment；授權、計算、驗證與執行留在 deterministic code。
- 不把 confidence 當正確率；所有自動化門檻必須經目標資料校準。
- 不提交 API keys、使用者 state、決策內容 log 或其他敏感資料。

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical five-label triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with root `CONTEXT.md` and system ADRs under `docs/adr/`. See `docs/agents/domain.md`.
