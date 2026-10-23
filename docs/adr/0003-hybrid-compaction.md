# ADR-0003: 兩段式 compaction（逐字刪除後再摘要中段）

- Status: Rejected（實測較差，未併入；程式碼見 `0003-hybrid-compaction.patch`）
- Date: 2026-10-23

## Context

`compact-hook.mjs` 的 Jev pass 只刪舊的 tool call/result，正文一律逐字保留。2026-10-16～23 的 Claude transcript 以 API usage 實測，同一 session 依壓縮次序的殘留中位數為：第 1 次 49k、第 2 次 57k、第 3 次 68k、第 4 次以後 77k（n=12）。正文會持續累積。

外部證據：
- JetBrains "The Complexity Trap"（arXiv 2508.21433）：觀察遮蔽不輸 LLM 摘要；先遮蔽、較晚才摘要的混合法再省 7%。
- opencode `session/compaction.ts`：逐字保留的尾端超過 max(30k, 25% window) 時改用摘要。

## 提案

Jev pass 之後，若預估殘留超過 `JEV_COMPACT_SUMMARIZE_ABOVE`（50k），把 transcript 切成 head、middle、tail 三段。切點不得落在 tool_result 開頭。只把 middle 交給 `next({ ...e, messages: middle })`，由 engine 摘要；回傳 head、engine 結果、tail。

## 實測（session 2663ac1b fork，Claude Code 2.1.309，同一程序內 `/compact` 後再送一輪）

| 方式 | 下一輪 context |
|---|---|
| 壓縮前 | 141,612 |
| 只用 Jev pass | 50,468 |
| Jev + 摘要中段 | 61,079 |
| 只用內建 /compact（resume 後） | 39,046 |

兩段式比只用 Jev 多出 21%。engine 的摘要結果會帶回最近讀過的檔案，加上摘要本身，抵銷了中段減少的量。樣本只有 n=1，但原因出在機制本身，換別的 session 也會發生。

## Decision

不併入。Jev pass 的殘留問題改從別的方向處理，候選見下。

## 實測中發現的事實（獨立於本提案）

1. `SessionMessage` 不包含 thinking、圖片、system prompt。用它估 token 嚴重偏低：此例估 46k，實際 141k。任何門檻都要以 `$.session.usage().context.tokens` 為準。
2. hook 回傳的 `{ messages }` 只在同一程序內有效。用 `claude -p` 壓縮後結束程序，再 `--resume`，context 會回到完整版：jev 150,845、兩段式 171,028。內建 /compact 在 resume 後仍保留（39,046）。這表示 jev 的壓縮結果沒有寫進 transcript，所有「壓完退出、之後 resume」的使用方式都會失效。

## 候選方向

- 修第 2 點：讓 jev 的壓縮結果能在 resume 後保留。這是比兩段式更大的漏洞。
- 殘留過大時，改交給內建 /compact 整段摘要，不只摘要中段。此例內建版為 39k，比 Jev 的 50k 小。代價是正文全部被改寫。
