## 任務

在 `/Users/you/dev/jev-gate-mcp` 讓夜訓不再因為標註階段的 rc=134（ONNX Runtime teardown 競態）而放棄後續訓練與導出。

要貼的 shell 片段、信標 JSON 欄位、測試四案例，全文在 `/Users/you/dev/jev-gate-mcp/work/plan-laya-nightly-rc134-20261003.md` 的「第二段：預防加固」與「附錄 A」。三處，缺一驗收不過：

1. `scripts/laya-label-corpus.mjs`：印完 `label stays null ...` 之後寫完成信標到 `process.env.JEV_LAYA_LABEL_DONE ?? join(homedir(), '.jevgate', 'laya-label.done')`，欄位格式照附錄 A（必須有 `epoch`，`mode: 0o600`），`--dry-run` 也要寫。
2. `scripts/laya-nightly.sh`：`echo start` 那段加 `START_EPOCH=$(date +%s)`；第 24 行標註指令改走 `${JEV_LAYA_LABEL_SCRIPT:-$DIR/scripts/laya-label-corpus.mjs}`；26-29 行的 rc 判定整段換成附錄 A 的片段；`set -u` 保留。
3. 新增 `gateway/test/nightly-rc134.sh`（bash，`chmod +x`），照附錄 A 四案例斷言，全程在 `mktemp -d` 沙箱內。

## 驗收

```sh
cd /Users/you/dev/jev-gate-mcp
bash gateway/test/nightly-rc134.sh
grep -q 'START_EPOCH=$(date +%s)' scripts/laya-nightly.sh
grep -q 'JEV_LAYA_LABEL_SCRIPT' scripts/laya-nightly.sh
grep -q 'JEV_LAYA_LABEL_DONE' scripts/laya-nightly.sh
grep -q 'epoch' scripts/laya-label-corpus.mjs
grep -q 'JEV_LAYA_ACC_FLOOR' scripts/laya-nightly.sh
grep -q 'live_gated.qids' scripts/laya-nightly.sh
grep -q 'JEV_LAYA_REGRESS_TOL' scripts/laya-nightly.sh
node scripts/laya-label-corpus.mjs --dry-run
test -s "$HOME/.jevgate/laya-label.done"
node -e "const e=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.jevgate/laya-label.done','utf8')).epoch;if(!(e>0))process.exit(1);if(Date.now()/1000-e>600)process.exit(1)"
out=$(node --test --test-reporter=tap gateway/test/)
echo "$out" | grep -q '^# fail 0$'
```

預期：`nightly-rc134.sh` 四案例皆 ok 且 rc=0；七個 `grep -q` 無輸出且 rc=0（後三個證明既有三道閘沒被動掉）；`--dry-run` 印 `corpus=...` 與 `label stays null ...` 且 rc=0；信標檔非空；`node -e` 無輸出且 rc=0（信標 `epoch` 是 10 分鐘內的真實時間）；TAP 輸出含 `# fail 0`。

## 禁止

- `launchctl bootout/bootstrap/kickstart` 必帶完整 service target `gui/$(id -u)/<label>`；裸 domain 與 `launchctl reboot` 禁止；載入回 141/125 立即停手回報。
- 無頭機：禁止回報「請使用者手動貼 token／授權／執行指令」。憑證讀不到＝停手回報阻斷點與需要的 key 名，不要求人工補值。
- 自創信標欄位或自創 rc 判定寫法（附錄 A 照抄）；把 rc 放寬到 134 以外的值；用「信標存在就算成功」取代 rc=134 條件。
- 動 `scripts/laya-nightly.sh` 第 31 行之後的訓練、FLOOR／TOL／champion／qids 三道閘、導出、摘要推播；動 `gateway/src/adapters.js`。
- stub `jq`；讓測試讀寫 `~/.jevgate`；重載 launchd job；用 `! cmd` 寫預期失敗的斷言（改 `rc=0; cmd || rc=$?; [ "$rc" = 134 ]`）。
- 改驗收指令或刪既有測試來讓驗收通過。
