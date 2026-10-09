# WO-20261010 M2：pull 到 2b0b668、重跑 npm test、回報 opencode TUI 實測

本工單在 M2 本機執行，所有路徑都以 `$HOME` 為準。repo 預設在 `~/jev-gate-mcp`，放在別處就先 `export JEV_GATE_DIR=<repo 路徑>`。

背景：上次在這台跑 `npm test`，`tests/agent-glue/compact-hook.test.mjs` 的「primary endpoint/model defaults name the same host as the primary key file」失敗。根因是測試沒清掉 `JEV_ENDPOINT`／`JEV_MODEL`／`JEV_API_KEY_FILE`，這台 shell 有 export 其中之一，測試就讀到環境值。`2b0b668` 修了測試，產品碼沒改。

## 步驟

```sh
# 0. 防呆：Mac16,10 是派工端那台，不是 M2
[ "$(sysctl -n hw.model)" != "Mac16,10" ] || { echo "這台不是 M2，停"; exit 1; }

REPO="${JEV_GATE_DIR:-$HOME/jev-gate-mcp}"
cd "$REPO"

# 1. 回 main、pull，確認含 2b0b668
git checkout main
git pull --ff-only
git merge-base --is-ancestor 2b0b668 HEAD && echo "HEAD 含 2b0b668" || echo "FAIL：HEAD 不含 2b0b668"
git log --oneline -1

# 2. 這台 export 了哪幾個 override（只印有沒有設，不印值）
for k in JEV_ENDPOINT JEV_MODEL JEV_API_KEY_FILE; do
  printf '%s=%s\n' "$k" "$([ -n "$(printenv "$k")" ] && echo set || echo unset)"
done
grep -l 'JEV_ENDPOINT\|JEV_MODEL\|JEV_API_KEY_FILE' ~/.zshenv ~/.zshrc ~/.zprofile ~/.bash_profile 2>/dev/null

# 3. 全套測試
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)|✖'

# 4. 重接 plugin＋煙霧測試（會再 pull 一次，冪等）
bash scripts/m2-opencode-jev-install.sh
```

### 5. TUI 實測

1. 關掉所有 opencode TUI，重開一個（plugin 只在啟動時載入）。
2. 在 TUI 裡請模型跑一個大輸出指令，例如 `seq 1 20000 | sed 's/^/heartbeat ok tick /'; echo 'ERROR: target line'`，問它「最後一行錯誤是什麼」。
3. 看三件事：
   - 模型看到的輸出有沒有 `[l0:` 或 `[jev-prune: dropped` 標記（有＝剪裁生效）。
   - 模型答不答得出 `ERROR: target line`（答得出＝沒剪掉答案）。
   - usage 記帳：

```sh
tail -n 20 ~/.jevgate/usage.jsonl | grep -o '"caller":"[^"]*"' | sort | uniq -c
```

caller 應是 `prune:opencode`，不該出現 `prune:prune:` 雙前綴（#27 修的）。

4. 推理強度：M2 沒有 Laya，預期 `~/.jevgate/opencode-effort.log` 不存在或沒新行。有新行就回報，代表自動關閉沒生效。

## 驗收（全部成立才算過）

- 步驟 1 印 `HEAD 含 2b0b668`
- 步驟 3 `ℹ fail 0`
- 步驟 4 煙霧測試 `judged=true` 且 `kept_error=true`
- 步驟 5 caller 只有 `prune:opencode`，沒有雙前綴；模型答出 ERROR 行

## 回報格式（貼原始輸出，不要改寫）

```
1. git log -1：
2. override set/unset＋哪個 rc 檔有設：
3. npm test 三行（tests/pass/fail）＋任何 ✖ 行：
4. 煙霧測試 JSON 那行：
5. TUI：有無剪裁標記／模型答出 ERROR 行與否／caller 計數／effort.log 有無新行：
```

步驟 3 仍 fail 時，貼完整 ✖ 區塊和 `actual`／`expected`，先別改碼。
