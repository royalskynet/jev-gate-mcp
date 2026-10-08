## 任務

新增 opencode 本機 plugin `integrations/opencode/jev-laya.js`、`integrations/opencode/README.md`、`tests/opencode-plugin.test.mjs`。前提：本目錄已有 `agent-glue/src/l0-prune.js`（上一張工單，匯出 `l0Prune(text) → {text, savedChars}`）。設計見 `/Users/51mini/dev/jev-gate-mcp/docs/prd/PLAN-20261008-laya-first-cascade.md`。

opencode plugin 形狀（官方 https://opencode.ai/docs/plugins/）：模組匯出具名 async 函式，接 `{ project, client, $, directory, worktree }`，回傳 hooks 物件。`tool.execute.after(input, output)` 的 `output.output` 是模型會看到的字串，直接改它即生效。

1. `jev-laya.js`：
   - `import { l0Prune } from '../../agent-glue/src/l0-prune.js';`
   - `export const MIN_CHARS = 2000;`
   - `export const JevLaya = async () => ({ 'tool.execute.after': async (input, output) => { ... } });`
   - 內容：`output?.output` 不是字串或長度 < MIN_CHARS → 直接 return；否則 `const r = l0Prune(output.output)`，`r.savedChars > 0` 才 `output.output = r.text`。整段包 try/catch，任何錯誤吞掉（fail-open，原輸出不動）。
   - 本單**不**打任何 HTTP、不呼叫 Laya daemon（P4 才接）。
2. `README.md`（繁體中文，≤25 行）：用途、安裝＝`ln -s /Users/51mini/dev/jev-gate-mcp/integrations/opencode/jev-laya.js ~/.config/opencode/plugins/jev-laya.js`、`opencode run --pure` 不載 plugin 所以 dc 不受影響、P4 會加 daemon `x-jev-mode: laya-only`。
3. 測試：import `JevLaya`，取得 hooks 後呼叫 `hooks['tool.execute.after']({tool:'bash'}, out)`，至少測：
   - `out.output` = 長度 > 2000、含 50 行相同的 `'npm WARN x'` → 呼叫後含 `[l0: repeated`，且長度變短。
   - 長度 < 2000 的字串不變。
   - `out = {}`（沒有 output 欄位）不 throw。

## 驗收

```sh
test -f integrations/opencode/jev-laya.js
test -f integrations/opencode/README.md
grep -q "export const JevLaya" integrations/opencode/jev-laya.js
grep -q "tool.execute.after" integrations/opencode/jev-laya.js
if grep -Eq 'fetch\(|http' integrations/opencode/jev-laya.js; then exit 1; fi
grep -q 'ln -s' integrations/opencode/README.md
node --test tests/opencode-plugin.test.mjs
JEV_ROUTING_LOG=/dev/null JEV_TEACHER_CORPUS=/dev/null JEV_USAGE_LOG=off node --test
git diff --quiet HEAD~1 -- agent-glue/src/l0-prune.js
```

預期：全部 exit 0；兩個 `node --test` 都 `fail 0`；l0-prune.js 沒被改。

## 禁止

- 禁止改上述三個新檔以外的檔案；禁止建立或寫入 `~/.config/opencode/**`（安裝由主 session 做）。
- 禁止新增依賴、`npm install`、`set -x`、讀 `~/.creds/**`。
- `launchctl bootout/bootstrap/kickstart` 必帶完整 service target `gui/$(id -u)/<label>`；裸 domain 與 `launchctl reboot` 禁止；本單不應動 launchd。
- 無頭機：禁止回報「請使用者手動執行」。
- 完成後 `git add` 三個新檔並 `git commit -m "feat(opencode): L0 剪裁 plugin"`，不 push。
