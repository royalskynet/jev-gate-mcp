# 工單：beam-free 加 API 路徑（CLI 退為後備）（2026-11-06）

工作目錄：/Users/you/dev/jev-gate-mcp

repo：`/Users/you/dev/jev-gate-mcp`（git，main 上改，commit 訊息含 `beam-api`，不 push）。前一張工單 `docs/wo/wo-20261106-cascade-beam.md` 已加 `makeOpencodeCliAdapter`，先讀它。

## 背景

使用者 11-06 定：`opencode-go/beam-free` 開 API 例外（同 Coco、OpenClaw）。cascade 順序變成 Laya → jev-1.13-free（Zen）→ beam-free API → beam-free CLI。

## 改動

1. `gateway/src/adapters.js` 新增 `makeBeamApiAdapter({ apiKey, baseUrl = 'https://opencode.ai/zen/go/v1', model = 'beam-free', timeoutMs = 60000, backup = null, fetch, now, readStatus, onStatus })`：
   - POST `${baseUrl}/chat/completions`（OpenAI 相容，`Authorization: Bearer <apiKey>`），`max_retries` 為 0、不重試。
   - prompt 與答案解析／驗證**共用** `makeOpencodeCliAdapter` 的同一組函式（抽成同檔內部函式，不複製）。
   - 失敗（非 2xx、逾時、JSON 不合格）→ 有 `backup` 就交 backup，沒有就 throw。
   - 回 403 且 body `error.type === 'FreeTierError'`，或 429 → 冷卻 6 小時，冷卻期間直接交 backup、不發網路請求。冷卻狀態寫 `~/.jevgate/beam-api-status.json`（路徑可注入，測試用暫存檔）。理由：使用者規則禁止對免費層反覆探測。
2. `gateway/src/cascade-server.js` main：`const beam = zenKey ? makeBeamApiAdapter({ apiKey: zenKey, backup: makeOpencodeCliAdapter({}) }) : makeOpencodeCliAdapter({})`，Zen 的 `backup: beam`。
3. Zen remediation 文字改成「期間走 beam-free（API，失敗退 opencode CLI）」。

## 測試（要會失敗）

`gateway/test/beam-api-adapter.test.mjs`（注入假 fetch，不連網）：
- (a) 200＋合法 JSON → 回答案，URL 以 `/chat/completions` 結尾、model＝`beam-free`。
- (b) 500 → 呼叫 backup。
- (c) 403 FreeTierError → 呼叫 backup，且寫入冷卻；第二次呼叫不觸發 fetch。
- (d) 機率不合格 → 呼叫 backup。

## 驗收

```bash
cd /Users/you/dev/jev-gate-mcp && npm test \
 && test -f gateway/test/beam-api-adapter.test.mjs \
 && grep -q "makeBeamApiAdapter" gateway/src/cascade-server.js \
 && grep -q "zen/go/v1" gateway/src/adapters.js \
 && ! grep -n "makeOpenrouterAdapter(" gateway/src/cascade-server.js \
 && git log --format=%s -20 | grep -qi beam-api
```

不要做：重啟服務、改 `~/.jevgate/*`、改 `~/.config/opencode/*`、push、真的打 opencode.ai。
