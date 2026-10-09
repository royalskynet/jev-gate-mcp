# jev-laya opencode plugin

在 opencode 的 `tool.execute.after` hook 縮短工具輸出，不分用哪個模型：

1. L0 剪裁（去 ANSI、收合 progress、收合重複行），本機確定性，免費。
2. 剪完仍 ≥16KB 的 `bash`／`read`／`grep`／`glob`／`webfetch` 輸出，交 Jev 依「最新一則使用者訊息」逐 chunk 判斷 keep/drop（同 `agent-glue/src/prune.js`，被丟的段落留 `[jev-prune: dropped N lines]`）。`edit`／`write` 等輸出不送。

任何錯誤 fail-open：最差就是 L0 結果，絕不比原輸出少資訊。

## 安裝

```sh
ln -s /Users/51mini/dev/jev-gate-mcp/integrations/opencode/jev-laya.js ~/.config/opencode/plugins/jev-laya.js
```

M2：`bash scripts/m2-opencode-jev-install.sh`（含煙霧測試）。

## Jev 端點

沿用 `hooks/jev.js` 的 `JEV_ENDPOINT`／`JEV_MODEL`／`JEV_API_KEY_FILE`。三者都沒設、但有 `~/.creds/kv/TYPESAFE_API_KEY.txt` 時自動改走 TypeSafe 直連（M2 的情況）。usage caller＝`prune:opencode`。

## 注意

- `opencode run --pure` 不載 plugin，dc 不受影響。
- `jev-laya.js` 只能匯出 plugin 本身：opencode 會把每個匯出的函式當 plugin 呼叫，輔助函式放 `prune-core.js`。
