# Jev Decision Gateway：繁中上線與 Codex 快速指南

Jev Gate 把「生成」與「判斷」拆開：Codex/GPT/Claude 繼續規劃與寫程式；
Jev 只對 caller 提供的最小 state 做快速、typed 的 Choice／Score／Noul 判斷。
deterministic code 負責 schema、授權、門檻、組合、執行與 fail-closed。

## 現在能上線到哪裡

- **本機 MCP plugin（stdio）是唯一主路徑**：`gateway/src/stdio.js` 直接接 Codex/Claude。
  原 Streamable HTTP / Docker / Caddy 層（`src/http.js`、`Dockerfile`、`compose.yaml`、
  `deploy/`、`rate-limiter-flexible`）已移除，未做過 runtime smoke。
- **目前 policies 只能 shadow**：四個 starter policy 都是 `uncalibrated`，所以原始結果即使是
  `accept`，公開 outcome 仍會被壓成 `review`。這是安全設計，不是故障。
- **要自動 accept**：必須收集真實 target-domain 標註、通過 calibration、人工審核 policy，
  再設定 `active + calibrated + activation.allow_outcomes + rollout_percent`。不可拿 synthetic fixture 當校準。

## 5 分鐘本機啟動

需求：Node 22/24；OpenRouter token 放在檔案，預設路徑：
`~/.creds/kv/OPENROUTER_API_KEY.txt`。

```sh
npm ci
npm test
npm run build
npm run gateway:acceptance
npm run gateway:stdio
```

`gateway:stdio` 是本機 plugin 的唯一 transport，直接由 Codex/Claude 以 stdio 啟動。

## Claude Code 接線

user scope 註冊一次即可：

```sh
claude mcp add jev_gate -s user \
  -e JEV_PROVIDER=openrouter -e JEV_MODEL=typesafe/jev-1.13 \
  -- node /absolute/path/to/jev-gate-mcp/gateway/src/stdio.js
```

server 名稱**必須排在 `-e` 之前**。`--env` 是 variadic，名稱放在後面會被當成又一個
`KEY=value` 吃掉，CLI 回 `Invalid environment variable format`。

不必傳 key 路徑：`src/config.js` 的 `apiKeyFile` 預設就是
`~/.creds/kv/OPENROUTER_API_KEY.txt`。policies 以 `import.meta.url` 解析而非
`process.cwd()`，所以 host 從任何目錄啟動都找得到。

驗證：`claude mcp list` 要看到 `jev_gate` ✓ connected；session 內 `/mcp` 看得到兩個工具。

## Codex 直接適配

Repo 內已有 [`.codex/config.toml`](../../.codex/config.toml)。把 repo 標記 trusted 後，
Codex CLI、IDE extension 與 desktop app 會共用這份 project MCP 設定；它會以 stdio 啟動 gateway。

驗證：

```sh
codex mcp list
```

進入 Codex 後用 `/mcp` 看 `jev_gate` 與兩個工具。設定刻意做到：

- 只 expose `jev_evaluate`、`jev_apply_policy`。
- 兩工具宣告 read-only/idempotent，省掉無意義的 write approval。
- 各工具設 `output_token_limit`，避免一次結果佔滿 context。
- server initialization 帶短版 instructions；重要規則在前 512 chars 內。

## 怎麼省 token 又不拖慢

1. 日常 coding、解釋、規劃、算術、schema validation 不呼叫 Jev。
2. 只在 routing、外部內容 screening、prepared action risk、completion claim 這四類窄判斷呼叫。
3. 多個相關問題一次 batch 到 `jev_evaluate`，不要多次 round-trip。
4. `jev_apply_policy` 只傳 policy schema 允許的欄位；gateway 會再次投影，額外欄位不會送到 OpenRouter。
5. 不傳整份檔案、聊天記錄、secret；先在 host 做 deterministic 摘要/欄位抽取。
6. consequential workflow 用 Host Adapter 強制執行；不要靠 agent「記得呼叫」MCP。

## Concrete Host Adapter

[`gateway/src/host-adapter.js`](../../gateway/src/host-adapter.js) 已可直接使用：

```js
import { createHostAdapter } from './gateway/src/host-adapter.js';

const guard = createHostAdapter({
  applyPolicy: (args) => gateway.applyPolicy(args),
  metrics,
});

const result = await guard.enforce({
  boundary: 'before_action',
  state: { action: 'publish', target: 'production' },
  correlation: { request_id: 'stable-workflow-id' },
  execute: () => publish(),
});
```

只有 literal `accept` 才會呼叫 `execute()`；`review`、`escalate`、`deny` 全部停止。
支援邊界：`before_action`、`after_external_result`、`before_finish`。

## Policy 安全啟用順序

1. 保持 `shadow + uncalibrated + rollout_percent: 0` 收集真實 labels。
2. 跑 `node gateway/scripts/calibrate.mjs <external.jsonl>`；只有 `eligible_for_review: true` 才進人工審核。
3. 跑 `npm run gateway:replay`，確認 policy digest 與既有 safe/red-line outcome。
4. 人工更新 dataset version、`calibrated`、`active`；先只 allow 最低風險 outcome。
5. `rollout_percent` 從小比例 canary 開始；必須傳穩定 `correlation.request_id`，否則 accept 會被壓成 review。
6. 觀察 review rate、resolution、retry cost、false-accept severity、breaker、latency，再擴大。
7. 異常時設 `JEV_KILL_SWITCH=1` 並重啟，立即 fail closed。

## 決策品質與 replay

每個 `gate_reason` 除 confidence 外還回：

- `margin`：top-1 與 top-2 機率差。
- `entropy`：正規化分布熵；越高代表越不確定。
- `variance`：Score 分布變異數。

Policy 可在真實資料校準後加入 `quality_thresholds`；margin 太低、entropy/variance
太高會把原本的 accept 降成 review。Starter policies 故意不猜門檻，只先觀測。

每次 policy result 另含 `policy_digest`、`question_digest`。Replay fixture 只保存 typed answers
與期望 outcome，不保存原始 state/question text：

```sh
npm run gateway:replay
```

policy digest 變更或 red-line outcome 漂移都會 non-pass，適合接 CI。

## 文章設計落地對照

參考：[Jev Clearly Explained（原 X 貼文）](https://x.com/akshay_pachaar/status/2101037514945597645)。

| 設計想法 | Repo 落地 |
|---|---|
| 只給判斷所需 state | policy `state_projection` + Ajv `state_schema`；object 額外欄位移除，legacy string 上限 2,048 chars |
| 不只看 confidence | Choice margin/entropy、Score variance；校準後可用 `quality_thresholds` 降級成 review |
| 最安全分支先上 | outcome allowlist + deterministic `rollout_percent` canary；缺穩定 request id 不 accept |
| 決策可重播 | `policy_digest`、`question_digest`、無 raw state 的 replay fixture/CLI |
| 衡量整條 workflow | decision/review resolution、retry cost、false-accept severity Prometheus metrics |
| 強制 lifecycle gate | concrete Host Adapter；non-accept 絕不呼叫 execution callback |

## 觀測與告警建議

Prometheus endpoint 提供：decision outcome/latency、Host Adapter resolution、
retry cost、false-accept severity。至少告警：

- breaker open。
- `deny`/`review` 比率突升。
- provider latency p95 超過 SLO。
- 任何 `false_accept_severity > 0`。

Pino JSONL 仍寫 stderr；allowlist 不記 state、questions、answers、keys。

## 上線前 checklist

```sh
npm ci
npm test
npm run build
npm run gateway:acceptance
npm run gateway:replay
```

- 本機 plugin 以 stdio 啟動（`node gateway/src/stdio.js` 或 `npm run gateway:stdio`）。
- secrets 只用檔案路徑傳給 provider，權限最小化。
- `claude mcp list` 與 Codex `/mcp` 都看得到 exactly two tools；實際呼叫回 structuredContent。
- policy 先 shadow；未完成外部校準前，不宣稱「可自動放行」。
- Host Adapter 對 `review` 的紅線測試必須證明 `execute()` 沒被呼叫。

更完整營運細節見 [`gateway/operations/runbook.md`](../../gateway/operations/runbook.md)。
