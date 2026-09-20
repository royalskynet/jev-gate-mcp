// Gateway Core unit tests: adapter failure space, strict validation, immutable
// registry, fail-safe gate, kill switch, and limits. Determines fail/deny
// behavior without needing a provider or a transport.
import test from 'node:test';
import assert from 'node:assert';
import { loadRegistry } from '../src/registry.js';
import { makeFakeAdapter, FakeMode } from '../src/adapters.js';
import { JevGateway, composeGate } from '../src/gateway.js';
import { ERR, LIMITS, killSwitchGlobal, resetRuntime } from '../src/core.js';

const registry = loadRegistry();
const QUESTIONS = {
  target: {
    type: 'choice',
    instructions: 'pick the best tier',
    criteria: { main: 'routine', deep: 'long', review: 'risky', no_match: 'none' },
  },
};

function gw(adapter) {
  return new JevGateway({ evaluateAdapter: adapter, registry });
}

test('evaluate: success is advisory with complete coverage and validated answers', async () => {
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  const r = await g.evaluate({ state: 'x', questions: QUESTIONS });
  assert.equal(r.outcome, 'advisory');
  assert.equal(r.coverage, 'complete');
  assert.equal(r.errors.length, 0);
  assert.equal(r.answers[0].answer.choice, 'main');
});

test('evaluate: malformed answer surfaces as typed error, not acceptance', async () => {
  const g = gw(makeFakeAdapter(FakeMode.MALFORMED, { failQuestionId: 'target' }));
  const r = await g.evaluate({ state: 'x', questions: QUESTIONS });
  assert.equal(r.coverage, 'incomplete');
  assert.ok(r.errors.some((e) => e.code === 'ERR_FOREIGN_CHOICE'));
});

test('evaluate: partial (missing) answer is typed error, never negative evidence', async () => {
  const g = gw(makeFakeAdapter(FakeMode.MISSING, { failQuestionId: 'target' }));
  const r = await g.evaluate({ state: 'x', questions: QUESTIONS });
  assert.equal(r.coverage, 'incomplete');
  assert.equal(r.errors[0].code, 'ERR_MISSING_ANSWER');
});

test('applyPolicy: incomplete coverage can never accept', async () => {
  const g = gw(makeFakeAdapter(FakeMode.MISSING, { failQuestionId: 'target' }));
  const r = await g.applyPolicy({ policy: 'intent-routing', state: 'x' });
  assert.equal(r.outcome, 'deny');
  assert.equal(r.coverage, 'incomplete');
  assert.equal(r.unavailable.code, 'ERR_MISSING_ANSWER');
});

test('applyPolicy: provider failure returns unavailable/deny, never fabricated accept', async () => {
  const g = gw(makeFakeAdapter(FakeMode.PROVIDER_FAILURE));
  const r = await g.applyPolicy({ policy: 'intent-routing', state: 'x' });
  assert.equal(r.outcome, 'deny');
  assert.equal(r.coverage, 'incomplete');
  assert.ok(r.unavailable.message.includes('upstream'));
});

test('applyPolicy: consequential policy can never auto-accept on low certainty', async () => {
  // score answer lands on a mid level -> not accept
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  const r = await g.applyPolicy({ policy: 'proposed-action-risk', state: { action: 'rm -rf /tmp/x' } });
  assert.notEqual(r.outcome, 'accept');
  assert.ok(['deny', 'escalate', 'review'].includes(r.outcome));
});

test('applyPolicy: high-certainty advisory policy accepts', async () => {
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  const r = await g.applyPolicy({ policy: 'completion-claims', state: 'evidence present' });
  assert.equal(r.outcome, 'accept');
  assert.equal(r.policy.id, 'completion-claims');
  assert.equal(r.policy.version, 1);
});

test('kill switch: global switch fails closed for evaluate and applyPolicy', async () => {
  resetRuntime();
  killSwitchGlobal();
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(() => g.evaluate({ state: 'x', questions: QUESTIONS }), (e) => e.code === 'ERR_KILL_SWITCH');
  await assert.rejects(() => g.applyPolicy({ policy: 'completion-claims', state: 'x' }), (e) => e.code === 'ERR_KILL_SWITCH');
  resetRuntime();
});

test('limits: too many questions are rejected, never truncated', async () => {
  const questions = {};
  for (let i = 0; i < LIMITS.maxQuestions + 1; i++) {
    questions['q' + i] = {
      type: 'noul',
      instructions: 'yes?',
      criteria: { true: 'y', false: 'n' },
    };
  }
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(() => g.evaluate({ state: 'x', questions }), (e) => e.code === 'ERR_BAD_REQUEST');
});

test('strict schema: caller cannot override policy thresholds/model/composition', async () => {
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(
    () => g.applyPolicy({ policy: 'completion-claims', state: 'x', thresholds: { auto: 0.1, review: 0.05 } }),
    (e) => e.code === 'ERR_BAD_REQUEST',
  );
});

test('registry: released policy specs are deep-frozen (immutable)', async () => {
  const spec = registry.resolve('completion-claims', 1);
  assert.throws(() => { spec.thresholds = { auto: 0.1 }; });
  assert.throws(() => { spec.questions.supported = null; });
});

test('registry: unknown version selection fails loudly', async () => {
  assert.throws(() => registry.resolve('completion-claims', 99), (e) => e.code === 'ERR_BAD_REQUEST');
});

test('composeGate: most conservative signal wins', () => {
  const policy = { consequence: 'advisory', thresholds: { auto: 0.9, review: 0.6 } };
  assert.equal(composeGate([{ confidence: 0.95 }], policy), 'accept');
  assert.equal(composeGate([{ confidence: 0.7 }], policy), 'review');
  assert.equal(composeGate([{ confidence: 0.4 }], policy), 'escalate');
  // consequential policy starts at escalate; a confident signal can still only reach review
  const conc = { consequence: 'irreversible', thresholds: { auto: 0.9, review: 0.6 } };
  assert.equal(composeGate([{ confidence: 0.95 }], conc), 'review');
});
