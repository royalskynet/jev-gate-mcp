## 任務

新增 `gateway/src/cascade-server.js`、`tests/cascade-server.test.mjs`、`scripts/launchd/com.51mini.jev-cascade.plist`。設計見 `/Users/51mini/dev/jev-gate-mcp/docs/prd/PLAN-20261008-laya-first-cascade.md`「設計」段。前提：本目錄已有 `gateway/src/budget.js`（上一張工單）。

1. 匯出 `makeCascadeServer({ cascade, layaOnly, log = logUsage, cacheMax = 2000, cacheTtlMs = 86400000, now = Date.now })` 回傳 `http.createServer(...)`（未 listen）。`logUsage` 從 `../../agent-glue/src/usage-ledger.js` import。
   - `GET /health` → 200 `{"ok":true}`。
   - `POST /v1/systemone`：body 上限 1MB（超過 413）；JSON 解析失敗或 `questions` 不是非空物件 → 422 `{"error":{"type":"invalid_request"}}`。
   - `x-jev-mode: laya-only` 用 `layaOnly`，其他用 `cascade`。呼叫 `fn(body.state, body.questions, {})`，**不轉傳 body.model**。
   - 快取：key＝`sha256(mode + JSON.stringify({state, questions}))`，Map 實作，超過 cacheMax 刪最舊，過期不用。命中回應加標頭 `x-jev-cache: hit`。
   - 成功 200：`{"model": r.model ?? "jev-cascade", "answers": r.answers, "usage": r.usage ?? {"input_tokens":0,"output_tokens":0}}`。
   - 錯誤對照：`e.code==='JEV_BUDGET_EXCEEDED'||'JEV_PAYMENT_REQUIRED'` → 402；`e.code==='LAYA_ABSTAIN'` → 503；`e.status===429` → 429；其餘 502。body 一律 `{"error":{"type":<code 或 "upstream">}}`，不放 message。
   - 每個請求呼叫一次 `log({caller: "cascade:" + (x-jev-caller 標頭 || "unknown"), model: 命中快取時 "cache" 否則 r.model, status: HTTP 狀態碼, input_tokens, output_tokens, latency_ms})`。
2. 檔案被直接執行時（`import.meta.url === pathToFileURL(process.argv[1]).href`）組真實鏈並 listen `process.env.JEV_CASCADE_PORT ?? 8793`、host 固定 `127.0.0.1`：
   - `local = makeLayaAdapter({})`；金鑰用本檔內的 `readKey(file)`（readFileSync trim，失敗回 null），路徑取 `DEFAULTS.zenBackupKeyFile`（OR）與 `DEFAULTS.apiKeyFile`（Zen），`DEFAULTS` 從 `./config.js` import。
   - `or = orKey ? withPaymentStop(withDailyBudget(makeOpenrouterAdapter({ apiKey: orKey }))) : null`
   - `zen = zenKey ? makeZenAdapter({ apiKey: zenKey, model: 'jev-1.13-free', backup: or }) : or`
   - `cascade = withRedaction(makeLayaRouter({ local, cloud: zen ? withTeacherCorpus(zen) : null }))`
   - `layaOnly = withRedaction(makeLayaRouter({ local, cloud: async () => { const e = new Error('laya abstained'); e.code = 'LAYA_ABSTAIN'; throw e; } }))`
   - `process.env.JEV_CASCADE_MODE === 'laya-only'` 時 `cascade` 也設成 `layaOnly`（給 M2）。
3. 測試用注入的假 `cascade`／`layaOnly`／`log`，`server.listen(0,'127.0.0.1')` 後用全域 `fetch` 打。至少測：health；同請求第二次 `x-jev-cache: hit` 且 cascade 只被叫 1 次；laya-only 標頭走 layaOnly；`LAYA_ABSTAIN`→503、`JEV_BUDGET_EXCEEDED`→402；body.model 沒傳進 fn 的 opts；log 收到 caller `cascade:test`。
4. plist：Label `com.51mini.jev-cascade`，ProgramArguments `/opt/homebrew/bin/node` 與 `/Users/51mini/dev/jev-gate-mcp/gateway/src/cascade-server.js`，`KeepAlive` true，`RunAtLoad` true，stdout/stderr 到 `/Users/51mini/.jevgate/cascade.log`／`cascade.err.log`，EnvironmentVariables 只放 `JEV_CASCADE_PORT=8793`。

## 驗收

```sh
test -f gateway/src/cascade-server.js
grep -q 'export function makeCascadeServer' gateway/src/cascade-server.js
grep -q "127.0.0.1" gateway/src/cascade-server.js
grep -q 'LAYA_ABSTAIN' tests/cascade-server.test.mjs
plutil -lint scripts/launchd/com.51mini.jev-cascade.plist
JEV_USAGE_LOG=off node --test tests/cascade-server.test.mjs
JEV_ROUTING_LOG=/dev/null JEV_TEACHER_CORPUS=/dev/null JEV_USAGE_LOG=off node --test
git diff --quiet HEAD~1 -- gateway/src/adapters.js gateway/src/config.js gateway/src/laya-routing.js gateway/src/budget.js
```

預期：全部 exit 0；兩個 `node --test` 都 `fail 0`；plutil 印 `OK`；既有 gateway 檔與 budget.js 無改動。

## 禁止

- 禁止改上述三個新檔以外的檔案；禁止 listen `0.0.0.0`。
- 禁止測試載入真 Laya、打真網路、讀 `~/.creds/**`；禁止 `npm install`、`set -x`。
- 禁止 `launchctl` 任何子指令（plist 只寫檔，由主 session 載入）。
- 無頭機：禁止回報「請使用者手動執行」。
- 完成後 `git add` 三個新檔並 `git commit -m "feat(cascade): 本機 /v1/systemone daemon，Laya→Zen→OR 分層"`，不 push。
