# PLAN 2026-10-20：route-judge 走 cascade，Laya 按白名單接手（第 3 步）

級別 L2（改 hook＋gateway 路由＋calibrate 判準）。前情：`~/.claude/projects/-Users-host/memory/state/jev-laya.md`「route-judge 進 Laya 白名單」段。

## 現況（已查）

- `~/.claude/hooks/route-judge.mjs:158` 用 `liveTransport()` 在 hook 行程內建 gateway 打 Jev：無 shadow、無白名單、無 teacher corpus 以外的 Laya 紀錄。3s deadline（:201），4.5s watchdog。近 825 次 Jev 延遲 p50 728ms／p95 1027ms；近 3000 行 log 有 3 次 `deadline-3s`。
- cascade 常駐（`local.jev-gate.cascade`，`gateway/src/cascade-server.js`，127.0.0.1:8793）已有整套：Laya router＋shadow＋teacher corpus＋白名單車道＋回退 Zen。compact 已經走它（`~/.jevgate/cascade-callers.json` `{"compact": url}`，header `x-jev-caller: compact` → caller `cascade:compact`）。
- 白名單車道是全域開關：`JEV_LAYA_WHITELIST=live` 才讀（`laya-routing.js:193`），現在 plist 設 `shadow`＝不讀。
- plist `JEV_LAYA_IDLE_MS=120000`：閒置 2 分鐘卸模型，下一個請求冷載 ~1s。
- **前置阻斷**：calibrate 的 noul 判準（|差|<0.2）和無常數對照，讓 `result_t#`、`wrong_reading_costly` 假過閘（常數 0.12／0.28 都贏本機）。這沒修就開 live，等於讓本機一律回近常數。

## 第一段：根治

### A. calibrate 判準（前置，先做先驗收）
1. noul 對錯＝本機與老師落在決策線同側。決策線表 `DECISION_LINE = {"default": 0.5}`，可按 (caller, family) 覆寫。
2. 過閘另需 lb > 同一批 kept 列「最佳常數答案」的準確率（choice＝多數類比例；noul＝一律答多數側）。不過列 rejected，`reason: "constant"`。
3. selftest 補：老師全 false、本機全 false → reason=constant；老師有 true 本機抓到 → 可過。

### B. route-judge 改走 cascade
1. hook 讀 `cascade-callers.json` 的 `route-judge` 鍵；有 URL 就 POST `/v1/systemone` 帶 `x-jev-caller: route-judge`（caller＝`cascade:route-judge`），沒有或連線失敗就退回現行 `liveTransport()`。照 compact-hook.mjs:352–377 的寫法，URL 只收 127.0.0.1。
2. deadline：cascade 請求沿用 3s，逾時照現行 fail-open，不在剩餘時間改打直連（兩段加起來會超過 3s）。只有連線被拒（daemon 沒跑）才立即改走直連。ponytail：要逾時後雙段，得把 hook deadline 拉長，另議。
3. 這一步本身不改答題來源：server 仍 `JEV_LAYA_WHITELIST=shadow`，雲端照答，本機只旁跑 → 線上 shadow 列開始累積 `cascade:route-judge`。

### C. caller 名對齊
1. 重放腳本 `CALLER` 改 `cascade:route-judge`（線上 shadow 與重放同鍵，lb 合併）。既有 2300 列 `gateway:route-judge` 重放列：calibrate 讀列時把 `gateway:route-judge` 映成 `cascade:route-judge`（一行 alias），不改歷史檔。
2. 防重複計數：B 上線後，同一個請求會同時產生線上 shadow 列（新 UUID）和 teacher corpus 列，重放再答一次就重複計。重放只收 B 切換時間之前的 corpus 列；切換時間記在 `~/.jevgate/cascade-callers.json` 旁的 `routejudge-cutover`，重放讀不到這個檔就照現行（全收）。

### D. 按 caller 開白名單車道
1. router 加 `JEV_LAYA_WHITELIST_CALLERS`（逗號清單）：`live` 時只對清單內 caller 讀白名單；未設＝全部（保持現行語意）。
2. 開法：plist 設 `JEV_LAYA_WHITELIST=live`＋`JEV_LAYA_WHITELIST_CALLERS=cascade:route-judge`，`launchctl kickstart -k`。這一步動系統常駐設定，執行前問一次。
3. 開的條件：A 修完後的白名單裡 `cascade:route-judge` 至少一族過閘。目前依假閘之外的數據，tier／ambiguous lb≈0.49，很可能修完後一族都不過 → D 不開，只做 A–C 累積 shadow。

## 第二段：預防加固

- calibrate selftest 的 constant 案例（A3）＝防假過閘回歸；反向改壞會 fail。
- hook 測試：cascade URL 指向不存在 port → 走 liveTransport 且 log `cascade-down`；URL 非 127.0.0.1 → 拒用。
- 斷流檢查（dbdc548 已上）會在 `cascade:route-judge` 7 天無 shadow 時報。
- 延遲看守：hook log 加 `via=cascade|direct`；晨報（laya-handoff-report）加 route-judge 經 cascade 的 p95 與 deadline 次數。p95 > 2.5s 連 2 天 → 推播。

## 驗收

1. `python3 scripts/laya-calibrate.py --selftest` ok；用 /tmp 路徑重跑真資料校準，`result_t#` 與 `wrong_reading_costly` 都落 rejected reason=constant（原始輸出貼回）。
2. `npm test` 全綠；hook 測試兩條（down／非 loopback）反向改壞會 fail。
3. 改 `cascade-callers.json` 加 `route-judge` 後，真實對話 10 則內：`route-judge.log` 出現 `via=cascade`，`routing-samples.jsonl` 出現 `cascade:route-judge` shadow 列，usage.jsonl 出現 `cascade:route-judge`、`gateway:route-judge` 停增。
4. 1 天後 hook `deadline-3s`／fail-open 比率不高於改前（改前基準：近 3000 行 3 次）。
5. D 只在條件成立時做；不成立就在 state 記「route-judge 0 族過閘，維持 shadow」。

## 不可逆／要問的點

- D2 改 launchd plist 並重啟 cascade 常駐：問一次。
- 其餘（calibrate、hook、cascade-callers.json 加鍵）可逆，直接做。

## 風險

- 冷載：IDLE 2 分鐘卸載，route-judge 間隔常超過 2 分鐘 → 每次冷載 ~1s 加到 Laya 旁跑上；shadow 是背景不擋回應，但 D 開 live 後會擋。D 前量冷載下 p95，必要時 route-judge 開 live 前把 IDLE 拉到 10 分鐘（記憶體 RSS 約 3GB 常駐，要看 Laya 峰值 <8GB 約束）。
- 走 cascade 後 hook 依賴常駐 daemon；daemon 掛掉退回直打，行為與現在相同。
