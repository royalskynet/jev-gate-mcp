# jev-gate 啟用驗證報告

日期：2026-09-29。repo `main`（base `4f5ef98`，加上測試修復 commit `8a10d31`）。

## 1. 離線測試

照 `work/handoff.md`「工作區與驗證」段與 `docs/DEVLOG.md` §25 的離線配方執行（假 key 路徑 `/tmp/jev-no-live-key`、`JEV_PROVIDER=typesafe`、停用資料紀錄 `JEV_ROUTING_LOG=off JEV_CALIBRATION_LOG=off`、停用遙測 `JEV_TELEMETRY=off`、排除 live 測試 `--test-skip-pattern='^live:|^codex adapters: the advisory actually carries a Jev answer'`）。

```
JEV_PROVIDER=typesafe JEV_API_KEY_FILE=/tmp/jev-no-live-key \
  JEV_ROUTING_LOG=off JEV_CALIBRATION_LOG=off JEV_TELEMETRY=off \
  node --test --test-skip-pattern='^live:|^codex adapters: the advisory actually carries a Jev answer'
```

原始 TAP 尾段（`/tmp/jev-offline-enable.tap`）：

```
✔ unified report keeps prune and routing savings separate (53.665542ms)
✔ a hung endpoint fails open and says so in the ledger (2.076791ms)
✔ a fetch that answers in time still judges (0.251167ms)
✔ the deadline is configured and each call leaves its latency behind (0.112708ms)
ℹ tests 275
ℹ suites 0
ℹ pass 273
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 2993.738208
```

TESTS: pass=273 fail=0 skip=2

## 2. hooks 載入驗證

唯一儀器（README / docs/REFERENCE.en.md §3「module 無 Node，`process` 是 ReferenceError」）：

```
env -u CLAUDE_CONFIG_DIR claude --debug -p "say hi"
```

DEBUGFILE: /Users/51mini/.claude/debug/8382dd33-b10e-4393-9927-c825445d81d5.txt

該檔第 178 行確認模組已載入，無 `failed to load`：

```
[DEBUG] hooks module jev-gate@jev-gate loaded (worker, environment 1, tier user); events: tool.call,agent.spawn,session.start,session.compact,turn.complete
```

（`grep -c "jev-gate.*failed to load"` = 0，`process.env` 全數經 `agent-glue/claude/env.mjs` 的 `typeof process === 'undefined'` 分支，參考 `tests/no-node-globals.test.mjs`。）

LOADFAIL: 0

## 3. 有錯就修

離線組測到一項失敗，已修：

- 失敗：`tests/agent-glue/compact-hook.test.mjs:63` 斷言 `lastBody.model === CONFIG.model`。commit `de1d0f4`（fix(compact): honour JEV_ENDPOINT/JEV_MODEL）把請求 body 從 `model: CONFIG.model` 改成 `model: CONFIG.model || 'typesafe/jev-1.13'`，但沒同步這條測試：`JEV_MODEL` 未設時 `CONFIG.model=''`，body 落到 fallback `'typesafe/jev-1.13'`，斷言對空字串失敗。
- 修法（外科手術）：把斷言改成 `lastBody.model === (CONFIG.model || 'typesafe/jev-1.13')`，把 de1d0f4 的 fallback intent（wire 上永遠送出 concrete model：優先 override、否則 typesafe 預設）編進測試，沒動既有 env 覆寫預設值、沒重構。commit `8a10d31`。
- 重跑離線組測：`tests 275 / pass 273 / fail 0 / skipped 2`；hooks 載入驗證同上 `LOADFAIL: 0`。

最終數字：TESTS pass=273 fail=0 skip=2；LOADFAIL 0。

## 4. 衝突檢查

`~/.claude/settings.json` 的 `Stop` 事件陣列（約 231–291 行）裡有一項 `node /Users/51mini/dev/jev-gate-mcp/plugin/hooks/gate.js`（timeout 10）。plugin `hooks/index.js` 聚合的三個 function hook 註冊的事件（debug log 178 行為準）：`tool.call`（jev.js，Bash/Grep/Read）、`agent.spawn`（spawn-hook.mjs）、`session.compact`＋`turn.complete`（compact-hook.mjs）、`session.start`。`hooks/index.js` 只 import `./jev.js`、`../agent-glue/claude/spawn-hook.mjs`、`../agent-glue/claude/compact-hook.mjs`，不 import `plugin/hooks/gate.js`。

GATEJS: 無衝突 — plugin 只註冊 tool.call/agent.spawn/session.start/session.compact/turn.complete，settings.json 的 gate.js 只掛在 Stop；事件空間完全不重疊，plugin index 未引入 plugin/hooks/gate.js，無重複註冊也無互踩。

## 驗收對照

- `DEFAULT_TIER_MODELS` 仍在 `agent-glue/claude/spawn-hook.mjs`（grep 命中）。
- `process.env` 仍在 `agent-glue/claude/env.mjs`（Node 分支保留，grep 命中）。

## 未動

- `~/.claude/settings.json` 未改。
- 未 push origin；修 bug 的 commit `8a10d31` 留在 local。