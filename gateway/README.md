# Jev Decision Gateway MCP (v2)

繁中快速上手、Codex 設定、Docker/Caddy 上線與 policy 啟用流程：
[`docs/zh-TW/README.md`](../docs/zh-TW/README.md)。

A governed MCP server exposing **exactly two tools** over the same Gateway Core,
served by both **stdio** and **Streamable HTTP**, built on the official
`modelcontextprotocol/typescript-sdk` **v2** (`@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, `@modelcontextprotocol/client`; the legacy
monolithic SDK package is not used). Schemas use **Zod v4**; production runtime
is **Node 22 or 24** (the container pins Node 22).

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
| `src/stdio.js` | v2 `serveStdio(factory)` entry |
| `src/http.js` | `/mcp` transport + auth, Host/Origin guards, limits, readiness, metrics, graceful drain |
| `src/policy-controls.js` | state projection/schema, digests, quality signals, deterministic canary |
| `src/host-adapter.js` | concrete lifecycle enforcement for in-process or MCP clients |
| `src/metrics.js` | low-cardinality Prometheus decision/HTTP/workflow metrics |
| `policies/*.json` | the four starter Policy Packs (data, not code) |
| `test/` | unit, conformance (stdio+HTTP equivalence, edge guards), opt-in smoke |

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

## HTTP surface

`src/http.js` mounts `/mcp` plus operational `/health`, `/ready`, and `/metrics`
(other paths → 404). It applies official SDK Host/Origin guards, Bearer auth,
request-body/rate/in-flight limits, and graceful signal-driven draining. A
non-loopback bind refuses startup without auth and an explicit host allowlist.
The same Gateway Core serves stdio and HTTP. Caddy/Docker production assets are
at repo root; see the Traditional Chinese deployment guide linked above.

## Codex

Project-scoped `.codex/config.toml` starts the stdio server and enables exactly
the two read-only tools with bounded output-token budgets. The server advertises
short initialization instructions so Codex can decide when *not* to spend a
tool call. Remote Codex clients can connect to the HTTPS `/mcp` endpoint with
`bearer_token_env_var`.

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
JEV_RUN_EVAL=1 node gateway/scripts/tool-eval.mjs                        # GPT/Claude tool-selection eval
```

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
