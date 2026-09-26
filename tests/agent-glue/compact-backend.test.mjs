/**
 * Both transcript shapes must compact.
 *
 * Why this exists: `agent-glue/src/compact.js` pairs a tool call to its result
 * by the OpenAI `tool_call_id`, so on Claude Code — which sends `SessionMessage`
 * (`{role, text, toolUses, toolResults}`, claude-code.d.ts:7470) — it paired
 * nothing and every pass reduced by 0 chars. The
 * bug was invisible: the hook logged a clean "fell back to built-in" and the
 * host summarised as usual. A regression here looks exactly the same, so the
 * assertion is on `reducedBy > 0` per shape, not on the dispatch alone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compactMessages } from '../../agent-glue/src/compact.js';
import { askerFor, backendFor, compactAnthropic } from '../../agent-glue/claude/compact-anthropic.mjs';

const BIG = 'x'.repeat(20_000);
const TAIL_TEXT = ['next', 'ok', 'x', 'y', 'z', 'w'];

// Claude Code's shape, handles and all: `session.compact` stamps one per message.
const anthropic = [
  { role: 'user', text: 'go', toolUses: [], handle: 'h0' },
  {
    role: 'assistant', text: '', handle: 'h1',
    toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/a' }, text: BIG }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: BIG }], handle: 'h2' },
  ...TAIL_TEXT.map((t, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', text: t, toolUses: [], handle: `h${i + 3}`,
  })),
];

const openai = [
  { role: 'user', content: 'go' },
  { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] },
  { role: 'tool', tool_call_id: 't1', content: BIG },
  ...TAIL_TEXT.map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: t })),
];

const CONFIG = { pinFirst: 1, pinLast: 6, minReductionChars: 4000, askChars: 1200 };

/** Answers "drop everything droppable" to every question, without a network. */
const dropAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0 }])) };
  },
};

test('backendFor picks a backend from the transcript shape', () => {
  assert.equal(backendFor(anthropic), 'anthropic');
  assert.equal(backendFor(openai), 'openai');
  // No tool payloads at all: nothing to drop, so the default cannot matter.
  assert.equal(backendFor([{ role: 'user', content: 'hi' }]), 'anthropic');
});

test('untouched messages keep the engine handle, rebuilt ones do not', async () => {
  const out = await compactAnthropic({ messages: anthropic, config: CONFIG, asker: dropAsker });
  assert.equal(out.messages[0], anthropic[0], 'a pinned message must come back as the same object');
  assert.equal(out.messages[0].handle, 'h0');
  assert.ok(out.messages.every((m) => !m.handle || anthropic.some((o) => o === m)),
    'a message carrying a handle must be one the core did not rebuild');
});

test('SessionMessage compacts (this is the shape Claude Code sends)', async () => {
  const out = await compactAnthropic({ messages: anthropic, config: CONFIG, asker: dropAsker });
  assert.equal(out.compacted, true, 'Anthropic shape must compact — a 0 here is the original bug');
  assert.ok(out.reducedBy > 19_000, `reducedBy ${out.reducedBy}`);
});

test('OpenAI tool_calls still compact (the Codex host)', async () => {
  const out = await compactMessages({
    messages: openai, ...CONFIG, judgeHeadChars: CONFIG.askChars, judge: async () => 'drop',
  });
  assert.equal(out.compacted, true);
  assert.ok(out.reducedBy > 19_000, `reducedBy ${out.reducedBy}`);
});

test('RED: the OpenAI core sees no pairs in a SessionMessage transcript', async () => {
  // Not a wish for it to work — this is the defect, pinned. The dispatch in
  // compact-hook.mjs exists precisely because this number cannot be > 0.
  const out = await compactMessages({
    messages: anthropic, ...CONFIG, judgeHeadChars: CONFIG.askChars, judge: async () => 'drop',
  });
  assert.equal(out.compacted, false);
  assert.equal(out.reducedBy, 0);
});

test('a judge failure keeps the context (fail-open) instead of throwing', async () => {
  const angry = { async ask() { throw new Error('402 no credits'); } };
  const out = await compactAnthropic({ messages: anthropic, config: CONFIG, asker: angry });
  assert.equal(out.compacted, false);
  assert.equal(out.messages, anthropic);
  assert.match(out.reason, /judge-failed/);
});

test('askerFor adapts the engine fetch to what JevClient expects', async () => {
  let seen;
  const asker = askerFor(async (url, init) => {
    seen = { url, method: init.method };
    return { ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 1 }, result_t1: { noul: 0 } } }) };
  }, 'k');
  const out = await compactAnthropic({ messages: anthropic, config: CONFIG, asker });
  assert.equal(seen.method, 'POST');
  assert.match(seen.url, /openrouter\.ai/);
  // keepCall 1, keepResult 0 -> the result is truncated, the call stays.
  assert.equal(out.compacted, true);
  assert.ok(out.messages[1].toolUses.length === 1, 'the call itself must survive');
});
