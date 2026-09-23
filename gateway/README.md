# Jev Decision Gateway MCP (v2)

繁中快速上手、Claude Code / Codex 接線與 policy 啟用流程：
[`docs/zh-TW/README.md`](../docs/zh-TW/README.md)。

A governed MCP server exposing **exactly two tools** over the same Gateway Core,
served over **stdio** (the local plugin transport), built on the official
`modelcontextprotocol/typescript-sdk` **v2** (`@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, `@modelcontextprotocol/client`; the legacy
monolithic SDK package is not used). Schemas use **Zod v4**; production runtime
is **Node 22 or 24**.

- `jev_evaluate` — advisory, caller-defined batched Choice/Score/Noul judgments. Cannot authorize any action.
- `jev_apply_policy` — server-owned, versioned Decision Policy returning a deterministic `accept`/`review`/`escalate`/`deny` Gate. The caller supplies state only.

## Layout

| path | role |
|---|---|
| `src/core.js` | limits, runtime flags (kill switch), typed errors |
| `src/schema.js` | Zod v4 input + output schemas (advertised as `outputSchema`) |
| `src/gateway.js` | Gateway Core: validation, answer checking, Gate composition, fail-safe |
| `src/registry.js` | immutable, versioned Decision Policy registry |
| `src/adapters.js` | OpenRouter Provider Adapter (via `jevwire`); native TypeSafe kept for the offline contract fixture only (all Jev live rides the single OpenRouter key); deterministic fakes |
| `src/server.js` | v2 `McpServer` tool surface (`outputSchema` + `structuredContent`) |
| `src/config.js` | deployment wiring and provider/keys |
| `src/stdio.js` | v2 `serveStdio(factory)` entry (the only transport) |
| `src/policy-controls.js` | state projection/schema, digests, quality signals, deterministic canary |
| `src/host-adapter.js` | concrete lifecycle enforcement for in-process or MCP clients |
| `src/metrics.js` | low-cardinality Prometheus decision/workflow metrics |
| `policies/*.json` | the four starter Policy Packs (data, not code) |
| `test/` | unit, conformance (stdio surface), opt-in smoke |

## Gate composition (answer semantics AND confidence)

A Gate decision never looks at confidence alone. Each policy declares a
`mapping` from **answer semantics** to an outcome:

- **choice** → keyed by candidate (`no_match` → `escalate`, `review` → `review`, …)
- **score** → keyed by level index (`2` destructive → `deny`, `0` local → `accept`, …)
- **noul** → keyed by `true`/`false` (`supported=false` → `deny`, `credential=true` → `deny`)

For every question the more conservative of the **semantic outcome** and the
**confidence outcome** (thresholds) wins; across questions the most
conservative signal wins. A non-`advisory` consequence caps the result at
`review` — a consequential policy can never auto-`accept`. Incomplete,
malformed, or provider-failed results fail closed to `deny`, never fabricate an
`accept`.

The four **starter policies ship `mode: shadow` + `uncalibrated`** on a
`synthetic-harness-*` dataset: synthetic labels + generated matching answers can
only exercise the harness, not prove model correctness. So the gateway **caps any
shadow or uncalibrated policy's public `outcome` at `review` (never `accept`)**
and reports the raw composed gate as `shadow_outcome` for observation. A policy
is only elevated to `active` + `calibrated` from real target-domain labels (see
the calibration CLI).

## Pinned model

`jev_apply_policy` forwards each policy's immutable `spec.model` to the
Provider Adapter and records the resolved model on every result. The caller
cannot override it — the strict input schema rejects any model field.

## Kill switch

- **Global** — takes every policy and `jev_evaluate` out of service.
- **Per-policy** — takes exactly that one policy out; it is a targeted
  shutdown, never an exemption from the global switch and never a shutdown of
  other policies.

## Calibration corpus

Every starter policy ships `shadow` + `uncalibrated`, and `registry.js` refuses
to release an `active` policy that is not `calibrated`. Leaving shadow needs
labelled decisions — and `scripts/calibrate.mjs` already scores them (precision,
recall, ECE, false-accept, `eligible_for_review`). What was missing is the
producer of the file it reads.

Telemetry cannot be that producer: its allowlist deliberately drops state,
questions and answers so a log line can never leak them. So set
`JEV_CALIBRATION_LOG=<path>` to append one JSONL sample per `apply_policy`
decision, in exactly `calibrate.mjs`'s input shape — provenance plus `gate`,
`coverage`, `confidence`, and a `label: null` slot for the outcome the policy
*should* have produced. Unset (the default) writes nothing.

```sh
JEV_CALIBRATION_LOG=corpus.jsonl node gateway/src/stdio.js   # collect
# fill in "label" on each line
node gateway/scripts/calibrate.mjs corpus.jsonl              # score
```

`gate` is the **raw composed gate**, not the shadow-capped public outcome
(kept alongside as `public_outcome`): capping is a rollout control, not a
judgement the model made, so scoring against it would measure the fuse.

Two refusals are load-bearing and both come from `calibrate.mjs`: an unlabelled
corpus fails validation, and a policy's pinned model must match the samples'
`model`, so a `fake` provider run can never be passed off as calibration data. A
`synthetic-harness-*` `dataset_version` is likewise flagged harness-only — set a
real `evaluation_dataset_version` on the policy before collecting for real.

## Transport

The only supported transport is **stdio** — this is a local MCP plugin. The
former Streamable HTTP / Docker / Caddy layer (`src/http.js`, `Dockerfile`,
`compose.yaml`, `deploy/`, and the `rate-limiter-flexible` dependency) was
removed; a local plugin needs no remote service layer, and that layer was never
runtime-smoked.

## Claude Code

Register the stdio server once, at user scope:

```sh
claude mcp add jev_gate -s user \
  -e JEV_PROVIDER=openrouter -e JEV_MODEL=typesafe/jev-1.13 \
  -- node /absolute/path/to/jev-gate-mcp/gateway/src/stdio.js
```

The server name must come **before** the `-e` flags. `--env` is variadic, so a
name placed after them is swallowed as one more `KEY=value` token and the CLI
fails with `Invalid environment variable format`.

No key path is passed: `src/config.js` defaults `apiKeyFile` to
`~/.creds/kv/OPENROUTER_API_KEY.txt`. Policies resolve through `import.meta.url`
rather than `process.cwd()`, so the host may spawn the server from any
directory.

Verify with `claude mcp list` (expect `jev_gate` ✓ connected); `/mcp` inside a
session lists the two tools.

## Codex

Project-scoped `.codex/config.toml` starts the stdio server and enables exactly
the two read-only tools with bounded output-token budgets. The server advertises
short initialization instructions so Codex can decide when *not* to spend a
tool call.

## Run

Offline (ordinary CI, no keys):

```sh
npm test                     # offline unit + conformance (breaker/telemetry canary/calibration/drift/tool-eval config/bench)
npm run build                # offline build check
npm run gateway:acceptance   # offline acceptance: eval thresholds, drift fixtures, tool-eval config, p95<50ms bench
```

Opt-in live (key-gated; never required by offline CI):

```sh
JEV_RUN_SMOKE=1 node --test gateway/test/smoke-matrix.test.mjs          # Jev (typesafe/jev-1.13) live smoke, single OpenRouter key
JEV_PROVIDER=typesafe JEV_RUN_SMOKE=1 node --test gateway/test/smoke-matrix.test.mjs  # native TypeSafe path (no key in this repo → skips)
JEV_RUN_EVAL=1 node gateway/scripts/tool-eval.mjs                        # GPT/Claude tool-selection eval
```

The smoke matrix runs whichever provider `JEV_PROVIDER` names (default
`openrouter`, matching the only credential this repo ships). The example above
with `JEV_PROVIDER=typesafe` uses `jev-latest` against the native TypeSafe
endpoint but has no native key here, so it skips unless one is supplied.

### Native TypeSafe path does not honor policy date pinning

Policies pin `"model": "typesafe/jev-1.13-20260917"` — a **response** model id,
not a valid native **request** id. OpenRouter accepts it (it re-resolves to the
same Jev model), but native `api.typesafe.ai` only accepts `jev-latest` today;
any other id returns 400. `makeTypesafeAdapter` therefore strips the
`typesafe/` prefix and forces `jev-latest` at the adapter boundary — the policy
file and its digest are never rewritten, and nothing shared with the OpenRouter
path changes (where `typesafe/jev-1.13` is the correct request id). The only
audit record left after translation is the response's `model` field, surfaced
as `resolved_model` on the result. Do not pretend the native path honors the
pin; it does not.

Operational CLIs:

```sh
node gateway/scripts/eval.mjs                 # per-policy eval report (no key)
node gateway/scripts/drift.mjs <base.json> <current.json>   # drift report
node gateway/scripts/bench.mjs                # processing-overhead p95 benchmark
node gateway/scripts/calibrate.mjs <external-labels.jsonl>  # calibration report; EXTERNAL labels only, never mutates a policy or marks it calibrated
npm run gateway:replay                        # digest + safe/red-line deterministic replay
```

Calibration input accepts a single JSON object (`{ samples, ...provenance }`), a
bare array, or JSONL with per-record provenance. It checks configurable
thresholds (min samples, coverage, precision, recall, false-accept, ECE) and
reports `breaches`, `meets_thresholds`, and `eligible_for_review`. A real
target-domain dataset meeting every threshold is only **eligible for a
policy-owner review** — a human must still hand-edit the policy's
`mode` / `calibration_status` / `evaluation_dataset_version`; this CLI never does
so and never labels a policy `calibrated`. Synthetic/demo sources are always
`harness_only` + not eligible. Exit codes: 0 clean, 1 threshold breach, 2
parse/validation/provenance failure.

See `operations/runbook.md` for breaker tuning, telemetry schema, calibration /
drift data contracts, live commands, and the raw-state rule. Wheel/research
rationale is in `docs/research/issue-1-prior-art.md`.

The plugin side of this repo (`hooks/`, `plugin/`) is the Claude Code prune
plugin; it is separate from this gateway and deliberately left untouched.
