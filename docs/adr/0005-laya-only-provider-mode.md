# ADR-0005: `laya-only` provider mode（嚴格本機、無雲端 fallback）

- Status: Accepted
- Date: 2026-11-26

## Context

`JEV_PROVIDER=laya` 是混合模式：合格的簡短判斷先由本機 Laya 回答，不能回答、格式不符或超出白名單時由 Jev/Zen/OpenRouter 接手。這適合省錢與逐步試行，但不能表達「這台 host 絕對不要把 judgment 送去雲端」。

實務上 fallback 不只有成功路徑。除了 local lane 的 cloud adapter，Claude compact hook 走 cascade daemon 時，原本在 daemon down 或 5xx 時會改打直接雲端 `/v1/systemone`；沒有雲端 key 時甚至會在呼叫 daemon 前放棄。只把 provider 命名為 `laya` 不能關閉這些 failure path。

## Decision

新增明確的 provider mode：`JEV_PROVIDER=laya-only`。

1. `laya` 維持原意：本機優先、雲端 fallback，行為不變。
2. `laya-only` 使用同一條 local lane，但不建立 cloud fallback adapter。Laya abstain、模型不可用、題型不合格或沒有 credential 時 fail closed；policy judgment 也沒有隱藏雲端出口。
3. Claude compact hook 增加對應的 per-caller 設定 `compact-mode: "laya-only"`。它對 cascade daemon 加 `x-jev-mode: laya-only`；daemon abstain、daemon 5xx 或 daemon 不在時不回退直接雲端，改把原始 messages 交還 host 內建 compaction。
4. 不用額外 boolean 作為正式介面。模式必須在 provider 名稱或 caller mode 中顯示，避免 `provider=laya` 與另一個開關組合出不清楚的語意。

## Consequences

- 預設與現有 `laya` hybrid 流量不變；strict mode 只在明確選擇時生效。
- strict mode 可保證 judgment 不因 fallback 出機，但不能保證 Laya 有答案。白名單不足或長 compact state 會常見 abstain。
- compact 的 fail-open 方向仍是保留 context：Laya 不能判斷時由 host 內建 compaction 接手。這不是 Laya 語意 prune。
- `jev_apply_policy` 在 strict mode 沒有雲端 policy provider；這是有意的 fail-closed 代價，不是隱含本地 policy 授權。
