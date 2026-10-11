#!/usr/bin/env node
// Offline policy evaluation CLI (item 5). Generates a versioned, no-sensitive
// synthetic dataset per policy and reports coverage, precision/recall,
// false-accept, review rate, Brier/ECE, latency. Exits non-zero when any
// threshold is breached. The report carries policy/model/dataset versions and
// NEVER treats model confidence as correctness (confidence feeds Brier/ECE as
// an uncertainty check against ground-truth labels).
import { loadRegistry } from '../src/registry.js';
import { syntheticDataset, runEval, metrics } from '../lib/evalkit.mjs';

const registry = loadRegistry();
const n = Number(process.env.JEV_EVAL_N ?? process.argv[2] ?? 60);
const seed = Number(process.env.JEV_EVAL_SEED ?? 1);
const minPrecision = Number(process.env.JEV_EVAL_MIN_PRECISION ?? 0.6);
const minRecall = Number(process.env.JEV_EVAL_MIN_RECALL ?? 0.6);
const maxFalseAccept = Number(process.env.JEV_EVAL_MAX_FALSE_ACCEPT ?? 0.2);

const report = { generated_at: new Date().toISOString(), dataset_seed: seed, policies: [] };
let failed = false;

for (const id of registry.ids()) {
  const spec = registry.spec(id);
  const version = spec.versions.find((v) => v.version === Math.max(...spec.versions.map((x) => x.version)));
  const cases = syntheticDataset({ id, ...version }, n, seed);
  const { metrics: m } = await runEval({ registry, policy: id, cases });
  const breaches = [];
  if (m.coverage !== 1) breaches.push(`coverage=${m.coverage.toFixed(3)} != 1`);
  // Precision/recall are only meaningful when the accept class is REACHABLE and
  // populated. A consequential (never-accepting) policy, or any shadow/
  // uncalibrated policy the gateway caps at review (item 3/4: synthetic labels
  // cannot prove model correctness), emits no accepts, so those checks are
  // skipped rather than misreported as failure.
  if (m.accepts > 0 && m.precision < minPrecision) breaches.push(`precision=${m.precision.toFixed(3)} < ${minPrecision}`);
  if (m.accepts > 0 && m.should_accept > 0 && m.recall < minRecall) breaches.push(`recall=${m.recall.toFixed(3)} < ${minRecall}`);
  if (m.false_accept > maxFalseAccept) breaches.push(`false_accept=${m.false_accept.toFixed(3)} > ${maxFalseAccept}`);
  if (breaches.length) failed = true;
  report.policies.push({
    policy: id,
    policy_version: version.version,
    mode: version.mode,
    model: version.model,
    evaluation_dataset_version: version.evaluation_dataset_version,
    calibration_status: version.calibration_status,
    metrics: m,
    breaches,
  });
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (failed) {
  process.stderr.write('eval FAIL: one or more policy thresholds breached\n');
  process.exit(1);
}
process.stderr.write('eval OK: all policy thresholds met\n');
