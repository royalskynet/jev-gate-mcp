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

// Why: the compact asker ignored JEV_ENDPOINT/JEV_MODEL, so a typesafe key went
// to OpenRouter's URL and 401'd on every pass — and typesafe's own API 400s on
// OpenRouter's `provider` field. Both failures fall back silently to built-in.
test('askerFor honours the configured endpoint/model and drops provider off OpenRouter', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: JSON.stringify({ answers: { q: { type: 'choice', choice: 'keep' } } }) };
  };
  const q = { q: { type: 'choice', instructions: 'i', criteria: { keep: 'k', drop: 'd' } } };
  await askerFor(fetch, 'k', { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' }).ask({}, q);
  await askerFor(fetch, 'k').ask({}, q);
  assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen[0].body.model, 'jev-latest');
  assert.equal('provider' in seen[0].body, false);
  assert.match(seen[1].url, /^https:\/\/openrouter\.ai\//);
  assert.ok(seen[1].body.provider, 'OpenRouter keeps its ZDR routing');
});

// Why: the four core knobs (keepThreshold, maxStateTokens, maxRequestTokens,
// truncateHeadChars) were readable from the environment but had to reach the
// core to mean anything. A 0.6 answer sits between the two thresholds here, so
// a knob that is read and dropped on the floor shows up as "keeps either way".
test('compactAnthropic forwards the core knobs', async () => {
  const asker = (seen) => askerFor(async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: JSON.stringify({ answers: { call_t1: { noul: 0.6 }, result_t1: { noul: 0.6 } } }) };
  }, 'k');

  const lenient = [];
  const keptAt05 = await compactAnthropic({
    messages: anthropic, asker: asker(lenient),
    config: { pinLast: 1, minReductionChars: 1, keepThreshold: 0.5, truncateHeadChars: 7 },
  });
  const strict = [];
  const droppedAt08 = await compactAnthropic({
    messages: anthropic, asker: asker(strict),
    config: { pinLast: 1, minReductionChars: 1, keepThreshold: 0.8, truncateHeadChars: 7 },
  });

  // 0.6 >= 0.5 keeps the pair; 0.6 < 0.8 drops both call and result.
  assert.equal(keptAt05.reducedBy, 0, 'a lenient threshold must keep the pair');
  assert.ok(droppedAt08.reducedBy > 0, 'a strict threshold must drop the pair');

  // truncateHeadChars only shows when the call stays and the result goes, so
  // this answer keeps the call (1) and drops the result (0).
  const kept = [];
  const truncated = await compactAnthropic({
    messages: anthropic,
    asker: askerFor(async (url, init) => {
      kept.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: JSON.stringify({ answers: { call_t1: { noul: 1 }, result_t1: { noul: 0 } } }) };
    }, 'k'),
    config: { pinLast: 1, minReductionChars: 1, keepThreshold: 0.5, truncateHeadChars: 7 },
  });
  const body = JSON.stringify(truncated.messages);
  assert.ok(body.includes('x'.repeat(7)), '7 chars of head must survive');
  assert.ok(!body.includes('x'.repeat(8)), 'and no more than 7');
});
