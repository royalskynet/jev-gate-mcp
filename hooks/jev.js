/**
 * jev-gate — prune long tool output with a Jev (System One) keep/drop judgment
 * before it enters the model's context.
 *
 * This is a function hook, not a settings `command` hook, on purpose: a
 * PostToolUse command hook cannot rewrite a tool result that core has already
 * recorded. `tool.call` can: await `next(e)`, then answer with `{ result }`
 * (no `ref`) so core re-maps the pruned record for the model.
 *
 * The module runs with no Node: everything outside it comes through `$`.
 */

import { ENV, fillEnv, ZEN_PRIMARY, ZEN_BACKUP, zenCooling, followsZen } from '../agent-glue/claude/env.mjs';
import { usageRecord, tokensOf, modelOf, hookUsageFile } from '../agent-glue/claude/usage-line.mjs';

export const CONFIG = {
  // The three env-backed fields are filled by `refreshConfig`, below: under
  // Node they are right at load, and in the hook they are right once
  // `hydrate($)` has read `$.env`.
  endpoint: '',
  model: '',
  apiKeyFile: '',
  chunkChars: 16000,
  // ponytail: judge at most this many chunks per call; the rest passes through
  // verbatim (never truncated). Raise it if the log shows tails going unjudged.
  maxJudgedChunks: 8,
  // Drop only when the answer's own probability of `drop` clears this.
  // NOT `confidence`: for a Choice, confidence measures how concentrated the
  // distribution is, and batching several chunks into one request spreads it —
  // the same noise chunk that answers drop 0.98 / confidence 0.96 alone came
  // back drop 0.63 / confidence 0.25 next to a sibling chunk. Gating on
  // confidence therefore vetoed every real drop. A missing `probabilities`
  // counts as 1, so an endpoint that omits the field cannot silently turn
  // pruning off (DEVLOG §18.2).
  //
  // 0.7 is measured, not taste: `scripts/calibrate-prune.mjs` over 17
  // hand-labelled chunks of this machine's own tool output (8 cases, $0.006 a
  // sweep). Obvious drops come back 0.86-1.00, but the expensive case is a chunk
  // that is mostly noise with the answer buried in it: the real 16 KB chunk that
  // holds one ERROR line among 200 heartbeats scores 0.47-0.62 across runs, so
  // 0.6 drops the answer on a bad roll while 0.7 never did. `vetoOnTerms` cannot
  // save that one — the request's only term appears in every chunk — so the
  // threshold has to. Cost: 29.3% of the bytes instead of 48.5%, and 0 false
  // drops instead of 1 (DEVLOG §22.2). A destroyed answer costs more than a
  // kept dump.
  minDropProbability: 0.7,
  // Wall-clock ceiling on the one Jev call, because nothing else bounds it.
  // The engine's 10 s hook budget explicitly does NOT: "the clock stops while
  // a `next(e)` call or any `$` call of the hook's is in flight" (HookBudget
  // `ms`, claude-code.d.ts), and `$.http.fetch` takes no signal or timeout
  // (HttpInit carries method/headers/body/auth/socketPath and nothing else).
  // So a Jev endpoint that accepts the connection and never answers stalls
  // every Bash, Grep and Read result behind it, forever, unmetered.
  //
  // 2000 is this repo's own number on this exact workload, not the article's:
  // `plugin/config.default.json` runs the jevwire prune path at timeoutMs 2000
  // over the same chunkChars 16000 x maxChunks 8, and jev-route's 3-question
  // call measures p50 458 ms / max 719 ms over 18 live calls. Fail-open costs
  // an unpruned dump; there is no cost to cutting a hung call short.
  timeoutMs: 2000,
};

/**
 * The tools worth pruning, how to reach the long string in each one's result
 * record, and how to put a pruned one back.
 *
 * Every threshold is `CONFIG.chunkChars`, and that is a measurement rather
 * than symmetry for its own sake. Below one chunk the judge is asked an
 * all-or-nothing question — drop the entire output or keep it — and it
 * correctly almost never drops. The production ledger
 * `~/.openclaw/state/jev-prune.log` holds 19 real prune calls: every call under
 * 20 KB dropped nothing at all, and the one 44 KB call produced all 28,015
 * saved chars. Replaying those real sizes at each threshold:
 *    4000 -> 19 calls, 28015 chars saved
 *   12000 ->  8 calls, 28015 chars saved
 *   16000 ->  3 calls, 28015 chars saved
 *   32000 ->  1 call,  28015 chars saved
 * 16000 buys a 84% cut in Jev calls — latency and spend on every Bash and
 * Grep — for 0% of the measured savings. 32000 costs no more on this corpus
 * but is one call wide, so it has no margin the day output lands between the
 * two; the threshold sits at the structural boundary instead, because one
 * chunk is the smallest output a partial drop can exist in at all.
 * `tests/jev.test.mjs` pins `thresholdChars >= chunkChars` (DEVLOG §23).
 *
 * Read keeps its row even though core token-caps a Read before the hook sees
 * it (measured delivery: 8,000 chars for a 207 KB log, 16,571 for a 114 KB
 * base64 blob), so it now fires only at the blob end — which is the only end
 * its `drop` criteria were ever written for. The `[jev-prune: ...]` marker
 * stays inline either way, so a removal is visible to the model rather than
 * silent.
 */
const TARGETS = {
  Bash: {
    thresholdChars: CONFIG.chunkChars,
    get: (r) => (typeof r?.stdout === 'string' ? r.stdout : undefined),
    set: (r, text) => ({ ...r, stdout: text }),
    criteria: {
      keep: "The chunk contains information directly needed to complete the user's current request/task.",
      drop: "The chunk is unrelated noise, duplicated boilerplate, or otherwise does not help complete the user's current request/task.",
    },
  },
  Grep: {
    thresholdChars: CONFIG.chunkChars,
    get: (r) => (typeof r?.content === 'string' ? r.content : undefined),
    set: (r, text) => ({ ...r, content: text, numLines: countLines(text) }),
    criteria: {
      keep: "The chunk holds matches that help answer the user's current request/task.",
      drop: "The chunk holds only matches from vendored, generated, minified or test-fixture files, or matches that cannot bear on the user's current request/task.",
    },
  },
  Read: {
    thresholdChars: CONFIG.chunkChars,
    get: (r) => (r?.type === 'text' && typeof r?.file?.content === 'string' ? r.file.content : undefined),
    set: (r, text) => ({ ...r, file: { ...r.file, content: text, numLines: countLines(text) } }),
    criteria: {
      keep: 'The chunk is source, configuration or prose the user could read, reference or edit. When in doubt, keep.',
      drop: 'The chunk is mechanical bulk that carries no meaning to read: minified or bundled code, base64 or hex blobs, lock-file bodies, generated tables, or long runs of repeated near-identical lines.',
    },
  },
};

const INSTRUCTIONS =
  "Decide whether the chunk of tool output is relevant to the user's current request/task. Keep output that helps answer or complete the task; drop output that is noise, repeated boilerplate, or unrelated.";

function countLines(text) {
  return text.split('\n').length;
}

/** Split on line boundaries, each part at most `chunkChars`. Lines longer than that stand alone. */
export function chunkLines(text, chunkChars = CONFIG.chunkChars) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of text.split('\n')) {
    if (len + line.length + 1 > chunkChars && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

/**
 * Read one Choice answer as a verdict. A `drop` under the probability floor is
 * reported as `unsure`, which prunes nothing but stays visible in the ledger —
 * a floor that quietly vetoes everything would look exactly like a judge that
 * never ran.
 */
export function verdictOf(answer, minProbability = CONFIG.minDropProbability) {
  if (answer?.choice !== 'drop') return 'keep';
  const p = answer?.probabilities?.drop;
  return (typeof p === 'number' ? p : 1) >= minProbability ? 'drop' : 'unsure';
}

/**
 * The words from the request a chunk could literally answer with. Four letters
 * or more, so `the`, `for` and a bare `js` cannot pin every chunk in place.
 *
 * ponytail: ASCII word characters only. A Chinese-only request yields no terms
 * and the veto below simply does not fire — the model's judgment stands, which
 * is where it was anyway. Segment CJK here if the ledger ever shows a drop that
 * a Chinese keyword would have caught.
 */
export function requestTerms(request = '') {
  return new Set(
    String(request).toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [],
  );
}

/**
 * Veto a `drop` on a chunk that contains a word the request asked about.
 *
 * The model has a reproducible blind spot here: asked which commits touched
 * `prune`, it answered `drop` (p=0.92 alone, 0.60-0.67 batched) on the very
 * `git log --stat` chunk naming `prune` eleven times — diffstat output reads as
 * boilerplate to it. No threshold separates that from a true drop, because true
 * drops land in the same 0.6-0.7 band. A literal string test does separate it,
 * costs nothing, and is the kind of rule the TypeSafe skill says to keep in code
 * rather than hand to the model (DEVLOG §22.4).
 */
export function vetoOnTerms(verdicts, chunks, terms) {
  if (!terms.size) return verdicts;
  const hays = chunks.map((c) => c.toLowerCase());
  // Only a term that tells the chunks apart is evidence. A term every chunk
  // contains ("worker" in a log where every line says worker) says nothing about
  // which chunk to keep, and vetoing on it held the single clearest true drop in
  // the corpus. With one chunk there is nothing to compare it to, so any term hit
  // counts — that is the case the model gets wrong on its own.
  const discriminating = [...terms].filter((t) => {
    const n = hays.filter((h) => h.includes(t)).length;
    return n > 0 && (chunks.length === 1 || n < chunks.length);
  });
  if (!discriminating.length) return verdicts;
  return verdicts.map((v, i) =>
    (v === 'drop' && discriminating.some((t) => hays[i].includes(t)) ? 'unsure' : v));
}

/** Race sentinel; a unique object so no response body can impersonate it. */
const TIMED_OUT = Symbol('jev-timeout');

/**
 * Round-trip of the last `judgeChunks` call, in milliseconds, or null where the
 * clock was unavailable. The ledger carries it so the timeout above has a
 * measured distribution to be retuned against instead of a borrowed number.
 */
export let lastLatencyMs = null;

/**
 * One Jev request for ALL the chunks: the chunks go up once as `state.chunks`
 * and each question points at its own element by path, which is the batching
 * shape the TypeSafe docs describe (independent questions over shared state run
 * in parallel server-side). It replaces one request per chunk — up to 8 round
 * trips and 8 copies of the user request per tool call.
 *
 * Returns one verdict per chunk; every failure path answers 'keep', so a bad
 * key, a 4xx or a bad schema can only pass output through unchanged.
 */
export async function judgeChunks($, key, userRequest, chunks, criteria = TARGETS.Bash.criteria, httpFetch = (url, init) => $.http.fetch(url, init)) {
  const keepAll = chunks.map(() => 'keep');
  if (!chunks.length) return keepAll;
  const questions = {};
  chunks.forEach((_, i) => {
    questions[`c${i}`] = {
      type: 'choice',
      instructions: `${INSTRUCTIONS} Judge only the chunk at \`chunks[${i}]\`.`,
      criteria,
    };
  });
  let res;
  const startedAt = await $.clock.now().catch(() => null);
  try {
    // `$.clock.sleep` is the one wait the engine meters against the hook's own
    // budget, so the deadline cannot itself go missing. The losing promise is
    // abandoned, not cancelled — `$.http.fetch` has no signal — which is fine:
    // it settles into nothing and the hook has already moved on.
    res = await Promise.race([
      httpFetch(CONFIG.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CONFIG.model,
          state: { user_request: userRequest, chunks },
          questions,
        }),
      }),
      $.clock.sleep(CONFIG.timeoutMs).then(() => TIMED_OUT),
    ]);
  } catch {
    return keepAll;
  }
  lastLatencyMs = startedAt == null ? null : (await $.clock.now().catch(() => null)) - startedAt;
  if (res === TIMED_OUT) {
    // A timeout must not read as "judged everything keep". That confusion is
    // this hook's oldest failure mode (DEVLOG: two days of an empty ledger read
    // as a hook that never loaded), and it is also the only way the 2000 above
    // ever gets retuned — a ledger full of jev-timeout is the evidence to raise
    // it, and none is the evidence to leave it alone.
    await appendLedger($, `jev-timeout: ${chunks.length} chunks unjudged after ${CONFIG.timeoutMs}ms — kept verbatim`);
    return keepAll;
  }
  if (!res || !res.ok) return keepAll;
  try {
    const answers = JSON.parse(res.text)?.answers ?? {};
    const verdicts = chunks.map((_, i) => verdictOf(answers[`c${i}`]));
    return vetoOnTerms(verdicts, chunks, requestTerms(userRequest));
  } catch {
    return keepAll;
  }
}

/** One chunk, one verdict — the single-question form, kept for live probes. */
export async function judgeChunk($, key, userRequest, chunk, criteria = TARGETS.Bash.criteria) {
  const [verdict] = await judgeChunks($, key, userRequest, [chunk], criteria);
  return verdict === 'drop' ? 'drop' : 'keep';
}

/**
 * Prune `text`. `judge` is `(chunks) => Promise<Array<'keep'|'drop'|'unsure'>>`
 * — one call for the whole batch, not one per chunk. Returns
 * `{ kept, droppedLines, unsure }`; kept text is always verbatim or a marker.
 */
export async function pruneText(text, judge, maxJudged = CONFIG.maxJudgedChunks) {
  const chunks = chunkLines(text);
  const judged = chunks.slice(0, maxJudged);
  const verdicts = judged.length
    ? await Promise.resolve()
        .then(() => judge(judged))
        .catch(() => [])
    : [];
  let droppedLines = 0;
  let unsure = 0;
  const parts = chunks.map((chunk, i) => {
    if (verdicts[i] === 'unsure') unsure += 1;
    if (verdicts[i] !== 'drop') return chunk;
    const n = countLines(chunk);
    droppedLines += n;
    return `[jev-prune: dropped ${n} lines]`;
  });
  return { kept: parts.join('\n'), droppedLines, unsure };
}

/** Per call: OpenRouter answers while Zen free is in its quota cooldown. */
export async function followZenCooldown($) {
  if (!followsZen()) return;
  const text = await $.fs.read(`${ENV.HOME || ENV.USERPROFILE}/.jevgate/zen-free-status.json`).catch(() => '');
  refreshConfig(zenCooling(text, await $.clock.now().catch(() => NaN)));
}

let keyPromise;
let keyFileOf;
function apiKey($) {
  if (keyFileOf !== CONFIG.apiKeyFile) keyPromise = undefined; // host swapped
  keyFileOf = CONFIG.apiKeyFile;
  keyPromise ??= Promise.resolve()
    .then(() => $.fs.read(CONFIG.apiKeyFile))
    .then((t) => String(t).trim() || null)
    .catch(() => null)
    .then((k) => {
      // ponytail: memoize the hit, not the miss. `??=` alone made one unreadable
      // read at session start disable pruning for the whole session, with the
      // key landing seconds later changing nothing.
      if (!k) keyPromise = undefined;
      return k;
    });
  return keyPromise;
}

/** Once per session: a key we cannot read is a standing condition, not an event. */
let noKeyLogged = false;

/**
 * What the pruning is relative to. The newest real user turn beats anything on
 * the call: a Read carries only a path, a Grep only a pattern, and Bash's
 * `description` is the model's own gloss on its plan, not the ask.
 */
export async function userRequestOf($, e) {
  try {
    const messages = await $.session.messages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && typeof m.text === 'string' && m.text.trim()) {
        return m.text.trim().slice(0, 2000);
      }
    }
  } catch {
    /* fall through to what the call itself carries */
  }
  return e.description || e.pattern || e.command || e.file_path || '';
}

/** Durable mirror of each judged-prunable outcome; see appendLedger's comment. */
export let LEDGER = '';

/**
 * Recompute what the environment decides, from `ENV`. Called once at load (right
 * under this definition, which is what Node needs) and again after `hydrate($)`
 * in the hook, where `ENV` starts empty.
 *
 * ponytail: the defaults live here and nowhere else, so the two callers cannot
 * drift apart.
 *
 * The OpenRouter proxy stays the default so a machine that only has the
 * OpenRouter key keeps working; a machine with a TypeSafe key overrides all
 * three together (endpoint, model, key file) — the model id differs per host,
 * so overriding the endpoint alone would send `typesafe/jev-1.13` to an API
 * that names it `jev-latest`, and fail-open would hide that as a silent keep.
 */
export function refreshConfig(backup = false) {
  const home = ENV.HOME || ENV.USERPROFILE;
  // Env set to the Zen defaults still follows Zen, so the backup must win over
  // it; a non-Zen pin never takes the backup (#28).
  const zen = backup && followsZen() ? ZEN_BACKUP : null;
  CONFIG.endpoint = zen ? zen.endpoint : ENV.JEV_ENDPOINT || ZEN_PRIMARY.endpoint;
  CONFIG.model = zen ? zen.model : ENV.JEV_MODEL || ZEN_PRIMARY.model;
  CONFIG.apiKeyFile = zen ? `${home}/.creds/kv/${zen.keyName}` : ENV.JEV_API_KEY_FILE || `${home}/.creds/kv/${ZEN_PRIMARY.keyName}`;
  CONFIG.timeoutMs = Number(ENV.JEV_TIMEOUT_MS) > 0 ? Number(ENV.JEV_TIMEOUT_MS) : 2000;
  LEDGER = ENV.JEV_LEDGER || `${ENV.HOME || ENV.USERPROFILE}/.openclaw/state/jev-prune.log`;
}
refreshConfig();

let hydrated;

/**
 * Read this module's environment through `$`, once per session, then recompute.
 * The names are string literals because `$.env.get` requires it and
 * `claude plugin validate` then lists what this module reads.
 */
function hydrate($) {
  hydrated ??= (async () => {
    // `$` is the engine's here and a stub in the unit tests, which have no
    // `env` noun — and a guard cannot ask, since reading `$.env` as a value is
    // exactly what the validator refuses. Under Node, ENV already holds
    // process.env, so there is nothing to fall back to.
    try {
      fillEnv({
        HOME: await $.env.get('HOME'),
        USERPROFILE: await $.env.get('USERPROFILE'),
        JEV_ENDPOINT: await $.env.get('JEV_ENDPOINT'),
        JEV_MODEL: await $.env.get('JEV_MODEL'),
        JEV_API_KEY_FILE: await $.env.get('JEV_API_KEY_FILE'),
        JEV_LEDGER: await $.env.get('JEV_LEDGER'),
        JEV_TIMEOUT_MS: await $.env.get('JEV_TIMEOUT_MS'),
        JEV_UI_LOG: await $.env.get('JEV_UI_LOG'),
        JEV_USAGE_LOG: await $.env.get('JEV_USAGE_LOG'),
      });
    } catch {
      /* no `$.env` (Node): ENV already came from process.env */
    }
    refreshConfig();
  })();
  return hydrated;
}

/**
 * Core >= 2.1.278 writes any Bash or Grep result over ~8 KB to
 * `tool-results/<id>.txt` and substitutes a ~2 KB preview wrapper. The hook is
 * handed the wrapper, so a 179 KB command arrives as 2 KB and every threshold
 * in TARGETS is unreachable on those two tools — silently, since a preview is a
 * perfectly ordinary short string.
 *
 * Read the file back so the judge sees what the command actually printed. The
 * shape is core's, not a contract, so every failure falls back to the preview.
 */
const PERSISTED_PATH = /^<persisted-output>[\s\S]{0,400}?saved to:\s*(\S+)/;
export async function resolvePersisted($, out) {
  const m = typeof out === 'string' ? PERSISTED_PATH.exec(out) : null;
  if (!m) return { text: out, persisted: false };
  try {
    const full = await $.fs.read(m[1]);
    if (typeof full !== 'string' || full.length <= out.length) return { text: out, persisted: false };
    return { text: full, persisted: true };
  } catch {
    return { text: out, persisted: false };
  }
}

/**
 * Append one prune line to the ledger, read-then-write because `$.fs` has no
 * append. Never throws: the ledger is observation only, so a broken clock or a
 * write refusal must never break the caller (prune). `$.clock.now` for a real
 * ISO timestamp.
 * @returns {Promise<void>}
 */
export async function appendLedger($, line) {
  try {
    const at = new Date(await $.clock.now()).toISOString();
    const previous = await $.fs.read(LEDGER).catch(() => '');
    await $.fs.write(LEDGER, `${previous}${at}\t${line}\n`);
  } catch {
    /* ledger is observation only — a failure must not stop the prune */
  }
}

let usageChain = Promise.resolve();

/**
 * `$.http.fetch` plus one usage line (agent-glue/claude/usage-line.mjs), 429s
 * and throws included, so a spent Zen quota names this hook. Only the hook
 * handler passes it: Node callers of judgeChunks (src/prune.js) meter their own
 * fetch. The line is written in the background and never throws.
 */
async function meteredFetch($, url, init) {
  const started = await $.clock.now().catch(() => null);
  const log = (status, body) => {
    usageChain = usageChain.then(async () => {
      try {
        const now = await $.clock.now();
        const at = new Date(now).toISOString();
        const file = hookUsageFile(ENV, at);
        if (!file) return;
        // Missing is the only reason to start empty; any other read failure
        // skips the line rather than overwrite the day's file.
        const previous = (await $.fs.exists(file)) ? await $.fs.read(file) : '';
        const line = usageRecord({ caller: 'hook-triage', model: modelOf(init?.body), status, ...tokensOf(body),
          latency_ms: started == null ? null : now - started }, at);
        await $.fs.write(file, `${previous}${JSON.stringify(line)}\n`);
      } catch { /* observation only */ }
    });
  };
  let res;
  try {
    res = await $.http.fetch(url, init);
  } catch (e) {
    log('error', '');
    throw e;
  }
  log(res?.status ?? (res?.ok ? 200 : 'error'), res?.text);
  return res;
}

/** The body of every pruning hook; `tool` picks the row of TARGETS to use. */
async function prune(tool, $, e, next) {
  // The module's environment has no `process`; this is where `$.env` is first
  // reachable. Memoized, so only the session's first prune pays for it.
  await hydrate($);
  const target = TARGETS[tool];
  const r = await next(e);
  if (r?.isError) return r;
  const { text: out, persisted } = await resolvePersisted($, target.get(r?.result));
  if (typeof out !== 'string' || out.length < target.thresholdChars) return r;

  await followZenCooldown($);
  const key = await apiKey($);
  if (!key) {
    // The same lesson as the ledger comment below, one gate earlier: this
    // `return r` used to be the last silent exit in the hook, so an unreadable
    // key file looked exactly like a hook that never loaded — which is how the
    // ledger stayed empty for two days after the credentials moved.
    if (!noKeyLogged) {
      noKeyLogged = true;
      await appendLedger($, `jev-nokey(${tool}): ${out.length} chars unjudged, key file unreadable — pruning is off`);
    }
    return r;
  }

  const request = await userRequestOf($, e);
  const { kept, droppedLines, unsure } = await pruneText(out, (chunks) =>
    judgeChunks($, key, request, chunks, target.criteria, (url, init) => meteredFetch($, url, init)),
  );
  const line = `jev-prune(${tool}): ${out.length} → ${kept.length} chars, ${droppedLines} lines dropped`
    + (unsure ? `, ${unsure} unsure drops vetoed` : '')
    // The round trip, so CONFIG.timeoutMs has a measured distribution to be
    // retuned against. Every other number in this line describes the verdict;
    // this is the only one that describes the call.
    + (Number.isFinite(lastLatencyMs) ? `, ${lastLatencyMs}ms` : '');
  // SDK hosts (Happy) render each ui.log as a message: one per tool call. Opt-in.
  if (ENV.JEV_UI_LOG === '1') $.ui.log(line);
  // ponytail: the ui.log above is TUI-only and reaches no file unless --debug;
  // on a headless box the prune outcome would be unobservable and the threshold
  // impossible to tune, so mirror it to a ledger. Ledger writes on EVERY
  // judged-prunable call, keep or drop. It used to sit under the
  // `if (!droppedLines) return r` gate and in a swallow-all catch, so a hook
  // that fired but judged everything `keep` left zero durable trace —
  // indistinguishable from a hook that never loaded. appendLedger never throws,
  // so a broken ledger cannot stop the prune itself.
  await appendLedger($, line);
  await usageChain; // the usage line above, written before the hook returns
  if (!droppedLines) return r;
  // ponytail: a persisted result was already out of the model's context at 2 KB.
  // Replacing it is only an improvement while the judged version stays small —
  // `maxJudgedChunks` lets the tail through verbatim, so an under-pruned 179 KB
  // log would otherwise land in full. One chunk is the ceiling; above it core's
  // blind preview wins on size and we leave it alone.
  if (persisted && kept.length > CONFIG.chunkChars) return r;
  // No `ref`: core re-maps this record for the model instead of reusing its own.
  return { result: target.set(r.result, kept) };
}

/**
 * Three spelled-out registrations rather than a loop over TARGETS, and a hook
 * literal rather than a factory call: `claude plugin validate` reads this
 * source statically. A loop variable makes it report `tool.call{tool=tool}`,
 * and a `prune('Bash')` in the hook slot makes it refuse the module outright —
 * the one check that the engine sees what was meant. The test asserts these
 * names match TARGETS, which is what the loop was buying.
 *
 * @type {import('claude-code').Register}
 */
export const register = (on) => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => prune('Bash', $, e, next));
  on('tool.call', { tool: 'Grep' }, ($, e, next) => prune('Grep', $, e, next));
  on('tool.call', { tool: 'Read' }, ($, e, next) => prune('Read', $, e, next));
};

export const TARGET_NAMES = Object.keys(TARGETS);
export { TARGETS };
