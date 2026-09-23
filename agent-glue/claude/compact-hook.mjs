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

const LEDGER = `${process.env.HOME}/.openclaw/state/jev-compact.log`;

export const CONFIG = {
  endpoint: 'https://openrouter.ai/api/v1/systemone',
  model: 'typesafe/jev-1.13',
  apiKeyFile: `${process.env.HOME}/.creds/kv/OPENROUTER_API_KEY.txt`,
  // Compact when the session passes this much of its context window. This is
  // the "fast" in fast compaction: acting at 60% costs one cheap pass, acting
  // at 100% costs a summary of everything.
  compactAtPercent: Number(process.env.JEV_COMPACT_AT_PERCENT ?? 60),
  // Below this the pass is not worth replacing the history for; the host's
  // own compaction runs instead.
  minReductionChars: Number(process.env.JEV_COMPACT_MIN_REDUCTION ?? 4000),
  pinFirst: 1,
  pinLast: Number(process.env.JEV_COMPACT_PIN_LAST ?? 6),
  // How much of one call/result pair the judge is shown. The judgment is
  // "is this still needed", which the head of a payload answers.
  askChars: Number(process.env.JEV_COMPACT_ASK_CHARS ?? 1200),
};

const INSTRUCTIONS =
  'This is a tool call and its result from earlier in a coding session. Decide whether the model still needs its full payload to continue the current task.';

const CRITERIA = {
  keep: 'The call or its output still carries information the current task depends on — a file the work is being done in, an error being fixed, a result later steps refer back to.',
  drop: 'The payload has served its purpose: exploratory listing, a search that led nowhere, output already summarised into the conversation, or a check that has since been superseded.',
};

/** Resolve the provider key: plugin option, env, then the key file. */
export async function apiKey($, options = {}) {
  if (typeof options.apiKey === 'string' && options.apiKey) return options.apiKey;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const text = await $.fs.read(options.keyFile ?? CONFIG.apiKeyFile);
    return String(text).trim() || null;
  } catch {
    return null;
  }
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
    res = await $.http.fetch(CONFIG.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CONFIG.model,
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

export const ENABLED = process.env.JEV_COMPACT_ENABLED !== '0';

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

/** @type {import('claude-code').Register} */
export const register = (on, options = {}) => {
  let compacting = false;
  let standDown = false;

  // Heartbeat: one line proves the module registered in this session, so a
  // missing compact line means the event never arrived — not that the hook is
  // dead. That distinction cost a day the first time it was missing.
  on('session.start', async ($, e, next) => {
    try {
      const settings = JSON.parse(await $.fs.read(`${process.env.HOME}/.claude/settings.json`));
      standDown = rivalCompactor(settings);
    } catch {
      standDown = false; // unreadable settings is not a reason to stop working
    }
    await appendLedger($, standDown
      ? 'jev-compact: standing down — fast-jev-compaction is also enabled; disable one of the two'
      : `jev-compact: registered (at ${CONFIG.compactAtPercent}%, pinLast ${CONFIG.pinLast}, enabled=${ENABLED})`);
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    if (!ENABLED || standDown) return next(e);
    const messages = e?.messages ?? [];
    const key = await apiKey($, options);
    if (!key) {
      await appendLedger($, 'jev-compact: no provider key, built-in compaction runs');
      return next(e);
    }
    const request = userRequestOf(messages);
    const out = await compactMessages({
      messages,
      minReductionChars: CONFIG.minReductionChars,
      pinFirst: CONFIG.pinFirst,
      pinLast: CONFIG.pinLast,
      judgeHeadChars: CONFIG.askChars,
      judge: (pair) => judgePair($, key, request, pair),
    });
    const before = JSON.stringify(messages).length;
    if (!out.compacted) {
      await appendLedger($, `jev-compact: fell back to built-in (reducedBy ${out.reducedBy ?? 0} of ${before} chars, floor ${CONFIG.minReductionChars})`);
      return next(e);
    }
    const line = `jev-compact: ${before} → ${before - (out.reducedBy ?? 0)} chars, ${out.reducedBy} dropped, ${out.messages.length}/${messages.length} messages, verbatim, trigger=${e?.trigger ?? '?'}`;
    $.ui.log(line);
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
      if ((context?.percent ?? 0) < CONFIG.compactAtPercent) return next(e);
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
