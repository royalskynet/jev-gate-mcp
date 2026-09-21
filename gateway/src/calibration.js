// Calibration corpus sink — the only place the gateway writes projected state
// to disk.
//
// `scripts/calibrate.mjs` already scores an EXTERNAL labelled file (precision,
// recall, ECE, false-accept, eligibility). Nothing produced that file. This is
// the missing producer, and it emits exactly that script's JSONL contract:
// per-record provenance (policy, policy_version, model, provider,
// dataset_version) plus per-sample `gate`, `confidence`, `coverage`, `label`.
//
// Telemetry (telemetry.js) cannot do this job. Its allowlist deliberately drops
// state, questions and answers so a log line can never leak them — and leaving
// `shadow`/`uncalibrated` needs precisely that material, paired with a human
// label. Hence a separate, opt-in file rather than a wider allowlist.
//
// Opt-in via JEV_CALIBRATION_LOG=<path>. Unset (the default) => no-op, no file,
// no cost. Only the policy's own `state_projection` fields are recorded; the
// caller's undeclared fields were stripped before this point.
import { appendFileSync } from 'node:fs';

/**
 * Append one decision sample as a JSONL line. Never throws: a corpus write must
 * not be able to fail a decision.
 *
 * `label` is written as null, to be filled in afterwards with the outcome the
 * policy *should* have produced. calibrate.mjs rejects a file whose samples are
 * unlabelled, so an untouched corpus can never be mistaken for evidence.
 *
 * @param {object} sample
 * @param {string} [path=process.env.JEV_CALIBRATION_LOG]
 * @returns {boolean} true if a line was written
 */
export function recordSample(sample, path = process.env.JEV_CALIBRATION_LOG) {
  if (!path) return false;
  try {
    appendFileSync(path, `${JSON.stringify({ ...sample, label: null })}\n`);
    return true;
  } catch {
    // ponytail: a corpus is best-effort evidence, not a durability contract.
    // Swap in a queue only if a dropped sample ever costs more than re-running.
    return false;
  }
}
