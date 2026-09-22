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
// On by situation: samples land in DEFAULT_CALIBRATION_LOG unless
// JEV_CALIBRATION_LOG names another path, or the literal `off` to stop
// collecting. Only the policy's own `state_projection` fields are recorded; the
// caller's undeclared fields were stripped before this point.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Shipped sink: a dir the rest of the stack already writes its ledgers to. */
export const DEFAULT_CALIBRATION_LOG = join(homedir(), '.openclaw', 'state', 'jev-calibration.jsonl');

/** The corpus path in force. `off` is the opt-out; any other value overrides. */
export function calibrationPath(env = process.env) {
  const v = env.JEV_CALIBRATION_LOG;
  if (v === 'off') return null;
  return v || DEFAULT_CALIBRATION_LOG;
}

/** Fixture-produced, by either channel the fake adapter stamps. */
function isFakeSample(sample) {
  return sample?.provider === 'fake' || String(sample?.model ?? '').startsWith('fake/');
}

/**
 * Append one decision sample as a JSONL line. Never throws: a corpus write must
 * not be able to fail a decision.
 *
 * `label` is written as null, to be filled in afterwards with the outcome the
 * policy *should* have produced. calibrate.mjs rejects a file whose samples are
 * unlabelled, so an untouched corpus can never be mistaken for evidence.
 *
 * @param {object} sample
 * @param {string} [path=calibrationPath()]
 * @returns {boolean} true if a line was written
 */
export function recordSample(sample, path = calibrationPath()) {
  if (!path) return false;
  // A fake adapter's answers are its fixtures read back, so they are evidence
  // about the fixtures and not about the model — yet they land in the same file
  // and outvote real traffic by orders of magnitude. `gateway/lib/bench.mjs`
  // wrote 10,200 `fake/jev-1.13` samples into the live corpus, 1,615 of them in
  // one minute, against 1,553 real ones; calibrating on that file would have
  // been calibrating on the fixtures. Only the DEFAULT sink is protected: a
  // named path is somebody deliberately collecting (harness tests do exactly
  // that), while the default is the live evidence corpus and nothing should be
  // able to seed it by forgetting an env var.
  if (path === DEFAULT_CALIBRATION_LOG && isFakeSample(sample)) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ...sample, label: null })}\n`);
    return true;
  } catch {
    // ponytail: a corpus is best-effort evidence, not a durability contract.
    // Swap in a queue only if a dropped sample ever costs more than re-running.
    return false;
  }
}
