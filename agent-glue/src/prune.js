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
  const out = (reason, kept = text, dropped = 0, judged = false) => ({
    text: kept,
    dropped_lines: dropped,
    chars_before: text.length,
    chars_after: kept.length,
    judged,
    reason,
  });
  if (text.length < threshold) return out('below-threshold');
  const key = deps.key ?? (await pruneKey());
  if (!key) return out('no-key');
  const judge = deps.judge
    ?? ((chunks) => judgeChunks(deps.host ?? fetchHost, key, payload.request ?? '', chunks, target.criteria));
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
