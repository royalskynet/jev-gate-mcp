import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFacts, checkFacts, decisive } from './index.js';

const REPLY = [
  '五種協議各自要另外繳月費。',
  '500U 是整套方案的月費。',
  '我推論 CODE 卡片可能要另外收費。',
  '要不要問供應商？',
  '今天天氣很好呢。',
].join('\n');

test('selectFacts keeps amounts and obligations, drops labelled inferences and questions', () => {
  assert.deepEqual(selectFacts(REPLY), ['五種協議各自要另外繳月費。', '500U 是整套方案的月費。']);
});

test('selectFacts ignores code blocks and dedupes', () => {
  assert.deepEqual(selectFacts('```\n每月 10 USD\n```\n費用必須先付。\n費用必須先付。'), ['費用必須先付。']);
});

test('no evidence -> every fact is not_addressed without calling the verifier', async () => {
  let called = false;
  const r = await checkFacts({ text: REPLY, evidence: '', verify: async () => { called = true; } });
  assert.equal(called, false);
  assert.deepEqual(r.judged.map((j) => j.verdict), ['not_addressed', 'not_addressed']);
  assert.equal(r.decisive.claim, '五種協議各自要另外繳月費。');
});

test('verifier verdicts map back to the clean claim and the worst one is decisive', async () => {
  const seen = [];
  const verify = async ({ claims, evidence }) => {
    seen.push(...claims);
    assert.match(evidence, /自動選用/);
    return { claims: [{ verdict: 'contradicted', gate: 'auto' }, { verdict: 'supported', gate: 'auto' }] };
  };
  const r = await checkFacts({ text: REPLY, evidence: '系統自動選用合適的協議。帳單：Solution monthly commitment 500U', verify });
  assert.ok(seen.every((c) => c.includes('source-level claim')));
  assert.equal(r.judged[0].claim, '五種協議各自要另外繳月費。');
  assert.equal(r.decisive.verdict, 'contradicted');
});

test('verifier error is reported, never turned into a verdict', async () => {
  const r = await checkFacts({ text: REPLY, evidence: 'x', verify: async () => { throw new Error('boom'); } });
  assert.equal(r.error, 'boom');
  assert.equal(r.decisive, null);
});

test('no fact claim -> skipped', async () => {
  assert.equal((await checkFacts({ text: '今天天氣很好呢。' })).skipped, 'no_claim');
});

test('decisive ranks confident contradiction over not_addressed', () => {
  const j = [{ verdict: 'not_addressed', gate: 'auto' }, { verdict: 'contradicted', gate: 'review' }, { verdict: 'contradicted', gate: 'auto' }];
  assert.equal(decisive(j), j[2]);
});
