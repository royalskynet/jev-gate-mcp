# jev-laya opencode plugin

在 opencode 的 `tool.execute.after` hook 對工具輸出做 L0 剪裁（去 ANSI、收合 progress、收合重複行），減少送入模型的 token。純本地 deterministic，不打任何 HTTP、不呼叫 Laya daemon。

## 安裝

```sh
ln -s /Users/51mini/dev/jev-gate-mcp/integrations/opencode/jev-laya.js ~/.config/opencode/plugins/jev-laya.js
```

## 行為

- 輸出字串長度 < 2000 或不是字串 → 不動。
- 剪裁後 `savedChars > 0` 才覆寫 `output.output`。
- 任何錯誤 fail-open，原輸出不動。

## 注意

- `opencode run --pure` 不載 plugin，dc 不受影響。
- P4 會加 daemon `x-jev-mode: laya-only`。
