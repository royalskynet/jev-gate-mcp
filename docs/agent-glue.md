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
  src/triage.js     省錢判斷層（一次數問 + tier 映射 + 地板規則 + cache + features 隱私；
                    有 catalog 時併 `skill` Choice 第 4 題，skills 為 advisory）
  src/index.js      匯出面
  cli.mjs           共用 CLI（compact|verify|review|route，route 已接真線：無 model
                    由 route 自身 fail-open，candidates 缺漏→有界 no-candidates）
  claude/bridge.mjs Claude adapter（route/verify/review/compact 走共享 core）
  claude/spawn-hook.mjs Claude `agent.spawn` hook（triage 設 subagent model，opt-in）
  codex/*.mjs       Codex adapter command hooks（user_prompt_submit 跑真 triage）
hooks/jev.js        Claude prune hook（保留，勿刪）
hooks/hooks.json    載入 jev.js + claude/spawn-hook.mjs
skills/jev-agent/   兩端共用操作規則
```

## 2. Claude 端

- **安裝**：plugin marketplace 掛 `jev-gate`（`.claude-plugin/plugin.json`）。`hooks/hooks.json`
  載入 `hooks/jev.js`（prune）。其他四項用 `agent-glue/claude/bridge.mjs` 直接 import 或 CLI。
- **停用**：移除/停用 `jev-gate` plugin。
- **觀測**：`~/.openclaw/state/jev-prune.log`（每筆被判定的 prune，keep 也寫）。
- **快速壓縮（已併入本 plugin）**：`agent-glue/claude/compact-hook.mjs` 註冊
  `session.compact`（逐字壓縮）與 `turn.complete`（context 百分比觸發，
  `JEV_COMPACT_AT_PERCENT` 預設 60）。契約在 `agent-glue/src/compact.js`：
  user/assistant 文字逐字保留、call 與其 result 成對刪、首尾 turn 釘住、
  judge 失敗或縮減未達 `JEV_COMPACT_MIN_REDUCTION`（預設 4000 字元）就把**原始**
  messages 還給 host 走內建壓縮。`JEV_COMPACT_ENABLED=0` 關閉。
  觀測：`~/.openclaw/state/jev-compact.log`。
- **壓縮互斥**：外部 fast-jev plugin（`~/dev/fast-jev-compaction-openrouter`）也註冊
  `session.compact`。**不要雙開**——兩個模組回同一事件是 undefined。本 plugin 會讓路：
  `session.start` 讀 `~/.claude/settings.json`，若 `fast-jev-compaction@…` 仍 enabled
  就 stand down 並在 ledger 寫明。要用本版，先停用外部 plugin。

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

## 3.5 Triage（省錢判斷層）

`src/triage.js` 一趟 Jev 一次問數件事——`difficulty`（Score 4 級）、`kind`
（Choice: coding/writing/research/general）、`costly_mistake`（Noul），有 skill
catalog 時加第 4 題 `skill`（Choice，criteria＝catalog＋`no_match`，**騎同一趟、
不另開一次 Jev**）——再由 deterministic code（`decideTier`）映射到
cheap→medium→hard tier。skill 選擇是 advisory 的 `skills` 陣列，不改 model 選擇。

**省錢閘（全在 Jev 呼叫之前）**：

- **免費前置守門**：空 turn／pinned／沒設 tiers → 一次都不打，直接保留現狀。
- **危險正則**：掃**整段原文**（不是送出去的切片），`isDangerous`。
- **切片**：先 unwrap 排程信封（`## Prompt|Task|Request` 段落保留，`previous
  output` 段落丟棄），超長再取開頭 1/4＋結尾 3/4（`ask_chars` 預設 2500）。
- **decision cache**：key＝（切片、context bucket、config 指紋、has_images、
  pinned、profile、**catalog 指紋**）。**context 與 catalog 都必須進 key**——否則
  小 context 的答案會被大 context 命中、換 catalog 會吃到舊答案（`tests` 有 bucket
  不同則 miss、catalog 不同則 miss 的防回歸）。
- **features 隱私模式**：只送統計特徵（`len_bucket`/`chars`/`has_code`/`steps`
  /`has_danger_word`），原文不出機器；敏感 profile 自動開啟。

**地板規則（`decideTier`，純函式，優先於方向判定）**：

- 低信心且不危險 → 保留現狀（不升級不降級）。
- 低信心但危險、或掃到危險詞 → medium。
- risky 或 `costly_mistake` noul（stakes）> 0.4 → 永不落到最便宜 tier。
- stakes > 0.85 且已偏難（難度側機率 ≥ `hard_needs_probability`，且信心足）→ hard。
- large context（bucket `l`）→ 永不降級到 cheapest。

**Claude 端**：`claude/spawn-hook.mjs` 註冊 `agent.spawn`，**依情境自動啟用**：
`triageEnabled()` 只要 `JEV_TRIAGE_MODEL_CHEAP/MEDIUM/HARD` 任一有設就是 true——
設了 tier model 本身就是「我要分層」的意思，再多一個 opt-in flag 只會多出
「看起來開著但什麼都不做」的狀態。`JEV_TRIAGE_ENABLED=1/0` 可強制覆寫。
transport 由 hook 自己注入（`agent-glue/src/live.js`）：沒有 provider key 時
transport 是 `null`，triage fail-open 回原狀。skill 選擇併進同趟 triage 的 `skill`
第 4 題（`pickSkills` 的關鍵字啟發式已刪除），catalog 來源
`input.skills ?? deps.skillCatalog ?? []`；多數 turn 回「不需要任何 skill」（`[]`）。

**Codex 端**：`user_prompt_submit.mjs` 跑真 triage，但 Codex hook 換不了模型，
所以只吐一行 advisory `additionalContext` notice，並在 `codex-route.log` 寫一行
bounded 記錄（文件要標明：**Codex 端只給建議，不設模型**）。

**ledger**：每筆決策記一行 bounded：tier／specialty（`kind.choice`）／confidence／
cached／latency_ms／是否 fail-open。**不記原文不記 secret。**

**驗收**：`npm run agents:acceptance` 已含 triage + spawn-hook smoke stage。

## 4. 成效指標（對照 HANDOFF §6）

| 指標 | 定義 | 從哪量 | 目標方向 |
|---|---|---|---|
| route accuracy / no_match | 命中正確候選比例；無匹配回 `no_match` 的比例 | Codex `codex-route.log`、Claude bridge route | accuracy 高、no_match 只在真無匹配時 |
| compaction reduction + rerun | 每 pass 減少的 chars；reduction < 最小門檻時的回退次數 | `compactMessages.reducedBy/minReductionChars`、`codex-compact.log` | reduction 夠、回退少 |
| verify false-pass / unknown | pass 但證據不足／`unknown` 的比例 | `codex-verify.log`、verify 測試 | 0 false-pass、unknown 只在真缺證據 |
| review precision / latency | 分階段審查精確度（真 diff 吃進、severity 正確）；端到端延遲 | review 測試、`reviewDiff` 輸出 | precision 高、latency 低 |
| triage savings / fail-open | 三問一趟、省錢閘（切片/cache/features）生效比例；transport 掛了是否保留現狀 | `codex-route.log`、triage 測試 | cache hit 高、fail-open 不誤升不誤降、地板規則零違反 |

## 5. 驗收

```sh
npm run agents:acceptance
```

依序跑：Claude plugin validate（CLI 存在時）、完整 tests、build、gateway acceptance、
Claude bridge smoke、Codex hooks smoke、injected client smoke、triage + spawn-hook smoke。
任何一步非零即整體失敗。
