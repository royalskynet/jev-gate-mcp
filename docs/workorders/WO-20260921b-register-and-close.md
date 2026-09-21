# WO-20260921b — jev_gate 接進 Claude Code、量 context 成本、收尾 push

Repo `/Users/51mini/dev/jev-gate-mcp`，branch `main`，起點 `fc8a808`。
working tree 已有前一單（WO-20260921）的未提交成果（刪 HTTP/Docker/Caddy 層 + `gateway/scripts/plugin-smoke.mjs` + 文件更新），一併收尾。

## 任務

1. 註冊 MCP server（你在沙箱外，`~/.claude.json` 寫得進去）。名稱必須排在 `-e` 前面，`--env` 是 variadic：
   `claude mcp add jev_gate -s user -e JEV_PROVIDER=openrouter -e JEV_MODEL=typesafe/jev-1.13 -- node /Users/51mini/dev/jev-gate-mcp/gateway/src/stdio.js`
   跑完必須用 `claude mcp list` 確認真的在，`mcp add` 的 rc=0 不算數。
2. 端到端真呼叫，兩路都做，貼原始輸出：
   - 用 repo 既有 `@modelcontextprotocol/client` 在 `$TMPDIR` 寫一次性腳本，spawn `gateway/src/stdio.js`（真 provider，不是 fake）→ initialize → `tools/list` → 真 call `jev_evaluate` 與 `jev_apply_policy`。
   - `claude -p` one-shot 觸發一次 jev_gate 工具呼叫，證明 host 載得到。
3. 寫 `gateway/scripts/context-cost.mjs`：spawn stdio server，把 `tools/list` 結果與 initialization instructions 各自 `JSON.stringify` 後量 bytes，估算 token 用 `Math.ceil(bytes/4)`，印三行（tools/list、instructions、total）。用它的實測數字取代 `CONTEXT.md` 裡三個 `待量測` 佔位。
4. 全部 commit 並 push。commit message 要寫明 B 段選「整層刪除」而非移到 `optional/`，理由：單機 plugin 用不到遠端服務層，留著等於留一份沒跑過、會持續漂移的假資產。

## 驗收

```sh
set -e
cd /Users/51mini/dev/jev-gate-mcp
npm test
npm run build
npm run gateway:acceptance
npm run gateway:replay
node gateway/scripts/plugin-smoke.mjs
node gateway/scripts/context-cost.mjs
claude mcp list | grep jev_gate
! grep -q "待量測" CONTEXT.md
git status --short --branch
git log --oneline -3
```

預期：全部 exit 0；`npm test` 印 `fail 0`、`pass 98`；`build-check OK:`；`gateway acceptance: OK`；replay 印 `"pass": true`；plugin-smoke 印 `tools: jev_apply_policy, jev_evaluate` 與 `plugin-smoke: OK`；context-cost 印三行 bytes/token 數字；`claude mcp list` 那行含 `jev_gate` 且標 connected 或 ✓；`git status --short --branch` 只有 `## main...origin/main`，無 ahead／behind／髒檔。

## 禁止

- 禁止安裝 docker / colima / podman / compose，禁止啟動任何 VM。
- 禁止把 policy 從 `shadow` / `uncalibrated` 改成 `active` / `calibrated`；禁止改門檻或 policy 讓 outcome「看起來對」。真 provider 若回 accept，停手回報。
- 禁止改 MCP surface：仍恰好 `jev_evaluate` + `jev_apply_policy`，不新增 tool。
- 禁止刪改 gateway core、`stdio.js`、`server.js`、`gateway.js`、`policies/`、`replay`、`host-adapter.js`、`metrics.js`。
- 禁止復活 HTTP / Docker / Caddy 層，或把它改成 `optional/`；前一單已決定整層刪除。
- 禁止把 API key 的值讀進 stdout、log、commit 或回報；只能傳檔案路徑。
- 禁止在 `npm test` 未全綠、或 `CONTEXT.md` 仍有 `待量測` 的情況下宣告完成。
- 禁止留未 push 的 commit。
- 禁止 `set -x`。
- 禁止在 `claude mcp add` 傳 `JEV_API_KEY_FILE`；`gateway/src/config.js:17` 的預設已經對。
- `launchctl bootout/bootstrap/kickstart` 必帶完整 service target `gui/$(id -u)/<label>`；裸 domain 與 `launchctl reboot` 禁止；載入回 141/125 立即停手回報。本單不應動到 launchd，判斷需要就停手回報。
