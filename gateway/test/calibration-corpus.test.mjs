// The calibration CORPUS sink (src/calibration.js) — distinct from
// calibration.test.mjs, which covers calibration METADATA on a policy spec.
//
// The contract under test is that a captured corpus feeds scripts/calibrate.mjs
// without reshaping: that script is the consumer, this sink is the producer.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { calibrationPath, DEFAULT_CALIBRATION_DIR, defaultSink, recordSample } from '../src/calibration.js';
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
  const live = defaultSink('completion-claims');
  assert.equal(recordSample(sample('review', { provider: 'fake' }), live), false);
  assert.equal(
    recordSample(sample('review', { provider: 'unknown', model: 'fake/jev-1.13' }), live),
    false,
  );
  // A named path is a deliberate collection — harness tests below rely on it.
  const path = join(mkdtempSync(join(tmpdir(), 'jev-corpus-')), 'corpus.jsonl');
  assert.equal(recordSample(sample('review', { provider: 'fake' }), path), true);
});

test('corpus: the sink ships on, and `off` is the only way to stop it', () => {
  // Nothing set: collecting shadow samples is the point of shadow mode, so the
  // sink has to be on without anyone exporting anything.
  assert.equal(calibrationPath({}, 'diff-risk'), defaultSink('diff-risk'));
  assert.match(defaultSink('diff-risk'), /jev-calibration\/diff-risk\.jsonl$/);
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


// lib/replay.mjs recomposes RECORDED answers through the current policy: no
// provider call, and `state` is a placeholder, so nobody can ever fill in
// `label`. It echoes the real pinned model id, so the `fake/` check misses it.
// 2,258 of the live corpus's 2,266 records were these.
test('corpus: a replay echo never enters the live sink', () => {
  const replay = sample('review', {
    provider: 'unknown',
    model: 'typesafe/jev-1.13-20260917',
    state: 'decision replay; original state withheld',
  });
  assert.equal(recordSample(replay, defaultSink('completion-claims')), false);
  // A named path is somebody deliberately collecting; still allowed.
  const path = join(mkdtempSync(join(tmpdir(), 'jev-replay-')), 'c.jsonl');
  assert.equal(recordSample(replay, path), true);
});

// calibrate.mjs asserts per-record provenance AGREES across a JSONL file, and
// `policy` is one of those fields. One shared sink for five policies is
// therefore unscoreable however much real traffic it holds.
test('corpus: each policy gets its own default file, so provenance can agree', () => {
  assert.notEqual(defaultSink('diff-risk'), defaultSink('completion-claims'));
  for (const p of ['diff-risk', 'completion-claims']) {
    assert.ok(defaultSink(p).startsWith(`${DEFAULT_CALIBRATION_DIR}/`), p);
  }
  // A policy id is registry data, not user input, but it still becomes a
  // filename: no traversal out of the sink dir.
  assert.equal(dirname(defaultSink('../../etc/passwd')), DEFAULT_CALIBRATION_DIR);
});
