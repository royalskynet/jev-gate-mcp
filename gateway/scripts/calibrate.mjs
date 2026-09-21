#!/usr/bin/env node
// Calibration CLI (item 5). Reads EXTERNAL labeled outcomes/predictions — real
// target-domain labels, never synthetic/generated-matching answers — validates
// the policy/model/provider/dataset-version provenance, computes the metrics,
// and emits a calibration report with configurable thresholds. It NEVER writes
// or mutates a policy file, so it can never mark a policy calibrated; a
// `synthetic`/`demo` source (or a `synthetic-harness-*` dataset version) is
// explicitly flagged harness-only and never eligible for review.
//
// Input (JSON or JSONL):
//   JSON object : { policy, policy_version?, model?, provider?, dataset_version?,
//                   samples: [ { label, gate, confidence, coverage } ] }
//   JSON array  : [ { label, gate, confidence, coverage, ... } ] — provenance
//                  taken from CLI flags.
//   JSONL       : one record per line; per-record provenance (policy/
//                  policy_version/model/provider/dataset_version) is extracted
//                  and must agree across all records.
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../src/registry.js';
import { metrics } from '../lib/evalkit.mjs';

const GATES = new Set(['accept', 'review', 'escalate', 'deny']);
const PROV_FIELDS = ['policy', 'policy_version', 'model', 'provider', 'dataset_version'];

const DEFAULT_THRESHOLDS = {
  minSamples: 30,
  minCoverage: 1,
  minPrecision: 0.6,
  minRecall: 0.6,
  maxFalseAccept: 0.2,
  maxEce: 0.2, // ponytail: ECE < 0.2 is a common "reasonable calibration" bar
};

/**
 * Parse a JSON / JSONL / bare-array external file into { meta, samples }.
 * A leading `{` may be a single JSON object OR the first record of a JSONL
 * stream; prefer the single object, and only when it fails (trailing records)
 * fall back to line-by-line JSONL with per-record provenance.
 */
export function parseCalibrateInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty input' };
  const first = trimmed[0];
  if (first === '[') {
    return { ok: true, meta: null, samples: JSON.parse(trimmed) };
  }
  if (first === '{') {
    let doc = null;
    try { doc = JSON.parse(trimmed); } catch { /* not a single object; try JSONL */ }
    if (doc) {
      if (!Array.isArray(doc.samples)) return { ok: false, error: 'JSON object must contain a samples array' };
      return { ok: true, meta: doc, samples: doc.samples };
    }
    // JSONL: one record per non-empty line, per-record provenance must agree.
    const samples = [];
    const meta = {};
    const seen = {};
    const mismatch = [];
    const lines = trimmed.split('\n').filter((l) => l.trim());
    if (!lines.length) return { ok: false, error: 'empty input' };
    for (let i = 0; i < lines.length; i++) {
      let r;
      try { r = JSON.parse(lines[i]); } catch (e) { return { ok: false, error: `line ${i + 1}: ${e.message}` }; }
      const sample = {};
      for (const [k, v] of Object.entries(r)) {
        if (PROV_FIELDS.includes(k)) {
          if (!(k in seen)) { seen[k] = v; meta[k] = v; }
          else if (String(seen[k]) !== String(v)) mismatch.push(`${k} line ${i + 1}: ${seen[k]} != ${v}`);
        } else sample[k] = v;
      }
      samples.push(sample);
    }
    return { ok: true, meta, samples, provMismatch: mismatch };
  }
  return { ok: false, error: `unexpected leading character '${first}'` };
}

/** Validate each sample's shape (the same contract metrics() consumes). */
export function validateCalibrateInput(samples) {
  const errors = [];
  if (!Array.isArray(samples) || samples.length === 0) return { ok: false, errors: ['samples must be a non-empty array'] };
  for (const [i, s] of samples.entries()) {
    if (!s || typeof s !== 'object') { errors.push(`sample[${i}]: must be an object`); continue; }
    if (!GATES.has(s.label)) errors.push(`sample[${i}]: label must be one of accept|review|escalate|deny`);
    if (!GATES.has(s.gate)) errors.push(`sample[${i}]: gate must be one of accept|review|escalate|deny`);
    if (!['complete', 'incomplete'].includes(s.coverage)) errors.push(`sample[${i}]: coverage must be complete|incomplete`);
    if (s.confidence != null && (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1)) {
      errors.push(`sample[${i}]: confidence must be null or a number in 0..1`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Verify provenance against the registry (when a policy is resolvable) and
 * require model/provider/dataset_version to be declared.
 */
export function verifyProvenance(meta, registry, flags = {}) {
  const prov = {
    policy: (meta?.policy ?? flags.policy) ?? null,
    policy_version: (meta?.policy_version ?? flags.policyVersion) ?? null,
    model: (meta?.model ?? flags.model) ?? null,
    provider: (meta?.provider ?? flags.provider) ?? null,
    dataset_version: (meta?.dataset_version ?? flags.datasetVersion) ?? null,
  };
  const problems = [];
  for (const [k, v] of Object.entries(prov)) if (!v) problems.push(`${k} required (file meta or --${k.replace(/_/g, '-')})`);
  if (prov.policy && problems.length === 0) {
    try {
      const spec = registry.spec(prov.policy);
      const v = spec?.versions?.find((x) => String(x.version) === String(prov.policy_version ?? Math.max(...spec.versions.map((y) => y.version))));
      if (v && prov.model && v.model !== prov.model) problems.push(`model ${prov.model} != pinned ${v.model} for ${prov.policy}`);
    } catch {
      problems.push(`policy ${prov.policy} not resolvable`);
    }
  }
  return { ok: problems.length === 0, provenance: prov, problems };
}

export function harnessOnly(source, datasetVersion) {
  return source === 'synthetic' || source === 'demo' || /^synthetic(-harness)?-/.test(datasetVersion ?? '');
}

/** Resolve calibration thresholds, CLI flags win over env, env wins over default. */
export function resolveThresholds(flags = {}) {
  const num = (v, def) => (v === undefined || v === null || v === '' ? def : Number(v));
  return {
    minSamples: num(flags.minSamples ?? process.env.JEV_CAL_MIN_SAMPLES, DEFAULT_THRESHOLDS.minSamples),
    minCoverage: num(flags.minCoverage ?? process.env.JEV_CAL_MIN_COVERAGE, DEFAULT_THRESHOLDS.minCoverage),
    minPrecision: num(flags.minPrecision ?? process.env.JEV_CAL_MIN_PRECISION, DEFAULT_THRESHOLDS.minPrecision),
    minRecall: num(flags.minRecall ?? process.env.JEV_CAL_MIN_RECALL, DEFAULT_THRESHOLDS.minRecall),
    maxFalseAccept: num(flags.maxFalseAccept ?? process.env.JEV_CAL_MAX_FALSE_ACCEPT, DEFAULT_THRESHOLDS.maxFalseAccept),
    maxEce: num(flags.maxEce ?? process.env.JEV_CAL_MAX_ECE, DEFAULT_THRESHOLDS.maxEce),
  };
}

/** Compare metrics against thresholds, gated as in eval.mjs for the accept class. */
export function checkThresholds(metrics, t) {
  const breaches = [];
  if (metrics.n < t.minSamples) breaches.push(`samples=${metrics.n} < ${t.minSamples}`);
  if (metrics.coverage < t.minCoverage) breaches.push(`coverage=${metrics.coverage.toFixed(3)} < ${t.minCoverage}`);
  if (metrics.accepts > 0 && metrics.precision < t.minPrecision) breaches.push(`precision=${metrics.precision.toFixed(3)} < ${t.minPrecision}`);
  if (metrics.accepts > 0 && metrics.should_accept > 0 && metrics.recall < t.minRecall) breaches.push(`recall=${metrics.recall.toFixed(3)} < ${t.minRecall}`);
  if (metrics.false_accept > t.maxFalseAccept) breaches.push(`false_accept=${metrics.false_accept.toFixed(3)} > ${t.maxFalseAccept}`);
  if (metrics.ece != null && metrics.ece > t.maxEce) breaches.push(`ece=${metrics.ece.toFixed(3)} > ${t.maxEce}`);
  return { breaches, meets: breaches.length === 0 };
}

/**
 * Full calibration pipeline. Returns a report; never mutates a policy.
 * Non-ok reports carry a `stage` of parse|validate|provenance. A valid run that
 * breaches thresholds is still `ok` but `meets_thresholds=false` and
 * `eligible_for_review=false`.
 */
export function runCalibration({ file, text, registry = loadRegistry(), source = 'external', flags = {} }) {
  const input = typeof text === 'string' ? text : readFileSync(file, 'utf8');
  const parsed = parseCalibrateInput(input);
  if (!parsed.ok) return { ok: false, stage: 'parse', error: parsed.error };
  if (parsed.provMismatch?.length) return { ok: false, stage: 'provenance', error: 'mixed provenance: ' + parsed.provMismatch.join('; ') };
  const validated = validateCalibrateInput(parsed.samples);
  if (!validated.ok) return { ok: false, stage: 'validate', errors: validated.errors };
  const prov = verifyProvenance(parsed.meta, registry, flags);
  if (!prov.ok) return { ok: false, stage: 'provenance', problems: prov.problems };
  // ECE/Brier need an honest correctness signal; calibration labels carry
  // label+gate, so correct = the gate matched the labeled target.
  const m = metrics(parsed.samples.map((s) => ({ ...s, correct: s.label === s.gate })));
  const thresholds = resolveThresholds(flags);
  const { breaches, meets } = checkThresholds(m, thresholds);
  const isHarness = harnessOnly(source, prov.provenance.dataset_version);
  const report = {
    generated_at: new Date().toISOString(),
    ok: true,
    calibrated: false, // this CLI never marks a policy calibrated
    source,
    harness_only: isHarness,
    eligible_for_review: !isHarness && meets, // real target-domain labels meeting thresholds
    meets_thresholds: meets,
    thresholds,
    breaches,
    provenance: prov.provenance,
    metrics: m,
  };
  return report;
}

// CLI entry.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('usage: node gateway/scripts/calibrate.mjs <file.json|file.jsonl> [--policy id] [--model id] [--provider id] [--dataset-version v] [--source external|synthetic|demo] [--min-samples n] [--min-coverage n] [--min-precision n] [--min-recall n] [--max-false-accept n] [--max-ece n]\n');
    process.exit(2);
  }
  const flags = {};
  const map = {
    '--policy': 'policy', '--model': 'model', '--provider': 'provider',
    '--dataset-version': 'datasetVersion', '--policy-version': 'policyVersion',
    '--min-samples': 'minSamples', '--min-coverage': 'minCoverage',
    '--min-precision': 'minPrecision', '--min-recall': 'minRecall',
    '--max-false-accept': 'maxFalseAccept', '--max-ece': 'maxEce',
  };
  for (let i = 0; i < args.length; i++) {
    if (map[args[i]]) { flags[map[args[i]]] = args[i + 1]; i++; }
  }
  const source = (args[args.indexOf('--source') + 1] ?? 'external');
  const report = runCalibration({ file, source, flags });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // parse/validate/provenance failures exit 2; a metrics breach (ok but not
  // meeting thresholds) exits 1; a clean report exits 0.
  process.exit(report.ok ? (report.meets_thresholds ? 0 : 1) : 2);
}
