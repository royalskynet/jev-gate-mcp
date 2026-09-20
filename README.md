# Jev Gate

A Claude Code plugin that prunes long tool output with a Jev (System One)
keep/drop judgment **before it reaches the model's context**.

Status: shipped. One function hook, live-verified end to end.

## What it does

`hooks/jev.js` hooks `tool.call` on `Bash`. It runs the command through
`next(e)`, and if the result's `stdout` is over 4,000 characters it splits it on
line boundaries and asks Jev, one Choice per chunk, whether that chunk helps the
user's current request. Dropped chunks are replaced by
`[jev-prune: dropped N lines]`; kept text is passed through verbatim, never
rewritten.

Measured on a 19,543-character noisy log with one real error line in the middle:

| | characters the model received |
|---|---|
| without the plugin | 19,543 |
| with the plugin | 30 |

One Jev call is ~343 in / 33 out tokens, $0.0000144, ~550 ms.

### Why a function hook and not a PostToolUse hook

A settings `command` hook on `PostToolUse` cannot rewrite a tool result: by the
time it runs, core has already recorded what the model will read. `tool.call`
can — it awaits `next(e)` and answers with its own `{ result }` (and no `ref`,
so core re-maps the pruned record rather than reusing its own messages).

Requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and Claude Code ≥ 2.1.274.

### Fail-open, deliberately

A missing key, a 4xx, a bad schema, a thrown judge — every one of them answers
`keep`, and the original output passes through untouched. A hook that overruns
its budget is skipped by the engine, which has the same effect.

That is also the failure mode that hides bugs: a wrong model id once made every
call 400 while three phases of tests still "passed". So the live tests assert
*positively* — output must measurably shrink, and a chunk of pure noise must
come back `drop`. Put `typesafe/jev-1.13.0` back in `hooks/jev.js` and they go
red.

## Install

```sh
npm install
claude plugin validate .
node --test              # 'live' tests need ~/.creds/kv/OPENROUTER_API_KEY.txt
```

Then register it as a local marketplace in `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "jev-gate": { "source": { "source": "directory", "path": "/path/to/jev-gate-mcp" } }
},
"enabledPlugins": { "jev-gate@jev-gate": true }
```

Or load it for one session: `claude --plugin-dir /path/to/jev-gate-mcp`.

Provider settings live at the top of `hooks/jev.js`: endpoint
`https://openrouter.ai/api/v1/systemone` (canonical
`POST /api/alpha/decisions`), model `typesafe/jev-1.13`, key read from
`~/.creds/kv/OPENROUTER_API_KEY.txt`.

## Also in this repo, not mounted

`plugin/` holds the Node-side experiments: `lib/judge.js`, `lib/route.js`
(deterministic prefilter + one open-world Jev Choice), `lib/gate.js` and
`hooks/gate.js` (a shadow-mode Stop/PreToolUse ghost-loop gate). They are
tested but deliberately not wired — see `docs/NEXT.md` for why.

## Documents

- [Product requirements](docs/prd/jev-decision-gateway.md)
- [Domain context](CONTEXT.md)
- [Architecture decisions](docs/adr/0001-governed-two-tool-mcp-boundary.md)
- [What is next](docs/NEXT.md)
