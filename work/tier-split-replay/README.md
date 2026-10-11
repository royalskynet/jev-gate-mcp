# tier 拆題重放（DEVLOG §34–§36）

- `labels.json`：80 筆人工標註，用 teacher-corpus 的 `id` 對回 state，不含請求原文。下一輪驗證要排除這 80 筆。
- `replay-split.mjs`（§34）、`replay-split2.mjs`（§35）、`replay-holdout.mjs`（§36）：從 scratchpad 原樣保存，路徑參數照各檔頂端。執行時要設 `JEV_TEACHER_CORPUS=<暫存檔>`，以免寫進真語料。
- 下一輪：照 §36 的三點改題目，用累積的新紀錄挑第三批（排除 `labels.json`），先標再問。
