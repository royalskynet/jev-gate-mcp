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
import { calibrationPath, DEFAULT_CALIBRATION_LOG, recordSample } from '../src/calibration.js';
import { harnessOnly, parseCalibrateInput, validateCalibrateInput } from '../scripts/calibrate.mjs';
import { FakeMode, makeFakeAdapter } from '../src/adapters.js';
import { JevGateway } from '../src/gateway.js';
import { loadRegistry } from '../src/registry.js';

const sample = (gate, over = {}) => ({
  policy: 'completion-claims',
  policy_version: 1,
  model: 'typesafe/jev-1.13',
  provider: 'openrouter',
  dataset_version: 'synthetic-harness-claims-v1',
  gate,
  coverage: 'complete',
  confidence: 0.8,
  state: { claims: 'done', evidence: 'none' },
  ...over,
});

test('corpus: a fake adapter\'s answers never enter the corpus', () => {
  // The bench harness drives the FakeMode adapter and wrote 10,200 samples into
  // the live sink against 1,553 real ones — calibrating on that file would be
  // calibrating on the fixtures. The sink refuses them, so no harness has to
  // remember an env var.
  // Refused for the live sink only, so nothing here can write to the real file.
  assert.equal(recordSample(sample('review', { provider: 'fake' }), DEFAULT_CALIBRATION_LOG), false);
  assert.equal(
    recordSample(sample('review', { provider: 'unknown', model: 'fake/jev-1.13' }), DEFAULT_CALIBRATION_LOG),
    false,
  );
  // A named path is a deliberate collection — harness tests below rely on it.
  const path = join(mkdtempSync(join(tmpdir(), 'jev-corpus-')), 'corpus.jsonl');
  assert.equal(recordSample(sample('review', { provider: 'fake' }), path), true);
});

test('corpus: the sink ships on, and `off` is the only way to stop it', () => {
  // Nothing set: collecting shadow samples is the point of shadow mode, so the
  // sink has to be on without anyone exporting anything.
  assert.equal(calibrationPath({}), DEFAULT_CALIBRATION_LOG);
  assert.match(DEFAULT_CALIBRATION_LOG, /jev-calibration\.jsonl$/);
  assert.equal(calibrationPath({ JEV_CALIBRATION_LOG: '/x/y.jsonl' }), '/x/y.jsonl');
  assert.equal(calibrationPath({ JEV_CALIBRATION_LOG: 'off' }), null, '`off` opts out');
  // A resolved-to-nothing path must still be a no-op, never a throw.
  assert.equal(recordSample(sample('review'), null), false);
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

// The whole point of collecting in shadow mode is being able to leave it. A
// live record stamped with the spec's `synthetic-harness-*` fixture version is
// harness-only forever, so the corpus would grow and stay ineligible.
test('corpus: a live sample is not harness-only, so it can actually be scored', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jev-cal-')), 'live.jsonl');
  const g = new JevGateway({ evaluateAdapter: makeFakeAdapter(FakeMode.SUCCESS), registry: loadRegistry() });
  const prev = process.env.JEV_CALIBRATION_LOG;
  process.env.JEV_CALIBRATION_LOG = path;
  try {
    const res = await g.applyPolicy({
      policy: 'intent-routing',
      state: { task: 'rename a helper', available_handlers: ['main', 'deep'], context: 'small' },
    });
    assert.ok(res.outcome);
  } finally {
    if (prev === undefined) delete process.env.JEV_CALIBRATION_LOG;
    else process.env.JEV_CALIBRATION_LOG = prev;
  }

  const rec = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0]);
  assert.equal(harnessOnly(undefined, rec.dataset_version), false, `still harness-only: ${rec.dataset_version}`);
  assert.equal(rec.dataset_version, 'live-intent-routing-v1');
  assert.equal(rec.label, null);
});

test('corpus: a wrapper object without a samples array is still rejected', () => {
  const parsed = parseCalibrateInput('{"foo":1,"bar":2}');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /samples array/);
});
