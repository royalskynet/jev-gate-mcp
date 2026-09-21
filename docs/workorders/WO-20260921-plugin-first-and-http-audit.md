# WO-20260921 — jev-gate 轉 plugin-first + HTTP/Docker 層瘦身

Repo: `/Users/51mini/dev/jev-gate-mcp`　Branch: `main`（起點 fc8a808，worktree clean，與 origin 同步）
前置閱讀：`docs/DEVLOG-HANDOFF.md`、`AGENTS.md`、`CONTEXT.md`、`docs/adr/0001-governed-two-tool-mcp-boundary.md`

## 判斷前提（推翻 handoff 第 6 節）

handoff 說「唯一驗收缺口 = Docker runtime smoke」。該缺口只在「部署成公開 HTTP 服務」這個
沒人提出的前提下成立。實際用途是**本機 MCP plugin**：`gateway/src/stdio.js`，兩個 tool。
本機無 docker daemon、無 compose plugin、無公開 DNS，Caddy 的 ACME 路徑不可能在此驗證。
→ Docker 缺口不補，改補真缺口。

真缺口：`claude mcp list` 沒有 jev。寫完只有 Codex 接得到，主力 session 用不到。

## 根治

### A. 接進 Claude Code 並端到端實測

1. 註冊 user scope。三個 env：`JEV_PROVIDER=openrouter`、`JEV_MODEL=typesafe/jev-1.13`、
   `JEV_API_KEY_FILE` 指向 `~/.creds/kv` 裡的 OpenRouter key **檔案路徑**（傳路徑，不傳值）。
   command 是 `node /Users/51mini/dev/jev-gate-mcp/gateway/src/stdio.js`。
   旗標名以 `claude mcp add --help` 實際輸出為準，不要硬套記憶中的寫法。
2. `claude mcp list` 必須出現 jev_gate 且狀態 connected；貼原始輸出。
3. 端到端真呼叫（兩路都要，二擇一不算完成）：
   - MCP client 直呼：用 repo 既有 `@modelcontextprotocol/client` 寫一次性腳本（放 `$TMPDIR`），
     spawn stdio server → initialize → `tools/list` → 真的 call `jev_evaluate` 與 `jev_apply_policy`。
   - Claude Code 端：`claude -p` one-shot 觸發一次工具呼叫，證明 host 真的載得到。
4. 量 context 成本：把 `tools/list` 結果連同 initialization instructions 序列化，記 bytes 與估算 token，
   寫進 `CONTEXT.md`。這是 handoff「減少 tool/context token」目標的唯一可量化證據。
5. 行為斷言：policy 仍 `shadow + uncalibrated`，實際 outcome 必須是 review 或 deny，**不得**出現 accept。
   若出現 accept 視為 bug，停下來報告，不要改 policy 讓它「看起來對」。

### B. ponytail-audit：HTTP / Docker / Caddy 層

已測繪的 import graph（以此為準，不要重掃）：

| 資產 | 被誰用 | 判定 |
|---|---|---|
| `gateway/src/http.js` (229 行) | `test/conformance.test.mjs`、`lib/bench.mjs`、`Dockerfile`、npm `gateway:http` | 僅 HTTP 路徑 |
| `rate-limiter-flexible` | 只有 `http.js` | 隨 http.js 去留 |
| `gateway/src/metrics.js` | `src/config.js` → core | **留著**，非 HTTP 專屬 |
| `Dockerfile` / `compose.yaml` / `deploy/Caddyfile` / `deploy/.env.example` | 無程式碼引用 | 純部署資產 |

決策規則（照 ladder，停在第一個站得住的階）：
- 先問「這需要存在嗎」。單機 plugin 用不到遠端服務層。
- 若刪：`http.js`、`rate-limiter-flexible`、`Dockerfile`、`compose.yaml`、`deploy/`、npm `gateway:http`
  一起走；`conformance.test.mjs` 與 `lib/bench.mjs` 的 HTTP 專屬部分同步處理
  （bench 的 stdio / in-process 量測若有價值就保留該分支，不要整檔砍）。
- 若保留：全部移到 `optional/remote-deploy/`，並在 `CONTEXT.md` 與 `gateway/README.md`
  明寫「optional remote deployment，不是主路徑，未做過 runtime smoke」。
- 兩者擇一，在 commit message 與最終回報寫明選了哪個、為什麼。不得兩邊都做一半。

判準：動刀後 `npm test` 必須全綠（原本 107 tests / 105 pass / 2 live skip；HTTP 測試若隨檔移除，
pass 數下降要在回報中逐項對帳，不能只說「還是全綠」）。

## 預防加固（缺這段不算完成）

新增 `gateway/scripts/plugin-smoke.mjs`：離線（`JEV_PROVIDER=fake`）spawn stdio server，
斷言 `tools/list` 恰好兩個 tool、名稱正確、`jev_evaluate` 可呼叫且回 shadow outcome。
掛進 `npm run gateway:acceptance` 流程（或放進 `gateway/test/` 讓 `node --test` 撿到）。
理由：plugin 路徑目前零回歸保護，HTTP 層一旦動刀，沒有測試會發現 stdio 也被牽連。

## 驗收（全部貼原始輸出，不得轉述）

```sh
cd /Users/51mini/dev/jev-gate-mcp
npm test
npm run build
npm run gateway:acceptance
npm run gateway:replay
node gateway/scripts/plugin-smoke.mjs
claude mcp list
git status --short --branch && git log --oneline -5
```

預期：七條指令全部 exit 0，`npm test` 0 fail，`claude mcp list` 有 connected 的 jev_gate，worktree clean 且與 origin/main 同步。

每步預期輸出：

- `npm test` → `0 fail`；pass 數若低於原本 105，逐項列出哪些測試隨 HTTP 層移除。
- `npm run build` → `build-check OK: intent-routing,context-screening,proposed-action-risk,completion-claims`
- `npm run gateway:acceptance` → `gateway acceptance: OK`（若 bench 分支隨 HTTP 移除，字樣可少 `bench offline`，需說明）
- `npm run gateway:replay` → `status: pass`、`2/2`、含 `completion-unsupported-red-line => deny`
- `node gateway/scripts/plugin-smoke.mjs` → 明確印出兩個 tool 名 `jev_evaluate`、`jev_apply_policy`，
  且 outcome 非 accept；exit 0。
- `claude mcp list` → 出現 `jev_gate` 且標示 connected／✓。
- `git status --short --branch` → `## main...origin/main` 且無 ahead／behind／髒檔。

加上 A-3 的真實 tool call 原始輸出、A-4 的 token 數字。
小步 commit，做完 push，不留未推 commit。

## 禁止

- 禁止安裝 docker / colima / podman / compose，禁止啟動任何 VM。
- 禁止硬套記憶中的 `claude mcp add` 旗標名；一律先讀 `claude mcp add --help` 實際輸出。
- 禁止在出現 accept outcome 時自行改 policy 或門檻讓它「看起來對」；停手回報。
- 禁止重掃 import graph；以工單表格為準。
- 禁止整檔砍 `gateway/lib/bench.mjs`；只動其中 HTTP 專屬分支。
- 禁止 B 段兩條路線（刪／移 optional）各做一半；擇一做完，並在 commit message 寫明選哪條、為什麼。
- 禁止把 policy 從 `shadow` / `uncalibrated` 改成 `active` / `calibrated`；禁止用 synthetic fixture 宣稱已校準。
- 禁止把 API key 的**值**讀進 stdout、log、commit 或回報；只能傳檔案路徑。
- 禁止刪改 gateway core、`stdio.js`、`server.js`、`gateway.js`、`policies/`、`replay`、`host-adapter`、
  `metrics.js`，以及任何非 HTTP 專屬的測試。
- 禁止擴功能：不新增 tool、不改 MCP surface（仍恰好 `jev_evaluate` + `jev_apply_policy`）。
- 禁止在 `npm test` 未全綠的情況下宣告完成。
- 禁止留未 push 的 commit。
- `launchctl bootout/bootstrap/kickstart` 必帶完整 service target `gui/$(id -u)/<label>`；
  裸 domain 與 `launchctl reboot` 禁止；載入回 141/125 立即停手回報。（本工單不應動到 launchd；
  若判斷需要，停下來回報，不要自行執行。）
