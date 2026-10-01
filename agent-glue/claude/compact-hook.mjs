#!/usr/bin/env node
/**
 * Claude `session.compact` + `turn.complete` — fast, verbatim Jev compaction,
 * folded into this plugin instead of living in a second one.
 *
 * What "fast" means here is the same thing the standalone
 * fast-jev-compaction plugin meant by it: compaction runs *continuously* on a
 * context-percent trigger rather than only at the wall, and a System One
 * judgment (~350 in / ~35 out tokens, ~500 ms) decides what goes, so there is
 * no summarisation pass and no paraphrase. What survives is byte-for-byte what
 * was there.
 *
 * Two backends, one per transcript shape, picked per call (see
 * `./compact-anthropic.mjs`): Anthropic content blocks go to the vendored
 * fast-jev-compaction core, OpenAI `tool_calls` go to `../src/compact.js`.
 * `JEV_COMPACT_BACKEND=anthropic|openai` pins one.
 *
 * The rules come from `../src/compact.js` and are a contract, not tuning:
 *   - user/assistant prose is never dropped or truncated, only tool call and
 *     tool result payloads may go;
 *   - a dropped call and its matching result go together, never one alone;
 *   - the first and the most recent turns are pinned;
 *   - a judge failure, or a reduction below the floor, hands the host its
 *     ORIGINAL messages back and lets built-in compaction run. Fail-open here
 *     means "keep the context", which is the safe direction.
 *
 * Do not run this and the standalone fast-jev-compaction plugin at once: two
 * `session.compact` registrations both answering the same event is undefined.
 * Disable one. `JEV_COMPACT_ENABLED=0` turns this one off.
 */
import { compactMessages } from '../src/compact.js';
import { askerFor, backendFor, compactAnthropic } from './compact-anthropic.mjs';
import { ENV, fillEnv, ZEN_BACKUP, zenCooling, followsZen } from './env.mjs';

let LEDGER = '';

export const CONFIG = {
  endpoint: '',
  model: '',
  // Every field below is filled by `refreshConfig`; see its comment for why.
  apiKeyFile: '',
  compactAtPercent: 60,
  compactAtTokens: 200000,
  pinFirst: 1,
  pinLast: 6,
  minReductionChars: 4000,
  askChars: 1200,
  backend: 'auto',
  // Undefined on purpose: the vendored core owns these defaults (0.5, 25000,
  // 30000, 300). See `refreshConfig`.
  keepThreshold: undefined,
  maxStateTokens: undefined,
  maxRequestTokens: undefined,
  truncateHeadChars: undefined,
};

/**
 * A number from the environment, or `undefined` when unset or unparseable —
 * `Number('')` is 0, which would silently mean "keep nothing" for a threshold.
 */
function numOrUndef(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Whether the module answers `session.compact` at all; `JEV_COMPACT_ENABLED=0` turns it off. */
export let ENABLED = true;

/**
 * Recompute what the environment decides, from `ENV`. Called once at load (for
 * Node) and again after `hydrate($)` in each hook, where `ENV` starts empty
 * because a hooks module has no `process`.
 *
 * ponytail: the defaults live here alone, so the two callers cannot drift.
 */
export function refreshConfig(backup = false) {
  LEDGER = `${ENV.HOME || ENV.USERPROFILE}/.openclaw/state/jev-compact.log`;
  // Same override as hooks/jev.js, so one JEV_API_KEY_FILE points both at a Jev-only key.
  CONFIG.apiKeyFile = ENV.JEV_API_KEY_FILE || `${ENV.HOME || ENV.USERPROFILE}/.creds/kv/${backup ? ZEN_BACKUP.keyName : 'OPENCODE_ZEN_API_KEY.txt'}`;
  // Same endpoint/model pair as hooks/jev.js. Left unread, a typesafe key file
  // was sent to OpenRouter's URL, every judge 401'd, and every compaction fell
  // back to the slow built-in summary. The primary default must name the same
  // host as the primary key file above (OPENCODE_ZEN_API_KEY): an empty default
  // let the vendored core fall back to its OpenRouter decisions URL, so a Zen
  // key reached OpenRouter and every compact 401'd `Missing Authentication
  // header` (2026-10-01). Keep these three in lockstep with hooks/jev.js.
  CONFIG.endpoint = ENV.JEV_ENDPOINT || (backup ? ZEN_BACKUP.endpoint : 'https://opencode.ai/zen/v1/systemone');
  CONFIG.model = ENV.JEV_MODEL || (backup ? ZEN_BACKUP.model : 'jev-1.13-free');
  // Compact when the session passes this much of its context window. This is
  // the "fast" in fast compaction: acting at 60% costs one cheap pass, acting
  // at 100% costs a summary of everything.
  CONFIG.compactAtPercent = Number(ENV.JEV_COMPACT_AT_PERCENT ?? 60);
  // Absolute ceiling, whichever comes first. A percentage alone scales with
  // the window: 60% of a 1M window is 600k, far past where long-context
  // quality falls off. 0 disables the ceiling.
  CONFIG.compactAtTokens = Number(ENV.JEV_COMPACT_AT_TOKENS ?? 200000);
  // Below this the pass is not worth replacing the history for; the host's
  // own compaction runs instead.
  CONFIG.minReductionChars = Number(ENV.JEV_COMPACT_MIN_REDUCTION ?? 4000);
  CONFIG.pinLast = Number(ENV.JEV_COMPACT_PIN_LAST ?? 6);
  // How much of one call/result pair the judge is shown. The judgment is
  // "is this still needed", which the head of a payload answers.
  CONFIG.askChars = Number(ENV.JEV_COMPACT_ASK_CHARS ?? 1200);
  // The four knobs the retired fast-jev-compaction plugin exposed as userConfig
  // and this one only inherited as core defaults. Same values, now overridable;
  // `undefined` means "let the core decide", so an unset name stays the core's
  // own default rather than this module's copy of it drifting away from it.
  CONFIG.keepThreshold = numOrUndef(ENV.JEV_COMPACT_KEEP_THRESHOLD);
  CONFIG.maxStateTokens = numOrUndef(ENV.JEV_COMPACT_MAX_STATE_TOKENS);
  CONFIG.maxRequestTokens = numOrUndef(ENV.JEV_COMPACT_MAX_REQUEST_TOKENS);
  CONFIG.truncateHeadChars = numOrUndef(ENV.JEV_COMPACT_TRUNCATE_HEAD);
  // 'auto' detects the shape per transcript; 'anthropic'/'openai' pin a backend.
  CONFIG.backend = ENV.JEV_COMPACT_BACKEND ?? 'auto';
  ENABLED = ENV.JEV_COMPACT_ENABLED !== '0';
}
refreshConfig();

let hydrated;

/** See jev.js: the names are literals so validate lists what this module reads. */
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
        OPENROUTER_API_KEY: await $.env.get('OPENROUTER_API_KEY'),
        JEV_API_KEY_FILE: await $.env.get('JEV_API_KEY_FILE'),
        JEV_ENDPOINT: await $.env.get('JEV_ENDPOINT'),
        JEV_MODEL: await $.env.get('JEV_MODEL'),
        JEV_UI_LOG: await $.env.get('JEV_UI_LOG'),
        JEV_COMPACT_ENABLED: await $.env.get('JEV_COMPACT_ENABLED'),
        JEV_COMPACT_AT_PERCENT: await $.env.get('JEV_COMPACT_AT_PERCENT'),
        JEV_COMPACT_AT_TOKENS: await $.env.get('JEV_COMPACT_AT_TOKENS'),
        JEV_COMPACT_MIN_REDUCTION: await $.env.get('JEV_COMPACT_MIN_REDUCTION'),
        JEV_COMPACT_PIN_LAST: await $.env.get('JEV_COMPACT_PIN_LAST'),
        JEV_COMPACT_ASK_CHARS: await $.env.get('JEV_COMPACT_ASK_CHARS'),
        JEV_COMPACT_BACKEND: await $.env.get('JEV_COMPACT_BACKEND'),
        JEV_COMPACT_KEEP_THRESHOLD: await $.env.get('JEV_COMPACT_KEEP_THRESHOLD'),
        JEV_COMPACT_MAX_STATE_TOKENS: await $.env.get('JEV_COMPACT_MAX_STATE_TOKENS'),
        JEV_COMPACT_MAX_REQUEST_TOKENS: await $.env.get('JEV_COMPACT_MAX_REQUEST_TOKENS'),
        JEV_COMPACT_TRUNCATE_HEAD: await $.env.get('JEV_COMPACT_TRUNCATE_HEAD'),
      });
    } catch {
      /* no `$.env` (Node): ENV already came from process.env */
    }
    refreshConfig();
  })();
  return hydrated;
}

const INSTRUCTIONS =
  'This is a tool call and its result from earlier in a coding session. Decide whether the model still needs its full payload to continue the current task.';

const CRITERIA = {
  keep: 'The call or its output still carries information the current task depends on — a file the work is being done in, an error being fixed, a result later steps refer back to.',
  drop: 'The payload has served its purpose: exploratory listing, a search that led nowhere, output already summarised into the conversation, or a check that has since been superseded.',
};

/**
 * Resolve the provider key: plugin option, the key file, then env — file before
 * env, as prune.js does. An inherited stale OPENROUTER_API_KEY used to beat a
 * rotated JEV_API_KEY_FILE, so every judge call 401'd and failed open to keep:
 * compaction "ran" and reduced nothing.
 */
export async function apiKey($, options = {}) {
  if (typeof options.apiKey === 'string' && options.apiKey) return options.apiKey;
  try {
    const text = String(await $.fs.read(options.keyFile ?? CONFIG.apiKeyFile)).trim();
    if (text) return text;
  } catch {
    /* fall through to the environment */
  }
  return ENV.OPENROUTER_API_KEY || null;
}

/**
 * A bounded description of the call site `compactMessages` hands the judge:
 * `{ calls: [{name, argsChars, argsHead}], results: [{chars, resultHead}] }`
 * (the heads are present because the hook asks for `judgeHeadChars`). Only the
 * heads cross the wire — never a whole payload.
 */
export function pairState(pair) {
  const calls = Array.isArray(pair?.calls) ? pair.calls : [];
  const results = Array.isArray(pair?.results) ? pair.results : [];
  return {
    tools: calls.map((c) => c?.name ?? 'unknown'),
    arguments: calls.map((c) => c?.argsHead ?? '').filter(Boolean).join('\n'),
    result: results.map((r) => r?.resultHead ?? '').filter(Boolean).join('\n'),
    result_chars: results.reduce((a, r) => a + (r?.chars ?? 0), 0),
  };
}

/**
 * One Jev Choice over a call/result pair. Every failure path answers 'keep',
 * so a bad key, a 4xx or a bad schema can only leave context in place.
 * @returns {Promise<'keep'|'drop'>}
 */
export async function judgePair($, key, userRequest, pair) {
  let res;
  try {
    res = await $.http.fetch(CONFIG.endpoint || 'https://opencode.ai/zen/v1/systemone', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CONFIG.model || 'jev-1.13-free',
        state: { user_request: userRequest, pair: pairState(pair) },
        questions: { q: { type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA } },
      }),
    });
  } catch {
    return 'keep';
  }
  if (!res || !res.ok) return 'keep';
  try {
    return JSON.parse(res.text)?.answers?.q?.choice === 'drop' ? 'drop' : 'keep';
  } catch {
    return 'keep';
  }
}

/** The newest real user turn, which is what "still needed" is judged against. */
export function userRequestOf(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content.slice(0, 2000);
  }
  return '';
}

/**
 * Append one line. Never throws: the ledger is observation, and a broken
 * ledger must not stop a compaction (or make one look like it never ran).
 */
export async function appendLedger($, line) {
  try {
    const at = new Date(await $.clock.now()).toISOString();
    const previous = await $.fs.read(LEDGER).catch(() => '');
    await $.fs.write(LEDGER, `${previous}${at}\t${line}\n`);
  } catch {
    /* observation only */
  }
}

/**
 * Is the standalone fast-jev-compaction plugin also enabled? Two modules
 * answering the same `session.compact` is undefined behaviour, and the symptom
 * — compaction "sometimes" keeping verbatim — is miserable to chase. So this
 * one yields: it checks the host settings once and stands down rather than
 * race. Pure over the settings object so it is testable without a filesystem.
 */
export function rivalCompactor(settings = {}) {
  const enabled = settings?.enabledPlugins ?? {};
  return Object.entries(enabled).some(([name, on]) => on === true && name.startsWith('fast-jev-compaction@'));
}

/**
 * The auto-trigger: past `compactAtPercent` of the window, or past
 * `compactAtTokens` absolute, whichever comes first. Pure so it is testable.
 */
export function shouldCompact(context = {}) {
  if ((context?.percent ?? 0) >= CONFIG.compactAtPercent) return true;
  return CONFIG.compactAtTokens > 0 && (context?.tokens ?? 0) >= CONFIG.compactAtTokens;
}

/** @type {import('claude-code').Register} */
export const register = (on, options = {}) => {
  let compacting = false;
  let standDown = false;

  // Heartbeat: one line proves the module registered in this session, so a
  // missing compact line means the event never arrived — not that the hook is
  // dead. That distinction cost a day the first time it was missing.
  on('session.start', async ($, e, next) => {
    await hydrate($);
    try {
      const settings = JSON.parse(await $.fs.read(`${ENV.HOME || ENV.USERPROFILE}/.claude/settings.json`));
      standDown = rivalCompactor(settings);
    } catch {
      standDown = false; // unreadable settings is not a reason to stop working
    }
    // No feature-detect of `$.session.compact` here: the engine's static check
    // rejects `$.session` read as a value and drops the WHOLE hooks module
    // (prune/spawn/compact). SDK hosts (Happy, `-p`) lack it anyway, so the
    // percent trigger is inert there and only the host's own wall reaches us.
    await appendLedger($, standDown
      ? 'jev-compact: standing down — fast-jev-compaction is also enabled; disable one of the two'
      : `jev-compact: registered (at ${CONFIG.compactAtPercent}% or ${CONFIG.compactAtTokens} tokens, pinLast ${CONFIG.pinLast}, enabled=${ENABLED})`);
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    await hydrate($);
    // Say so when the event arrives and we decline it. Silence here is
    // ambiguous in exactly the way that costs a day: a missing compact line
    // could mean "the host never sent the event" or "we stood down", and the
    // ledger is the only place that difference is observable.
    if (!ENABLED || standDown) {
      await appendLedger($, `jev-compact: session.compact arrived, not handling it (enabled=${ENABLED}, standDown=${standDown})`);
      return next(e);
    }
    const messages = e?.messages ?? [];
    // Zen free in its quota cooldown: OpenRouter answers until it lapses.
    if (followsZen()) {
      const status = await $.fs.read(`${ENV.HOME || ENV.USERPROFILE}/.jevgate/zen-free-status.json`).catch(() => '');
      refreshConfig(zenCooling(status, await $.clock.now().catch(() => NaN)));
    }
    const key = await apiKey($, options);
    if (!key) {
      await appendLedger($, 'jev-compact: no provider key, built-in compaction runs');
      return next(e);
    }
    const request = userRequestOf(messages);
    const backend = CONFIG.backend === 'auto' ? backendFor(messages) : CONFIG.backend;
    const out = backend === 'anthropic'
      ? await compactAnthropic({ messages, config: CONFIG, asker: askerFor((url, init) => $.http.fetch(url, init), key, CONFIG) })
      : await compactMessages({
        messages,
        minReductionChars: CONFIG.minReductionChars,
        pinFirst: CONFIG.pinFirst,
        pinLast: CONFIG.pinLast,
        judgeHeadChars: CONFIG.askChars,
        judge: (pair) => judgePair($, key, request, pair),
      });
    const before = JSON.stringify(messages).length;
    if (!out.compacted) {
      await appendLedger($, `jev-compact: fell back to built-in (backend=${backend}, reducedBy ${out.reducedBy ?? 0} of ${before} chars, floor ${CONFIG.minReductionChars}${out.reason ? `, ${out.reason}` : ''})`);
      return next(e);
    }
    const line = `jev-compact: backend=${backend}, ${before} → ${before - (out.reducedBy ?? 0)} chars, ${out.reducedBy} dropped, ${out.messages.length}/${messages.length} messages, verbatim, trigger=${e?.trigger ?? '?'}`;
    // ponytail: SDK hosts (Happy) turn every ui.log into a visible message; the ledger already has it.
    if (ENV.JEV_UI_LOG === '1') $.ui.log(line);
    await appendLedger($, line);
    return { messages: out.messages };
  });

  // The "fast" trigger: compact on a context percentage rather than waiting
  // for the wall. Guarded against re-entry — `$.session.compact()` raises the
  // very event this module answers.
  on('turn.complete', async ($, e, next) => {
    if (!ENABLED || standDown || compacting) return next(e);
    try {
      const { context } = await $.session.usage();
      if (!shouldCompact(context)) return next(e);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      await appendLedger($, `jev-compact: auto-trigger skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(e);
  });
};
