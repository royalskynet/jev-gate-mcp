# 工單：Triage 層補兩個洞（route stub + skill 選擇）

Repo: `/Users/51mini/dev/jev-gate-mcp`（base = `f07e5c4`，tree clean，HEAD == origin/main）

上一輪 triage 層已落地並驗過。剩兩處是「掛著沒接線」的殘件，本工單只做這兩件。

---

## 任務 A：route 子命令接真線（刪 stub）

現況：`agent-glue/cli.mjs:49-53` 與 `agent-glue/claude/bridge.mjs:38-44` 的 `route`
分支回傳寫死的 `{ no_match: true, top: [], dispatch: null, reason: 'cli-no-model' }`，
完全不呼叫已存在且已測過的 `route()`。

事實：`plugin/lib/route.js` 的 `route()` 在沒有 model 時，`makeScorer()` 會 throw，
`route` 自己 catch 成 `{ no_match: true, top: [], dispatch: null, reason: 'jev-unavailable' }`。
fail-open 行為本來就有，stub 是多餘的。

要做：
1. 兩個檔的 `route` 分支改成呼叫 `await route(payload)`（`route` 已在兩檔的 import 清單裡）。
2. `route()` 在 `candidates` 缺漏／空／含 `no_match` 時會 throw `EmptyCandidatesError`。
   CLI 必須 catch，回傳有界 JSON（例如 `{ no_match: true, top: [], dispatch: null,
   reason: 'no-candidates' }`）並以 exit 0 結束，不可噴 stack trace。其他例外同樣 catch。
3. 刪掉 `cli-no-model` 字串與兩段過期註解；檔頭 docstring 講「route returns no_match」
   的部分同步改成「route 走真判斷，無 model 時由 route 自身 fail-open」。
4. 測試：新增 cli/bridge 的 route smoke（走 stdin JSON），至少兩筆
   —— 給 candidates 但無 model → `reason: 'jev-unavailable'`；不給 candidates → `no-candidates`。

---

## 任務 B：pickSkills 換成真的 Jev Choice（且不准多花一次請求）

現況：`agent-glue/claude/spawn-hook.mjs:42-48` 的 `pickSkills` 是雙重過濾關鍵字啟發式
（skill 名要命中 regex **且** prompt 要含去標點後的名字），實務上幾乎永遠回 `[]`，
等於沒作用。它自己的 `ponytail:` 註解已寫明升級路徑＝對 catalog 做一次真 Jev Choice。

要做（**省錢是本層存在理由，照下列方式，不准另開一次請求**）：
1. 把 skill 選擇**併進既有的那一次 triage 請求**，當第 4 題 `skill`（Choice，
   criteria = catalog + `no_match`）。`triageQuestions()` 改成可接 catalog 參數；
   **catalog 為空或未提供時，questions 必須仍然只有 3 題**（零額外成本）。
2. `triage()` 的 `cacheKey` 必須加入 catalog 的穩定指紋（排序後 join 再走既有
   `configFingerprint` 同款 hash），否則換 catalog 會吃到舊答案。
3. `triage()` 回傳加 `skills`（陣列；`no_match` 或無 catalog → `[]`）。沿用既有邊界：
   transport 失敗 / 低信心 / features 隱私模式一律 `[]`，絕不猜。
4. `spawnDecision` 改用 `decision.skills`，`pickSkills` 整個刪掉（含三處呼叫）。
   catalog 來源：`input.skills ?? deps.skillCatalog ?? []`。
   skills 仍為 advisory，**絕不可影響 model 選擇或 `change` 旗標**。
5. 測試（含負向斷言）：
   - 無 catalog → transport 收到的 `questions` key 數 === 3，且 `skills` 為 `[]`；
   - 有 catalog → key 數 === 4，選中項回傳在 `skills`；
   - `skill` 答 `no_match` → `skills` 為 `[]`；
   - 同 prompt 換 catalog → cache miss（要回傳新 catalog 的結果）；
   - transport 失敗 → `skills` 為 `[]` 且 `failOpen: true`。

---

## 文件（必做，漏一項不算完成）

`docs/DEVLOG.md` 新增一節（接在 §15 後）記這兩個洞與修法；
`README.md`、`docs/zh-TW/README.md`、`docs/agent-glue.md` 各自更新 triage / route 段落的 delta
（只寫變動，不重抄整段）。中英兩份說明都要動到。

---

## 驗收（原始輸出要貼回）

```
cd /Users/51mini/dev/jev-gate-mcp
npm test 2>&1 | grep -E '^(ℹ|#) (tests|pass|fail|skipped)'
npm run agents:acceptance 2>&1 | tail -20 ; echo "exit=$?"
grep -rn "cli-no-model" agent-glue/ ; echo "grep_rc=$?"     # 必須 rc=1（無命中）
grep -rn "pickSkills" agent-glue/ ; echo "grep_rc=$?"       # 必須 rc=1（無命中）
grep -rn "registerTool" gateway/src/ | wc -l                # 必須 = 2
git diff --stat f07e5c4..HEAD -- gateway/                   # 必須為空
git status --porcelain                                      # 必須為空
git rev-parse HEAD origin/main                              # 兩行必須相同
```

通過標準：tests ≥ 173、fail = 0、skipped ≤ 2；acceptance `ALL OK` exit 0。
小步 commit（A 一筆、B 一筆、文件一筆），全部 push 到 origin/main。

預期：上列每條指令依序印出 —— tests ≥173 / pass ≥171 / fail 0 / skipped 2；acceptance 尾行 `[agents:acceptance] ALL OK` 且 exit=0；兩個 grep 皆 `grep_rc=1`（無命中）；registerTool 計數印 `2`；gateway diff 無輸出；git status 無輸出；rev-parse 印出兩行相同 SHA。

---

## 禁止

- 禁止新增任何 MCP tool；surface 永遠只有 `jev_evaluate` 與 `jev_apply_policy`（`registerTool` 恰好 2 處）。
- 禁止引入 HTTP / Docker / Caddy / VM；stdio only。
- 禁止改動 `gateway/policies/` 任何 threshold、`mode`、`calibration_status`、`rollout_percent`；
  五支 policy 必須維持 shadow / uncalibrated / rollout 0。禁止為了讓測試過而改 policy。
- uncalibrated 結果只能是 advisory / ledger，**禁止**拿來 hard-block 或授權任何有後果的動作。
  本工單的 `skills` 與 `route` 結果皆為 advisory，禁止讓它們阻斷或改變 model 選擇。
- 禁止為了 skill 選擇而多發一次 Jev 請求（必須併進既有那一次）。
- 禁止 commit transcript、decision state、calibration JSONL、API key。
- 禁止把使用者絕對路徑寫死進產出的程式碼。
- 禁止宣稱 Reticle 已接上 Jev。
- 禁止抄上游 branding 或程式碼。
- 禁止把 `hooks/hooks.json` 覆寫成 Codex 格式。
- 禁止減少測試數、禁止新增 skip、禁止在測試紅燈時宣告完成。
- 禁止在 features 隱私模式下把 catalog 名稱以外的原文送出。
- 禁止減少測試數、禁止新增 skip。
- 禁止要求使用者手動下指令（無頭設備，全自動）。
- `launchctl bootout/bootstrap/kickstart` 必帶完整 service target `gui/$(id -u)/<label>`；
  裸 domain 與 `launchctl reboot` 禁止；載入回 141/125 立即停手回報。（本工單不應碰 launchd）
