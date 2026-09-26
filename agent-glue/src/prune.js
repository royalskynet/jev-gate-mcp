/**
 * agent-glue prune — the keep/drop judgment as a callable, for hosts that
 * cannot load this repo's in-process hooks.
 *
 * Claude Code gets pruning from `hooks/jev.js` directly. Hermes' tool
 * middleware is Python and openclaw has no async tool-result rewrite point, so
 * the CLI (`cli.mjs prune`) is their seam onto the SAME judge rather than a
 * second implementation of it.
 */
import { pruneText, judgeChunks, TARGETS, CONFIG } from '../../hooks/jev.js';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * CLI ledger: separate from the hook ledger by design (#4/#6 option 2). The
 * CLI is a *different* seam — a CLI run only proves the judge loaded, never
 * that the in-process hook did — so it must not write `jev-prune.log` or the
 * hook-liveness probe reads a CLI run as hook activity (hooks/jev.js:358/371/391
 * are the hook-side probe's meaning and stay untouched).
 */
export const CLI_LEDGER = process.env.JEV_CLI_LEDGER || `${process.env.HOME || homedir()}/.openclaw/state/jev-prune-cli.log`;

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
      const r = await globalThis.fetch(url, opts);
      return { ok: r.ok, text: await r.text() };
    },
  },
};

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
    writeCliLedger(ledger, payload.tool ?? 'Bash', reason);
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
