# Jev Decision Gateway：繁中上線與 Codex 快速指南

Jev Gate 把「生成」與「判斷」拆開：Codex/GPT/Claude 繼續規劃與寫程式；
Jev 只對 caller 提供的最小 state 做快速、typed 的 Choice／Score／Noul 判斷。
deterministic code 負責 schema、授權、門檻、組合、執行與 fail-closed。

## 現在能上線到哪裡

- **本機 MCP plugin（stdio）是唯一主路徑**：`gateway/src/stdio.js` 直接接 Codex/Claude。
  原 Streamable HTTP / Docker / Caddy 層（`src/http.js`、`Dockerfile`、`compose.yaml`、
  `deploy/`、`rate-limiter-flexible`）已移除，未做過 runtime smoke。
- **目前 policies 只能 shadow**：五個 starter policy 都是 `uncalibrated`，所以原始結果即使是
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

## Agent Glue：五項用法、兩端共用

`agent-glue/src/` 是 Claude Code 與 Codex **共用的純判斷核心**，兩端只留薄 adapter。
完整安裝／停用／觀測／成效指標見 [`docs/agent-glue.md`](../agent-glue.md)。

| 用法 | 判什麼 | 契約 |
|---|---|---|
| route | 這一輪交給哪個候選 | 只能從給定候選挑；無匹配回 `no_match`；失敗保留目前模型 |
| triage | 一次請求數問（`difficulty`/`kind`/`costly_mistake`，有 catalog 時加一支 advisory `skill` Choice）映射到 cheap→medium→hard tier | 一趟 Jev 全問完；skill 選擇搭同趟請求（**不另開一次**）；危險文本掃**整段原文**（非切片）；risky／低信心／大 context 一律不降級；transport 失敗保留現狀 |
| compact | 哪個 tool call/result 該刪或截斷 | user/assistant 文字**原樣**通過；call/result 成對；首筆與近期 pin |
| verify | 完成宣稱回 `pass｜fail｜unknown` | `pass` 必附可稽核 command/log evidence；沒有執行證據一律 `unknown` |
| review | 分階段 diff 審查 | risk filter → file profile → evidence → mechanism → severity → reviewer route |

兩條撐住整套的規則：

- **任一 judge throw 是整次 fail-open**，不是只保留丟出例外的那一對。壞掉的 judge 只能讓
  context 沒被壓縮，不能讓它被剝一半。`reducedBy` 低於最小門檻時同理——host 拿回**原本**的 messages。
- **Jev 永遠不改 deterministic 結果。** `deterministicSeverity()` 裡直接 `void jevOpinion`：
  意見掛在結果上進 ledger，severity 與 reviewer route 只由 diff profile 算出。
  五個 policy 還是 `shadow` + `uncalibrated` 的期間，未校準判斷不得授權也不得阻擋。
  `tests/agent-glue/policy-shadow.test.js` 是這條的防回歸守門。

兩端能力差異照實寫，不粉飾：

| | Claude Code | Codex |
|---|---|---|
| 改工具結果 | function hook `tool.call` 可在模型讀到前替換 | `PreToolUse` 才擋得住；`PostToolUse` 副作用已發生 |
| 壓縮 | 可替換內建 compaction | **不能**；只能 `PreCompact` snapshot ＋ `PostCompact` 追加 `additionalContext`（原文 **restoration layer**） |
| 續跑 | — | `Stop` 用 `decision:block`，必讀 `stop_hook_active`，最多一次 |

manifest 分檔互不覆寫：Claude 走 `hooks/hooks.json`，Codex 走 `.codex/hooks.json` 或
`.codex-plugin/hooks.json`。

### Triage（省錢判斷層）

`triage` 一趟 Jev 一次問數件事——`difficulty`（Score）、`kind`（Choice）、
`costly_mistake`（Noul），有 skill catalog 時再加一支 advisory `skill`（Choice，
criteria＝catalog＋`no_match`，**騎同一趟請求、不另開一次**）——再由
deterministic code 映射到 cheap→medium→hard tier。route 已接真線（`cli.mjs`/
`bridge.mjs` 不再回寫死 stub）：無 live model 時 `route` 自身 fail-open 到
`no_match`，candidates 缺漏則 catch 成有界 `no-candidates`（exit 0）。
route 也不再只拿到裸 id：`agent-glue/src/catalog.js` 會去
`./skills`、`~/.claude/skills`、`~/.claude/plugins/*/skills` 把每個 candidate 的
SKILL.md frontmatter `description:` 讀出來自動補成 `descriptions`（實測 2/4 → 4/4，
呼叫端零改動；`JEV_ROUTE_CATALOG_DIRS` 可覆寫路徑）。

兩端都接、都純 advisory，且**依情境自動啟用**：`triageEnabled()` 只要任一 tier
model 有設就是 true，而 `DEFAULT_TIER_MODELS`（`cheap: haiku`／`medium: sonnet`／
`hard: opus`）開箱就把三層設好，所以預設是**開**的。`JEV_TRIAGE_MODEL_*` 逐層
覆寫，字面值 `off` 退回父層模型，三層都 `off` 就把 hook 關掉；
`JEV_TRIAGE_ENABLED=1/0` 強制覆寫。

- **Claude**：`agent-glue/claude/spawn-hook.mjs` 註冊 `agent.spawn`，依 tier 設
  subagent 的 `model`。transport 由 hook 自己注入（`agent-glue/src/live.js`）：
  沒有 provider key 時 transport 是 `null`，triage fail-open 回原狀，什麼都不改。
- **Codex**：`UserPromptSubmit` 跑同一套 triage 但換不了模型，只吐一行 advisory
  `additionalContext` notice，並在 `codex-route.log` 寫一行 bounded 記錄。

所有省錢閘都發生在 Jev 呼叫之前：空 turn／pinned／沒設 tiers 直接保留現狀不打；
危險詞表掃**整段原文**（不是切片）；超長文本取開頭 1/4＋結尾 3/4（`ask_chars`）；
decision cache key 含 **context bucket**（小 context 的答案不會被大 context 命中）；
`features` 隱私模式（敏感 profile 自動開啟）只送統計特徵、原文不出機器。全程 fail-open：
transport 掛了就保留現狀，絕不往上或往下猜。每筆決策記一行 bounded ledger，不記原文不記 secret。

### 快速壓縮（已併入本 plugin）

`agent-glue/claude/compact-hook.mjs` 註冊 `session.compact` 與 `turn.complete`。
「快」是兩件事：壓縮在 **context 百分比**（`JEV_COMPACT_AT_PERCENT`，預設 60）就觸發，
不是撞牆才做；每個 tool call／result 對只問一次 System One（約 350 in／35 out token、
約 500 ms）決定去留，**沒有摘要 pass**，留下來的是逐字原文。

| 旋鈕 | env | 預設 |
|---|---|---|
| 觸發點 | `JEV_COMPACT_AT_PERCENT` | 60（% context） |
| 縮減門檻 | `JEV_COMPACT_MIN_REDUCTION` | 4000 字元 |
| 釘住最近 turn | `JEV_COMPACT_PIN_LAST` | 6 |
| 給 judge 看的 payload 開頭 | `JEV_COMPACT_ASK_CHARS` | 1200 |
| 關閉 | `JEV_COMPACT_ENABLED=0` | 開啟 |

契約在 `agent-glue/src/compact.js`，不是調參：user/assistant 文字逐字保留、
call 與其 result 成對刪、首尾 turn 釘住；judge 失敗或縮減未達門檻就把**原始** messages
還給 host 走內建壓縮。這裡的 fail-open 方向是「保留 context」。
觀測：`~/.openclaw/state/jev-compact.log`。

**壓縮互斥**：外部 fast-jev compaction plugin 也註冊 `session.compact`，**不要雙開**。
本 plugin 會讓路：`session.start` 讀 `~/.claude/settings.json`，發現
`fast-jev-compaction@…` 仍 enabled 就 stand down 並在 ledger 寫明。詳見
[`docs/agent-glue.md`](../agent-glue.md) §2。

```sh
npm run agents:acceptance
```

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

1. 保持 `shadow + uncalibrated + rollout_percent: 0` 收集真實 labels：**出貨即開**，
   gateway 會把每次 `apply_policy` 決策以 `calibrate.mjs` 的 JSONL 格式逐行寫到
   `~/.openclaw/state/jev-calibration.jsonl`（projection 後的 state、answers、
   raw `gate`、被蓋住的 `public_outcome`、`label: null`）。`JEV_CALIBRATION_LOG=<path>`
   改路徑，字面值 `off` 關掉。收完逐行把 `label` 填成「本來應該是什麼結果」。
   樣本的 `dataset_version` 已改為 `live-<policy>-v1`，不再繼承 spec 的
   `synthetic-harness-*`（那會讓 `harnessOnly()` 判成永不 eligible）。
2. 跑 `node gateway/scripts/calibrate.mjs <external.jsonl>`；只有 `eligible_for_review: true` 才進人工審核。
   未填 label 會被 validate 擋下，fake provider 的樣本會被 provenance 擋下（pinned model 不符）。
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
npm run agents:acceptance
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
npm run agents:acceptance
```

- 本機 plugin 以 stdio 啟動（`node gateway/src/stdio.js` 或 `npm run gateway:stdio`）。
- secrets 只用檔案路徑傳給 provider，權限最小化。
- `claude mcp list` 與 Codex `/mcp` 都看得到 exactly two tools；實際呼叫回 structuredContent。
- policy 先 shadow；未完成外部校準前，不宣稱「可自動放行」。
- Host Adapter 對 `review` 的紅線測試必須證明 `execute()` 沒被呼叫。

- Agent glue 的五項全是 advisory；policy 未校準前不宣稱「Jev 決定了什麼」。

更完整營運細節見 [`gateway/operations/runbook.md`](../../gateway/operations/runbook.md)、
[`docs/agent-glue.md`](../agent-glue.md)、[`skills/jev-agent/SKILL.md`](../../skills/jev-agent/SKILL.md)。
