/**
 * agent-glue prune — the keep/drop judgment as a callable, for hosts that
 * cannot load this repo's in-process hooks.
 *
 * Claude Code gets pruning from `hooks/jev.js` directly. Hermes' tool
 * middleware is Python and openclaw has no async tool-result rewrite point, so
 * the CLI (`cli.mjs prune`) is their seam onto the SAME judge rather than a
 * second implementation of it.
 */
import { pruneText, judgeChunks, followZenCooldown, refreshConfig, TARGETS, CONFIG } from '../../hooks/jev.js';
import { ZEN_PRIMARY, ZEN_BACKUP, followsZen } from '../claude/env.mjs';
import { recordZenStatus } from '../../gateway/src/zen-status.js';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { meteredFetch, callerName } from './usage-ledger.js';

// `prune:<who>`: the Hermes plugin sets JEV_USAGE_CALLER on the subprocess.
const usageFetch = meteredFetch(callerName('prune'));

/**
 * CLI ledger: separate from the hook ledger by design (#4/#6 option 2). The
 * CLI is a *different* seam — a CLI run only proves the judge loaded, never
 * that the in-process hook did — so it must not write `jev-prune.log` or the
 * hook-liveness probe reads a CLI run as hook activity (hooks/jev.js:358/371/391
 * are the hook-side probe's meaning and stay untouched).
 */
// Under `node --test` the default is /dev/null, as for the usage ledgers (fix 10668).
export const CLI_LEDGER = process.env.JEV_CLI_LEDGER
  || (process.env.NODE_TEST_CONTEXT ? '/dev/null' : `${process.env.HOME || homedir()}/.openclaw/state/jev-prune-cli.log`);

/**
 * Append one `jev-cli(...)` line to the CLI ledger. Never throws: a broken
 * ledger must not stop the prune (same fail-open contract as `appendLedger`).
 * Reads `JEV_CLI_LEDGER` at call time (not module scope) so tests and hosts can
 * redirect per run.
 */
export async function writeCliLedger(ledger, tool, reason) {
  try {
    appendFileSync(ledger, `${new Date().toISOString()}\tjev-cli(${tool}): ${reason}\n`);
  } catch {
    /* observation only — a write refusal must not break the prune */
  }
}

/**
 * `$` as the hooks module expects it, over plain Node: `fetch` there returns a
 * Response (`.text()` is a method), the hook contract wants `{ ok, text }`.
 */
const fetchHost = {
  http: {
    fetch: async (url, opts) => {
      let r = await usageFetch(url, opts);
      if (r.status === 429 && url === ZEN_PRIMARY.endpoint && followsZen()) {
        const retry = await zenFailover(opts);
        if (retry) r = await usageFetch(ZEN_BACKUP.endpoint, retry);
      }
      return { ok: r.ok, text: await r.text() };
    },
  },
  // judgeChunks meters its deadline on `$.clock` (d835990); without it the CLI
  // path threw before the fetch and every Hermes prune kept everything.
  clock: {
    now: async () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()),
  },
  // Read by followZenCooldown: the Zen free status file picks Zen or OpenRouter.
  fs: { read: async (p) => readFileSync(p, 'utf8') },
};

/**
 * Zen answered 429 before the hourly probe wrote a cooldown (#28; same gap as
 * cli.mjs compact-live). Start the cooldown now, switch CONFIG to the backup
 * for the calls that follow, and return this request re-addressed to it.
 * null when the backup key is missing: the caller keeps the 429 and fails open.
 */
async function zenFailover(opts) {
  recordZenStatus(false, { error: 'HTTP 429 (agent-glue prune)', error_class: 'quota', cooldown_until: Date.now() + 60 * 60_000 });
  refreshConfig(true);
  const key = await pruneKey();
  if (!key) return null;
  const body = JSON.parse(opts.body);
  return {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ ...body, model: ZEN_BACKUP.model }),
  };
}

/**
 * The rotated key file first, the environment only as a fallback — the reverse
 * of what the standalone compaction plugin does, and the reason a rotation
 * there could be silently beaten by a stale copy (DEVLOG §19.4).
 */
async function pruneKey(env = process.env) {
  try {
    const { readFile } = await import('node:fs/promises');
    const t = (await readFile(CONFIG.apiKeyFile, 'utf8')).trim();
    if (t) return t;
  } catch {
    /* fall through to the environment */
  }
  return env.OPENROUTER_API_KEY || null;
}

/**
 * keep/drop for caller-built segments (opencode compaction: one segment per
 * old tool call). Same transport, key order and per-batch deadline as
 * `pruneCommand`; one request per `per` segments, run in parallel. Every
 * failure answers 'keep' for the segments it covered.
 * @returns {Promise<('keep'|'drop')[]>}
 */
export async function judgeSegments({ request, segments, criteria, per = 8 }, deps = {}) {
  const keepAll = (segments ?? []).map(() => 'keep');
  if (!keepAll.length || !String(request ?? '').trim()) return keepAll;
  try {
    if (!deps.key) await followZenCooldown(deps.host ?? fetchHost);
    const key = deps.key ?? (await pruneKey());
    if (!key) return keepAll;
    const judge = deps.judge
      ?? ((batch) => judgeChunks(deps.host ?? fetchHost, key, request, batch, criteria));
    const starts = [];
    for (let i = 0; i < segments.length; i += per) starts.push(i);
    const parts = await Promise.all(starts.map(async (s) => {
      const batch = segments.slice(s, s + per);
      try {
        const v = await judge(batch);
        return Array.isArray(v) && v.length === batch.length ? v : batch.map(() => 'keep');
      } catch {
        return batch.map(() => 'keep');
      }
    }));
    return parts.flat().map((v) => (v === 'drop' ? 'drop' : 'keep'));
  } catch {
    return keepAll;
  }
}

/**
 * Judge-and-drop one long tool output. `{ tool, request, text }` in,
 * `{ text, dropped_lines, chars_before, chars_after, judged, reason }` out.
 * Fail-open in every direction: no key, no network, short input or a bad
 * payload all answer with the input text verbatim and `judged: false`.
 */
export async function pruneCommand(payload = {}, deps = {}) {
  const text = typeof payload.text === 'string' ? payload.text : '';
  const target = TARGETS[payload.tool] ?? TARGETS.Bash;
  const threshold = Number(payload.threshold_chars ?? target.thresholdChars);
  // Ledger BEFORE any early return, so a CLI run with no key, a short input or
  // a broken judge still leaves a trace (fix 0522 §7: `const key = …; if (!key)
  // return` came before the hook's appendLedger and the ledger stayed silent for
  // two days). This line must never move below a return.
  const ledger = deps.ledger ?? CLI_LEDGER;
  writeCliLedger(ledger, payload.tool ?? 'Bash', `len=${text.length}`);
  const out = (reason, kept = text, dropped = 0, judged = false) => {
    // Outcome line with reason: judged / below-threshold / no-request /
    // no-key / error all land here, so no exit path is silent. Runs inside
    // `out()`, which every return path constructs through, so it executes
    // before the function returns (never after a return).
    // before → after on every outcome line, so savings can be summed from the
    // ledger alone (#31: the `judged` line carried no sizes).
    writeCliLedger(ledger, payload.tool ?? 'Bash', `${reason} ${text.length} → ${kept.length} chars`);
    return {
      text: kept,
      dropped_lines: dropped,
      chars_before: text.length,
      chars_after: kept.length,
      judged,
      reason,
    };
  };
  if (text.length < threshold) return out('below-threshold');
  // A prune with no request is not a weaker prune, it is a different and unsafe
  // one: every keep/drop criterion this repo has is written relative to the
  // user's task. Measured both ways in DEVLOG §22.3 — relevance judged against a
  // stand-in request dropped the file the task was about, and request-free
  // "mechanical bulk" criteria dropped every log and JSON dump, needle included.
  // Refusing costs the savings; guessing costs the answer.
  if (!String(payload.request ?? '').trim()) return out('no-request');
  if (!deps.key) await followZenCooldown(deps.host ?? fetchHost);
  const key = deps.key ?? (await pruneKey());
  if (!key) return out('no-key');
  const judge = deps.judge
    ?? ((chunks) => judgeChunks(deps.host ?? fetchHost, key, payload.request, chunks, target.criteria));
  try {
    const { kept, droppedLines, unsure } = await pruneText(text, judge);
    const r = out('judged', kept, droppedLines, true);
    if (unsure) r.unsure = unsure;
    return r;
  } catch {
    // ponytail: the judge already fail-opens per chunk; this catch is only for
    // a broken chunker, and a prune that throws must never lose tool output.
    return out('error');
  }
}
