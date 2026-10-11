import test from 'node:test';
import assert from 'node:assert';
import { applyActivation, decisionQuality, policyDigests } from '../src/policy-controls.js';

test('decision quality: reports margin/entropy for Choice and variance for Score', () => {
  const choice = decisionQuality(
    { type: 'choice', criteria: { a: '', b: '', c: '' } },
    { probabilities: { a: 0.7, b: 0.2, c: 0.1 } },
  );
  assert.equal(choice.margin, 0.5);
  assert.ok(choice.entropy > 0 && choice.entropy < 1);
  assert.equal(choice.variance, null);

  const score = decisionQuality(
    { type: 'score', criteria: ['low', 'mid', 'high'] },
    { probabilities: { 0: 0.25, 1: 0.5, 2: 0.25 } },
  );
  assert.equal(score.variance, 0.5);
});

test('activation: accept needs calibration, allowlist, rollout, and stable request id', () => {
  const base = {
    id: 'p', version: 1, mode: 'active', calibration_status: 'calibrated',
    activation: { allow_outcomes: ['accept'], rollout_percent: 50, salt: 'v1' },
  };
  assert.equal(applyActivation('accept', { ...base, calibration_status: 'uncalibrated' }, 'r').outcome, 'review');
  assert.equal(applyActivation('accept', { ...base, activation: { ...base.activation, allow_outcomes: [] } }, 'r').outcome, 'review');
  assert.equal(applyActivation('accept', base, null).outcome, 'review');
  assert.deepEqual(applyActivation('accept', base, 'stable-id'), applyActivation('accept', base, 'stable-id'));
  assert.equal(applyActivation('deny', base, 'r').outcome, 'deny');
});

test('policy digest: key order does not change identity; policy content does', () => {
  const a = { id: 'p', version: 1, model: 'm', questions: { q: { type: 'noul' } }, mapping: {}, thresholds: {}, consequence: 'advisory', state_schema: {}, state_projection: ['x'], activation: {} };
  const b = { version: 1, id: 'p', questions: { q: { type: 'noul' } }, model: 'm', mapping: {}, thresholds: {}, consequence: 'advisory', state_projection: ['x'], state_schema: {}, activation: {} };
  assert.equal(policyDigests(a).policy_digest, policyDigests(b).policy_digest);
  assert.notEqual(policyDigests(a).policy_digest, policyDigests({ ...a, model: 'm2' }).policy_digest);
});
