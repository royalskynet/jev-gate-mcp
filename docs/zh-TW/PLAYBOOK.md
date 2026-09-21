# Jev 十步操作手冊（對照本 repo 實作）

外部來源：0xCodila 的十步拆解（<https://x.com/0xcodila/status/2100984487802708306>）。
本文把那十步逐條落到這個 repo 的**實際檔案與指令**上，並標明哪幾步我們還沒做、
哪幾步是刻意不做。

> 外部宣稱的 193× 加速 / 444× 降本是 TypeSafe 自家在 Claude Fable 5.1 與 GPT-6 Astra
> 上的測試數字，本 repo **沒有複現也不背書**。我們自己量到的只有一件事：
> gateway 的處理開銷 `core p95 < 50ms`、`transport p95 < 50ms`（`node gateway/scripts/bench.mjs`）。
> 省下多少錢取決於你把多少判斷從大模型搬到 Jev，不是取決於這個網關。

---

## 0. 先記住三分法

```
LLM 創造  →  agent 執行  →  Jev 決定下一步
```

對應到本 repo：Jev 只經由 MCP 的兩支工具出現，**都是 advisory**：

| 工具 | 用途 | 誰擁有規則 |
|---|---|---|
| `jev_evaluate` | 一次性、窄範圍的 Choice／Score／Noul 判斷 | caller |
| `jev_apply_policy` | 伺服器自有、帶版本的 policy，回 `accept`/`review`/`escalate`/`deny` | 伺服器 |

「MCP 有這個工具」不等於「規則被執行」。真正的阻斷要由 host 端實作
（見 `docs/host-adapter.md`）。

---

## 1 → LLMs 創造。代理執行。Jev 決定下一步

**做到了。** MCP surface 只有兩支工具，沒有第三支；任何生成、寫作、規劃都不經過 Jev。
server instructions 直接寫死了這條界線，見 `gateway/src/server.js`。

---

## 2 → 把分支拆成三個原語：Choice、Score、Noul

**做到了，三種都在用。** 現行五個 policy 的題型分布：

| policy | 題目 | 型別 |
|---|---|---|
| `intent-routing` | `target` | choice |
| `context-screening` | `relevance` / `suspicious_instructions` | score / noul |
| `proposed-action-risk` | `blast_radius` / `credential_exposure` | score / noul |
| `completion-claims` | `supported` | noul |
| `diff-risk` | `risk_surface` / `undeclared_behavior_change` | score / noul |

挑型別的實務規則：**可窮舉的分支用 choice；有序程度用 score；是非題用 noul。**
把「這個 diff 危不危險」寫成 noul 會丟掉「有點危險」這一層，這正是 `diff-risk`
用 score（0/1/2 三級）而不是 noul 的原因。

---

## 3 → 先用 OpenAI／Anthropic 建，再換 Jev，不重建圖

**做到了，而且是 adapter 級別的換。** `gateway/src/adapters.js` 三個 adapter 同一個簽名
`(state, questions, opts) => answers`：`makeTypesafeAdapter`、`makeOpenrouterAdapter`、
以及一組 deterministic fake（`FakeMode.SUCCESS` / `MALFORMED` / `MISSING` /
`PROVIDER_FAILURE` / `TIMEOUT` / `RATE_LIMIT`）。換 provider 只動 config，policy、
mapping、gate 組合、telemetry 全部不動。

fake adapter 不是玩具：整套 offline 驗收（`npm run gateway:acceptance`、`gateway:replay`、`drift.mjs`）都靠它
跑，才不用每次驗收都燒 token。

---

## 4 → 從共享 state、並行決策、風險閾值、執行佇列開始

**一半做到。**

- 共享 state：**有**。每個 policy 宣告 `state_projection`，gateway 只把白名單欄位送出去。
  `diff-risk` 是 `["diff","intent","files_changed"]`，其餘欄位根本到不了 provider。
- 風險閾值：**有**。五個 policy 統一 `thresholds: { auto: 0.85, review: 0.6 }`，
  語意等級與 confidence 兩軸一起組（`gateway/README.md` 的 Gate composition 段）。
- 並行決策：**沒有**。同一個 policy 內的多題是同一次 provider 呼叫（見第 5 步），
  但**跨 policy 沒有並行**——連續套五個 policy 就是五次呼叫。
- 執行佇列：**沒有，也刻意不做**。本 repo 是 stdio MCP server，排程屬於 host 的事。

---

## 5 → 批次決策，不要一題一題來

**單一 policy 內已經是批次。** adapter 簽名收的是 `questions`（複數物件），
`JevDecisionModel.evaluate({ state, questions })` 一次呼叫帶走全部題目——
`context-screening`、`proposed-action-risk`、`diff-risk` 各 2 題都是一次打完。

**跨 policy 還沒批次，這是目前最大的效能缺口。** 外部文章講的「13 題快 10 倍、
便宜 12.2 倍」對應的是把 13 題塞進一次呼叫；我們現在五個 policy 各自一次，
state projection 又各不相同，要合併得先解決「同一次呼叫如何送多份不同投影的 state」。
還沒動。

---

## 6 → 把 Jev 放在受限分支上

**做到了，而且是唯一放法。** 目前落地的分支只有一個：`hooks/jev.js`
（context-screening，逐 chunk keep/drop，`chunkChars: 16000`、每次呼叫最多判固定
數量的 chunk，其餘直接放行）。其餘四個 policy 有 policy 檔但沒接 hook。

「受限」在本 repo 有具體定義：policy 必須宣告 `state_projection`、`state_schema`、
`consequence`，而且 `activation.allow_outcomes` 限制哪些結果可以直通。
五個 policy 目前都是 `["review","escalate","deny"]`——**只有 `accept` 會被封頂**，
因為在未校準的狀態下，唯一危險的結果是「放行」。

---

## 7 → benchmark 整個迴圈，不是單次模型呼叫

**做到一半，而且要講清楚是哪一半。** `node gateway/scripts/bench.mjs` 量的是**網關自己的處理開銷**
（`benchCore` + `benchTransport`，p95 各自必須 < 50ms，超過就 exit 非零）。
它**不含** provider 往返時間，也不含 agent 迴圈其他部分。

理由：provider 延遲不是我們能控制的變數，把它混進來會讓回歸測試變成網路測試。
但這也代表 **repo 裡沒有任何「整個迴圈快了幾倍」的數字**，要談端到端收益得另外量。

---

## 8 → 廣泛排序，狹窄閱讀

**做到了，就是 `hooks/jev.js` 的形狀。** 工具輸出切 chunk → Jev 對每個 chunk 判
keep/drop（便宜、批次、窄題目）→ 只有 keep 的 chunk 進 context 讓大模型讀（貴）。
這一步的重點不是「省 token」，是**把昂貴的閱讀集中在值得讀的東西上**。

---

## 9 → 重複使用同一套系統：狀態 → 問題 → 動作 → 驗證

**做到了，五個 policy 共用同一條程式路徑。** 加一個 policy = 加一個 JSON 檔，
不寫新程式：

```
policies/*.json          宣告 state_projection / questions / mapping / thresholds
  → registry.js          載入、驗版本、擋掉 active 但未校準的 policy
  → gateway.js           投影 state → 呼叫 adapter → mapping → composeGate → 封頂
  → telemetry.js         allowlist 欄位落 log（state/questions/answers 永遠不落）
  → calibration.js       選擇性把完整樣本落成標註集（見下）
```

驗證那一環在本 repo 是 `scripts/calibrate.mjs`：它要求每筆樣本有 `label`、`gate`、
`coverage`、`confidence`，且 `policy` / `policy_version` / `model` / `provider` /
`dataset_version` 五個 provenance 欄位整份檔一致。**沒有 label 過不了 validate**，
用 fake provider 收的樣本會因為 pinned model 不符被擋——這兩條是故意的。

---

## 10 → 數學、寫作、不可逆執行，不要交給 Jev

**做到了，寫進 server instructions 強制提醒。** 界線是：

- 算得出來的用程式算（schema 檢查、授權、門檻比較、金額計算）。
- 要生成的交給 LLM。
- 只有「往哪邊走」交給 Jev。
- **不可逆的事永遠不由 Jev 單獨決定**——這就是為什麼所有 policy 都停在 advisory、
  `consequence` 欄位要明寫，而真正的阻斷要 host 自己實作。

---

## 實際要怎麼開始用

```sh
npm ci && npm test                  # 105 tests
npm run build                       # build-check：驗五個 policy 檔合法
npm run gateway:acceptance          # offline 驗收（eval / drift / replay / tool-eval / bench）
npm run gateway:replay              # 對 fixtures/replay-baseline.json 重放
node gateway/scripts/bench.mjs      # 處理開銷 p95（core / transport 各 < 50ms）
node gateway/scripts/context-cost.mjs   # 這套工具吃掉多少常駐 context
```

provider token 路徑與 MCP 掛載方式見 `docs/zh-TW/README.md`；gateway 細節見
`gateway/README.md`。

### 讓 policy 走出 shadow 的唯一路徑

五個 policy 現在全是 `shadow + uncalibrated + rollout_percent: 0`，
`registry.js` 會擋下任何「active 但未校準」的 policy。要轉正：

1. 設 `JEV_CALIBRATION_LOG=<path>`，gateway 就會把每次決策以 `calibrate.mjs`
   的 JSONL 格式逐行落盤（含投影後 state、answers、raw gate、`label: null`）。
   不設就完全不寫。
2. 逐行把 `label` 填成「本來應該是什麼結果」。policy 的
   `evaluation_dataset_version` 若還是 `synthetic-harness-*`，先改掉——
   `calibrate.mjs` 會把它標成 harness-only 且永不 eligible。
3. `node gateway/scripts/calibrate.mjs <file.jsonl>`，只有 `eligible_for_review: true`
   才進人工審核。
4. 人工審過才改 `active + calibrated`，並用 `rollout_percent` 慢慢開。

跳過任何一步都是拿 synthetic fixture 當校準，那等於沒有校準。
