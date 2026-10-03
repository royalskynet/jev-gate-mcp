## 任務

在 `/Users/51mini/dev/jev-gate-mcp` 讓 Laya 的 ONNX session 在 process 退出前被顯式釋放。

先讀計畫的「第一段：根治」：`/Users/51mini/dev/jev-gate-mcp/work/plan-laya-nightly-rc134-20261003.md`

只改兩個檔，不改其他任何東西：

1. `gateway/src/adapters.js` 的 `makeLayaAdapter`（約 161 行）：現在是 `return async function layaAdapter(...) {...}` 內聯回傳。改成先把那個函式存成區域變數 `layaAdapter`，掛上 `layaAdapter.release = unload;`，再 `return layaAdapter;`。函式簽名 `(state, questions, _opts)` 不動，idle unload 與 `idleTimer.unref()` 行為不動。
2. `scripts/laya-label-corpus.mjs`：在推論 `for (const record of pending)` 迴圈結束之後、`if (!dryRun && scored)` 寫檔之前，加一行 `await laya.release?.();`。只能加在 `if (pending.length)` 區塊內（`laya` 在那裡才存在）。

冪等：已經有 `layaAdapter.release = unload` 或已經有 `await laya.release` 時就當成已完成。

## 驗收

```sh
cd /Users/51mini/dev/jev-gate-mcp
grep -q 'layaAdapter.release = unload' gateway/src/adapters.js
grep -q 'await laya.release' scripts/laya-label-corpus.mjs
grep -q 'idleTimer.unref' gateway/src/adapters.js
grep -q 'export function makeLayaAdapter' gateway/src/adapters.js
grep -q 'function layaAdapter(state, questions, _opts)' gateway/src/adapters.js
node -e "import('./gateway/src/adapters.js').then(m=>{const a=m.makeLayaAdapter({load:async()=>({systemOne:async()=>({answers:{}}),close:async()=>{}})});if(typeof a!=='function')process.exit(1);if(typeof a.release!=='function')process.exit(1);}).catch(()=>process.exit(1))"
node scripts/laya-label-corpus.mjs --dry-run
out=$(node --test --test-reporter=tap gateway/test/)
echo "$out" | grep -q '^# fail 0$'
```

預期：五個 `grep -q` 都無輸出且 rc=0；`node -e` 無輸出且 rc=0（adapter 仍是函式、且帶 `release` 函式屬性）；`laya-label-corpus.mjs --dry-run` 印出 `corpus=... pending=...` 與 `label stays null ...` 且 rc=0；TAP 輸出含 `# fail 0`。

## 禁止

- 重複加已存在的那兩行（先 grep 確認，有就不動）。

- `launchctl bootout/bootstrap/kickstart` 必帶完整 service target `gui/$(id -u)/<label>`；裸 domain 與 `launchctl reboot` 禁止；載入回 141/125 立即停手回報。
- 無頭機：禁止回報「請使用者手動貼 token／授權／執行指令」。憑證讀不到＝停手回報阻斷點與需要的 key 名，不要求人工補值。
- 不要改 `scripts/laya-nightly.sh`、不要改 `gateway/src/laya-loader.js`、不要動 `package.json` 依賴版本。
- 不要為了讓驗收通過而改驗收指令或刪既有測試。
