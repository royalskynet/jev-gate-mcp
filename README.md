# Jev Gate

> 繁中：若要把 Decision Gateway 接到 Claude Code 或 Codex，直接看
> [繁中接線與 Codex 快速指南](docs/zh-TW/README.md)。

## Three separate things live here

| | what it is | entry point | status |
|---|---|---|---|
| **Prune plugin** | a Claude Code plugin that shrinks long tool output before the model reads it | `hooks/jev.js` | shipped, live-verified |
| **Decision Gateway** | a local MCP server exposing exactly two governed decision tools | `gateway/src/stdio.js` | shipped as a **local stdio plugin**; policies run in shadow only |
| **Agent glue** | one shared core for five Jev uses, thin adapters for Claude Code *and* Codex | `agent-glue/src/` | shipped; **advisory only** while the policies stay uncalibrated |

They share a repo and a provider key, nothing else. The rest of this page is the
prune plugin; the gateway has its own [README](gateway/README.md), and the glue
has [`docs/agent-glue.md`](docs/agent-glue.md).

## Prune plugin

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

### Observability: the ledger

`$.ui.log` only reaches the TUI, not a file, so on a headless box the only
durable record of the hook is a ledger appended to `/Users/51mini/.openclaw/state/jev-prune.log`
(`$` has no append, hence read-then-write; `$.clock.now` for the ISO timestamp).
The ledger records **every judged-prunable call**, kept or dropped — not only
drops. It used to write only after a successful drop and swallow its own write
errors, so a hook that fired but judged everything `keep` left zero trace,
indistinguishable from a hook that never loaded. `appendLedger()` never throws,
so a broken ledger cannot stop the prune itself. A ledger line is evidence that
the hook fired; **it is not a calibration result** — `calibration_status`
stays `uncalibrated` until a labelled evaluation corpus exists.

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

## Agent glue: five Jev uses, two hosts

`agent-glue/src/` holds one testable core, shared verbatim by both hosts:

| | what it decides | contract |
|---|---|---|
| route | which candidate handles this turn | picks only from the given candidates; `no_match` when none fit; failure keeps the current model |
| triage | one request, three answers (`difficulty` / `kind` / `costly_mistake`) — plus an advisory `skill` Choice when a catalog is given — mapped to a cheap→medium→hard tier | one Jev call serves all of them; skill selection rides the same request (no extra call); dangerous text is regex-scanned whole (not the slice); risky / low-confidence / large-context never downgrade; transport failure keeps the status quo |
| compact | which tool call/result to drop or truncate | user/assistant prose passes through byte-for-byte; call/result stay paired; first and recent turns pinned |
| verify | `pass` / `fail` / `unknown` on a completion claim | `pass` needs auditable command/log evidence; no execution evidence means `unknown`, never `pass` |
| review | staged diff review | risk filter → file profile → evidence → mechanism → severity → reviewer route |

The `route` and `triage` glue paths are fully wired through `agent-glue/cli.mjs`
and `agent-glue/claude/bridge.mjs` (the old `route` stub with `cli-no-model` is
gone): with no live Jev model `route` fails open to `no_match` itself, and a
missing/empty candidate list is caught into a bounded `no-candidates` result
(exit 0). Skill selection rides the same single triage request — it never spawns
a second Jev call.

Two rules hold the whole thing up:

- **Any judge failure fails open for the whole pass**, not just the pair that threw.
  A broken judge can only leak context, never silently half-strip it. Same for a
  reduction below `minReductionChars`: the host gets the *original* messages back.
- **Jev never moves a deterministic outcome.** `deterministicSeverity()` literally
  does `void jevOpinion`. The opinion rides along on the result and lands in a
  ledger; severity and reviewer route are computed from the diff profile alone.
  While the five policies are `shadow` + `uncalibrated`, an uncalibrated judgment
  is not allowed to authorize or block anything.
  `tests/agent-glue/policy-shadow.test.js` turns red if anyone flips that.

Host differences are real and documented rather than papered over: a Claude
function hook can replace a tool result before the model reads it and can replace
built-in compaction; Codex can only block in `PreToolUse`, and its compaction side
is a **restoration layer** (`PreCompact` snapshot + `PostCompact` additionalContext),
not a replacement. Manifests stay in separate files — `hooks/hooks.json` for Claude,
`.codex/hooks.json` / `.codex-plugin/hooks.json` for Codex.

### The triage layer (money-saving judgment)

`triage` asks one Jev request several questions at once — `difficulty` (Score),
`kind` (Choice) and `costly_mistake` (Noul), plus an advisory `skill` (Choice
over the catalog + `no_match`) when a skill catalog is supplied — and
deterministic code maps them onto a cheap→medium→hard tier. The skill pick
rides the same request, so it never costs an extra Jev call and is advisory
only (never changes the model choice). It is wired on both hosts but is
strictly advisory and **opt-in** (`enabled:false` by default):

- **Claude**: `agent-glue/claude/spawn-hook.mjs` registers `agent.spawn`. When
  enabled (`JEV_TRIAGE_ENABLED=1`) **and** a transport is injected, it picks the
  subagent `model` by tier; with the default wiring it does nothing, so the
  subagent's model is never changed out of the box. A per-tier model can be set
  with `JEV_TRIAGE_MODEL_CHEAP/MEDIUM/HARD`.
- **Codex**: `UserPromptSubmit` runs the same triage but can't change the model,
  so it only emits a one-line advisory `additionalContext` notice and writes a
  bounded line to `codex-route.log`.

The money-saving gates all run before a Jev call: empty/pinned/no-tiers turns
are kept as-is without any request; a dangerous word list is regex-scanned over
the **full original** text (not the slice); overlong text is cut to the last
3/4 plus first 1/4 (`ask_chars`); a decision cache keys on the **context bucket**
so a small-context answer is never served to a large-context hit; and `features`
privacy mode (forced for a sensitive profile) sends only statistics, never the
original text. Every decision records one bounded ledger line. Fail-open holds:
any transport failure keeps the status quo and never guesses up or down.

This plugin does **not** register its own `session.compact`. If you also run the
external fast-jev compaction plugin, do not enable both — see
[`docs/agent-glue.md`](docs/agent-glue.md) for the migration.

```sh
npm run agents:acceptance   # plugin validate, full tests, build, gateway, both host smokes
```

## Also in this repo, not mounted

`plugin/` holds the Node-side experiments: `lib/judge.js`, `lib/route.js`
(deterministic prefilter + one open-world Jev Choice), `lib/gate.js` and
`hooks/gate.js` (a shadow-mode Stop/PreToolUse ghost-loop gate). They are
tested but deliberately not wired — see `docs/NEXT.md` for why.

## Documents

- [Gateway README](gateway/README.md) — the Decision Gateway MCP server (v2 SDK, two tools, stdio only)
- [Companion agent instructions](docs/agent-instructions.md) — when an agent should call the tools
- [Host Adapter contract](docs/host-adapter.md) — mandatory, host-enforced lifecycle gating
- [Product requirements](docs/prd/jev-decision-gateway.md)
- [Domain context](CONTEXT.md)
- [Architecture decisions](docs/adr/0001-governed-two-tool-mcp-boundary.md)
- [What is next](docs/NEXT.md)
- [Handoff 2026-09-21（繁中）](docs/HANDOFF-20260921.md) — **start here if you have no prior context**
- [Jev 十步操作手冊（繁中）](docs/zh-TW/PLAYBOOK.md) — the ten-step playbook mapped onto this repo, gaps included
- [Agent glue（繁中）](docs/agent-glue.md) — install / disable / observability per host, and the four effectiveness metrics
- [Agent skill](skills/jev-agent/SKILL.md) — the operating rules both hosts share
- [Dev log](docs/DEVLOG.md) — how this got built, and the traps that cost time
