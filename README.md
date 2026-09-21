# Jev Gate

> 繁中：若要把 Decision Gateway 接到 Codex 或正式部署，直接看
> [繁中上線與 Codex 快速指南](docs/zh-TW/README.md)。

A Claude Code plugin that prunes long tool output with a Jev (System One)
keep/drop judgment **before it reaches the model's context**.

Status: shipped. Three function hooks (Bash, Grep, Read), live-verified end to end.

## What it does

`hooks/jev.js` hooks `tool.call` on `Bash`, `Grep` and `Read`. It runs the call
through `next(e)`, and if the long string in the result is over that tool's
threshold it splits it on line boundaries and asks Jev, one Choice per chunk,
whether that chunk helps the user's current request. Dropped chunks are
replaced by `[jev-prune: dropped N lines]`; kept text is passed through
verbatim, never rewritten.

| tool | field pruned | threshold | criteria drop |
|---|---|---|---|
| `Bash` | `stdout` | 4,000 chars | noise, boilerplate, anything off-task |
| `Grep` | `content` (content mode) | 4,000 chars | matches from vendored, generated or fixture files |
| `Read` | `file.content` (text branch) | 12,000 chars | mechanical bulk only — minified code, base64, lock bodies |

Read is the cautious one on purpose: a Bash or Grep result is a *report about*
files, but a Read result *is* the file the model asked for by name, so its
criteria drop only bulk that carries no meaning to read, and say "when in doubt,
keep". Its threshold is 12,000 rather than something larger because core
token-caps a Read before the hook sees it — measured, 8,000 chars delivered for
a 207 KB log and 16,571 for a 114 KB base64 blob. A threshold above that cap is
a hook that can never fire, and fail-open would hide it.

What the model actually received, measured end to end in a real session:

| | without the plugin | with the plugin |
|---|---|---|
| Bash, 19,543-char noisy log with one error line | 19,543 | 30 |
| Read, 114 KB base64 blob | 16,571 (core's cap) | ~60 |
| Grep, 48 KB of vendored minified matches | ~13,000 | 138 |
| Read, `node_modules/send/index.js`, 20 KB of real source | whole file | whole file (control) |

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

### Registration is spelled out, not looped

`register` names `Bash`, `Grep` and `Read` one line each, and each hook slot is
a function literal, because `claude plugin validate` reads the source
statically: a loop variable leaves it reporting `tool.call{tool=tool}`, and a
factory call in the hook slot makes it refuse the module outright. A test
asserts the three registered names match the `TARGETS` table, which is what a
loop would have bought.

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

- [Gateway README](gateway/README.md) — the Decision Gateway MCP server (v2 SDK, two tools, stdio + HTTP)
- [Companion agent instructions](docs/agent-instructions.md) — when an agent should call the tools
- [Host Adapter contract](docs/host-adapter.md) — mandatory, host-enforced lifecycle gating
- [Product requirements](docs/prd/jev-decision-gateway.md)
- [Domain context](CONTEXT.md)
- [Architecture decisions](docs/adr/0001-governed-two-tool-mcp-boundary.md)
- [What is next](docs/NEXT.md)
- [Dev log](docs/DEVLOG.md) — how this got built, and the traps that cost time
