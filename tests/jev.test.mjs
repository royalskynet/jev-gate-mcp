/**
 * The two code-side rules in front of the judge, offline.
 *
 * Both exist because the model alone was measured to be wrong: `verdictOf`'s
 * floor because `confidence` is distribution concentration and gating on it
 * vetoed every real drop (§18.2), and `vetoOnTerms` because a chunk carrying a
 * term the request names came back "drop" with 0.92/0.84 on repeated runs
 * (§22.2). Keep the rules in code; the model only supplies the judgment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requestTerms, vetoOnTerms, verdictOf, CONFIG } from '../hooks/jev.js';

test('requestTerms keeps the searchable words only', () => {
  const t = requestTerms('Which commits touched prune? 有改到嗎');
  assert.ok(t.has('commits') && t.has('touched') && t.has('prune'));
  assert.ok(!t.has('which'.slice(0, 3)), 'sub-4-char noise stays out');
});

test('vetoOnTerms holds a drop whose chunk carries a discriminating term', () => {
  const chunks = ['commit abc touched prune.js', 'unrelated lockfile bytes'];
  const v = vetoOnTerms(['drop', 'drop'], chunks, requestTerms('which commits touched prune'));
  assert.deepEqual(v, ['unsure', 'drop'], 'only the chunk with the term is held');
});

test('vetoOnTerms ignores a term every chunk shares', () => {
  // A term in all chunks says nothing about which to keep. Vetoing on it held
  // the single clearest true drop in the calibration corpus.
  const chunks = ['worker heartbeat', 'worker heartbeat too'];
  assert.deepEqual(vetoOnTerms(['drop', 'drop'], chunks, requestTerms('worker log')), ['drop', 'drop']);
});

test('vetoOnTerms with one chunk vetoes on any hit', () => {
  assert.deepEqual(vetoOnTerms(['drop'], ['worker heartbeat'], requestTerms('worker log')), ['unsure']);
});

test('verdictOf gates on probabilities.drop, not confidence', () => {
  const t = CONFIG.minDropProbability;
  assert.equal(verdictOf({ choice: 'drop', probabilities: { drop: t }, confidence: 0.05 }), 'drop');
  assert.equal(verdictOf({ choice: 'drop', probabilities: { drop: t - 0.01 }, confidence: 0.99 }), 'unsure');
  assert.equal(verdictOf({ choice: 'drop' }), 'drop', 'a missing probabilities cannot silently disable pruning');
});
