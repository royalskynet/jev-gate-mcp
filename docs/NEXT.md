# NEXT — Jev 接線

## 版本升級記錄
- 升級前：Claude Code 2.1.263
- 升級後：Claude Code 2.1.278（`claude update`）
- 開旗標：`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`（settings.json env）

## Jev 接線參數（本次確認）
- 端點：`https://openrouter.ai/api/v1/systemone`（canonical 為 `https://openrouter.ai/api/alpha/decisions`）
- model：`typesafe/jev-1.13`，實際回 `typesafe/jev-1.13-20260917`
- auth：OpenRouter key，`Authorization: Bearer`
- question 形狀：`{type: "choice"|"score"|"noul", instructions, criteria}`，`type` 為必填 discriminator
- 實測：單次 343 in / 33 out、cost 0.000014406 USD、約 550ms
