// Calibration CLI (item 5): offline parser/threshold/provenance/invalid-input
// checks against real fixture files. The CLI reads EXTERNAL labeled outcomes/
// predictions, never writes a policy, and marks synthetic sources harness-only.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../src/registry.js';
import {
  parseCalibrateInput, validateCalibrateInput, verifyProvenance,
  runCalibration, harnessOnly,
} from '../scripts/calibrate.mjs';

const registry = loadRegistry();
const here = fileURLToPath(new URL('.', import.meta.url));
const fix = (f) => fs.readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8');

test('calibrate: external JSON fixture parses, validates, and yields metrics', () => {
  const rep = runCalibration({ text: fix('calibration-external.json'), registry, source: 'external', flags: {} });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(rep.calibrated, false, 'calibration CLI must never mark a policy calibrated');
  assert.equal(rep.harness_only, false, 'external labels are not harness-only');
  assert.equal(rep.provenance.model, 'typesafe/jev-1.13-20260917');
  assert.equal(rep.metrics.n, 30);
  assert.equal(rep.metrics.coverage, 1);
  assert.ok(rep.metrics.precision === 1, 'all accepts correct -> precision 1');
  assert.equal(rep.meets_thresholds, true, 'external labels meeting thresholds pass');
  assert.equal(rep.eligible_for_review, true, 'external labels meeting thresholds are eligible for review');
});

test('calibrate: valid external JSONL (per-record provenance) passes and is eligible for review', () => {
  const rep = runCalibration({ text: fix('calibration-external.jsonl'), registry, source: 'external', flags: {} });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(rep.harness_only, false);
  assert.equal(rep.calibrated, false);
  assert.equal(rep.metrics.n, 30);
  assert.equal(rep.meets_thresholds, true, 'valid JSONL must meet thresholds');
  assert.equal(rep.eligible_for_review, true);
  assert.equal(rep.provenance.dataset_version, 'label-claims-v3', 'provenance aggregated across records');
});

test('calibrate: bad-metrics external fixture computes breaches and is non-pass', () => {
  const rep = runCalibration({ text: fix('calibration-bad-metrics.jsonl'), registry, source: 'external', flags: {} });
  assert.equal(rep.ok, true);
  assert.equal(rep.meets_thresholds, false, 'bad metrics must not meet thresholds');
  assert.equal(rep.eligible_for_review, false);
  assert.ok(rep.breaches.some((b) => b.includes('precision')), 'precision breach present');
  assert.ok(rep.breaches.some((b) => b.includes('false_accept')), 'false_accept breach present');
});

test('calibrate: mixed per-record provenance is a provenance-stage failure', () => {
  const rep = runCalibration({ text: fix('calibration-mixed-provenance.jsonl'), registry, source: 'external', flags: {} });
  assert.equal(rep.ok, false);
  assert.equal(rep.stage, 'provenance');
  assert.match(rep.error, /mixed provenance/);
});

test('calibrate: synthetic-harness source is explicitly harness-only', () => {
  const rep = runCalibration({ text: fix('calibration-synthetic.json'), registry, source: 'synthetic', flags: {} });
  assert.equal(rep.ok, true);
  assert.equal(rep.harness_only, true, 'synthetic source must be flagged harness-only');
  assert.equal(rep.eligible_for_review, false, 'synthetic is never eligible for review');
  assert.equal(rep.calibrated, false);
  assert.equal(harnessOnly('synthetic', 'synthetic-harness-claims-v1'), true);
  assert.equal(harnessOnly('external', 'label-claims-v3'), false);
  assert.equal(harnessOnly('demo', 'demo-claims-v1'), true, 'demo is harness-only');
});

test('calibrate: invalid JSONL is a parse-stage failure', () => {
  const rep = runCalibration({ text: fix('calibration-invalid.jsonl'), registry, source: 'external', flags: {} });
  assert.equal(rep.ok, false);
  assert.equal(rep.stage, 'parse');
});

test('calibrate: bad gate is a validate-stage failure', () => {
  const parsed = parseCalibrateInput('{"policy":"completion-claims","model":"typesafe/jev-1.13-20260917","provider":"openrouter","dataset_version":"dv1","samples":[{"label":"accept","gate":"not-a-gate","confidence":0.9,"coverage":"complete"}]}');
  assert.equal(parsed.ok, true);
  const v = validateCalibrateInput(parsed.samples);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('gate')));
});

test('calibrate: provenance mismatch (wrong pinned model) is rejected', () => {
  const parsed = parseCalibrateInput(fix('calibration-external.json'));
  const prov = verifyProvenance(
    { ...parsed.meta, model: 'some/other-model' }, registry, {});
  assert.equal(prov.ok, false);
  assert.ok(prov.problems.some((p) => p.includes('pinned')));
});

test('calibrate: missing provenance is rejected', () => {
  const prov = verifyProvenance({ samples: [] }, registry, {});
  assert.equal(prov.ok, false);
  assert.ok(prov.problems.length >= 1);
});
