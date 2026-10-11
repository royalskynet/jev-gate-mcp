#!/usr/bin/env node
// Drift CLI (item 6): compares a baseline outcome distribution to a current one
// using Jensen-Shannon divergence and PSI plus a confidence-calibration shift.
// Only opaque, decision-relevant fields (gate, confidence, correct) cross the
// boundary — raw runtime state is never saved. With too few samples the result
// is `non-pass` (drift is unknown and must not silently pass), and malformed
// input is a hard error.
//
// Usage:
//   node gateway/scripts/drift.mjs <baseline.json> <current.json>
// Files are arrays of { gate, confidence?, correct? } records (output of an
// eval or a shadow-mode aggregation).
import fs from 'node:fs';
import { driftReport } from '../lib/evalkit.mjs';

const [baseFile, currFile] = process.argv.slice(2);
if (!baseFile || !currFile) {
  process.stderr.write('usage: node gateway/scripts/drift.mjs <baseline.json> <current.json>\n');
  process.exit(2);
}

function load(file) {
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`malformed input ${file}: ${e.message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(arr)) {
    process.stderr.write(`malformed input ${file}: expected an array\n`);
    process.exit(2);
  }
  return arr;
}

const baseline = load(baseFile);
const current = load(currFile);
const report = {
  baseline_samples: baseline.length,
  current_samples: current.length,
  baseline_file: baseFile,
  current_file: currFile,
  ...driftReport(baseline, current),
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(report.status === 'pass' ? 0 : 1);
