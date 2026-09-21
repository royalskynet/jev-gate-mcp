import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeTransport, makeGatewayTransport, safeCall } from '../../agent-glue/src/client.js';

test('client: fake transport never hits network and surfaces bounded answers', async () => {
  const t = makeFakeTransport({ choice: 'keep', confidence: 0.9 });
  const out = await t.evaluate({ state: { secret: 'x' }, questions: { q: { type: 'choice', instructions: 'i', criteria: {} } } });
  assert.deepEqual(Object.keys(out.answers), ['q']);
  assert.equal(out.answers.q.choice, 'keep');
  // The secret state is not echoed back in the bounded output.
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].keys[0], 'q');
});

test('client: fake applyPolicy is advisory, shadow, uncalibrated', async () => {
  const t = makeFakeTransport();
  const out = await t.applyPolicy({ policy: 'diff-risk', state: { diff: 'x' } });
  assert.equal(out.mode, 'shadow');
  assert.equal(out.calibration_status, 'uncalibrated');
  assert.equal(out.policy, 'diff-risk');
});

test('client: safeCall maps a throwing transport to a typed fail-open, never throws', async () => {
  const t = { async evaluate() { throw new Error('provider down'); } };
  const out = await safeCall(t, 'evaluate', { state: {}, questions: {} });
  assert.equal(out.error.code, 'ERR_CLIENT');
});

test('client: gateway transport surfaces bounded applyPolicy fields', async () => {
  const fakeGateway = {
    async applyPolicy(input) {
      return { outcome: 'review', reasons: ['r'], policy: input.policy, version: '1', calibration_status: 'uncalibrated', mode: 'shadow', raw: 'never-exposed' };
    },
    async evaluate() { throw new Error('not used'); },
  };
  const t = makeGatewayTransport(fakeGateway);
  const out = await t.applyPolicy({ policy: 'completion-claims', state: {} });
  assert.equal(out.outcome, 'review');
  assert.equal(out.mode, 'shadow');
  assert.equal(JSON.stringify(out).includes('never-exposed'), false, 'raw server fields are not surfaced');
});
