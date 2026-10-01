# ADR-0002: Calibrated question-type lane for the local Laya model

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0001 keeps `jev_apply_policy` on the cloud provider and leaves `jev_evaluate`
free to route. The first local pilot (`gateway/src/laya-routing.js`) admitted
exactly two frozen choice schemas, `task-kind-v1` and `message-topic-v1`, chosen
because an exact schema match is something the caller cannot forge. That lane is
narrow by construction, so nearly all `jev_evaluate` traffic still reached the
paid provider, and the free Zen tier exhausts after roughly ten hours a day.

The published Laya weights are a post-training-quantised int8 ONNX graph. On our
own teacher corpus they agree with Jev on 36.9% of question units, below the
per-type majority-class baseline in two of three types, which is why an earlier
review (fix 9544) concluded "do not switch". Two of that review's three
objections were specific: the model answers multi-intent inputs confidently and
wrongly, and judgement-type `noul` questions were useless.

An int8 PTQ graph cannot be fine-tuned — the quantised operators have no gradient
builders, and onnxruntime-training closed the request as not planned — and the
fused graph exposes only `logits` and `act_probs`, so it cannot even be used as a
frozen feature extractor. Training therefore has to start from the upstream fp
weights (`convaiinnovations/laya`, Apache-2.0).

## Decision

Train a decision head on the teacher corpus with the encoder frozen, and admit a
second routing lane keyed on the *question type* rather than the exact schema:

1. `scripts/laya-train.py` caches the frozen encoder's output once, cross-fits a
   decision head over grouped folds, fits per-type temperatures on the
   out-of-fold logits, and promotes new weights only when the paired gain over
   the current bundle has a bootstrap confidence interval clear of zero.
2. `JEV_LAYA_QTYPE_PILOT` (default `score,noul`) lists the admitted types, and
   `JEV_LAYA_CONF_MIN` (default `0.70`) is the post-temperature max-softmax a
   local answer must clear. Both are server-side; the caller can neither name a
   type nor supply a confidence, which preserves ADR-0001's property that the
   caller cannot talk its way onto the local path.
3. The conservative state filter still applies to this lane, and anything under
   the threshold, invalid, or `no_match` falls back to the cloud in the same
   request as the rest of the batch.
4. The older profile lane is **not** put behind the threshold. Its questions are
   `choice`, whose confidence clears 0.70 on only 4.4% of corpus units, so gating
   it would move most of that pilot's traffic back to the paid provider — the
   opposite of the intent.
5. Promotion and ONNX export are one step in `scripts/laya-nightly.sh`. Weights
   that the consumer cannot read are not a promotion.

## Measurement

521–533 question units from the teacher corpus, out-of-fold throughout;
Clopper–Pearson intervals for accuracy, bootstrap for the paired gain.

| | accuracy |
| --- | --- |
| int8 bundle | 36.9% |
| trained head, 0.79M params | 40.9%, paired +2.9pp, CI [-1.7, +7.6] — rejected |
| trained head, 14.97M params | 68.9%, paired +33.2pp, CI [+26.7, +36.7] |

Per type, against the majority-class baseline: `score` 50.0% → 98.6%, `noul`
20.7% → 86.0%, `choice` 35.6% → 55.9%. Fine-tuning therefore refutes the "`noul`
is useless" objection and confirms the "confidently wrong" one: at the operating
point `choice` admits 4.4% of its units with an interval of [73.5, 100], so it
stays out of the lane.

At `score,noul` / 0.70 / state filter: **24.2% of all question units answered
locally, 129 of 129 agreeing with the teacher, CI [97.2, 100]**.

Selective quantisation matters for this lane. Quantising the whole graph moves
logits by up to 2.82 and breaks the fitted temperatures, costing 60% of coverage
at T=0.80; quantising the encoder only and leaving the 15M decision layers in
fp32 holds 0.87 and matches fp32 coverage at T=0.70, at the same bundle size as
the published int8 bundle.

## Consequences

- Roughly a quarter of `jev_evaluate` units stop reaching the paid provider, with
  a measured lower bound of 97.2% teacher agreement on what stays local.
- The lane's defaults are claims about a specific corpus. Only
  `scripts/laya-train.py` output may move them, per AGENTS.md
  "不把 confidence 當正確率；所有自動化門檻必須經目標資料校準". In-sample accuracy
  on the promoted bundle runs ~5pp optimistic, so the gate reads out-of-fold rows.
- Nightly labelling is pinned to the frozen int8 baseline. Pointing it at the
  trained bundle would make `local_answer` the model's own output and silently
  turn the next night's comparison into self-comparison.
- `choice` keeps its narrow exact-schema lane and gains nothing here.
- Policies remain cloud-only; nothing in this ADR touches `jev_apply_policy`.
