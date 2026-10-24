# 0004 Jev 殘留過高時，下一次改用內建摘要重設

- Status: Accepted（2026-10-23）
- 取代：0003 的提案（Rejected）

## Context

Jev pass 只刪舊的 tool call/result，正文逐字保留，所以同一個 session 每壓一次，殘留就變大。近 8 天的 transcript 中，取 200k 視窗、壓縮前 140k–200k 的樣本，比較下一輪 context 的中位數：

| 第幾次 | Jev | 內建 /compact |
|---|---|---|
| 1 | 47k（n=65） | 39k（n=12） |
| 2 | 58k | 44k |
| 3 | 68k | 48k |
| 4+ | 75k | 51k |

這兩組是不同的 session，不是同一 session 的對照。借鏡 JetBrains《The Complexity Trap》（arXiv 2508.21433）：observation masking 為主、晚期才做摘要，比單用任一種都好。

## Decision

- `turn.complete` 在 Jev pass 之後的第一輪，讀 `$.session.usage().context.tokens` 記為殘留。只用 API 的真實 token，不用 `SessionMessage` 估算（fix 11264）。
- 下一次 `session.compact` 時，若殘留超過 `JEV_COMPACT_RESET_ABOVE`（預設 60000，設 0 關閉），本次直接呼叫 `next(e)`，交給內建摘要；之後回到 Jev。
- 狀態只存在程序內。resume 後的 session 視為未量測，先跑 Jev。

## 實測（session 2663ac1b fork，2.1.309，同一程序，門檻暫設 40000）

`/compact`：Jev 把 142,840 壓到 50,079（ledger 由 turn.complete 記錄）→ 再次 `/compact`：ledger 記 `reset via built-in`，下一輪 31,884。

## 限制

- SDK 宿主若 `$.session.usage()` 拋錯，就量不到殘留，行為等同改版前（全用 Jev）。
- issue H8：Jev 結果在 resume 後不保留。本 ADR 不處理；2026-10-23 另修（見下）。

## 附記：H8 根因與修法（2026-10-23）

hook 回傳的 messages 有寫進 transcript（compact_boundary 後接新 uuid 的副本）。問題在帶 `handle` 原樣保留的 tool_result 訊息：寫入時沿用 `sourceToolAssistantUUID`，2.1.309 的 `insertMessageChain` 把它的 `parentUuid` 設成這個值，也就是壓縮前的原始 assistant 列。`--resume` 從 leaf 沿 parentUuid 往回走，經這條連結越過 boundary，把整段舊歷史載回。修法：`detachToolResultHandles` 只拿掉 tool_result 訊息的 handle，讓 engine 重建（沒有 sourceToolAssistantUUID）；其他訊息保留 handle。實測（haiku，同一 session 的兩個 fork）：未修版的 leaf 鏈上有 33 列在 boundary 之前，resume 後 36,271；修正版的鏈根是 compact_boundary，resume 後 34,743。差 1,528 tokens，約等於 Jev 刪掉的 4,602 字元。代價：保留下來的 tool_result 只剩文字，圖片會掉。
