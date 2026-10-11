# Issue #1 Prior Art & Wheel Selection

Scope: production hardening for the Jev Decision Gateway MCP (circuit breaker,
telemetry, benchmark, tool-selection eval, drift, smoke matrix). In the original
Issue #1 phase, wheels were verified against stars, activity, and its then-current
Node >=20 floor. The 2026-09-21 deployment extension below adopts the renamed
Prometheus package and raises the supported production runtime to Node 22/24;
the reference container pins Node 22.

## Circuit breaker

| option | stars | adopted? | evidence |
|---|---|---|---|
| `nodeshift/opossum` @v9 | 1,688 (active 2026-08) | **yes** | Purpose-built Node breaker with `events`, `stats`, open/half-open/closed state. `engines: ^24 \|\| ^22 \|\| ^20` — **Node 20 compatible**. Chosen per task boundary. |
| `opossum` @v10 (unpublished main) | same repo | no | `main` package.json `engines: ^26 \|\| ^24 \|\| ^22` — **drops Node 20**. This is exactly why v9 is pinned, not v10. |
| `connor4312/cockatiel` | 1,821 (active 2026-09) | no | Viable (1,821★, comparator requested by task), but the task fixed opossum as priority; a mature, purpose-built, events/stats breaker already satisfies the requirement without adding a second breaker library. State machine, half-open recovery, and failure thresholds are delegated to the library (see `src/breaker.js`) rather than reimplemented. |

Decision: **opossum@9.0.0** (`gateway/src/breaker.js`). One process-wide breaker
per provider; only retryable provider / timeout / rate-limit failures open it
(auth/invalid-request fail closed for the caller but never trip the breaker).
`errorFilter` semantics verified from opossum source: returning `true` filters
the error OUT (counts as success); `false` counts a failure.

## Telemetry

| option | stars | adopted? | evidence |
|---|---|---|---|
| `pinojs/pino` | 18,209 | **yes** | First-class JSONL writer to a custom sink. `engines: {}` (engine-agnostic, current Node fine). `base: undefined` + custom destination = clean stderr lines. |
| `opentelemetry-js` | ~3,472 | no | Not forced in. The task scopes telemetry to one tiny structured interface (correlation id, tool/provider/model, policy metadata, latency, cost, gate, error class, breaker state). Pino satisfies that without an agent, a collector contract, or a heavier dependency tree. OTel adds real value only when a collector/back-end exists, which is out of MVP scope. |
| hand-rolled JSON logger | — | no | YAGNI: stdlib has no structured JSONL logger, but Pino is already the smallest maintained answer; writing one invites formatting/redaction bugs. |

Decision: **pino@10.3.1** (`gateway/src/telemetry.js`). Default sink is **stderr**
(never stdout — the stdio MCP transport owns stdout for JSON-RPC). Redaction is
an **allowlist**, not a blocklist: `record()` emits only explicitly named fields
and silently drops everything else, so a caller can never leak state, questions,
answers, or API keys no matter what object it passes. Covered by
`gateway/test/telemetry-canary.test.mjs` (scans the actual bytes written to the
sink with a canary secret).

## Benchmark

| option | stars | adopted? | evidence |
|---|---|---|---|
| `tinylibs/tinybench` | 2,378 | **yes** | Micro-benchmark harness, `engines: node >=20.0.0` in installed 6.2.0. `benchmark` handles warmup/sample collection deterministically. |
| `simple-statistics/simple-statistics` | 3,521 | **yes** | Statistics over the samples (p95/p99/median), engine-agnostic. |
| `autocannon` | 8,520 | no | HTTP load tester — the wrong tool for processing-overhead: it measures full HTTP round-trips (which mix in network/provider latency) and its built-in percentiles do **not** expose p95 the way the acceptance requires. We need a deterministic no-I/O provider with warmup + many samples and separate direct-core vs transport p95. |

Decision: **tinybench@6.2.0** + **simple-statistics@7.12.0**
(`gateway/lib/bench.mjs`, `gateway/test/bench.test.mjs`). Provider latency is
never in the sample (deterministic adapter); direct core and full transport are
reported separately; p95 < 50ms for both is asserted.

## Tool-selection eval

| option | stars | adopted? | evidence |
|---|---|---|---|
| `promptfoo/promptfoo` | 25,315 (active 2026-09) | no (evaluated) | The standard prompt/eval runner (used by OpenAI and Anthropic). Investigated first per the task. Not adopted: wiring it in is a heavyweight dependency + CLI surface for a single, narrow decision (does the model select one of two tools or `none`). A promptfoo config could be written, but it would pull in a parallel config/dataset/runtime just to assert "one token ∈ {jev_evaluate, jev_apply_policy, none}". |
| `promptfoo` Node20-pinned | — | no | Even a Node20-pinned promptfoo adds a large dependency tree and its own lifecycle for a decision better expressed as one small runner. |
| small runner | — | **yes** | `gateway/scripts/tool-eval.mjs`: an offline-validated dataset (positive + negative cases) and an opt-in (JEV_RUN_EVAL=1) live loop that asks each model for a single-token tool choice via OpenRouter chat-completions and asserts >=95% correct selection. |

Decision rationale recorded in `gateway/scripts/tool-eval.mjs`: this is an
agent-instruction eval (does the model know *when* a Jev call is appropriate),
not a Jev judgment — it deliberately uses chat completions, which the gateway
itself never uses for its own decisions. The dataset/config is validated
offline with **no key** (`gateway/test/tool-eval-config.test.mjs`); the live,
key-costing half stays opt-in.

## Drift CLI (no wheel)

Outcome/choice distribution comparison (Jensen-Shannon divergence + PSI) and a
confidence-calibration shift are ~80 lines of deterministic math implemented
directly in `gateway/lib/evalkit.mjs`. JS-divergence and PSI are both standard,
documented closed-form metrics with no maintenance-worthy dependency. A
statistics wheel would only add a surface for two formulas we implement and
test. Adopted: none (stdlib math). Covered by `gateway/test/evalkit.test.mjs`
(stable / drift / insufficient / malformed fixtures) and the drift CLI
(`gateway/scripts/drift.mjs`).

## Smoke matrix (no new wheel)

Live smoke reuses the existing `jevwire` dependency (OpenRouter Decisions)
already in the project. **One shared OpenRouter credential drives all live Jev/
System One traffic** (`typesafe/jev-1.13` over OpenRouter `POST
/api/v1/systemone`); there is no independent TypeSafe key or TypeSafe live path.
The native TypeSafe adapter is retained only for its offline contract fixture
and optional configuration. No new wheel.

## Calibration (external labels only; item 3/5)

The four starter policies ship `mode: shadow` + `uncalibrated` on a
`synthetic-harness-*` dataset. Synthetic labels plus generated matching answers
can only exercise the harness — they cannot prove model correctness, so they
never justify marking a policy calibrated. Calibration now comes only from real
target-domain labels fed to `gateway/scripts/calibrate.mjs` (validates
policy/model/provider/dataset-version, computes metrics, and never mutates a
policy file). The gateway caps any shadow/uncalibrated policy's public `outcome`
at `review`, exposing the raw gate as `shadow_outcome`.

## Summary of adopted wheels (all already in `package.json`)

- `opossum@^9.0.0` — circuit breaker (Node20-compatible; v10 needs Node22 and is the documented reason v9 is pinned)
- `pino@^10.3.1` — structured telemetry to stderr with allowlist redaction
- `tinybench@^6.2.0` — processing-overhead benchmark samples
- `simple-statistics@^7.12.0` — benchmark percentiles
- (existing) `jevwire` — provider adapters / smoke matrix

Rejected after verification: `cockatiel`, `opentelemetry-js`, `autocannon`,
`promptfoo`, and any hand-rolled breaker / logger.

## Queries tried

- `gh repo view nodeshift/opossum|connor4312/cockatiel|tinylibs/tinybench|simple-statistics/simple-statistics|promptfoo/promptfoo` (stars + activity)
- opossum `main` vs `v9` `package.json` `engines` (Node20 compatibility check)
- `npm view autocannon` (why not adopted)

## 2026-09-21 deployment / decision-control extension

Current stars and package activity were rechecked before adding dependencies:

| concern | wheel | stars | decision |
|---|---|---:|---|
| JSON Schema + minimum-state validation | `ajv-validator/ajv` / `ajv@8.20` | 14,837 | Adopted. Policy-owned JSON Schema; a tiny deterministic top-level allowlist performs projection before Ajv validation and before provider egress. |
| request rate limit | `animir/node-rate-limiter-flexible@11.2` | 3,586 | Adopted, then **removed 2026-09-21** with the HTTP transport. A stdio plugin has one local caller and no request queue to protect. Re-adopt only if a remote transport comes back. |
| Prometheus metrics | `prometheus/client_js` / `@prometheus-io/client@0.16` | 3,489 | Adopted current package. The former `prom-client` name is deprecated, so it was removed before commit. Current package requires Node 22/24/26+, and the production image pins Node 22. |
| TLS / reverse proxy | `caddyserver/caddy` | 75,893 | Adopted as deployment glue: automatic HTTPS, upstream health checks, compression, security headers. Gateway remains the auth/rate/concurrency enforcement point. |
| stable digest | third-party stringify/hash packages | <=1,474 | Rejected. Node `crypto` plus a small key-sorted JSON encoder is less supply chain for a narrow, fully tested policy digest. |
| in-flight rejection / canary cohort | generic queues | — | Rejected. These are short safety invariants (reject, never queue; deterministic SHA-256 cohort), not general scheduling problems. |

OpenTelemetry was reconsidered (~3,472 stars), but a collector/back-end is still
not part of this repo. Prometheus metrics plus the existing Pino allowlisted
JSONL cover immediate deployment and can be scraped/shipped by any platform.
Adding OTel without a collector contract would add configuration surface rather
than operational evidence.
