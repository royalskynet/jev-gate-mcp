# Gateway Operations Runbook

Operational reference for the Jev Decision Gateway: breaker tuning, telemetry
schema, calibration/drift data contracts, live commands, and the raw-state
rule. All commands are offline / no-key unless tagged **live**.

## 1. Circuit breaker tuning

One process-wide breaker per provider is wired in `gateway/src/config.js`
(`makeBreaker`) and wrapped around the provider adapter so every request on that
gateway routes through it. Only **retryable** provider / timeout / rate-limit
failures open it; auth and invalid-request errors fail closed for the caller but
never trip the breaker (see `gateway/src/breaker.js`).

| env | default | meaning |
|---|---|---|
| `JEV_BREAKER_ERROR_THRESHOLD` | `60` | % of calls in the rolling window that must fail before the breaker opens |
| `JEV_BREAKER_VOLUME` | `5` | minimum calls before the breaker evaluates at all |
| `JEV_BREAKER_RESET_MS` | `30000` | time in `open` before one half-open probe is allowed |

Open / half-open / closed state is observable on every result and in telemetry
(`breaker_state`). In `open`, the policy returns a typed `unavailable` and never
`accept`s. Per-provider sensitivity is a config concern: a low-signal provider
can pass distinct values at wiring time.

## 2. Telemetry schema

Structured JSONL to **stderr** (never stdout — the stdio transport owns stdout),
via `gateway/src/telemetry.js`. Redaction is an **allowlist**: only these exact
top-level keys survive `record()`; everything else is silently dropped, so
state / questions / answers / API keys cannot leak regardless of input.

Sanctioned fields:

```
ts  level  event  correlation_id
tool  provider  resolved_model
policy  policy_version  mode  calibration_status  evaluation_dataset_version
latency_ms  usage_tokens_input  usage_tokens_output  estimated_cost
coverage  gate  shadow_outcome  error_class  error_code  breaker_state
eval_id  eval_dataset  eval_correct  eval_duration_ms
```

Env: `JEV_TELEMETRY=off` disables the sink; `JEV_TELEMETRY_LEVEL=warn` dampens.
Proof: `gateway/test/telemetry-canary.test.mjs` scans the actual bytes written to
the sink for a canary secret.

## 3. Calibration / drift data contracts

### Calibration (per released policy)

Every released policy version records `evaluation_dataset_version` and
`calibration_status` (`calibrated` | `uncalibrated`). The registry **rejects at
startup** any `active` policy whose `calibration_status !== 'calibrated'` —
uncalibrated confidence can never auto-accept. Active calibration is the ADR
minimal contract: shadow/review first, activation requires calibration. Callers
cannot override thresholds / model / mode via the strict input schema (schema
reject).

The four **starter policies ship `mode: shadow` + `calibration_status:
uncalibrated`** and name a `synthetic-harness-*` dataset: synthetic labels plus
generated matching answers can only exercise the harness, they cannot prove
model correctness. Consequently the gateway **caps any shadow or uncalibrated
policy's public `outcome` at `review` (never `accept`)**, reporting the raw
composed gate separately as `shadow_outcome` for observation only. Only real
target-domain labels (see Calibration CLI below) justify elevating a policy to
`active` + `calibrated`.

### Calibration CLI

`gateway/scripts/calibrate.mjs` reads an **external** JSON / JSONL file of
labeled outcomes + predictions, validates `policy` / `model` / `provider` /
`dataset-version` provenance against the registry, computes the metrics, and
emits a calibration report. It **never writes or mutates a policy file** and
therefore can never mark a policy calibrated; a `synthetic`/`demo` source or a
`synthetic-harness-*` dataset version is explicitly flagged `harness_only`.

```
node gateway/scripts/calibrate.mjs fixtures/calibration-external.jsonl \
  --policy completion-claims --model typesafe/jev-1.13-20260917 \
  --provider openrouter --dataset-version label-claims-v3
```

JSON / JSONL handling: a leading `{` is first parsed as a single JSON object;
only when that fails (trailing records) does the parser fall back to line-by-line
JSONL, extracting each record's optional per-record provenance and failing if the
records disagree (`stage: provenance`). Bare arrays and JSON objects take
provenance from file meta or CLI flags.

Thresholds are configurable (defaults below; CLI flags `--min-samples`
`--min-coverage` `--min-precision` `--min-recall` `--max-false-accept`
`--max-ece`, or `JEV_CAL_*` env vars):

| threshold | default | breach when |
|---|---|---|
| `min_samples` | 30 | n < 30 |
| `min_coverage` | 1.0 | coverage < 1.0 |
| `min_precision` | 0.6 | precision < 0.6 (accept class populated) |
| `min_recall` | 0.6 | recall < 0.6 (accept class populated) |
| `max_false_accept` | 0.2 | false_accept > 0.2 |
| `max_ece` | 0.2 | ECE > 0.2 |

The report carries `breaches` (each threshold crossed), `meets_thresholds`
(no breaches), and `eligible_for_review` (`true` only for **external**,
non-`harness_only` labels that meet every threshold). A real target-domain
dataset that is `eligible_for_review` is **still not calibrated** — it only
becomes eligible for a **policy-owner review**: a human must then edit the
policy's `mode` / `calibration_status` / `evaluation_dataset_version` by hand.
This CLI never writes a policy file and never sets `calibrated`.

Exit codes: **0** clean report meeting thresholds, **1** valid report with
threshold breaches, **2** parse / validation / provenance failure (invalid line,
mixed provenance, missing provenance).

Input shapes (JSON object with `samples`, bare JSON array, or JSONL) plus
invalid-input / provenance-mismatch / bad-metrics handling are covered offline by
`gateway/test/calibrate.test.mjs` and the acceptance fixtures.

### Drift CLI

```
node gateway/scripts/drift.mjs <baseline.json> <current.json>
```

Input files are arrays of `{ gate, confidence?, correct? }` records — the only
fields that cross the boundary. Raw runtime state is never saved or compared.
The report carries JS divergence, PSI, and a confidence-calibration shift.

- `status: pass` exit 0 — distributions agree within tolerance.
- `status: non-pass` exit 1 — JS > tolerance, PSI > tolerance, or calibration
  shift > 0.08. **Too few samples (< 30) is `non-pass`** — drift is unknown and
  must never silently pass.
- malformed file (not an array) → exit 2, hard error.

Fixtures: `gateway/test/evalkit.test.mjs` (stable / drifted / insufficient /
malformed) and `gateway/fixtures/drift-*.json` consumed by
`gateway/scripts/acceptance.mjs`.

## 4. Live commands (opt-in, key-gated)

Ordinary CI stays offline. Live smoke and tool-selection eval require a real
credential (the gateway reads it from the key file configured by env, never
from tool args) plus the opt-in flag.

One shared OpenRouter credential drives all live traffic. Jev/System One lives
over OpenRouter `POST /api/v1/systemone` (model `typesafe/jev-1.13`); the native
TypeSafe adapter is retained only for its offline contract fixture and optional
config — there is **no second TypeSafe key** and no independent TypeSafe live
path.

```
# Jev live smoke (typesafe/jev-1.13 via the single OpenRouter key)
JEV_RUN_SMOKE=1 node --test gateway/test/smoke-matrix.test.mjs

# GPT/Claude tool-selection eval (via OpenRouter chat-completions; agent-instruction eval only)
JEV_RUN_EVAL=1 node gateway/scripts/tool-eval.mjs
```

A smoke test with `JEV_RUN_SMOKE=1` but a missing OpenRouter credential skips
with a skip reason; it is never a failure of offline CI.

## 5. Raw-state rule

The gateway never persists or logs raw runtime state by default. Telemetry is an
allowlist; drift consumes only opaque `{ gate, confidence, correct }` records;
live eval records only `eval_id` / `eval_dataset` / `eval_correct` /
`eval_duration_ms` metadata. No state payload, question text, or answer text is
retained.

## 6. Offline acceptance

```
npm test && npm run build && npm run gateway:acceptance
```

`gateway:acceptance` (`gateway/scripts/acceptance.mjs`) re-runs the executable
CLIs offline: policy eval thresholds (coverage/precision/recall/false-accept/
review/Brier/ECE — accept-class metrics skipped for shadow/uncalibrated policies
by design), drift fixtures (stable→pass, shifted→non-pass, malformed→hard
error), tool-eval config validation (no key), calibration CLI fixtures
(external JSON + JSONL→pass/eligible, bad-metrics→non-pass, mixed/missing
provenance→provenance hard error, synthetic→harness-only, invalid→parse hard
error, never mutates a policy), and the processing-overhead p95 <50ms benchmark
(direct core + transport, deterministic no-I/O provider).
