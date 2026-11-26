# Handoff：Jev 前四項雙 Agent 膠水（停止點）

日期：2026-09-21（Asia/Taipei）  
Repo：`/Users/you/dev/jev-gate-mcp`  
接手方式：把本檔完整交給一個**沒有對話上下文的模型**。先讀現況，不要假設半成品正確。

## 0. 使用者最後指令與停止狀態

使用者要把以下前四種 Jev 用法吸收到本 repo，Claude Code 與 OpenAI Codex 都實裝，最後 commit + push：

1. 快速判斷層：模型路由、skill 選擇、保留/繼續等 bounded decisions。
2. 上下文壓縮：user/assistant 文字原樣，只判 tool call/result 保留、刪除或截斷。
3. 完成驗證：用真實 runtime evidence 回 `pass | fail | unknown`，不能相信模型自稱 done。
4. 分階段 code review：risk → file profile → evidence → mechanism → severity → reviewer route。

使用者隨後明確說「停手，寫 handoff」。已中止唯一的 `deep-run`，**不得自動重啟**。

- deep task：`/Users/you/.cache/deep-tasks/jev-four-agent-glue.md`（31+ 行，`deep-lint` 已 OK）
- deep session：tmux `deep-1789982557`，已精確 kill。
- wrapper/inner 最終錯誤：`[claude-code:unrecognized_model] {"model":"deepseek-v4-flash-0731"...}`；外層 exit 255。
- wrappers log 只有 start，沒有正常 end/verify：`2026-09-21 17:22:37 deep-run start ...`。
- **沒有 commit、沒有 push、沒有 manifest/hook 接線完成。**

## 1. Git 與測試精確現況

停止時：

```text
branch: main
HEAD: ecdb578 test(live.test): retry the live Jev drop a bounded number of times
origin/main: ecdb578（與 HEAD 相同）
tracked diff: 無
untracked: agent-glue/、tests/agent-glue/
```

原本 clean baseline（本工作開始前）已驗過：108 tests，106 pass，0 fail，2 skipped；build 與 gateway acceptance 通過。

停止後主 session 跑 `npm test`：

```text
tests 125
pass 120
fail 3
skipped 2
```

三個失敗：

1. `compact: user/assistant prose never stripped...`：fixture call arguments 只有 15 chars，小於 `MIN_STRIP_CHARS=48`，測試卻期待 marker。
2. `compact: call/result pairing...`：4-message fixture 使用預設 `pinLast=8`，整段都被 pin，測試卻期待 drop。
3. `review: ... nudges severity one band...`：測試把 200 additions 當 large，但實作 large 門檻是 `>300`；更重要的是「Jev nudges deterministic route」違反 shadow/advisory 邊界，應修設計，不要只改門檻迎合測試。

## 2. Deep 留下的半成品（全部未追蹤、未審核）

```text
/Users/you/dev/jev-gate-mcp/agent-glue/cli.mjs
/Users/you/dev/jev-gate-mcp/agent-glue/src/index.js
/Users/you/dev/jev-gate-mcp/agent-glue/src/compact.js
/Users/you/dev/jev-gate-mcp/agent-glue/src/verify.js
/Users/you/dev/jev-gate-mcp/agent-glue/src/review.js
/Users/you/dev/jev-gate-mcp/tests/agent-glue/core.test.js
```

可保留的方向：共享 pure core + CLI、route 重用 `plugin/lib/route.js`、verbatim compaction、deterministic completion evidence、固定 review stage。

已知缺陷／未完成：

- `cli.mjs` 沒有 live Jev adapter；route 永遠 `no_match`，compact 永遠 keep。它只是 offline shell，不能算實裝。
- 未建立 Claude adapter、Codex adapter、`.codex/hooks.json`、`.codex-plugin/plugin.json`、agent skill、manifest 更新、文件、`agents:acceptance`。
- compaction 只懂 OpenAI-style `{role, content, tool_calls}`；尚未轉 Claude `SessionMessage` 或 Codex transcript JSONL。
- 同一 assistant message 若有多個 tool calls，現行 pair/drop 邏輯可能只判第一個卻一起 strip 全部 calls/results；需按 call-site 聚合後一次完整判斷，或逐 pair 正確重建。
- 任一 judge throw 的契約應是整次 fail-open/fallback；現行只保留該 pair，其他 pair 仍可能被刪。
- `reducedBy < minReductionChars` 時現行仍回傳已改寫的 `messages`，只把 `compacted:false`；安全 API 應直接回原 messages 或 adapter 強制不用改寫結果。
- `pinLast` 在短 transcript 會 pin 全部；要明訂這是預期，並修 fixture，或用安全且可測的有效 pin 範圍。
- verify 的 `pass` 可回空 evidence（所有 execution evidence 都沒有 path）；應保留可稽核 command/log evidence，`file:line` 只在有位置時附上。
- review 只看 additions，不看 removals、敏感 path、diff hunks；沒有真 git diff parser。
- review 現行會讓高 confidence Jev 把 severity 升一級，會改 deterministic reviewer route；在 policy 尚未校準時禁止。Jev 意見只能附註/ledger。

## 3. 本 repo 不可破壞的既有契約

先完整讀：`/Users/you/dev/jev-gate-mcp/docs/HANDOFF-20260921.md`。

- MCP surface 永遠只有 `jev_evaluate`、`jev_apply_policy`；加能力用 policy/client glue，不加 tool。
- 五個 policy 全是 `shadow` + `uncalibrated`、rollout 0：
  `intent-routing`、`context-screening`、`proposed-action-risk`、`completion-claims`、`diff-risk`。
- 不改 thresholds、mode、calibration_status、rollout 來讓測試好看。
- 未校準結果只能 advisory/ledger；不能硬阻擋，也不能授權 consequential action。
- 不加 HTTP/Docker/Caddy/VM；維持 stdio MCP。
- 不輸出或提交 API key；key 只以設定路徑存在。
- 不提交 transcript、decision state、calibration JSONL。
- 保留現有 Claude function hook prune 與 ledger：`hooks/jev.js`。
- 不降低既有測試數、不新增 skip、不在紅測試時宣告完成。

## 4. 已查證的上游做法（只吸收原理）

- `https://github.com/kerpopule/hermes-jev-skills`
  - 每輪路由、skill choice、memory/context filtering；先 shadow、fail-open、保留目前 model。
- `https://github.com/tamaratran/fast-jev-compaction`
  - user/assistant prose 原樣；call/result pairing；首筆與近期 pin；每個 tool call 判 call/result；不足 reduction 或 Jev 失敗回內建 summary。
- 本機已有 OpenRouter/ZDR fork：`/Users/you/dev/fast-jev-compaction-openrouter`
  - 可讀其 `hooks/fast-jev.ts` 與 `src/`；避免複製整套，優先重用可靠 library/演算法。
  - 若整合進本 plugin，要文件說明不能和此外掛同時啟用兩個 `session.compact` handler。
- `https://github.com/reticlehq/reticle`
  - 吸收 `pass/fail/unknown + runtime evidence + file:line`。
  - Reticle README 的 Jev routing 是 roadmap，**不要宣稱 Reticle 現在已接 Jev**，也不要無故新增 Reticle dependency。
- `https://github.com/devagrawal09/jev-review`
  - risk filter → file profile → evidence selection → mechanism → severity → reviewer routing；threshold/policy 必須由 deterministic code 擁有，Jev finding 不是 proof。
- 找到 Codex port 參考：`https://github.com/leonaaardob/fast-dev-compaction`；未審碼，不可直接信任。

## 5. Claude 與 Codex 的能力差異

Claude 現況：

- `.claude-plugin/plugin.json` + `hooks/hooks.json`（function modules）載入 `hooks/jev.js`。
- function hook `tool.call` 可在模型看到前重寫 tool result；現有 Bash/Grep/Read prune 已實裝且有 ledger。
- 本機外部 plugin 已提供 `session.compact` verbatim compaction；本 repo 若吸收，需要明確遷移/互斥。

Codex 官方 manual 已查：`/var/folders/77/kcgt6zhn0zg8314ql3fvnv800000gn/T/openai-docs-cache/codex-manual.md`（暫存可能消失；必要時重新跑 openai-docs helper）。

- 支援 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreCompact`、`PostCompact`、`Stop` command hooks。
- 專案 hooks 可放 `.codex/hooks.json`；plugin 可用 `.codex-plugin/plugin.json` 指向專屬 hooks 檔。
- 不要覆寫 Claude 的 `hooks/hooks.json` 成 Codex 格式；兩端 manifest/hooks 分檔。
- `PreToolUse` 才能阻止/重寫尚未執行的 action。
- `PostToolUse` 已發生副作用，不能撤銷；block 只替換 model-facing result/feedback。
- `Stop` 用 `decision:block` 續跑；必讀 `stop_hook_active`，最多續跑一次，防 infinite loop。
- `PreCompact` 可 snapshot；`PostCompact` 或 `SessionStart(source=compact)` 可注入 `additionalContext`。Codex 不能像 Claude function hook 一樣直接替換內建 compaction，所以要清楚標成「原文 restoration layer」，不能假稱改寫 core transcript。

## 6. 建議完成切片

1. 先修/重構 pure core，使 `npm test` 回綠；新增 multi-call、global fail-open、below-min 原樣、short transcript pin 測試。
2. 建一個 injected gateway client：production 呼叫既有兩 MCP semantics/in-process gateway；test 用 fake。所有輸出 bounded、無 state/secret log。
3. Claude adapter：route/verify/review 走共享 core；compaction 要嘛可靠重用本機 fork 的 library，要嘛完整移植必要最小邏輯。保留現有 prune。
4. Codex adapter：解析官方 hook input 與 transcript；PreCompact snapshot、PostCompact 原文 restoration；Stop completion claim detection + evidence collector + one retry；Pre/PostToolUse 只 advisory，因 policies 未校準。
5. 加 `skills/jev-agent/SKILL.md`（兩端共用操作規則），`.codex-plugin/plugin.json`、Codex hooks config、Claude manifest 描述與安裝/互斥文件。
6. staged review 必須吃真 git diff/file list/hunks，保留 stage trace；Jev 只分類，不得改硬 route。
7. 加 `npm run agents:acceptance`：Claude plugin validate（存在時）、完整 tests、build、gateway acceptance、雙端 offline smoke。
8. 更新 `docs/HANDOFF-20260921.md` 與雙端觀測/停用/成效量測：route accuracy/no_match、compaction reduction+rerun、verify false-pass/unknown、review precision/latency。
9. 完整驗收後才 commit + push；確認 `git status` clean 且 HEAD == upstream。

## 7. 驗收與重新派 Deep

原任務定義的唯一最終驗收（目前 script 尚不存在）：

```sh
npm run agents:acceptance
```

若使用者之後明確要求重派 Deep：先修 `/Users/you/.deepclaude` 的 model alias／設定，確認 `deepseek-v4-flash-0731` 被 backend 接受；再 `deep-lint /Users/you/.cache/deep-tasks/jev-four-agent-glue.md`，只能啟動一個 session。不要因安靜而重派。

## 8. 接手第一批只讀指令

```sh
cd /Users/you/dev/jev-gate-mcp
git status --short --branch
git log -3 --oneline --decorate
find agent-glue tests/agent-glue -type f -maxdepth 3 -print
npm test
sed -n '1,260p' docs/HANDOFF-20260921.md
sed -n '1,240p' /Users/you/.cache/deep-tasks/jev-four-agent-glue.md
```

不要刪半成品；先判定哪些可救。不要把本 handoff 的存在誤認成實裝完成。
