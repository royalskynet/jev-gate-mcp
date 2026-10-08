## 任務

在目前目錄（jev-gate-mcp 的 git worktree）新增 `gateway/src/budget.js` 與 `tests/budget.test.mjs`。背景：OpenRouter Jev 是付費的，要有日上限，且 402（沒錢）時停止呼叫。設計全文 `/Users/51mini/dev/jev-gate-mcp/docs/prd/PLAN-20261008-laya-first-cascade.md`。

`gateway/src/budget.js` 只匯出兩個函式，只用 node 內建模組：

1. `withDailyBudget(adapter, { max = Number(process.env.JEV_OR_DAILY_MAX ?? 200), file = <homedir>/.jevgate/or-budget.json, notify = defaultNotify, now = Date.now } = {})` 回傳 `async (state, questions, opts) => …`：
   - 檔案格式 `{"day":"YYYY-MM-DD","calls":n,"notified":bool}`，day 用本機時區由 `now()` 算；day 不同就歸零。檔案不存在或壞掉當成 calls=0。
   - `calls >= max`：若 `notified` 為 false 就呼叫 `notify("Jev OpenRouter 日上限 <max> 次已到，今日其餘呼叫 fail-open")` 並寫回 `notified:true`；然後 throw 一個 Error，`err.code = 'JEV_BUDGET_EXCEEDED'`。不呼叫 adapter。
   - 否則先 `calls+1` 寫檔，再 `return adapter(state, questions, opts)`。
2. `withPaymentStop(adapter, { file = <homedir>/.jevgate/or-status.json, holdMs = 3600000, notify = defaultNotify, now = Date.now } = {})`：
   - 檔案 `blocked_until > now()` → throw Error，`err.code = 'JEV_PAYMENT_REQUIRED'`，不呼叫 adapter。
   - adapter throw 且 `e.status === 402 || e.cause?.status === 402` → 寫 `{"blocked_until": now()+holdMs}`，呼叫 `notify("Jev OpenRouter 回 402（額度不足），停用 1 小時")`，再原樣 rethrow。其他錯誤原樣 rethrow，不寫檔。
3. `defaultNotify(msg)`：`child_process.execFile('hpush', [msg], () => {})`，任何錯誤吞掉。
4. 寫檔用 `mkdirSync(dirname(file), {recursive:true})`＋`writeFileSync`，mode 0o600。

`tests/budget.test.mjs`（`node:test`＋`node:assert/strict`，檔案寫在 `os.tmpdir()` 下的 mkdtemp 目錄，notify 用陣列收集）至少測：max=2 時第 3 次 throw `JEV_BUDGET_EXCEEDED` 且 notify 只被叫 1 次（第 4 次不再叫）；換日歸零；402 後同一 adapter 第二次呼叫不碰 adapter 並 throw `JEV_PAYMENT_REQUIRED`；非 402 錯誤不寫 or-status 檔。

## 驗收

```sh
test -f gateway/src/budget.js
grep -q 'export function withDailyBudget' gateway/src/budget.js
grep -q 'export function withPaymentStop' gateway/src/budget.js
grep -q 'JEV_BUDGET_EXCEEDED' tests/budget.test.mjs
grep -q 'JEV_PAYMENT_REQUIRED' tests/budget.test.mjs
JEV_USAGE_LOG=off node --test tests/budget.test.mjs
JEV_ROUTING_LOG=/dev/null JEV_TEACHER_CORPUS=/dev/null JEV_USAGE_LOG=off node --test
git diff --quiet HEAD -- gateway/src/adapters.js gateway/src/config.js gateway/src/laya-routing.js
```

預期：全部 exit 0；budget 測試 `fail 0`；全套 `node --test` `fail 0`；adapters/config/laya-routing 無改動。

## 禁止

- 禁止改 `gateway/src/budget.js`、`tests/budget.test.mjs` 以外的檔案。
- 禁止測試讀寫真實 `~/.jevgate`；一律用 tmp 目錄。
- 禁止真的執行 hpush；測試一律注入 notify。
- 禁止新增 npm 依賴、禁止 `npm install`。
- 禁止 `set -x`、禁止讀 `~/.creds/**`。
- `launchctl bootout/bootstrap/kickstart` 必帶完整 service target `gui/$(id -u)/<label>`；裸 domain 與 `launchctl reboot` 禁止；本單不應動 launchd。
- 無頭機：禁止回報「請使用者手動執行」。卡住就停手回報阻斷點。
- 完成後 `git add` 兩個新檔並 `git commit -m "feat(budget): OpenRouter 日上限與 402 停用包裝"`，不 push。
