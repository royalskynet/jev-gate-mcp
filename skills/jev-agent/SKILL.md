# jev-agent — Jev 前四項雙 Agent 膠水操作規則

共用於 Claude Code 與 OpenAI Codex。核心在 `agent-glue/src/`，兩端只有薄 adapter。

## 四項能力（都 advisory，policy 未校準前永不硬阻擋）

| 能力 | 核心 | Claude | Codex | 契約 |
|---|---|---|---|---|
| 快速路由 | `route` | `bridge.mjs route` | `UserPromptSubmit` | 只選已提供候選；無匹配回 `no_match`；失敗 fail-open 保留現況 |
| 原樣壓縮 | `compactMessages` | `bridge.mjs compact` | `PreCompact`+`PostCompact` restoration | user/assistant 文字原樣；只動 tool call/result；成對；pin 首尾；不足 reduction 回原樣 |
| 完成驗證 | `verifyCompletion` | `bridge.mjs verify` | `Stop` (一次續跑) | 只信執行證據；缺證據回 `unknown`；`pass/fail/unknown` + `file:line` 有才附 |
| 分階段審查 | `reviewDiff` | `bridge.mjs review` | 同 core（skill 呼叫） | risk→profile→evidence→mechanism→severity→reviewer；Jev 只附註，不改路由 |

## 硬規則

- 五個 policy 全是 `shadow` + `uncalibrated`、rollout 0。任何一方都不能用 Jev 結果硬阻擋或授權。
- `skills/jev-agent` 只用既有兩支 MCP tool（`jev_evaluate`/`jev_apply_policy`），不加第三支、不加 HTTP/Docker。
- Jev 意見只能 advisor/ledger；deterministic severity/reviewer route 永不被 Jev 改動。
- 不輸出、不提交 transcript／decision state／calibration JSONL／API key；key 只讀設定路徑。

## Claude 端

- prune hook：`hooks/jev.js`（`tool.call`，Bash/Grep/Read）。保留，勿刪。
- 其它四項：`agent-glue/claude/bridge.mjs`（stdin JSON → stdout bounded JSON）。
- `bridge.mjs route` 無 live scorer 時 fail-open `no_match`；host 起 gateway 後可注入真 scorer（`plugin/lib/route.js`）。

## Codex 端

- `.codex/hooks.json`（專案）與 `.codex-plugin/plugin.json`＋`.codex-plugin/hooks.json`（plugin）分檔，與 Claude 的 `hooks/hooks.json` 無關。
- `PreCompact` snapshot 寫 `.jev-runtime/`（gitignored）；`PostCompact` 用 `additionalContext` restoration，標明是 restoration layer，非改寫 core transcript。
- `Stop` 必讀 `stop_hook_active`，最多續跑一次，防 infinite loop。
- `PreToolUse`/`PostToolUse` 只 advisory，回 `decision: allow`。

## 壓縮互斥／遷移

- `agent-glue/src/compact.js` 是 fast-jev-compaction 的最小必要移植，但 **本 plug-in 不註冊自己的 `session.compact`**。
- 外部 fast-jev plugin 已註冊 `session.compact`（`~/dev/fast-jev-compaction-openrouter`）。兩者**不可同時啟用**兩個 `session.compact` handler。
- 遷移：要改用本移植，停用外部 fast-jev plugin，再於 Claude host 註冊本 plug-in 的 `session.compact`；反之亦然。文件化，勿雙開。

## 觀測

- Claude prune ledger：`~/.openclaw/state/jev-prune.log`。
- Codex runtime ledger：`.jev-runtime/codex-route.log`、`codex-compact.log`、`codex-verify.log`、`codex-tooluse.log`。

## 停用

- Claude：在 plugin marketplace 移除/停用 `jev-gate`。
- Codex：`codex -H` 關 hooks，或移除 `.codex/hooks.json` 與 `.codex-plugin/`。
