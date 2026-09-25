# Jev Gate

**English** · [繁體中文](README.zh-TW.md)

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
threshold it splits it on line boundaries and asks Jev whether each chunk helps
the user's current request — **all chunks in one request**, one Choice question
per chunk, because independent questions over the same state belong in a single
call. Dropped chunks are replaced by `[jev-prune: dropped N lines]`; kept text
is passed through verbatim, never rewritten. At most `CONFIG.maxJudgedChunks`
(8) chunks are judged per call — roughly 128 KB; anything past that is passed
through unjudged and, in particular, never truncated, so a very large output
loses nothing it would otherwise have kept.

A `drop` is only acted on when the answer's own `probabilities.drop` clears
`CONFIG.minDropProbability` (0.7) **and** the deterministic keyword veto below
lets it through. The floor is on the probability, not on
Choice `confidence`: batching spreads the distribution, and the same noise chunk
that answers `drop` 0.98 / confidence 0.96 on its own came back `drop` 0.63 /
confidence 0.25 next to a sibling chunk — a floor on `confidence` vetoed every
real drop and looked exactly like a hook that never loaded. Vetoed drops are
counted into the ledger line (`N unsure drops vetoed`) so a floor that is too
high stays visible instead of silently turning pruning off.

The 0.7 is measured, not chosen: `node scripts/calibrate-prune.mjs <corpus.jsonl>`
replays hand-labelled chunks of this machine's own tool output through the exact
request the hook sends and sweeps the threshold over the labels (8 cases / 17
chunks / ~$0.006 a sweep). Obvious drops come back 0.86-1.00, but the expensive
case is a chunk that is mostly noise with the answer buried in it: a real 16 KB
chunk holding one `ERROR` line among 200 heartbeats scored 0.47-0.62 across runs.
0.6 saved 48.5% of the bytes and destroyed that answer on a bad roll; 0.7 saves
29.3% and never did. A destroyed answer costs more than a kept dump.

Two rules sit in code, in front of the model, because the model alone was
measured to be wrong:

* **No request, no prune.** Every criteria row is written relative to the user's
  task, so with no task there is nothing to judge against and `pruneCommand`
  answers `no-request` instead of guessing. The Hermes middleware used to pass
  the tool's own shell command as a stand-in; judged against `cat log`, a 40 KB
  file the task was entirely about came back 99.8% dropped. Hermes now binds the
  turn's real request into the middleware context as `user_request` — not
  `request`, which `_run_execution_chain` treats as the dispatch *payload*, so a
  `request=` kwarg would hand the tool the user's sentence in place of its
  arguments. A subagent thread starts with an empty context and therefore
  declines rather than judging against the main agent's task.
* **Keyword veto** (`vetoOnTerms`). A `drop` is held as `unsure` when the chunk
  carries a *discriminating* term from the request — one that some but not all
  chunks contain. A term every chunk shares says nothing about which to keep, so
  it is ignored; with a single chunk any hit counts. This catches the model's one
  reproducible blind spot (a `git log --stat` chunk answered `drop` 0.92 /
  confidence 0.84 for a question about which commits touched a path).

| tool | field pruned | threshold | criteria drop |
|---|---|---|---|
| `Bash` | `stdout` | 16,000 chars | noise, boilerplate, anything off-task |
| `Grep` | `content` (content mode) | 16,000 chars | matches from vendored, generated or fixture files |
| `Read` | `file.content` (text branch) | 16,000 chars | mechanical bulk only — minified code, base64, lock bodies |

Every threshold is `CONFIG.chunkChars`, and that is the ledger's verdict rather
than a tidy number. `~/.openclaw/state/jev-prune.log` holds 19 real prune calls
on this machine: **one** of them dropped anything — a 44 KB Bash dump that
produced all 28,015 saved chars — and the other 18, including three Reads of
12-13 KB, dropped nothing at all. Below one chunk the judge is asked to drop the
whole output or keep it, and an output that fits in one chunk usually does hold
the answer, so `keep` is the right answer. Replaying those real sizes:

| threshold | calls | chars saved |
|---|---|---|
| 4,000 | 19 | 28,015 |
| 12,000 | 8 | 28,015 |
| **16,000** | **3** | **28,015** |
| 32,000 | 1 | 28,015 |

16,000 cuts Jev calls by 84% for 0% of the measured savings. 32,000 costs no
more on this corpus but is one call wide — no margin the day output lands
between the two — so the threshold sits on the structural boundary instead: one
chunk is the smallest output in which a partial drop can exist.
`tests/jev.test.mjs` pins `thresholdChars >= chunkChars`.

What the ledger settles is the *relation* — a threshold of one chunk — not the
number. `chunkChars: 16000` has shipped since the first commit and has never
been swept on its own; moving it moves all three thresholds with it, so it is a
`scripts/calibrate-prune.mjs` question, not an edit.

The raise gave up a band: 8-16 KB of output that used to be judged and no longer
is. Those calls leave no trace by construction, so `prune` temporarily writes a
`jev-skip` line for output that clears half a chunk but not the threshold, and
`node scripts/prune-verdict.mjs` splits the ledger at the cutover to print
before/after hit rates plus those skipped sizes as chunk-relative bands. The hit
rate is arithmetic — dropping calls that never dropped anything raises it by
itself — so the band is the evidence: a fat one argues for 12,000, a thin one
settles 16,000. Both the logging and this paragraph come out at that verdict.

Read is still the cautious one: a Bash or Grep result is a *report about* files,
but a Read result *is* the file the model asked for by name, so its criteria
drop only bulk that carries no meaning to read, and say "when in doubt, keep".
It now lives in a thin band, squeezed from both sides by measurement — at least
one chunk below, and core's own token cap above (measured delivery: 8,000 chars
for a 207 KB log, 16,571 for a 114 KB base64 blob). A threshold above that cap
is a hook that can never fire, and fail-open would hide it, so
`tests/hook.live.test.js` pins both edges.

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

Requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and Claude Code ≥ 2.1.274 — the
version of the binary actually running the session (`$CLAUDE_CODE_EXECPATH`), which is
not necessarily the `claude` on `PATH`. Below 2.1.274 the module is not refused, it is
never loaded, and nothing in this repo can tell you so; see “An empty ledger” below.

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
durable record of the hook is a ledger appended to `~/.openclaw/state/jev-prune.log`
(`$` has no append, hence read-then-write; `$.clock.now` for the ISO timestamp).
The ledger records **every judged-prunable call**, kept or dropped — not only
drops. It used to write only after a successful drop and swallow its own write
errors, so a hook that fired but judged everything `keep` left zero trace,
indistinguishable from a hook that never loaded. `appendLedger()` never throws,
so a broken ledger cannot stop the prune itself. A ledger line is evidence that
the hook fired; **it is not a calibration result** — `calibration_status`
stays `uncalibrated` until a labelled evaluation corpus exists.

### An empty ledger is a symptom with six causes

A ledger that gains no lines looks the same from the outside whatever the
reason. Check in this order; each step is one command and rules out everything
above it. `npm run probe:ledger:e2e` walks the whole thing in one command: it
writes the fixture, runs `claude -p --debug --plugin-dir .` against it headless
and diffs the ledger, so nobody has to reopen an interactive session to find out.

1. **The host is a different binary than you think.** `claude --version` reports
   whatever is on `PATH`, not what is running the session you are inside. A
   wrapper (Happy, an IDE extension, any SDK embed) ships its own copy:
   `$CLAUDE_CODE_EXECPATH` names it and `"$CLAUDE_CODE_EXECPATH" --version` is
   the number that matters. Measured here: 2.1.263 inside the wrapper while
   `PATH` had 2.1.278 — two days of an empty ledger that read as a threshold
   problem.
2. **The module was refused, and `validate` said it passed.** `hooks/index.js`
   is one aggregator: a single static-analysis error anywhere under it refuses
   the whole module, so the prune hook goes with it. `claude plugin validate .`
   takes the marketplace branch whenever a `marketplace.json` is present and
   never looks at the hooks module at all — that `✔` is about the catalogue.
   Use `npm run validate:hooks`, which moves the file aside and restores it on
   exit. Measured here: `$.ui?.log?.()` in two agent-glue hooks refused the
   module for days behind a green marketplace `✔` (`$.ui` read as a value; `$`
   is only ever spelled `$.noun.event(...)`, so the optional chaining is what
   broke it, not the call).
   Also check *which copy* is running: a plugin installed from a marketplace
   lives in `~/.claude/plugins/cache/<name>/<name>/<version>/`, keyed by
   version, so editing the source repo changes nothing and `plugin update`
   answers "already at the latest version" until the version is bumped. A
   plugin whose `settings.json` entry has a local `path` runs from the repo
   itself and has no such copy.
3. **The module threw at load, and nothing that asks "is it installed" can
   tell.** A hooks module has no Node: `process` is a `ReferenceError` there,
   and since `hooks/index.js` is one aggregator, a single `process.env` at
   module scope takes all seven hooks down before any of them registers.
   `validate` passes — it reads the shape of the `$` calls, not what else the
   source names. The one instrument that says so is `claude --debug`, one line
   in `~/.claude/debug/<uuid>.txt`:

   ```
   [ERROR] hooks module jev-gate@inline failed to load:
           ReferenceError: process is not defined
   ```

   Measured here: two days of an empty ledger while the binary, the flag, the
   key file and `validate:hooks` all answered yes. Every environment read now
   goes through `agent-glue/claude/env.mjs` — `ENV` is `process.env` under Node
   and an empty object in the hook, which each module's own `hydrate($)` fills
   from `$.env.get('NAME')` on first use. `tests/no-node-globals.test.mjs`
   fails if any file in the load chain names a Node global again.
4. **Function hooks are off.** `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` has to be in
   that binary's environment, not only in a shell profile it never sourced.
5. **The output never reached the threshold.** Core persists Bash and Grep
   results over ~8 KB to `tool-results/<id>.txt` and substitutes a ~2 KB
   preview, so a 179 KB command used to arrive at the hook as 2 KB and no
   threshold in TARGETS was reachable on those two tools. `resolvePersisted()`
   now reads that file back before judging, and the write-back is capped at one
   chunk — above it core's blind preview is the smaller of the two and is left
   in place. The wrapper's shape is core's, not a contract, so probe with `Read`
   anyway: a Read result is delivered whole (18,060 chars measured) and does not
   depend on that parse holding.
6. **The key file is unreadable.** Then the ledger says so, one
   `jev-nokey(<tool>)` line per session. No such line means this was not it.

And a seventh, the CLI path: **the CLI never writes the hook ledger.** A run of
`cli.mjs prune` writes its own `~/.openclaw/state/jev-prune-cli.log` (tagged
`jev-cli(...)`, redirectable via `JEV_CLI_LEDGER`) — by design, so the hook
liveness probe reads a CLI run as nothing. A CLI run only proves the judge
loaded; it does **not** prove the hook loaded. An empty hook ledger with a busy
CLI ledger is the "hook never loaded" signal, not a healthy state.

1 to 4 leave no trace anywhere by construction, which is why they come first:
every instrument in this repo lives *inside* a hook that was never loaded. The
debug log is the exception, and the only one — it is written by the engine, not
by the plugin, so it still speaks when the module never ran.

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

**Route reads the candidate descriptions off disk.** A Jev Choice over bare ids
(`graphify`, `to-issues`, `diagnose`) is a guessing game: measured at 2/4, the
same four cases score 4/4 once each candidate carries one sentence. The sentence
already exists — it is the `description:` in a skill's SKILL.md frontmatter — so
`agent-glue/src/catalog.js` reads it and both CLI entry points fill
`descriptions` for any candidate the caller did not describe. A caller keeps
passing ids; route stops guessing. Explicit `descriptions` still win, `null`
forces bare labels, and an id with no doc simply stays bare. Search path:
`./skills`, `./.claude/skills`, `~/.claude/skills`, `~/.claude/plugins/*/skills`
— override with `JEV_ROUTE_CATALOG_DIRS` (colon-separated).

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

**Shadow mode now collects the evidence it needs to end.** Shadow is only useful
if the samples it produces can be scored, so the corpus sink ships on: every
`apply_policy` appends one JSONL record to
`~/.openclaw/state/jev-calibration/<policy>.jsonl` — one file per policy, because
`calibrate.mjs` requires per-record provenance to agree and `policy` is one of
those fields, so a shared sink is unscoreable however much traffic it holds
(`JEV_CALIBRATION_LOG=<path>` moves it, the literal `off` stops it). Each record
carries the raw `gate` *and* the shadow-capped `public_outcome`, plus `label: null`
for a human to fill in — `gateway/scripts/calibrate.mjs` refuses an unlabelled
file, so an untouched corpus can never be mistaken for evidence. A sample's
`dataset_version` is `live-<policy>-v1`: stamping the spec's `synthetic-harness-*`
fixture version here made `harnessOnly()` mark every live record permanently
ineligible, i.e. the collection could never have led anywhere.

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
only (never changes the model choice).

**It activates on situation, not on a flag, and the ladder ships.**
`triageEnabled()` is true as soon as any per-tier model is configured, and
`DEFAULT_TIER_MODELS` configures all three out of the box:

| tier | default model | what lands here |
|---|---|---|
| `cheap` | `haiku` | mechanical work: a rename, a file search, a status read |
| `medium` | `sonnet` | ordinary implementation: write code, edit, debug |
| `hard` | `opus` | architecture, deep multi-file analysis, anything risky |

That is the same split the community model-routing hooks converged on
([tzachbon/claude-model-router-hook](https://github.com/tzachbon/claude-model-router-hook),
[AqueGen/model-routing](https://github.com/AqueGen/model-routing)); the
difference is that the tier comes from one Jev judgment rather than local
keyword heuristics. Override a tier with `JEV_TRIAGE_MODEL_CHEAP/MEDIUM/HARD`;
the literal `off` drops that tier back to the parent's model, and all three
`off` turns the hook off by the same rule. `JEV_TRIAGE_ENABLED=1` forces it on,
`=0` is the escape hatch.

The layer used to ship with an empty map, which made the auto rule resolve to
"off" on every machine: an enabled-looking hook that could not move a model
whatever Jev answered. Defaults are what put it on the wire.

- **Claude**: `agent-glue/claude/spawn-hook.mjs` registers `agent.spawn` and
  picks the subagent `model` by tier. It injects the live gateway itself
  (`agent-glue/src/live.js`); with no provider key the transport is `null` and
  the triage fail-opens to the status quo, so a missing key changes nothing.
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

### Fast compaction (`session.compact` + `turn.complete`)

`agent-glue/claude/compact-hook.mjs` folds the fast-jev-compaction capability
into this plugin. "Fast" means two things: compaction fires on a **context
percentage** (`JEV_COMPACT_AT_PERCENT`, default 60) rather than at the wall, and
one System One judgment per tool call/result pair (~350 in / ~35 out tokens,
~500 ms) decides what goes — there is no summarisation pass, so what survives is
**byte-for-byte** what was there.

| knob | env | default |
|---|---|---|
| trigger point | `JEV_COMPACT_AT_PERCENT` | 60 (% of context) |
| reduction floor | `JEV_COMPACT_MIN_REDUCTION` | 4,000 chars |
| pinned recent turns | `JEV_COMPACT_PIN_LAST` | 6 |
| payload head shown to the judge | `JEV_COMPACT_ASK_CHARS` | 1,200 |
| off switch | `JEV_COMPACT_ENABLED=0` | on |

The contract is `agent-glue/src/compact.js` and is not tuning: user/assistant
prose is never dropped or truncated, a dropped call and its result go together,
the first and the most recent turns are pinned, and a judge failure or a
below-floor reduction hands the host its **original** messages back so built-in
compaction runs. Fail-open here means "keep the context".

`compactMessages` shows the judge names and sizes only (`judgeHeadChars: 0`) by
default; the hook opts in to a bounded head, because "is this `npm ls` output
still needed" is not answerable from a tool name.

**Do not run this and the standalone fast-jev-compaction plugin at once.** Two
`session.compact` registrations answering one event is undefined. This one
yields: at `session.start` it reads `~/.claude/settings.json`, and if
`fast-jev-compaction@…` is still enabled it stands down and says so in
`~/.openclaw/state/jev-compact.log`. Disable the standalone plugin to let this
one run.

```sh
npm run agents:acceptance   # plugin validate, full tests, build, gateway, both host smokes
```

## Measured, live

`scripts/live-probe.mjs` runs every capability against the real provider and
reports three things per row: did it *reach* Jev at all (a fail-open looks
exactly like success from the outside), how many cases it got right, and by how
much it changed the outcome. Last run, 2026-09-22:

| capability | live | correct | ms | measured degree |
|---|---|---|---|---|
| prune (`hooks/jev.js`) | yes | 2/2 | 468 | mixed chunk 39,418 → 16,028 (59% cut, signal line kept); pure noise 39,379 → 92 (100% cut) |
| route (bare labels) | yes | 2/4 | 2383 | labels alone are not enough |
| route (+ descriptions) | yes | 4/4 | 2773 | a hand-written `descriptions` map took it to 4/4 |
| route (bare skill ids) | yes | 2/4 | 2141 | same 2/4 ceiling with real skill ids and no catalog |
| route (auto catalog) | yes | 4/4 | 2453 | 4/4 ids described straight out of SKILL.md — 2/4 → 4/4 with no caller change |
| triage | yes | 3/3 | 1592 | 3/3 tiers right, 0/3 fell back to status quo, cache populating |
| spawn hook (ambient) | yes | 3/3 | 1283 | 3/3 spawns had their model changed: `cheap→haiku`, `hard→opus`, risky `hard→opus` |
| compact | yes | 1/1 | 727 | 29,117 → 1,407 chars (95%), prose verbatim |
| verify | yes | 3/3 | 348 | verdict stays deterministic; Jev is advisory |
| review | yes | 1/1 | 415 | severity `medium`/route `peer` while Jev said `high` — deterministic unmoved |
| gateway `jev_evaluate` | yes | 2/2 | 343 | coverage `complete`, 382 in / 66 out tokens |
| gateway `jev_apply_policy` | yes | 5/5 | 1869 | all five policies answer, all pinned `shadow` + `uncalibrated` |

The `spawn hook (ambient)` row is the one that says the layer is *on*: no
injected transport, no forced flag, ambient environment only — exactly what a
subagent spawned right now gets. It read `3/3 status-quo / inherit` until the
tier ladder shipped.

The probe is the reason three live-wiring defects are fixed rather than latent:
the gateway transport keyed its answers by array index so `triage` never saw
them, `makeScorer` sent Jev bare labels with `null` criteria, and the spawn hook
never injected a transport — each one passed its unit tests, because the fake
transport had the shape the real one did not.

```sh
node scripts/live-probe.mjs   # needs a provider key; costs a few cents
```

## Other hosts: openclaw and Hermes

Both are installed and live on this machine. What is portable is decided by what
each host's hook contract lets a plugin *change*, not by what the capability is:

| capability | Claude Code | openclaw | Hermes |
|---|---|---|---|
| prune (rewrite a tool result) | `tool.call` | ✗ — `tool_result_persist` is synchronous (an async handler's result is logged and discarded), `after_tool_call` observes | `tool_execution` middleware |
| fast compaction | `session.compact` | ✗ — `before_compaction` / `after_compaction` observe only | not wired (an `llm_request` middleware could carry it) |
| triage (model routing) | `agent.spawn` | `before_model_resolve` → `providerOverride` / `modelOverride` | not wired (`llm_request`) |
| gate (block a call) | `PreToolUse` | `before_tool_call` | `pre_tool_call` — blocking contradicts shadow mode, so not wired |

### openclaw: `integrations/openclaw/` (plugin id `jev-gate`)

One triage per turn on `before_model_resolve`, **downgrade-only**: only the
`cheap` rung is wired into the model map, so a `medium`/`hard` verdict resolves
to `no-model-map` → status quo. A wrong downgrade costs one weak answer; a wrong
upgrade silently bills the expensive model on every ambiguous turn.

```sh
openclaw plugins install --link ./integrations/openclaw --force --accept-capabilities
openclaw plugins enable jev-gate --accept-capabilities
# Non-bundled plugins may not touch conversation hooks until this is granted:
openclaw config set plugins.entries.jev-gate.hooks.allowConversationAccess true
openclaw plugins inspect jev-gate --runtime --json   # hookCount must be 1, not 0
```

Escape hatch `JEV_OPENCLAW_TRIAGE=off`. Every decision — change or not — appends
one line to `~/.openclaw/logs/jev-gate.jsonl`.

### Hermes: `integrations/hermes/jev-prune/`

A `tool_execution` middleware that wraps the real tool call and answers with a
pruned result. The judge is not reimplemented in Python: it shells out to
`agent-glue/cli.mjs prune`, the same judge the Claude Code hook uses.

```sh
ln -s "$PWD/integrations/hermes/jev-prune" ~/.hermes/profiles/<profile>/plugins/jev-prune
hermes -p <profile> plugins enable jev-prune
hermes plugins doctor ./integrations/hermes/jev-prune
python3 integrations/hermes/live-probe.py    # real loader + real middleware chain
```

Plugins live under the *profile's* home (`~/.hermes/profiles/<profile>/plugins`),
not `~/.hermes/plugins`; `~/.hermes/active_profile` names the default one. The
manifest declares no `provides_hooks`: a middleware is a different surface from
`VALID_HOOKS`, and declaring it as a hook fails `plugins doctor`. Ledger:
`<profile home>/logs/jev-prune.jsonl`.

## Skills: which situation pulls in which rules

Two skills ship inside the plugin under `skills/`, and are symlinked into
`.claude/skills/` so they also load at project scope when you work in this repo
directly.

| Skill | Fires when |
|---|---|
| `skills/jev-agent` | routing, compacting, claiming completion, picking a review profile, editing `agent-glue/src/*`, or calling the `jev_evaluate` / `jev_apply_policy` MCP tools |
| `skills/typesafe-ai` | designing or changing any Jev question — wording, batching, criteria, thresholds, confidence policy — or editing `hooks/jev.js` and the host integrations |

`skills/typesafe-ai/SKILL.md` is TypeSafe's own skill, vendored (MIT, upstream
[typesafe-ai/skills](https://github.com/typesafe-ai/skills)) with two extra
trigger lines in its `description` and a clearly-marked local addendum mapping
its patterns onto this repo. It is vendored because
`claude plugin marketplace add typesafe-ai/skills` cannot run here — the sandbox
denies writes under `~/.claude/plugins` — while this repo *is* a plugin install
location, so shipping the skill inside it reaches the same place. Note that the
sandboxed shell also cannot reach `docs.typesafe.ai`; WebFetch can, and the
addendum says so.

Frontmatter is what makes a skill reachable at all. `skills/jev-agent/SKILL.md`
shipped without any, so nothing could ever match it; a test in
`tests/integrations.test.mjs` now asserts every `SKILL.md` declares a `name` and
a `description`.

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
- [繁中接線與 Codex 快速指南](docs/zh-TW/README.md) — wiring the gateway into Claude Code / Codex
- [Handoff 2026-09-21（繁中）](docs/HANDOFF-20260921.md) — **start here if you have no prior context**
- [Jev 十步操作手冊（繁中）](docs/zh-TW/PLAYBOOK.md) — the ten-step playbook mapped onto this repo, gaps included
- [Agent glue（繁中）](docs/agent-glue.md) — install / disable / observability per host, and the four effectiveness metrics
- [Agent skill](skills/jev-agent/SKILL.md) — the operating rules both hosts share
- [TypeSafe skill](skills/typesafe-ai/SKILL.md) — vendored upstream skill (MIT) + how its patterns map onto this repo
- [Dev log](docs/DEVLOG.md) — how this got built, and the traps that cost time
