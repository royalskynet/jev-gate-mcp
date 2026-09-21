# Dev Log Handoff — Jev Decision Gateway production hardening

> **部分作廢（2026-09-21）**：第 6 節說「唯一驗收缺口 = Docker runtime smoke」。
> 該缺口只在「部署成公開 HTTP 服務」這個沒人提出的前提下成立；實際用途是本機 MCP plugin。
> HTTP / Docker / Caddy 層已於 2026-09-21 整層刪除，本文件所有相關段落（§2 的 `http.js`、
> `Dockerfile`、`compose.yaml`、`deploy/`、§6 的 Docker 缺口）只當歷史紀錄讀，不要照做。
> 現況看 [`DEVLOG.md` §10](DEVLOG.md)。

這份文件提供給「沒有前文、沒有 session memory」的下一個模型。先不要擴功能；先依下列順序重建現況。

## 1. Repo 與任務

- Repo：`/Users/51mini/dev/jev-gate-mcp`
- Branch：`main`
- Remote：`origin/main`
- 原始目標：把 Jev Decision Gateway 做到可實裝上線；OpenRouter 是唯一 live Jev provider；優先膠合高星成熟輪子；支援 Codex；減少 tool/context token；完成後 push。
- 使用者最後指示：先收工，留下空白模型可自足的 handoff，不再擴功能。

接手先讀：

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/adr/0001-governed-two-tool-mcp-boundary.md`
4. `docs/zh-TW/README.md`
5. `gateway/operations/runbook.md`

## 2. 目前可宣稱的狀態

### 可宣稱

- Gateway service 層已具 production controls，可部署成 **shadow/review service**。
- stdio 與 Streamable HTTP 共用同一 `JevGateway` core，MCP surface 仍 exactly two tools：
  `jev_evaluate`、`jev_apply_policy`。
- OpenRouter live System One 路徑已驗證，resolved model：`typesafe/jev-1.13-20260917`。
- Codex project MCP config 已加入並由 Codex CLI 成功解析。
- HTTP auth/rate/concurrency/readiness/metrics、state projection、quality signals、digest/replay、canary、Host Adapter 均有 tests。

### 不可宣稱

- **不能說 starter policies 已可自動 accept。** 四個 policy 都是 `shadow + uncalibrated`，公開 accept 會被壓成 review。
- **不能說 Docker image 已在本機跑過。** 目前機器有 Docker CLI，但 daemon 未啟動，且沒有 Compose plugin；只完成 Compose YAML 靜態解析。
- **不能說已部署到公開 DNS/production host。** Repo 只有 reference assets，沒有取得目標 host、DNS、TLS 環境或 deployment authority。

## 3. 本批完成內容

### HTTP / deployment

- `gateway/src/http.js`
  - loopback safe default。
  - non-loopback 缺 token/allowed hosts 直接拒絕啟動。
  - Bearer token 從 file 讀取；公開 bind 最少 32 chars。
  - 官方 MCP Host/Origin guards。
  - body limit、`rate-limiter-flexible` rate limit、in-flight reject（503，不排隊）。
  - `/health`、`/ready`、`/metrics`。
  - SIGTERM/SIGINT graceful drain。
- `Dockerfile`：Node 22 Alpine、non-root、read-only-compatible、healthcheck。
- `compose.yaml`：gateway 不 publish port；Caddy 對外；Docker secrets；internal network；`no-new-privileges`。
- `deploy/Caddyfile`：automatic HTTPS、upstream health、compression、security headers。
- `deploy/.env.example`：公開 host 與兩個 secret-file 路徑。

### Policy / decision safety

- `gateway/src/policy-controls.js`
  - server-owned top-level `state_projection`。
  - Ajv `state_schema` validation；legacy string state 上限 2,048 chars。
  - SHA-256 `policy_digest` / `question_digest`。
  - Choice top1-top2 margin、normalized entropy；Score variance。
  - optional `quality_thresholds`：breach 只能把 accept 降成 review。
  - deterministic canary cohort；缺 stable `correlation.request_id` 不 accept。
- 四個 `gateway/policies/*.json`
  - 仍 `shadow + uncalibrated`。
  - 已加入 projection/schema/activation。
  - `activation.allow_outcomes` 不含 accept，`rollout_percent: 0`。
- `gateway/src/adapters.js`
  - Choice/Score probability distribution 必須 keys 完整、值在 0..1、總和接近 1。
  - confidence 若存在也必須在 0..1。
- `gateway/src/gateway.js`
  - provider 只收到 projected state。
  - 結果含 quality、digest、activation metadata。
  - Prometheus decision metrics。

### Host enforcement / observability / replay

- `gateway/src/host-adapter.js`
  - lifecycle：`before_action`、`after_external_result`、`before_finish`。
  - 只有 literal `accept` 才呼叫 `execute()`。
  - 支援 in-process `applyPolicy` 與 initialized MCP Client。
  - 支援 resolution/retry cost/false-accept feedback metrics。
- `gateway/src/metrics.js`
  - 官方 `@prometheus-io/client`，private registry，bounded labels。
  - decisions、latency、HTTP、in-flight、workflow resolution、retry cost、false-accept severity。
- `gateway/lib/replay.mjs`、`gateway/scripts/replay.mjs`
  - 不保存 raw state/question text；用 recorded typed answers 重組 deterministic Gate。
  - digest mismatch 或 outcome drift 都 non-pass。
  - fixture 含明確 denial red line。

### Codex / token control

- `.codex/config.toml`
  - project-scoped stdio MCP。
  - only two tools。
  - read-only approval、tool timeout、每工具 output token limit。
- `gateway/src/server.js`
  - MCP initialization instructions，重要規則在前 512 chars。
  - tools 標示 read-only/destructive=false/idempotent。
- `docs/zh-TW/README.md`
  - 完整繁中 quickstart、Codex、deployment、calibration/canary、文章設計落地、上線 checklist。

## 4. 採用輪子與理由

- Ajv（GitHub 約 14.8k★）：JSON Schema。
- `rate-limiter-flexible`（約 3.6k★）：request rate limit。
- Prometheus `client_js` / `@prometheus-io/client`（約 3.5k★）：metrics。
- Caddy（約 75.9k★）：TLS/reverse proxy。
- 既有 Opossum、Pino、tinybench、simple-statistics、jevwire 保留。
- 舊 `prom-client` npm name 已 deprecated，已移除；因此 production runtime 收斂到 Node 22/24，reference image pins Node 22。
- policy digest/canary/in-flight reject 使用 Node stdlib 小型 deterministic code；沒有為十幾行安全不變量增加供應鏈。

研究記錄：`docs/research/issue-1-prior-art.md`。

## 5. 最終驗收證據（2026-09-21 Asia/Taipei）

全部在 repo root 執行：

```sh
npm test
# 107 tests；105 pass；0 fail；2 opt-in live skip

npm run build
# build-check OK: intent-routing,context-screening,proposed-action-risk,completion-claims

npm run gateway:acceptance
# gateway acceptance: OK (eval, drift, replay, tool-eval config, bench offline)

npm run gateway:replay
# status: pass；2/2；含 completion-unsupported-red-line => deny

JEV_RUN_SMOKE=1 node --test gateway/test/smoke-matrix.test.mjs
# 1 pass；resolved_model=typesafe/jev-1.13-20260917；latency_ms=361

npm audit --omit=dev
# found 0 vulnerabilities

ruby -e "require 'yaml'; YAML.load_file('compose.yaml'); puts 'compose YAML parse OK'"
# compose YAML parse OK

git diff --check
# no output / pass
```

Codex config 另以臨時 `CODEX_HOME` 驗證：

```text
jev_gate enabled=true
transport=stdio
command=node
args=gateway/src/stdio.js
enabled_tools=jev_evaluate,jev_apply_policy
```

注意：本機 Node 是 v26.8.1，因此 npm 會對 project engine `^22 || ^24` 與 Opossum v9 顯示 EBADENGINE warning；測試仍過。正式 runtime 請用 Dockerfile 的 Node 22，不要把 Node 26 warning 當 production compatibility 證據。

## 6. 唯一已知驗收缺口

Docker runtime smoke 未執行：

```text
docker daemon unavailable: /var/run/docker.sock missing
docker compose command/plugin unavailable
```

下一個有 Docker 的環境先跑：

```sh
cp deploy/.env.example deploy/.env
# 填 JEV_PUBLIC_HOST、OPENROUTER_API_KEY_FILE、JEV_HTTP_AUTH_TOKEN_FILE
docker compose --env-file deploy/.env config
docker compose --env-file deploy/.env build
docker compose --env-file deploy/.env up -d
docker compose --env-file deploy/.env ps
curl -fsS https://$JEV_PUBLIC_HOST/health
curl -fsS -H "Authorization: Bearer $JEV_GATE_TOKEN" https://$JEV_PUBLIC_HOST/ready
```

不要把真 token 寫進 `deploy/.env`；該檔應只放 secret **file path**。Bearer token 本身至少 32 chars。

## 7. 下一步（只有使用者重新開工才做）

1. 在 Node 22 + Docker Compose 環境完成 image/runtime smoke。
2. 把 Prometheus scrape/alerts 接到實際監控後端。
3. 收集真實 target-domain labels；跑 calibration；人工 review。
4. 僅對低風險 branch 將 policy 改成 `active + calibrated`，先小比例 canary。
5. 接實際 host workflow，確保 Host Adapter 包住真正的 execution callback。
6. 觀察 review resolution、retry cost、false-accept severity，再決定是否擴 rollout。

禁止用 synthetic fixture 把 policy 標成 calibrated；禁止只因 MCP tool 可見就宣稱 mandatory gating。

## 8. FixIndex

本批唯一可重用 defect 已記錄並由 FixIndex 自行 commit/push：

- `0729-gateway-boot-guard-gateway-boot-3.md#S5`
- commit `3350ed8`
- `pushed: true`
- 主題：transport benchmark 被 production rate limit 的第 61 request 打成 429；修法是 benchmark-local quota，production default 不變。

## 9. 接手第一條命令

```sh
cd /Users/51mini/dev/jev-gate-mcp
git status --short --branch
git log -3 --oneline
npm test && npm run build && npm run gateway:acceptance
```

預期交付完成後：`main` 與 `origin/main` 同步、worktree clean。若不是，先確認 push/working tree，不要重做已完成設計。
