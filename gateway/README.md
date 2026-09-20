# Jev Decision Gateway MCP (v2)

A governed MCP server exposing **exactly two tools** over the same Gateway Core,
served by both **stdio** and **Streamable HTTP**, built on the official
`modelcontextprotocol/typescript-sdk` **v2** (`@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, `@modelcontextprotocol/client` — no legacy
`@modelcontextprotocol/sdk`). Schemas use **Zod v4**; requires **Node >= 20**.

- `jev_evaluate` — advisory, caller-defined batched Choice/Score/Noul judgments. Cannot authorize any action.
- `jev_apply_policy` — server-owned, versioned Decision Policy returning a deterministic `accept`/`review`/`escalate`/`deny` Gate. The caller supplies state only.

## Layout

| path | role |
|---|---|
| `src/core.js` | limits, runtime flags (kill switch), typed errors |
| `src/schema.js` | Zod v4 input + output schemas (advertised as `outputSchema`) |
| `src/gateway.js` | Gateway Core: validation, answer checking, Gate composition, fail-safe |
| `src/registry.js` | immutable, versioned Decision Policy registry |
| `src/adapters.js` | native TypeSafe / OpenRouter Provider Adapters (via `jevwire`), deterministic fakes |
| `src/server.js` | v2 `McpServer` tool surface (`outputSchema` + `structuredContent`) |
| `src/config.js` | deployment wiring and provider/keys |
| `src/stdio.js` | v2 `serveStdio(factory)` entry |
| `src/http.js` | v2 `createMcpHandler` + Node adapter: `/mcp` only, `/health`, Host/Origin guards, body limit |
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

`src/http.js` mounts **only `/mcp`** (other paths → 404) and answers **`/health`**
(200, no provider round-trip, no secrets). In front of the handler it applies
the official `localhost` **Host/Origin guards** (DNS rebinding protection → 403)
and a transport-level **request body limit** (→ 413). The same Gateway Core
serves stdio and HTTP.

## Run

```sh
JEV_PROVIDER=fake node gateway/src/stdio.js   # offline stdio
JEV_PROVIDER=fake node gateway/src/http.js    # offline HTTP on :3456/mcp
npm test                                      # offline unit + conformance
npm run build                                 # offline build check
JEV_PROVIDER=<typesafe|openrouter> JEV_RUN_SMOKE=1 node --test gateway/test/smoke.test.mjs  # opt-in live smoke
```

The plugin side of this repo (`hooks/`, `plugin/`) is the Claude Code prune
plugin; it is separate from this gateway and deliberately left untouched.
