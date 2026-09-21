// The calibration CORPUS sink (src/calibration.js) — distinct from
// calibration.test.mjs, which covers calibration METADATA on a policy spec.
//
// The contract under test is that a captured corpus feeds scripts/calibrate.mjs
// without reshaping: that script is the consumer, this sink is the producer.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordSample } from '../src/calibration.js';
import { parseCalibrateInput, validateCalibrateInput } from '../scripts/calibrate.mjs';

const sample = (gate) => ({
  policy: 'completion-claims',
  policy_version: 1,
  model: 'fake/jev-1.13',
  provider: 'fake',
  dataset_version: 'synthetic-harness-claims-v1',
  gate,
  coverage: 'complete',
  confidence: 0.8,
  state: { claims: 'done', evidence: 'none' },
});

test('corpus: no path configured means no write and no throw', () => {
  assert.equal(recordSample(sample('review'), undefined), false);
  assert.equal(recordSample(sample('review'), ''), false);
});

test('corpus: an unwritable path degrades to false, never throws', () => {
  assert.equal(recordSample(sample('review'), '/nonexistent-dir-jev/corpus.jsonl'), false);
});

test('corpus: captured lines parse and validate as calibrate.mjs input', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jev-cal-')), 'corpus.jsonl');
  assert.equal(recordSample(sample('review'), path), true);
  assert.equal(recordSample(sample('deny'), path), true);

  const text = readFileSync(path, 'utf8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].label, null, 'label must start empty so a human fills it in');

  const parsed = parseCalibrateInput(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.provMismatch, [], 'provenance must agree across records');
  assert.equal(parsed.meta.policy, 'completion-claims');
  assert.equal(parsed.meta.dataset_version, 'synthetic-harness-claims-v1');

  // Unlabelled: calibrate.mjs must refuse it, so an untouched corpus can never
  // be mistaken for evidence.
  assert.equal(validateCalibrateInput(parsed.samples).ok, false);

  // Labelled: the same records become valid without any reshaping.
  const labelled = parsed.samples.map((s) => ({ ...s, label: 'review' }));
  const v = validateCalibrateInput(labelled);
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('corpus: a one-record corpus parses as JSONL, not as a malformed wrapper', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jev-cal-')), 'corpus.jsonl');
  assert.equal(recordSample(sample('review'), path), true);

  const parsed = parseCalibrateInput(readFileSync(path, 'utf8'));
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.samples.length, 1);
  assert.equal(parsed.meta.policy, 'completion-claims');
});

test('corpus: a wrapper object without a samples array is still rejected', () => {
  const parsed = parseCalibrateInput('{"foo":1,"bar":2}');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /samples array/);
});
