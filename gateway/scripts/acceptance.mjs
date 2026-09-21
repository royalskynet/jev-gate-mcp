#!/usr/bin/env node
// Offline acceptance (items 2-9) tied into one deterministic, no-key run that
// `npm run gateway:acceptance` invokes. Re-runs the executable CLIs (not just
// their unit tests) so the shipped entry points themselves are proven to pass:
//   - policy eval thresholds (coverage/precision/recall/false-accept/review/Brier/ECE)
//   - drift stable -> pass, drift shifted -> non-pass, malformed -> hard error
//   - tool-selection eval config validated offline (no key)
//   - processing-overhead benchmark p95 < 50ms (core and transport)
// Everything here is offline and deterministic; live smoke/tool-eval stay opt-in.
import { loadRegistry } from '../src/registry.js';
import { syntheticDataset, runEval, metrics } from '../lib/evalkit.mjs';
import { benchCore, benchTransport } from '../lib/bench.mjs';
import { buildDataset, validateEvalConfig } from './tool-eval.mjs';
import { driftReport } from '../lib/evalkit.mjs';
import { runCalibration } from './calibrate.mjs';

const LIMIT_MS = 50;
let failed = false;
const fail = (m) => { failed = true; process.stderr.write('ACCEPTANCE FAIL: ' + m + '\n'); };

// --- 5. policy eval thresholds ---
{
  const registry = loadRegistry();
  for (const id of registry.ids()) {
    const spec = registry.spec(id);
    const version = spec.versions.find((v) => v.version === Math.max(...spec.versions.map((x) => x.version)));
    const cases = syntheticDataset({ id, ...version }, 60, 1);
    const { metrics: m } = await runEval({ registry, policy: id, cases });
    if (m.coverage !== 1) fail(`${id}: coverage ${m.coverage} != 1`);
    // shadow/uncalibrated starter policies are capped at review by the gateway,
    // so the accept class is unreachable and precision/recall/false-accept are
    // harness-only (synthetic labels cannot prove model correctness — item 3).
    if (m.accepts > 0 && m.precision < 0.6) fail(`${id}: precision ${m.precision} < 0.6`);
    if (m.accepts > 0 && m.should_accept > 0 && m.recall < 0.6) fail(`${id}: recall ${m.recall} < 0.6`);
    if (m.accepts > 0 && m.false_accept > 0.2) fail(`${id}: false_accept ${m.false_accept} > 0.2`);
  }
}

// --- 6. drift fixtures ---
{
  const fs = await import('node:fs');
  const load = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
  const base = load('../fixtures/drift-baseline.json');
  const stable = driftReport(base, load('../fixtures/drift-stable.json'));
  if (stable.status !== 'pass') fail(`drift stable should pass: ${stable.status}`);
  const shifted = driftReport(base, load('../fixtures/drift-shifted.json'));
  if (shifted.status !== 'non-pass') fail(`drift shifted should be non-pass: ${shifted.status}`);
  const malformed = JSON.parse(fs.readFileSync(new URL('../fixtures/drift-malformed.json', import.meta.url), 'utf8'));
  if (Array.isArray(malformed)) fail('drift malformed fixture must not be an array');
}

// --- 7. tool-selection eval config offline ---
{
  const cfg = validateEvalConfig(buildDataset());
  if (!cfg.ok) fail('tool-eval config: ' + cfg.errors.join('; '));
}

// --- 7b. calibration CLI: external labeled fixture -> report; synthetic marked
// harness-only; invalid input is a hard error; never set calibrated. ---
{
  const fs = await import('node:fs');
  const here = new URL('.', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, here), 'utf8');
  const { registry } = { registry: loadRegistry() };
  const ext = runCalibration({ text: read('../fixtures/calibration-external.json'), registry, source: 'external' });
  if (!ext.ok) fail('calibrate external: ' + (ext.error ?? ext.problems?.join('; ')));
  if (ext.calibrated) fail('calibrate external: must never mark calibrated');
  if (ext.metrics.coverage !== 1) fail(`calibrate external: coverage ${ext.metrics.coverage} != 1`);
  if (ext.meets_thresholds !== true) fail('calibrate external JSON: must meet thresholds: ' + ext.breaches.join('; '));
  const extl = runCalibration({ text: read('../fixtures/calibration-external.jsonl'), registry, source: 'external' });
  if (!extl.ok) fail('calibrate external JSONL: ' + (extl.error ?? extl.problems?.join('; ')));
  if (!extl.meets_thresholds) fail('calibrate external JSONL: must meet thresholds: ' + extl.breaches.join('; '));
  if (!extl.eligible_for_review) fail('calibrate external JSONL: must be eligible_for_review');
  const bad = runCalibration({ text: read('../fixtures/calibration-bad-metrics.jsonl'), registry, source: 'external' });
  if (!bad.ok) fail('calibrate bad-metrics: ' + (bad.error ?? bad.problems?.join('; ')));
  if (bad.meets_thresholds) fail('calibrate bad-metrics: must NOT meet thresholds');
  if (bad.eligible_for_review) fail('calibrate bad-metrics: must NOT be eligible for review');
  const mixed = runCalibration({ text: read('../fixtures/calibration-mixed-provenance.jsonl'), registry, source: 'external' });
  if (mixed.ok || mixed.stage !== 'provenance') fail('calibrate mixed provenance: must fail at provenance stage');
  const synth = runCalibration({ text: read('../fixtures/calibration-synthetic.json'), registry, source: 'synthetic' });
  if (!synth.ok) fail('calibrate synthetic: ' + (synth.error ?? synth.problems?.join('; ')));
  if (!synth.harness_only) fail('calibrate synthetic: must be flagged harness-only');
  if (synth.eligible_for_review) fail('calibrate synthetic: must NOT be eligible for review');
  const invalid = runCalibration({ text: read('../fixtures/calibration-invalid.jsonl'), registry, source: 'external' });
  if (invalid.ok || invalid.stage !== 'parse') fail('calibrate invalid: malformed JSONL must fail at parse stage');
}

// --- 9. processing-overhead benchmark ---
{
  const core = await benchCore(300, 40);
  const transport = await benchTransport(150, 20);
  if (core.p95_ms >= LIMIT_MS) fail(`core p95 ${core.p95_ms} >= ${LIMIT_MS}ms`);
  if (transport.p95_ms >= LIMIT_MS) fail(`transport p95 ${transport.p95_ms} >= ${LIMIT_MS}ms`);
}

if (failed) {
  process.stderr.write('gateway acceptance: FAIL\n');
  process.exit(1);
}
process.stderr.write('gateway acceptance: OK (eval, drift, tool-eval config, bench offline)\n');
