# 工單：cascade 雲端備援改 beam-free CLI＋opencode 壓縮走 cascade（2026-11-06）

工作目錄：/Users/you/dev/jev-gate-mcp

repo：`/Users/you/dev/jev-gate-mcp`（git，直接在 main 上改，做完 commit，commit 訊息含 `beam`，不 push）。

## 目標順序（使用者定）

Laya（本機）→ `jev-1.13-free`（Zen，保留現狀）→ `opencode-go/beam-free`（**只准經 opencode CLI**）。OpenRouter 從 cascade 拿掉，整條鏈零費用。

## 改動 1：cascade 備援換成 beam-free CLI

檔案 `gateway/src/cascade-server.js` 第 184–187 行附近（main 區塊）目前是：

```js
const orKey = readKey(DEFAULTS.zenBackupKeyFile);
const or = orKey ? withPaymentStop(withDailyBudget(makeOpenrouterAdapter({ apiKey: orKey }))) : null;
const zen = zenKey ? makeZenAdapter({ apiKey: zenKey, model: 'jev-1.13-free', backup: or }) : or;
```

改成：

- 在 `gateway/src/adapters.js` 新增 `makeOpencodeCliAdapter({ model = 'opencode-go/beam-free', bin = 'opencode', timeoutMs = 60000, spawn })`，回傳 `async (state, questions, opts) => ({ model, answers, usage })`，shape 與 `makeOpenrouterAdapter` 的結果相同（看同檔 `validateAnswer`／`validateDistribution`、`laya-adapter.js:40` 的回傳）。
  - 用 `child_process.spawn(bin, ['run', '--pure', '-m', model, prompt])`（`--pure` 不載 plugin，避免遞迴）。`spawn` 可注入，測試不准真的跑 opencode、不准連網（`npm test` 已載 `tests/_no-network.mjs`）。
  - prompt 內含 state 與 questions（JSON），要求模型只輸出一個 JSON：`{"answers":[...]}`，每題格式照該題 type（choice／score／noul）的現有 schema。從 stdout 抓最後一個 JSON 物件解析。
  - 每題答案過現有驗證函式；任一題不合格或逾時／非 0 退出 → `throw`（code `'upstream'`），不得回傳猜測值。
  - **嚴禁**對 `opencode.ai/zen` 或任何 opencode HTTP 推論端點直接 fetch（使用者規則：opencode 免費層只准 CLI）。
- main 區塊：`const beam = makeOpencodeCliAdapter({})`；`zen = zenKey ? makeZenAdapter({ apiKey: zenKey, model: 'jev-1.13-free', backup: beam }) : beam`。移除 main 裡 OpenRouter 的建構與 `orKey` 讀取（`makeOpenrouterAdapter` 本身保留，`config.js` 還在用）。若 `withPaymentStop`／`withDailyBudget` 因此在此檔變成未使用 import，一併移除 import。
- Zen adapter 內 remediation 文字「期間 Jev 走付費 OpenRouter」改成「期間走 beam-free（opencode CLI）」。

## 改動 2：opencode 外掛的壓縮判斷走 cascade

- `integrations/opencode/jev-laya.js` 第 84 行附近 compaction 用 `agent-glue/src/prune.js` 的 `judgeSegments`，它目前經 `fetchHost` 直打 Jev 端點。
- 讓它在 `~/.jevgate/cascade-callers.json` 有 `compact` 鍵（現值 `http://127.0.0.1:8793`）時，改用 `agent-glue/src/live.js` 的 `cascadeUrlFor('compact', …)`＋`cascadeTransport(url, { caller: 'compact:opencode', laneQtypes: null, timeoutMs: 90000 })` 當判斷傳輸；照 `jev-laya.js` 第 21–48 行 effort 段的寫法（每輪重讀 callers 檔）。cascade 打不通 → fail-open（保留原歷史，不退回直打付費端點），寫一行到 `~/.jevgate/opencode-compact.log`。
- 第 2 節的 `tool.execute.after` 單筆 prune 也同樣處理（caller `prune:opencode`）。
- `integrations/opencode/README.md` 的「Jev 端點」段補一句：有 `compact` cascade 時壓縮走 `:8793`（Laya→jev-1.13-free→beam-free CLI）。

## 測試（要會失敗）

- `gateway/test/` 新增 `opencode-cli-adapter.test.mjs`：注入假 spawn，覆蓋 (a) 合法 JSON → 回傳答案；(b) 機率和≠1 → throw；(c) 非 0 退出 → throw；(d) 斷言 argv 含 `run`、`--pure`、`-m`、`opencode-go/beam-free`。
- 新增一個靜態測試：讀 `gateway/src/cascade-server.js`，斷言不含 `makeOpenrouterAdapter(`；讀 `gateway/src/adapters.js` 的 `makeOpencodeCliAdapter` 函式本體，斷言不含 `fetch`。
- `integrations/opencode/jev-laya.test.mjs` 補一例：callers 檔有 `compact` 時，判斷走注入的 cascade transport 且 caller＝`compact:opencode`。

## 驗收（全部 exit 0）

```bash
cd /Users/you/dev/jev-gate-mcp && npm test \
 && ! grep -n "makeOpenrouterAdapter(" gateway/src/cascade-server.js \
 && grep -q "makeOpencodeCliAdapter" gateway/src/cascade-server.js \
 && grep -q "compact:opencode" integrations/opencode/jev-laya.js \
 && test -f gateway/test/opencode-cli-adapter.test.mjs \
 && git log --format=%s -20 | grep -qi beam
```

不要做：重啟任何服務、改 `~/.jevgate/*`、改 `~/.config/opencode/*`、push。
