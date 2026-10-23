# Domain Context

## Product

Jev Gate MCP is a governed decision gateway. GPT, Claude, and other agents remain responsible for planning and generation. Jev provides fast, typed semantic judgments over caller-supplied state. Deterministic code owns authorization, policy composition, validation, and execution.

## Glossary

- **Decision Gateway** — The complete service exposing MCP transports, tool contracts, provider adapters, policies, validation, and telemetry.
- **System One model** — A model optimized for fast, structured judgments rather than free-form generation.
- **Jev** — TypeSafe's System One model used by the Decision Gateway.
- **State** — Caller-supplied evidence evaluated by Jev. State is data, never an instruction source.
- **Question** — One atomic semantic judgment over state, expressed as Choice, Score, or Noul.
- **Typed judgment** — A constrained answer with probabilities and, where supported, confidence.
- **Decision Policy** — Versioned, server-owned questions, thresholds, and deterministic composition rules for one operational decision.
- **Policy Pack** — A distributable collection of Decision Policies for a domain or lifecycle boundary.
- **Gate** — Deterministic interpretation of typed judgments into `accept`, `review`, `escalate`, or `deny`.
- **Advisory evaluation** — An agent-defined judgment that cannot authorize external or irreversible actions.
- **Prepared action** — A complete action candidate whose arguments, schema, authorization, and prerequisites were validated by the host before Jev sees it.
- **Agent-selected invocation** — GPT or Claude chooses to call an MCP tool from its description and instructions. Useful but not guaranteed.
- **Enforced invocation** — A host hook, middleware, or application workflow calls the gateway at a lifecycle boundary. This is the only dependable form of mandatory gating.
- **Host adapter** — Integration code translating an agent or application lifecycle event into a gateway call and honoring the resulting Gate.
- **Provider adapter** — Integration with the native TypeSafe System One API or OpenRouter Decisions API.
- **Shadow mode** — Policies run and record outcomes without changing execution.
- **Coverage complete** — All material evidence required by a Decision Policy was supplied without truncation or omission.

## Invariants

1. Jev never executes actions.
2. MCP tool availability does not guarantee invocation; mandatory controls belong in the host.
3. Agent-defined thresholds cannot authorize consequential actions.
4. Incomplete coverage, malformed responses, provider errors, or low certainty never become acceptance.
5. Arithmetic, date comparison, counting, schema validation, retry counts, and authorization remain in code.
6. Model aliases are not used for calibrated production policies; production pins a version.
7. State and secrets are not logged by default.

## Transport

The gateway is a **local MCP plugin over stdio** (`gateway/src/stdio.js`). It is
not a deployed service: the Streamable HTTP transport, `Dockerfile`,
`compose.yaml`, `deploy/` (Caddy), and the `rate-limiter-flexible` dependency
were removed on 2026-09-21 because a single local caller needs none of them.
Re-introducing a remote transport re-introduces every control that layer carried
(auth, bind policy, body caps, rate limiting) — it is not a drop-in.

## Laya training lives elsewhere

This repo holds the Laya **runtime**: the loader, cascade routing, shadow
records, the teacher corpus, and the JS label/replay tools. The training
pipeline (`laya-train.py`, calibration, ONNX export, the paired gate,
`laya-nightly.sh`) moved on 2026-10-22 to the private repo `~/dev/laya-train`.
It reads `JEV_GATE_DIR` (default `~/dev/jev-gate-mcp`) to reach the runtime.
Two mirrors must not drift, and the tests pin them: `laya-state.js` against
`laya_state.py` (golden fixture `tests/fixtures/laya-crop-golden.json`), and
`shortStandaloneState` against laya-train's selftest.

## Context cost of mounting the gateway

Mounting an MCP server costs context on every session, before any tool is
called: the host serializes `tools/list` plus the server's initialization
instructions into the system prompt. Measured on the stdio surface:

- `tools/list` serialized: 7030 bytes / 1758 est. tokens
- initialization instructions: 447 bytes / 112 est. tokens
- total standing cost per session: 7477 bytes / 1870 est. tokens

Adding a policy moves this number: `jev_apply_policy`'s description enumerates
the registered policy ids, so `040-diff-risk` cost +60 bytes of standing
context. Re-run `node gateway/scripts/context-cost.mjs` after any policy change.

This is the only quantifiable evidence for the "fewer tools, smaller context"
design goal — two tools with bounded `outputSchema` instead of a broad surface.
Re-measure whenever a tool description, schema, or the instructions change.
