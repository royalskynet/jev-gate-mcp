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
import { compact } from '../../agent-glue/vendor/fast-jev/index.js';
import { batchCalls, resolveOptions } from '../../agent-glue/vendor/fast-jev/compact.js';

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
    config: { pinLast: 1, minReductionChars: 1, keepThreshold: 0.5, truncateHeadChars: 7, askResult: true },
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

// Why: `result_#` ("keep this output verbatim") only changes the outcome for a
// call that is kept, and it is the longer question (66 vs 58 tokens), so asking
// the pair nearly halves how many calls fit one request — a compaction paid
// batches of Jev calls for an answer that, in 11,577 recorded teacher answers,
// never reached 0.5 (fix 10629). Splitting the passes costs one extra request,
// so it must only happen when it saves more than one. Both directions are
// silent and only show on the bill, hence an assertion per direction.
const KEEP = 't3';
const FOUR_CALLS = [
  { role: 'user', text: 'go', toolUses: [] },
  ...['t1', 't2', KEEP, 't4'].flatMap((id) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `/${id}` }, text: BIG }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: BIG }] },
  ]),
  ...TAIL_TEXT.map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: t, toolUses: [] })),
];

/** Records the questions of every request; keeps one call, drops every result. */
function spyAsker(asked) {
  return {
    async ask(_state, questions) {
      const keys = Object.keys(questions);
      asked.push(keys);
      return { answers: Object.fromEntries(keys.map((k) => [k, { noul: k === `call_${KEEP}` ? 1 : 0 }])) };
    },
  };
}

test('compact asks call_# first and result_# only for the calls it keeps', async () => {
  // Four calls only split into two passes when the questions are the binding
  // constraint, so the budget is narrowed to ~130 tokens of questions: one
  // pair, or two lone `call_#`. The state's own size is whatever fitState
  // makes it, so it is measured first rather than assumed.
  const probe = await compact(FOUR_CALLS, dropAsker, { preserveRecentMessages: 6 });
  const options = {
    keepThreshold: 0.5,
    preserveRecentMessages: 6,
    maxRequestTokens: probe.stats.stateTokens + 40 + 130,
    askResult: true,
  };

  const asked = [];
  const out = await compact(FOUR_CALLS, spyAsker(asked), options);

  const callPasses = asked.filter((keys) => keys.every((k) => k.startsWith('call_')));
  const resultPasses = asked.filter((keys) => keys.every((k) => k.startsWith('result_')));
  assert.equal(callPasses.length + resultPasses.length, asked.length, 'no request may mix the two questions');
  assert.equal(callPasses.length, 2, 'the lone call_# questions pack two to a request');
  assert.deepEqual(resultPasses.flat(), [`result_${KEEP}`], 'only the kept call earns a result_# question');
  assert.equal(out.stats.requests, asked.length);
  assert.equal(out.stats.requests, 3, 'three requests, where asking the pairs needs four');

  const byId = new Map(out.decisions.map((d) => [d.id, d]));
  assert.equal(byId.get(KEEP).action, 'drop_result', 'kept call, worthless result');
  for (const id of ['t1', 't2', 't4']) assert.equal(byId.get(id).action, 'drop_call', `${id} must go whole`);
});

// Why: result_# never reached 0.5 in 11,577 teacher answers (fix 10629), so by
// default it is not asked: a fixed 0 gives the same decisions for one request
// fewer whenever the pairs need more batches than the lone call_# questions.
test('compact does not ask result_# by default and decides the same', async () => {
  const probe = await compact(FOUR_CALLS, dropAsker, { preserveRecentMessages: 6 });
  const asked = [];
  const out = await compact(FOUR_CALLS, spyAsker(asked), {
    keepThreshold: 0.5,
    preserveRecentMessages: 6,
    maxRequestTokens: probe.stats.stateTokens + 40 + 130,
  });

  assert.ok(asked.flat().every((k) => k.startsWith('call_')), 'no result_# question is sent');
  assert.equal(out.stats.requests, 2, 'two requests, where asking result_# needs three');
  const byId = new Map(out.decisions.map((d) => [d.id, d]));
  assert.equal(byId.get(KEEP).action, 'drop_result', 'kept call, worthless result');
  for (const id of ['t1', 't2', 't4']) assert.equal(byId.get(id).action, 'drop_call', `${id} must go whole`);
});

test('compact keeps asking the pair when splitting the passes would cost a request', async () => {
  // Default budget: all four pairs fit one request, so a second pass would be
  // one request more than the whole job needs.
  const asked = [];
  const out = await compact(FOUR_CALLS, spyAsker(asked), { keepThreshold: 0.5, preserveRecentMessages: 6, askResult: true });

  assert.equal(out.stats.requests, 1, 'one request must stay one request');
  assert.deepEqual(asked.length, 1);
  assert.ok(asked[0].includes(`call_${KEEP}`) && asked[0].includes(`result_${KEEP}`), 'that request carries the pair');
  const byId = new Map(out.decisions.map((d) => [d.id, d]));
  assert.equal(byId.get(KEEP).action, 'drop_result');
});

// Why: the core budgeted 30k tokens per request, but Jev 1.13 takes 64k for
// state plus all questions — the 32k number in its docs limits state plus the
// *longest single* question, a different thing (docs.typesafe.ai/models).
// Conflating them split a 190-call compaction into three requests that each
// re-sent the same ~22k state. Both halves of the fix need holding down: the
// bigger request budget, and the state ceiling that the other limit still
// imposes however large that budget gets.
test('one request fits a real compaction, and the state keeps its own ceiling', () => {
  const options = resolveOptions({});
  const calls = Array.from({ length: 190 }, (_, i) => ({ id: `t${i}`, tool: 'Bash', resultChars: 4096 }));

  assert.equal(batchCalls(calls, 22_000, options, 'both').length, 1, '190 calls over a 22k state must be one request');
  assert.equal(batchCalls(calls, options.maxStateTokens, options, 'both').length, 1, 'and still one at the state cap');

  assert.equal(resolveOptions({ maxStateTokens: 60_000 }).maxStateTokens, 27_000, 'state cannot exceed the 32k state+question limit');
  assert.ok(options.maxRequestTokens <= 64_000, 'the request budget must stay under the documented 64k');
});
