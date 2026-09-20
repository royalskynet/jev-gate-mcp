# Host Adapter contract

An MCP registration alone does not make a guarantee: it exposes a tool, and an
agent can decline to call it. **Mandatory** invocation is the responsibility of
the **Host Adapter** — integration code that maps application or agent lifecycle
events into gateway calls and **honors** the resulting Gate.

Host-enforced invocation is the only dependable form of gating for
consequential work. Agent-selected invocation (see
`docs/agent-instructions.md`) is best-effort and must never be the sole
control.

## When the host must call

The host calls `jev_apply_policy` (not `jev_evaluate` — the latter is advisory
and cannot authorize) at the following lifecycle boundaries:

1. **Before-action** — before a prepared shell command, file mutation, external
   API call, purchase, publication, or other consequential action crosses an
   execution boundary. The action must already be validated
   (schema, authorization, prerequisites) in code; Jev only judges risk.
2. **After-external-result** — after untrusted web, email, user-generated, or
   third-party MCP content enters the workflow, screen it for relevance and
   suspicious instructions before it steers behavior.
3. **Before-finish** — before the agent reports completion or makes claims
   about tests, deployment, or evidence; the claims must be checked against the
   supplied diff/test/log evidence.

## Honoring the Gate

The host must treat a non-`accept` Gate as an instruction to stop or route
elsewhere — never as a suggestion and never as an `accept`:

| Gate | Host behavior |
|---|---|
| `accept` | may proceed |
| `review` | pause for human/reviewer confirmation before the action |
| `escalate` | route to a human/approval path (or a domain owner); do not proceed on your own |
| `deny` | do not proceed; the result is fail-closed (provider failure, malformed/incomplete coverage, or a `deny` semantic outcome) |

Consequential decisions further require an **independent approval path**; the
gateway supplies semantic judgment only.

## Result fields the host branches on

Prefer `structuredContent` over parsing prose:

- `outcome` — `accept`/`review`/`escalate`/`deny`.
- `coverage` — `complete`/`incomplete`; incomplete coverage never `accept`s.
- `unavailable` — typed error on provider failure / malformed / timeout /
  rate-limit / auth. The host may then choose its own generative-model or human
  fallback — the gateway never invents one.
- `gate_reasons` / `semantic_level` — per-question basis so a reviewer knows why
  automation stopped.
- `model` — the resolved (pinned) model identity, for drift observability.

## Non-goals

The Host Adapter **does not** trust the gateway to authorize users, execute the
action, generate fallback text, or act as a universal injection firewall. Those
remain outside the gateway (PRD Out of Scope). Concrete vendor hooks (Claude
Code hooks, OpenAI tool middleware) are kept outside the core runtime so GPT and
Claude integrations share one policy behavior.
