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
   `JEV_LAYA_CONF_MIN` (default `score=0.65,noul=0.70`) is the post-temperature
   max-softmax a local answer must clear. The floors differ per type because the
   knees do: `score` holds 100% OOF accuracy down to 0.65 (n=77) while `noul`
   falls to 90.7% at 0.60, so a single shared number has to either forfeit
   `score` coverage or admit `noul` answers the data does not support. A bare
   number is still accepted and applies to every type; a type absent from the
   spec has no calibrated floor and is never served locally. Both are
   server-side; the caller can neither name a type nor supply a confidence,
   which preserves ADR-0001's property that the caller cannot talk its way onto
   the local path.
3. The conservative state filter still applies to this lane, and anything under
   the threshold, invalid, or `no_match` falls back to the cloud in the same
   request as the rest of the batch.
4. The older profile lane is **not** put behind the threshold. `choice` is the
   worst type overall, but that average is carried by questions the state filter
   already rejects: of the `choice` units that reach the local lane, 28 of 28
   agree with the teacher out of fold. Gating them would forfeit 11.7 points of
   request-level saving and buy no accuracy.
5. Promotion and ONNX export are one step in `scripts/laya-nightly.sh`. Weights
   that the consumer cannot read are not a promotion.

## Measurement

521–533 question units from the teacher corpus, out-of-fold throughout;
Clopper–Pearson intervals for accuracy, bootstrap for the paired gain.

545 units over 197 records, five grouped folds:

| | accuracy |
| --- | --- |
| int8 bundle | 35.7% |
| trained head, 0.79M params | 40.9%, paired +2.9pp, CI [-1.7, +7.6] — rejected |
| trained head, 14.97M params | 69.0%, CI [65.1, 72.7], paired +32.6pp, CI [+27.1, +37.8] |

Capacity, not corpus size, was the limit: freezing the 14.2M decision head on
the assumption that 500-odd units could not train it produced the rejected row.

Per type, against the majority-class baseline: `score` 50.0% → 98.6%, `noul`
20.7% → 80.2%, `choice` 35.6% → 52.9%. Fine-tuning therefore refutes the "`noul`
is useless" objection and confirms the "confidently wrong" one, so `choice` is
kept out of the question-type lane and left to its exact-schema lane.

Lowering `score` to 0.65 is free rather than a trade: coverage goes from 74.7%
to 97.5% with no new disagreement, and the Clopper-Pearson lower bound rises
(95.2 against 93.9) because the sample is larger.

At `score=0.65,noul=0.70` plus the state filter: **188 question units answered
locally, 187 agreeing with the teacher, CI [97.1, 100]**.

Question units are not the billing unit: the gateway sends every fallen-back
question of a request in one cloud call, so a request is only free when all of
its questions stay local. Per request, out of fold, with zero disagreements in
all three configurations:

| local lanes | requests fully local |
| --- | --- |
| `score,noul` gated, `choice` to the cloud | 22.3% |
| `score,noul` gated + profile lane ungated (chosen) | **38.1%** |
| every lane gated | 31.7% |

Neither lane had served traffic when this was decided: `JEV_PROVIDER` was
`zen`, so `makeLayaRouter` was never constructed. Switching the provider was
the go-live step for both lanes at once, which is why the profile lane's
accuracy was measured here rather than assumed from its earlier review.

Selective quantisation matters for this lane. Quantising the whole graph moves
logits by up to 2.82 and breaks the fitted temperatures, costing 60% of coverage
at T=0.80; quantising the encoder only and leaving the 15M decision layers in
fp32 holds 0.87 and matches fp32 coverage at T=0.70, at the same bundle size as
the published int8 bundle.

## Consequences

- About a third of `jev_evaluate` requests stop reaching the paid provider, with
  a measured lower bound of 97.3% teacher agreement on what stays local.
- `choice` rests on 28 out-of-fold units, lower bound 87.7%. It is the thinnest
  evidence here; a later corpus should re-measure it before the lane is widened.
- The lane's defaults are claims about a specific corpus. Only
  `scripts/laya-train.py` output may move them, per AGENTS.md
  "不把 confidence 當正確率；所有自動化門檻必須經目標資料校準". In-sample accuracy
  on the promoted bundle runs ~5pp optimistic, so the gate reads out-of-fold rows.
- Nightly labelling is pinned to the frozen int8 baseline. Pointing it at the
  trained bundle would make `local_answer` the model's own output and silently
  turn the next night's comparison into self-comparison.
- `choice` keeps its narrow exact-schema lane and gains nothing here.
- Policies remain cloud-only; nothing in this ADR touches `jev_apply_policy`.
- The nightly's export gate reads `live_gated` from the train report: the
  accuracy over exactly the rows the two live lanes would keep local (pilot
  qtypes above `CONF_MIN`, everything else behind the state filter). The
  all-qtype `coverage_curve` describes a configuration that is not deployed —
  it folds in a confidence-gated `choice`, which drags the number down and
  makes the floor measure a point no traffic sees.
- Two comparisons guard the export, after `mlflow`'s `MetricThreshold`:
  `JEV_LAYA_ACC_FLOOR` is an absolute floor, and `~/.jevgate/laya-champion.json`
  holds the incumbent's `live_gated` accuracy so a challenger that beats the
  frozen int8 baseline but regresses against what is already serving cannot
  replace it. The champion file is written only after a successful swap.
