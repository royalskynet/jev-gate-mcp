# 工單：opencode 壓縮外掛依審查修 7 條（2026-11-06）

工作目錄：/Users/you/dev/jev-gate-mcp

repo：`/Users/you/dev/jev-gate-mcp`（git，main 上改，commit 訊息含 `compact-fix`，不 push）。先讀 commit 910d161、3bba8ec 的改動，以及 `integrations/opencode/jev-laya.js`、`integrations/opencode/prune-core.js`、`agent-glue/src/prune.js`、`agent-glue/src/live.js`、`gateway/src/cascade-server.js`。

## 背景

蛋先生審 CHG-20261106-06 回 FAIL。以下 7 條要改程式。

## 改動

1. **外送前遮蔽 PII（cascade-server）**：cascade 的雲端層（Zen → beam API → beam CLI，即 main 區塊的 `zen` 鏈）外面包一層 `withPiiScrub`：呼叫雲端前，把 `state` 裡所有字串葉節點收成陣列，POST `http://127.0.0.1:4102/scrub`，body `{"texts":[...]}`，回應 `{"texts":[...]}` 依序放回；URL 可由 `JEV_CASCADE_SCRUB_URL` 覆寫、可注入 fetch。遮蔽服務失敗（非 2xx、逾時 5s、長度不符）→ throw `code:'upstream'`，**絕不送原文**。Laya（本機）拿原文不變。介面照抄 `integrations/hermes/jev-prune/__init__.py` 第 124–132 行的 `_scrub_http`。新檔 `gateway/src/pii-scrub.js`。
2. **caller 鍵統一**：外掛的單筆剪裁與歷史壓縮都用 `cascadeUrlFor('compact', …)` 取 URL（usage caller 標籤維持 `prune:opencode`／`compact:opencode`）。
3. **沒 cascade 就跳過**：callers 檔沒有 `compact` 鍵、或讀不到 → 單筆剪裁只做 L0、歷史壓縮整段不做；不得退回 `judgeSegments` 直打 Jev 端點。`agent-glue/src/prune.js` 的直打路徑保留給其他呼叫者，外掛不再走到。
4. **判決快取跟著使用者訊息走**：`decisions` 的 key 改成 `callID + 最新使用者訊息的 sha1`；換新使用者訊息就重判。被丟的段落在新訊息下若判 keep，要還原原文（原文另存在同一個 Map，不寫磁碟）。
5. **只丟可重跑的唯讀輸出**：只有 `read`、`grep`、`glob` 的輸出可被判 drop；`bash`、`webfetch` 及其他工具一律 keep。drop 標記改成 `[jev-compact: dropped N chars of <tool> <參數>; re-run the tool to see it]`，讓 bot 知道怎麼取回。
6. **短 deadline＋失敗必記＋自動關閉**：每次 cascade 判斷 deadline 8 秒（`JEV_COMPACT_TIMEOUT_MS` 可覆寫），逾時或錯誤 → 保留原樣，`~/.jevgate/opencode-compact.log` 寫一行 `fail-open <原因>`；同一行程連續 3 次失敗 → 本行程停用壓縮並寫一行 `disabled after 3 failures`。沒 URL 的跳過也寫一行 `skip no-cascade`（同一行程只寫一次）。
7. **README 路徑**：`integrations/opencode/README.md` 安裝段改成 `~/.config/opencode/plugin/`（單數，本機實際載入的目錄），並在「Jev 端點」段寫明壓縮外送前經 `:4102` 遮蔽、只走 `compact` cascade。

## 測試（要會失敗）

- `gateway/test/pii-scrub.test.mjs`：(a) 字串葉節點被替換成遮蔽後文字、雲端 adapter 收到的是遮蔽版；(b) 遮蔽回 503 → throw 且雲端 adapter 沒被呼叫；(c) 回傳長度不符 → throw。
- `integrations/opencode/jev-laya.test.mjs` 補：(a) callers 檔無 `compact` → judge 不被呼叫；(b) `bash` 輸出不送判；(c) 換新使用者訊息後同一 callID 重判；(d) 連 3 次 judge throw 後第 4 次不再呼叫。
- 靜態：`gateway/src/cascade-server.js` 含 `withPiiScrub`。

## 驗收

```bash
cd /Users/you/dev/jev-gate-mcp && npm test \
 && test -f gateway/test/pii-scrub.test.mjs \
 && test -f gateway/src/pii-scrub.js \
 && grep -q "withPiiScrub" gateway/src/cascade-server.js \
 && grep -q "4102/scrub" gateway/src/pii-scrub.js \
 && grep -q "opencode/plugin/" integrations/opencode/README.md \
 && ! grep -q "opencode/plugins/" integrations/opencode/README.md \
 && grep -q "disabled after 3 failures" integrations/opencode/jev-laya.js \
 && git log --format=%s -20 | grep -qi compact-fix
```

不要做：重啟服務、改 `~/.jevgate/*`、改 `~/.config/opencode/*`、push、連網。
