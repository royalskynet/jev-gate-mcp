# NEXT：卡點與待辦

## 卡點（必須先解）— Provider 端無法提供 Jev model

WO 指定「Provider 走 OpenRouter Decisions endpoint」＋ `OPENROUTER_API_KEY`。
`jevwire` 的 `JevDecisionModel` 是 **TypeSafe `/v1/systemone` 直通**（baseUrl 可換，
wire shape 固定）。實測（2026-09-20）：

- `POST https://openrouter.ai/api/v1/systemone` 路由存在（非 404），
- 但此帳號下所有 Jev model id 全部 400「model does not exist」：
  `typesafe/jev-1.13.0`、`typesafe/jev-latest`、`typesafe/system-one`、`jev-*` 皆然，
- `GET /v1/models` 不含任何 jev/typesafe/system 系列 model。

**結論**：目前手上這把 key 無法讓任何 Jev 判斷真正跑通。所有 Phase 因此走 fail-open
（不 prune、全部 no_match、gate 只記錄失敗），**安全但無實際省 token 效果**。

解鎖方式（擇一，屬外部依賴）：
1. 取得真正的 TypeSafe API key（`https://typesafe.ai`），改
   `plugin/config.default.json` 的 `apiKeyFile` 指向該 key 檔，`baseUrl=https://api.typesafe.ai`，
   `model=jev-1.13.0`（已釘版本，非 `-latest`）。驗證：跑一次 `node plugin/hooks/prune.js < tests/fixtures/long-bash.json` 看 kept_len 是否 < orig_len。
2. 若 OpenRouter 之後提供 Jev model，更新 `model` 為其正式 id 並驗證同上。

> 未改 provider adapter：`jevwire` 匯出（`JevDecisionModel`、`runEvaluate`/`runVerify`/`runNextStep`）直接當依賴使用。

## Phase 0 未完成項

- claude.ai connectors `Gmail` / `Google_Calendar` / `Claude_Docs`：30 天 0 真實呼叫。
  它們**不在** `/Users/51mini/.claude.json`（該檔無對應鍵），斷開是 claude.ai `/mcp` 的
  GUI 動作，無頭機無法程式化執行。需手動在 `/mcp` 關閉。其餘（headroom/graphify/skillspector/markitdown/repomix/mem0）已移至 `_mcpServersDisabled`。

## Phase 3 剩餘：live 掛載

`plugin/hooks/gate.js` 已寫好且 shadow=true（只記錄不阻擋），單元測試全過；
但**尚未**註冊進 `/Users/51mini/.claude/settings.json`（系統檔，跨 repo，且 Phase 3 採
shadow 兩週）。待：
1. provider 解鎖（見上）。
2. 在 settings.json 的 `hooks.PreToolUse` 與 `hooks.Stop` **既有項目之後**追加 gate.js，
   並確認 `hooks` 順序排最後、任何情況不覆蓋既有 deny。
3. 兩週 shadow 紀錄無誤後才把 `plugin/config.default.json` 的 `shadow` 改 false。

## 各 Phase 現況

| Phase | 狀態 | 驗證 |
|---|---|---|
| 0 | ✅ 完成 | 背份＋移出 disabled，驗證指令全過 |
| 1 | ✅ 完成（邏輯） | npm test；long-bash 59889→59889（fail-open）；short 未動；log 無 key |
| 2 | ✅ 完成（結構） | route-bench 10 題全 fail-open no_match；empty 拋錯；npm test 過 |
| 3 | ✅ 完成（shadow 結構） | coexist test 過；shadow=true 檢查過 |
