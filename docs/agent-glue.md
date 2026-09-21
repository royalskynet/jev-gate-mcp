# Jev Agent Glue — 雙端安裝／停用／觀測／成效

Claude Code 與 OpenAI Codex 共用 `agent-glue/src/` 的判斷核心。本文件說明兩端的啟用方式、
停用方式、觀測通道，以及四項成效指標的定義（對照 `docs/HANDOFF-20260921.md` §6）。

## 1. 元件地圖

```
agent-glue/
  src/compact.js    原樣壓縮（verbatim + pairing + pin + fail-open）
  src/verify.js     完成驗證（pass|fail|unknown + evidence / file:line）
  src/review.js     分階段審查（risk→profile→evidence→mechanism→severity→route）＋真 git diff parser
  src/client.js     注入式 gateway client（production 走 in-process gateway；test 用 fake）
  src/index.js      匯出面
  cli.mjs           共用 CLI（compact|verify|review|route）
  claude/bridge.mjs Claude adapter（route/verify/review/compact 走共享 core）
  codex/*.mjs       Codex adapter command hooks
hooks/jev.js        Claude prune hook（保留，勿刪）
skills/jev-agent/   兩端共用操作規則
```

## 2. Claude 端

- **安裝**：plugin marketplace 掛 `jev-gate`（`.claude-plugin/plugin.json`）。`hooks/hooks.json`
  載入 `hooks/jev.js`（prune）。其他四項用 `agent-glue/claude/bridge.mjs` 直接 import 或 CLI。
- **停用**：移除/停用 `jev-gate` plugin。
- **觀測**：`~/.openclaw/state/jev-prune.log`（每筆被判定的 prune，keep 也寫）。
- **壓縮互斥**：本 plug-in 不註冊自己的 `session.compact`；外部 fast-jev plugin
  （`/Users/51mini/dev/fast-jev-compaction-openrouter`）註冊了 `session.compact`。**不要雙開。**
  要改用本移植版本，停用外部 plugin 後再由 host 註冊。見 `skills/jev-agent/SKILL.md`。

## 3. Codex 端

- **安裝**：`features.hooks=true`（預設開）。專案級 `.codex/hooks.json`；或 plugin 裝
  `.codex-plugin/plugin.json`（`hooks` 指到 `.codex-plugin/hooks.json`）。
- hooks 會用到 `$(git rev-parse --show-toplevel)` 的專案路徑（無絕對路徑）或 `$PLUGIN_ROOT`。
- **停用**：`[features] hooks = false` 全域關；或刪 `.codex/hooks.json`、`.codex-plugin/`。
- **觀測**：repo 內 `.jev-runtime/`（gitignored）：
  - `codex-route.log`（UserPromptSubmit 路由）
  - `codex-compact.log`（PreCompact snapshot / PostCompact restore 筆數）
  - `codex-verify.log`（Stop 驗證 verdict/evidence 數/是否已 active）
  - `codex-tooluse.log`（Pre/PostToolUse advisory）
- **能力差異**：Codex 的 `PostCompact` 只能「追加 additionalContext」做原文 restoration，
  **不能**像 Claude function hook 直接替換內建 compaction——因此永遠標成 restoration layer。

## 4. 四項成效指標（對照 HANDOFF §6）

| 指標 | 定義 | 從哪量 | 目標方向 |
|---|---|---|---|
| route accuracy / no_match | 命中正確候選比例；無匹配回 `no_match` 的比例 | Codex `codex-route.log`、Claude bridge route | accuracy 高、no_match 只在真無匹配時 |
| compaction reduction + rerun | 每 pass 減少的 chars；reduction < 最小門檻時的回退次數 | `compactMessages.reducedBy/minReductionChars`、`codex-compact.log` | reduction 夠、回退少 |
| verify false-pass / unknown | pass 但證據不足／`unknown` 的比例 | `codex-verify.log`、verify 測試 | 0 false-pass、unknown 只在真缺證據 |
| review precision / latency | 分階段審查精確度（真 diff 吃進、severity 正確）；端到端延遲 | review 測試、`reviewDiff` 輸出 | precision 高、latency 低 |

## 5. 驗收

```sh
npm run agents:acceptance
```

依序跑：Claude plugin validate（CLI 存在時）、完整 tests、build、gateway acceptance、
Claude bridge smoke、Codex hooks smoke、injected client smoke。任何一步非零即���次失敗。
