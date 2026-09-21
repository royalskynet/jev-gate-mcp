import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triage,
  decideTier,
  sliceText,
  unwrapEnvelope,
  isDangerous,
  contextBucket,
  configFingerprint,
  textFeatures,
} from '../../agent-glue/src/triage.js';

/** A triage-shaped fake transport: canned answers per question key. */
function fakeTransport(answersByKey = {}, calls = []) {
  return {
    calls,
    async evaluate(input) {
      calls.push(input);
      const answers = {};
      for (const key of Object.keys(input?.questions ?? {})) answers[key] = answersByKey[key] ?? { type: 'score', confidence: 0.9 };
      return { answers, model: 'fake', coverage: 'complete', latency_ms: 5 };
    },
  };
}

const easy = () => ({ type: 'score', score: 0.5, probabilities: { 0: 0.3, 1: 0.55, 2: 0.15, 3: 0 }, confidence: 0.92 });
const hardScore = () => ({ type: 'score', score: 2.8, probabilities: { 0: 0, 1: 0, 2: 0.4, 3: 0.6 }, confidence: 0.91 });
const mediumConf = () => ({ type: 'score', score: 2.0, probabilities: { 2: 0.5, 3: 0.5 }, confidence: 0.4 });
const lowRisk = () => ({ type: 'noul', noul: 0.1 });

test('triage: one request carries all three questions (difficulty/kind/costly_mistake)', async () => {
  const calls = [];
  const t = fakeTransport(
    { difficulty: easy(), kind: { type: 'choice', choice: 'coding', probabilities: { coding: 0.9 }, confidence: 0.9 }, costly_mistake: lowRisk() },
    calls,
  );
  const out = await triage({ text: 'refactor the parser module', contextChars: 1000 }, { transport: t });
  assert.equal(calls.length, 1);
  const q = calls[0].questions;
  assert.deepEqual(Object.keys(q).sort(), ['costly_mistake', 'difficulty', 'kind'].sort());
  assert.equal(q.difficulty.type, 'score');
  assert.equal(q.kind.type, 'choice');
  assert.equal(q.costly_mistake.type, 'noul');
  assert.equal(out.specialty, 'coding');
  // easy + safe + confident -> cheapest tier (money saved)
  assert.equal(out.tier, 'cheap');
});

test('triage: confident & hard & safe -> hard tier', async () => {
  const t = fakeTransport({ difficulty: hardScore(), kind: { type: 'choice', choice: 'research', confidence: 0.9 }, costly_mistake: lowRisk() });
  const out = await triage({ text: 'design a new subsystem', contextChars: 40000 }, { transport: t });
  assert.equal(out.tier, 'hard');
});

test('triage: floor — low confidence & not dangerous -> status quo (no upgrade)', async () => {
  const t = fakeTransport({ difficulty: mediumConf(), costly_mistake: lowRisk() });
  const out = await triage({ text: 'tidy up the docs', contextChars: 1000 }, { transport: t });
  assert.equal(out.unchanged, true);
  assert.equal(out.tier, null);
});

test('triage: floor — low confidence but dangerous -> medium (never cheaper)', async () => {
  const t = fakeTransport({ difficulty: mediumConf(), costly_mistake: { type: 'noul', noul: 0.9 } });
  const out = await triage({ text: 'deploy the migration to production', contextChars: 1000 }, { transport: t });
  assert.equal(out.tier, 'medium');
});

test('triage: floor — risky (danger text) never lands on the cheapest tier even when easy', async () => {
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() });
  const out = await triage({ text: 'rm -rf the staging env after confirming', contextChars: 1000 }, { transport: t });
  assert.notEqual(out.tier, 'cheap');
  assert.equal(out.tier, 'medium');
});

test('triage: floor — stakes>0.4 never the cheapest tier', async () => {
  const t = fakeTransport({ difficulty: easy(), costly_mistake: { type: 'noul', noul: 0.5 } });
  const out = await triage({ text: 'rename the payment column', contextChars: 1000 }, { transport: t });
  assert.notEqual(out.tier, 'cheap');
});

test('triage: floor — large context never downgrades to the cheapest tier', async () => {
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() });
  const small = await triage({ text: 'quick formatting tweak', contextChars: 1000 }, { transport: t }); // s
  assert.equal(small.tier, 'cheap');
  const large = await triage({ text: 'quick formatting tweak', contextChars: 90000 }, { transport: t }); // l
  assert.notEqual(large.tier, 'cheap');
});

test('triage: floor — stakes>0.85 and hard-leaning -> hard', async () => {
  const t = fakeTransport({ difficulty: hardScore(), costly_mistake: { type: 'noul', noul: 0.9 } });
  const out = await triage({ text: 'rotate auth for prod and migrate the DB', contextChars: 2000 }, { transport: t });
  assert.equal(out.tier, 'hard');
});

test('triage: cache hit — same slice + same context bucket reuses (no second Jev call)', async () => {
  const calls = [];
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() }, calls);
  const cache = new Map();
  await triage({ text: 'fix the type error', contextChars: 1000 }, { transport: t, cache });
  const out2 = await triage({ text: 'fix the type error', contextChars: 1000 }, { transport: t, cache });
  assert.equal(calls.length, 1, 'second identical call must hit cache');
  assert.equal(out2.cached, true);
  assert.equal(out2.latency_ms, 0);
});

test('triage: cache MISS when the context bucket differs', async () => {
  const calls = [];
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() }, calls);
  const cache = new Map();
  await triage({ text: 'fix the type error', contextChars: 1000 }, { transport: t, cache }); // s
  await triage({ text: 'fix the type error', contextChars: 50000 }, { transport: t, cache }); // l
  assert.equal(calls.length, 2, 'a different context bucket must not reuse a small-context answer');
});

test('triage: features mode never sends the original text off-machine', async () => {
  const calls = [];
  const secretText = 'API_KEY=deadbeef1234 and here is the full original body';
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() }, calls);
  await triage({ text: secretText, contextChars: 1000, features: true }, { transport: t });
  const sent = JSON.stringify(calls[0]);
  assert.equal(sent.includes('deadbeef'), false, 'original text must not leave in features mode');
  assert.equal(sent.includes(secretText), false);
  assert.ok(sent.includes('features'), 'features state must be sent instead');
});

test('triage: sensitive profile forces features mode (no original text)', async () => {
  const calls = [];
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() }, calls);
  const out = await triage({ text: 'rotate the payment secret on prod', contextChars: 1000, profile: 'sensitive' }, { transport: t });
  assert.equal(out.featuresOnly, true);
  const sent = JSON.stringify(calls[0]);
  assert.equal(sent.includes('rotate the payment secret'), false);
});

test('triage: danger regex scans the FULL original text, not the slice', async () => {
  // The risk word sits at the very end, outside the first-1/4+last-3/4 slice edge
  // is still included in the tail, so build one where the word is in a section
  // that slicing keeps but which would be missed if we scanned the pre-unwrapped
  // schedule envelope. Concretely: the word is deep in a `previous output` block
  // that unwrapEnvelope would drop -> only a full-text scan (pre-unwrap) catches it.
  const calls = [];
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() }, calls);
  const long = 'a'.repeat(3000) + '\n## Previous Output\nall the old stuff with a PROD deploy line here\n';
  const out = await triage({ text: long, contextChars: 50000 }, { transport: t });
  assert.equal(out.notice, 'danger');
  assert.notEqual(out.tier, 'cheap');
  // And confirm the slice itself no longer contains the word (envelope dropped)
  const slice = sliceText(long);
  assert.equal(slice.includes('deploy'), false);
});

test('triage: transport failure fail-opens to status quo, never guesses', async () => {
  const broken = { async evaluate() { throw new Error('provider down'); } };
  const out = await triage({ text: 'hard open-ended redesign task', contextChars: 40000 }, { transport: broken });
  assert.equal(out.failOpen, true);
  assert.equal(out.unchanged, true);
  assert.equal(out.tier, null);
});

test('triage: free pre-gates spend no Jev call (empty text / pinned / no tiers)', async () => {
  const calls = [];
  const t = fakeTransport({ difficulty: easy(), costly_mistake: lowRisk() }, calls);
  await triage({ text: '' }, { transport: t });
  await triage({ text: '  ', contextChars: 1000 }, { transport: t });
  await triage({ text: 'x', pinned: true }, { transport: t });
  await triage({ text: 'x', tiers: [] }, { transport: t });
  assert.equal(calls.length, 0);
});

test('triage: default (no injected transport) fail-opens without throwing', async () => {
  const out = await triage({ text: 'something big and risky to do', contextChars: 40000 });
  assert.equal(out.failOpen, true);
  assert.equal(out.unchanged, true);
});

// --- pure helpers ---

test('triage helpers: envelope unwrap keeps Prompt/Task, drops previous output', () => {
  const s = unwrapEnvelope('## Task\nbuild it\n## Previous Output\nold deploy notes\n## Request\nredo');
  assert.match(s, /build it/);
  assert.match(s, /redo/);
  assert.doesNotMatch(s, /previous output/i);
});

test('triage helpers: slice is first 1/4 + last 3/4 of an overlong body', () => {
  const body = 'x'.repeat(4000);
  const s = sliceText(body, 1000);
  assert.equal(s.length, 1000 + 7); // 7 = '\n[...]\n'
  assert.ok(s.startsWith('x'.repeat(250)));
  assert.ok(s.endsWith('x'.repeat(750)));
});

test('triage helpers: isDangerous is case-insensitive over the full text', () => {
  assert.equal(isDangerous('Please DEPLOY to prod'), true);
  assert.equal(isDangerous('a harmless note'), false);
});

test('triage helpers: context bucket splits small/medium/large', () => {
  assert.equal(contextBucket(1000), 's');
  assert.equal(contextBucket(20000), 'm');
  assert.equal(contextBucket(90000), 'l');
});

test('triage helpers: config fingerprint changes when a threshold changes', () => {
  assert.notEqual(configFingerprint({ min_confidence: 0.5 }), configFingerprint({ min_confidence: 0.9 }));
});

test('decideTier is pure and floor-rules hold in isolation', () => {
  const tiers = ['cheap', 'medium', 'hard'];
  // no probabilities, easy score -> cheap
  assert.equal(decideTier({ difficulty: { score: 0.5, confidence: 0.95 }, costly_mistake: { noul: 0.1 } }, { tierNames: tiers }).tier, 'cheap');
  // danger forces >= medium regardless of easy difficulty
  assert.equal(decideTier({ difficulty: { score: 0.5, confidence: 0.95 }, costly_mistake: { noul: 0.1 } }, { tierNames: tiers, danger: true }).tier, 'medium');
  // stakes>0.4 floors off cheapest
  assert.equal(decideTier({ difficulty: { score: 0.5, confidence: 0.95 }, costly_mistake: { noul: 0.7 } }, { tierNames: tiers }).tier, 'medium');
  // stakes>0.85 + hard-leaning -> hard
  assert.equal(decideTier({ difficulty: hardScore(), costly_mistake: { noul: 0.9 } }, { tierNames: tiers }).tier, 'hard');
  // low confidence + not dangerous -> status quo (null)
  assert.equal(decideTier({ difficulty: { score: 2.0, confidence: 0.3 }, costly_mistake: { noul: 0.1 } }, { tierNames: tiers, danger: false }).tier, null);
});

test('textFeatures never leaks the original characters', () => {
  const f = textFeatures('function run() { }\n- step one\n- step two\nSECRETTOKEN');
  assert.ok(!JSON.stringify(f).includes('SECRETTOKEN'));
  assert.equal(f.has_code, true);
  assert.equal(f.steps, 2);
});

test('a difficulty answer with no score and no probabilities never reads as simple', () => {
  // A malformed/partial Jev answer used to clear the simple gate on the default
  // simpleProb and downgrade to the cheapest tier. Absent signal == status quo.
  const out = decideTier({ difficulty: { confidence: 0.95 }, costly_mistake: { noul: 0 } }, {});
  assert.equal(out.tier, null);
  assert.equal(out.notice, 'status-quo');
});
