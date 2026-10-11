// Eval + drift fixtures (items 5/6): deterministic synthetic datasets with no
// sensitive state; metrics (coverage, precision/recall, false-accept, review
// rate, Brier/ECE); drift report over stable / drifted / insufficient /
// malformed samples.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  syntheticDataset, labelledAnswers, metrics, brier, ece,
  jensenShannon, psi, driftReport,
} from '../lib/evalkit.mjs';
import { loadRegistry } from '../src/registry.js';
import { composeGate } from '../src/gateway.js';

const registry = loadRegistry();
const spec = { id: 'completion-claims', ...registry.resolve('completion-claims') };

test('synthetic dataset: deterministic, versioned label space, no sensitive state', () => {
  const a = syntheticDataset(spec, 60, 7);
  const b = syntheticDataset(spec, 60, 7);
  assert.deepEqual(a, b, 'same seed must produce identical cases');
  assert.equal(a.length, 60);
  for (const c of a) {
    assert.match(c.state, /^case::/, 'state must be an opaque token, not sensitive content');
    assert.ok(!/pytest|secret|key/.test(c.state), 'no sensitive value in state');
    assert.ok(['accept', 'review', 'escalate', 'deny'].includes(c.label));
  }
});

test('labelledAnswers composes to the requested gate', () => {
  // completion-claims: supported=true -> accept. Verify a labelled accept
  // actually composes to accept when run through composeGate.
  const answers = labelledAnswers(spec, 'accept', 0.95);
  const qid = Object.keys(spec.questions)[0];
  const perQ = [{ question: qid, answer: answers[qid], confidence: 0.95, map: spec.mapping[qid] }];
  assert.equal(composeGate(perQ, spec), 'accept');
});

test('metrics: coverage, precision/recall, false-accept, review, brier, ece', () => {
  const samples = [
    { label: 'accept', gate: 'accept', confidence: 0.9, coverage: 'complete', correct: true },
    { label: 'accept', gate: 'accept', confidence: 0.8, coverage: 'complete', correct: true },
    { label: 'deny', gate: 'accept', confidence: 0.9, coverage: 'complete', correct: false },
    { label: 'deny', gate: 'deny', confidence: 0.85, coverage: 'complete', correct: true },
    { label: 'accept', gate: 'review', confidence: 0.6, coverage: 'incomplete', correct: false },
    { label: 'deny', gate: 'review', confidence: 0.5, coverage: 'complete', correct: false },
  ];
  // The incomplete sample is excluded from `done`, so accepts/shouldReview are
  // computed over complete cases only.
  const m = metrics(samples);
  assert.equal(m.n, 6);
  assert.equal(m.coverage, 5 / 6);
  assert.equal(m.accepts, 3);
  assert.equal(m.precision, 2 / 3); // 2 correct accepts / 3 accepts (a3 is a false accept)
  assert.equal(m.recall, 1);        // 2 correct / 2 should-accept among complete cases
  assert.equal(m.false_accept, 1 / 6);
  assert.equal(m.review_rate, 1 / 6); // only a6 (complete) is a review
  assert.ok(m.brier >= 0 && m.brier < 1);
  assert.ok(m.ece >= 0 && m.ece <= 1);
});

test('brier/ece: well-calibrated probabilities have near-zero error', () => {
  const okay = [
    ...Array.from({ length: 10 }, () => ({ confidence: 1.0, correct: true })),
    ...Array.from({ length: 10 }, () => ({ confidence: 0.0, correct: false })),
  ];
  assert.ok(ece(okay) < 0.05, 'well-calibrated set must have low ECE');
  assert.ok(brier(okay) < 0.03, 'well-calibrated set must have low Brier');
});

test('jensenShannon and psi are symmetric and zero for identical distributions', () => {
  const d = { accept: 0.5, review: 0.3, deny: 0.2 };
  assert.equal(jensenShannon(d, d), 0);
  assert.equal(psi(d, d), 0);
  assert.ok(jensenShannon({ a: 1 }, { b: 1 }) > 0, 'disjoint distributions diverge');
});

function sample(gate, conf, correct = true) {
  return { label: gate, gate, confidence: conf, coverage: 'complete', correct };
}

test('drift: stable outcome distribution passes', () => {
  const base = ['accept', 'review', 'deny', 'accept'].flatMap((g) => Array.from({ length: 15 }, () => sample(g, 0.85)));
  const cur = [...base];
  const r = driftReport(base, cur);
  assert.equal(r.status, 'pass');
  assert.ok(r.outcome_js < 0.001);
});

test('drift: shifted outcome distribution is non-pass', () => {
  const base = ['accept', 'review', 'deny'].flatMap((g) => Array.from({ length: 30 }, () => sample(g, 0.85)));
  const cur = ['deny', 'deny', 'esc'].flatMap((g) => g === 'esc' ? Array.from({ length: 40 }, () => sample('escalate', 0.85)) : Array.from({ length: 25 }, () => sample(g, 0.85)));
  const r = driftReport(base, cur);
  assert.equal(r.status, 'non-pass');
});

test('drift: insufficient samples is non-pass (unknown must not pass)', () => {
  const small = Array.from({ length: 10 }, () => sample('accept', 0.85));
  const r = driftReport(small, small);
  assert.equal(r.status, 'non-pass');
  assert.ok(r.reasons.some((x) => x.includes('insufficient_samples')));
});

test('drift: confidence calibration shift flags drift', () => {
  const base = Array.from({ length: 40 }, () => sample('accept', 0.9));
  const cur = Array.from({ length: 40 }, () => ({ label: 'accept', gate: 'review', confidence: 0.4, coverage: 'complete', correct: true }));
  const r = driftReport(base, cur);
  assert.equal(r.status, 'non-pass');
});
