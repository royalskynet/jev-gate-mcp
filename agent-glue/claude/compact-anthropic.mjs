/**
 * The Anthropic backend of `compact-hook.mjs`.
 *
 * Two hosts send this plugin two different transcript shapes:
 *
 *   Anthropic  SessionMessage: {role, text, toolUses[], toolResults?[], handle?}
 *              (claude-code.d.ts:7470; paired by `tool_use_id`)
 *   OpenAI     assistant.tool_calls[].id  +  {role:'tool', tool_call_id}
 *
 * `../src/compact.js` only knows the OpenAI shape, so on Claude Code it paired
 * nothing and every pass reduced by 0 — a compaction has never once succeeded
 * there. Rather than teach it a second shape, the Anthropic side is the
 * vendored fast-jev-compaction core (`../vendor/fast-jev`), which was written
 * against `SessionMessage` and already does state fitting, request splitting
 * and head-truncation. Glue only; see vendor/fast-jev/VENDORED.md.
 *
 * A message the core leaves alone comes back as the same object, `handle` and
 * all, so the engine keeps its own copy; a rebuilt one has no handle and is
 * read as built, which is what it is.
 *
 * `JEV_COMPACT_BACKEND=anthropic|openai` forces one; the default detects.
 */
import { compact } from '../vendor/fast-jev/index.js';
import { JevClient } from '../vendor/fast-jev/client.js';

/**
 * Which backend a transcript needs. Anthropic wins ties: Claude Code is the
 * host that sends `SessionMessage`, and a transcript with neither marker has no
 * tool payloads to drop, so the choice cannot matter.
 * @returns {'anthropic'|'openai'}
 */
export function backendFor(messages = []) {
  for (const m of messages) {
    if (Array.isArray(m?.toolUses) || Array.isArray(m?.toolResults)) return 'anthropic';
    if (m?.role === 'tool' || (m?.role === 'assistant' && Array.isArray(m?.tool_calls))) return 'openai';
  }
  return 'anthropic';
}

/**
 * The engine's fetch answers `{ok, status, text}` with `text` a string;
 * `JevClient` wants WHATWG `fetch`, whose `text` is a method. One shim, one
 * direction. Takes the fetch itself rather than `$`, because the hook
 * validator refuses to see `$` passed anywhere.
 */
export function askerFor(httpFetch, key, { endpoint = '', model = '' } = {}) {
  const fetcher = async (url, init) => {
    // The vendored request always adds OpenRouter's `provider` routing;
    // typesafe's direct API answers 400 to that field, so it goes off-OpenRouter.
    if (!url.startsWith('https://openrouter.ai/')) {
      const body = JSON.parse(init.body);
      delete body.provider;
      init = { ...init, body: JSON.stringify(body) };
    }
    const res = await httpFetch(url, init);
    return {
      ok: Boolean(res?.ok),
      status: res?.status ?? (res?.ok ? 200 : 502),
      text: async () => String(res?.text ?? ''),
    };
  };
  return new JevClient({ apiKey: key, fetch: fetcher, baseUrl: endpoint || undefined, model: model || undefined });
}

/**
 * Run the vendored core and answer in the hook's own contract
 * (`{messages, compacted, reducedBy, reason}`), so the caller does not branch
 * on which backend ran. Throws nothing: a judge failure means "keep the
 * context", the same fail-open direction as the OpenAI side.
 */
export async function compactAnthropic({ messages, config, asker }) {
  let out;
  try {
    out = await compact(messages, asker, {
      // No `goal`: the core derives it from the last user prompts, which reads
      // `text` — the field this shape actually has.
      preserveRecentMessages: config.pinLast,
      // Each one `undefined` unless its env name is set; the core resolves an
      // undefined option to its own default, so this does not pin a copy of it.
      keepThreshold: config.keepThreshold,
      maxStateTokens: config.maxStateTokens,
      maxRequestTokens: config.maxRequestTokens,
      truncateHeadChars: config.truncateHeadChars,
      askResult: config.askResult,
    });
  } catch (error) {
    return { messages, compacted: false, reducedBy: 0, reason: `judge-failed: ${error?.message ?? error}` };
  }
  const reducedBy = out.stats.charsBefore - out.stats.charsAfter;
  return {
    messages: out.messages,
    compacted: reducedBy >= config.minReductionChars && reducedBy > 0,
    reducedBy,
    reason: '',
    stats: out.stats,
    decisions: out.decisions,
  };
}
