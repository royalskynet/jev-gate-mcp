# Laya 夜訓 rc=134 根治與預防（2026-10-03）

## 症狀

`⚠️ Laya 夜間標註失敗 rc=134`（launchd nightly，03:00 Asia/Taipei）。

## 根因（實證，非推測）

`~/.jevgate/laya-nightly.err.log` 末兩行：

```
libc++abi: terminating due to uncaught exception of type std::__1::system_error: recursive_mutex lock failed: Invalid argument
/Users/51mini/dev/jev-gate-mcp/scripts/laya-nightly.sh: line 24:  2840 Abort trap: 6  ... node .../laya-label-corpus.mjs
```

rc=134 = 128+6 = SIGABRT。證據鏈：

1. **工作做完才死。** 10-02 那次的 stdout 全部印出（`scored=133 agree=0 failed=0`、完整 agreement 表、結尾 `label stays null — promotion to a training set is a human step.`）。abort 發生在 node teardown，不在推論或寫檔。
2. **與筆數無關。** 10-01 05:42 `scored=148` rc=0；10-01 19:00 `scored=13` rc=0；10-02 19:00 `scored=133` rc=134。偶發競態。
3. **本機無法穩定重現。** `scratchpad/repro-abort.mjs` 跑 1 次 inference ×3 輪、40 次 inference ×1 輪，4 輪全 rc=0。**所以修復不能靠「重現後不再出現」驗證**（Fail Loud）。
4. **上游類別已知，殘留路徑無修。** microsoft/onnxruntime#24579「mutex issue at process exit on MacOS since v1.21.*」已由 PR#26445「[node] Fix logging mutex crash at exit on macOS」修掉（merged 2025-10-31，`310ff93`）。本機 `onnxruntime-node@1.30.0`（npm 發布 2026-09-14）**已含該修**，仍 abort → 撞的是殘留路徑。`gh search issues --repo microsoft/onnxruntime recursive_mutex` 無命中，上游無開放 issue、無可採用的修。
5. **我們這端的放大因子（可控）。** `gateway/src/adapters.js:161` `makeLayaAdapter` 的 ONNX session 從來沒被顯式釋放：`unload()` 只掛在 idle timer 上，而該 timer 被 `unref()`（adapters.js:183），批次腳本跑完就退出，timer 永不觸發。ORT env 因此一律交給 process teardown 析構 —— 正是競態現場。`@receptron/laya` 有 `close()`（`dist/laya.d.ts:28`），但 adapter 沒有對外入口可呼叫。

## 不採用的路徑

| 方案 | why not |
|---|---|
| 升級 onnxruntime-node | 1.30.0 已含 #26445，沒有更新的修可升 |
| 降版到 1.20.x | `@receptron/laya@0.1.2` 釘 1.30.0；為偶發 teardown 競態換掉整個推論核心不划算 |
| 關 ORT telemetry（社群 workaround） | Node 綁定未暴露。實測 `ort.env` 只有 `wasm/webgl/webgpu/versions/logLevel`，無 `telemetry` |
| `process.exit(0)` 硬退 | 同樣會跑 C++ 靜態析構，不保證避開；且會遮蔽真正的失敗退出碼 |

## 第一段：根治（降低競態機率）

讓 ORT session 在 process 開始 teardown **之前**就被顯式釋放，不留給靜態析構。

- `gateway/src/adapters.js`：把既有的 `unload` 掛成 adapter 函式屬性 `layaAdapter.release = unload`。不改 adapter 簽名 `(state, questions, opts) => result`，既有呼叫者零影響（外科手術式）。
- `scripts/laya-label-corpus.mjs`：推論迴圈結束後、寫檔之前 `await laya.release?.()`。

**驗證邊界（Fail Loud）**：這段只能驗證「session 真的被釋放了」，**無法驗證「競態消失」** —— 4 輪重現都沒中，缺少可判定的失敗基準。所以第二段不是可選項。

## 第二段：預防加固（保證夜訓不再整晚白跑）

真正的損失不是 abort 本身，是 `laya-nightly.sh:26-29` 看到 rc!=0 就 `exit` —— 標註明明做完了，訓練、ONNX 導出、champion 更新整段沒跑。改成「以完成信標為真相，不以退出碼為真相」。

- `scripts/laya-label-corpus.mjs`：走完全部輸出後寫完成信標 `~/.jevgate/laya-label.done`（JSON：`ts`、`corpus`、`scored`、`failed`、`pid`，mode 0600）。`--dry-run` 也寫，否則測試無從斷言。
- `scripts/laya-nightly.sh`：開頭記 `START_EPOCH=$(date +%s)`。標註 rc!=0 時：
  - rc=134 **且** 信標 `ts` 不早於 `START_EPOCH` → `hpush "⚠️ Laya 標註完成但退出碼 rc=134（ORT teardown 競態，見 work/plan-laya-nightly-rc134-20261003.md），繼續訓練"`，**不 exit**，往下跑訓練。
  - 其餘（rc 非 134，或信標過期／不存在）→ 照舊 hpush 失敗並 `exit $RC`。
- 標註腳本路徑抽成 `JEV_LAYA_LABEL_SCRIPT`（預設 `$DIR/scripts/laya-label-corpus.mjs`），讓測試能注入假腳本。這是加固的前提，不是順手重構。

## 驗收（機械可判，不看模型自述）

1. 假標註腳本 exit 134 **且**寫當次信標 → nightly.sh 必須走到訓練階段。
2. 假標註腳本 exit 134 **不**寫信標 → nightly.sh 必須 exit 134，不得繼續。
3. 假標註腳本 exit 1 **且**寫當次信標 → 必須 exit 1（只放寬 SIGABRT，不放寬真失敗）。
4. 信標 `ts` 早於 `START_EPOCH`（上一輪的殘留）→ 必須 exit 134，不得當成本次完成。
5. 真跑 `node scripts/laya-label-corpus.mjs --dry-run` → rc=0 且信標被更新。
6. 既有行為保留斷言：`adapters.js` 的 adapter 簽名與 idle unload 仍在；`nightly.sh` 的 FLOOR／TOL／champion／qids 三道閘一行未動。

註：驗收區塊在 `set -e` 下不用 `! cmd`（會讓斷言變空包彈），預期失敗一律寫 `rc=0; cmd || rc=$?; [ "$rc" = 134 ]`。

## 派工

兩張 dcq 工單（同 cwd 自動互斥序列化）：

- `work/task-laya-release-session-20261003.md` — 第一段
- `work/task-laya-nightly-beacon-20261003.md` — 第二段

cwd：`/Users/51mini/dev/jev-gate-mcp`

## 附錄 A：第二段要落地的確切形狀

信標 `~/.jevgate/laya-label.done`（路徑可用 `JEV_LAYA_LABEL_DONE` 覆寫，mode 0600）。**必須含 `epoch` 欄位**，shell 才能直接比數字，不必解析 ISO 字串：

```json
{"ts":"2026-10-03T19:10:11Z","epoch":1791997811,"corpus":335,"scored":133,"failed":0,"pid":2840}
```

`scripts/laya-nightly.sh` 的 rc 判定（取代現行 26-29 行）：

```sh
if [ "$RC" != 0 ]; then
  DONE="${JEV_LAYA_LABEL_DONE:-$HOME/.jevgate/laya-label.done}"
  EP=$(jq -r '.epoch // 0' "$DONE" 2>/dev/null || echo 0)
  if [ "$RC" = 134 ] && [ "${EP:-0}" -ge "$START_EPOCH" ]; then
    hpush "⚠️ Laya 標註完成但退出碼 rc=134（ORT teardown 競態），繼續訓練"
  else
    hpush "⚠️ Laya 夜間標註失敗 rc=${RC}，看 ~/.jevgate/laya-nightly.log"
    exit "$RC"
  fi
fi
```

測試 `gateway/test/nightly-rc134.sh`（bash，`set -u`，自備 `mktemp -d` 沙箱；PATH 前置 stub `hpush`；`JEV_LAYA_PYTHON` 指向假 python，該假 python 落一個 marker 檔代表「走到訓練階段」；`JEV_LAYA_LABEL_SCRIPT` 指向假 .mjs；`JEV_LAYA_LABEL_DONE`／`JEV_LAYA_TRAIN_REPORT`／`JEV_LAYA_CHAMPION` 全部指進沙箱，不得碰 `~/.jevgate`）。四個案例：

| 假標註腳本行為 | 信標 | 期望 nightly rc | 期望 marker |
|---|---|---|---|
| `process.exit(134)` | 寫，`epoch` = 現在 | 0 | 存在 |
| `process.exit(134)` | 不寫 | 134 | 不存在 |
| `process.exit(1)` | 寫，`epoch` = 現在 | 1 | 不存在 |
| `process.exit(134)` | 寫，`epoch` = 1 | 134 | 不存在 |

`jq` 用真的，不要 stub：假 python 不產 report，現行的 `.promoted // false` 分支自然跳過導出，這是預期行為。

## 收尾

驗收通過後跑 `/fi` 記一筆：規則是「批次腳本用的原生推論 session 要在 process 退出前顯式釋放；靠 unref 的 idle timer 等於永不釋放」，以及「夜間 pipeline 的階段成敗以完成信標判定，不以退出碼判定」。
