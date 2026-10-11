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
// On by situation: samples land in DEFAULT_CALIBRATION_DIR, one file per
// policy (see defaultSink), unless
// JEV_CALIBRATION_LOG names another path, or the literal `off` to stop
// collecting. Only the policy's own `state_projection` fields are recorded; the
// caller's undeclared fields were stripped before this point.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Shipped sink: a dir the rest of the stack already writes its ledgers to. */
export const DEFAULT_CALIBRATION_DIR = join(homedir(), '.openclaw', 'state', 'jev-calibration');

/**
 * One default file per policy. calibrate.mjs reads JSONL by asserting that
 * per-record provenance AGREES across the file, and `policy` is one of the five
 * provenance fields -- so a single shared sink carrying five policies is
 * rejected at stage `provenance` no matter how much real traffic it holds. The
 * live sink held 2,266 records across five policies and scored none of them.
 * Sharding here is what makes the producer feed the consumer unreshaped.
 */
export function defaultSink(policy) {
  const slug = String(policy ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(DEFAULT_CALIBRATION_DIR, `${slug}.jsonl`);
}

/** True when `path` is a shipped per-policy sink rather than a named collection. */
export function isDefaultSink(path) {
  return typeof path === 'string' && path.startsWith(`${DEFAULT_CALIBRATION_DIR}/`);
}

/** The corpus path in force. `off` is the opt-out; any other value overrides. */
export function calibrationPath(env = process.env, policy = undefined) {
  const v = env.JEV_CALIBRATION_LOG;
  if (v === 'off') return null;
  return v || defaultSink(policy);
}

/**
 * Not evidence about the model. Two channels the fake adapter stamps, plus any
 * sample with no provider at all: `Gateway` writes `provider: 'unknown'`
 * whenever it was constructed without one, which is exactly the harness
 * signature -- every deployment path goes through `buildGateway`, which always
 * sets it. `lib/replay.mjs` is the case that matters: it recomposes RECORDED
 * answers with no provider call and `state: 'decision replay; original state
 * withheld'`, echoing the real pinned model id so the `fake/` check misses it.
 * 2,258 of the live corpus's 2,266 records were replay echoes, and a withheld
 * state can never be labelled by anyone.
 */
function isNotLiveSample(sample) {
  const provider = sample?.provider;
  return provider === 'fake' || !provider || provider === 'unknown'
    || String(sample?.model ?? '').startsWith('fake/');
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
export function recordSample(sample, path = calibrationPath(process.env, sample?.policy)) {
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
  if (isDefaultSink(path) && isNotLiveSample(sample)) return false;
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
