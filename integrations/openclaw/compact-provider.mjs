/**
 * jev-compact as an openclaw compaction provider.
 *
 * openclaw 2026.9 added `api.registerCompactionProvider()`: when
 * `agents.defaults.compaction.provider` names a registered id, the safeguard
 * compactor hands the to-be-summarized span to `summarize()` and persists the
 * string it returns. That is the rewrite point the old header in index.mjs said
 * did not exist (`before_compaction` / `after_compaction` are still
 * observe-only), so fast-jev compaction is now portable — prune is not:
 * `after_tool_call` is observe-only and `tool_result_persist` is synchronous.
 *
 * Same contract as the Claude hook (agent-glue/claude/compact-hook.mjs):
 * user/assistant text is verbatim, only tool call/result pairs a Jev judge
 * calls `drop` are elided. The "summary" is therefore the span itself minus
 * dead tool payloads, not an LLM rewrite.
 *
 * Fail-open is openclaw's: a throw (or empty string) makes it fall back to its
 * built-in summarizer with its quality audit. So every case this module cannot
 * vouch for — no key, judge failure, reduction under the floor, or a result
 * still too large to relieve the window — throws, and the ledger says why.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compactMessages } from '../../agent-glue/src/compact.js';
import { CONFIG, apiKey, judgePair, userRequestOf } from '../../agent-glue/claude/compact-hook.mjs';

export const PROVIDER_ID = 'jev-compact';
export const LEDGER = join(homedir(), '.openclaw', 'state', 'jev-compact.log');

/**
 * The verbatim span must shrink at least this much, or it would not relieve the
 * window that triggered compaction and openclaw would compact again next turn.
 */
export const DEFAULT_MAX_KEEP_RATIO = 0.6;

/** One line per decision; never throws (observation only). */
export async function logLine(line, path = LEDGER) {
  try {
    await appendFile(path, `${new Date().toISOString()}\topenclaw ${line}\n`);
  } catch {
    /* a ledger failure must not change the compaction */
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * openclaw (pi-ai) messages -> the OpenAI-shaped records compact.js pairs on:
 * `toolCall` content parts become `tool_calls`, `toolResult` becomes `tool`.
 * Thinking parts are dropped here — they are not persisted into a summary.
 */
export function toCompactShape(messages = []) {
  return messages.map((m) => {
    if (m?.role === 'toolResult') {
      return { role: 'tool', tool_call_id: m.toolCallId, name: m.toolName, content: textOf(m.content) };
    }
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      const calls = m.content.filter((c) => c?.type === 'toolCall');
      const out = { role: 'assistant', content: textOf(m.content) };
      if (calls.length) {
        out.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      return out;
    }
    return { role: m?.role ?? 'user', content: textOf(m?.content) };
  });
}

/** Render the (compacted) span as the persisted summary text. */
export function render(messages = [], previousSummary = '') {
  const parts = [];
  if (previousSummary) parts.push(`## Earlier summary\n${previousSummary}`);
  parts.push('## Conversation (verbatim; tool payloads a Jev judge found no longer needed are elided)');
  for (const m of messages) {
    if (m.role === 'tool') {
      parts.push(`[tool result ${m.name ?? ''} ${m.tool_call_id ?? ''}]\n${m.content}`);
      continue;
    }
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role;
    if (m.content) parts.push(`${label}: ${m.content}`);
    for (const tc of m.tool_calls ?? []) {
      parts.push(`[tool call ${tc.function?.name} ${tc.id}] ${tc.function?.arguments ?? ''}`);
    }
  }
  return parts.join('\n\n');
}

/** Node-side `$` for the shared judge: the hook API it was written against. */
const node$ = {
  fs: { read: (p) => readFile(p, 'utf8') },
  http: {
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
  },
};

/**
 * @param {object} [opts]  plugin config: `{ keyFile?, maxKeepRatio?, minReductionChars? }`
 * @param {object} [deps]  test seams: `{ judge?, key?, log? }`
 */
export function makeProvider(opts = {}, deps = {}) {
  const log = deps.log ?? logLine;
  return {
    id: PROVIDER_ID,
    label: 'Jev verbatim compaction',
    async summarize({ messages = [], previousSummary } = {}) {
      const shaped = toCompactShape(messages);
      const before = render(shaped, previousSummary).length;
      // The raw size next to the rendered one: a big gap means a message shape
      // toCompactShape does not read, which would otherwise look like "nothing
      // worth eliding" rather than like a blind adapter.
      const span = `span ${messages.length} msgs [${[...new Set(messages.map((m) => m?.role))].join(',')}] raw ${JSON.stringify(messages).length}`;
      const key = deps.key !== undefined ? deps.key : await apiKey(node$, { keyFile: opts.keyFile });
      if (!key && !deps.judge) {
        await log('jev-compact: no provider key, built-in compaction runs');
        throw new Error('jev-compact: no provider key');
      }
      const request = userRequestOf(shaped);
      const out = await compactMessages({
        messages: shaped,
        // openclaw already keeps the recent tail out of the span it hands us.
        pinFirst: 0,
        pinLast: 0,
        minReductionChars: opts.minReductionChars ?? CONFIG.minReductionChars,
        judgeHeadChars: CONFIG.askChars,
        judge: deps.judge ?? ((pair) => judgePair(node$, key, request, pair)),
      });
      if (!out.compacted) {
        await log(`jev-compact: fell back to built-in (${out.reason ?? 'below floor'}, reducedBy ${out.reducedBy ?? 0} of ${before} chars, ${span})`);
        throw new Error('jev-compact: nothing worth eliding');
      }
      const summary = render(out.messages, previousSummary);
      const ratio = opts.maxKeepRatio ?? DEFAULT_MAX_KEEP_RATIO;
      if (summary.length > before * ratio) {
        await log(`jev-compact: fell back to built-in (verbatim ${summary.length} of ${before} chars > ${ratio} keep ratio, ${span})`);
        throw new Error('jev-compact: verbatim result too large');
      }
      await log(`jev-compact: ${before} → ${summary.length} chars, ${out.droppedIds.length} tool sites elided, ${span}, verbatim`);
      return summary;
    },
  };
}
