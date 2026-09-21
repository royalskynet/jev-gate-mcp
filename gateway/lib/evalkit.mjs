// Offline evaluation + drift kit for Decision Policies.
//
// Everything here is deterministic and offline (no provider key required). It
// turns a versioned, labelled synthetic dataset into honest operating metrics:
//   - coverage, accept precision/recall, false-accept, review rate
//   - Brier score and ECE (expected calibration error) — confidence vs
//     correctness, because model confidence is NOT correctness (PRD-27).
//   - latency / cost when recorded.
// And a drift report comparing a baseline distribution to a current one with
// Jensen-Shannon divergence and PSI (population stability index), flagging
// non-pass when divergence or calibration has moved or samples are too thin.
//
// The datasets carry NO sensitive state: state is a short opaque token (e.g.
// "case::intent-c1"), answers and labels are the only decision-relevant fields.
import { makeFakeAdapter, FakeMode } from '../src/adapters.js';
import { JevGateway } from '../src/gateway.js';

const GATE_ORDER = ['deny', 'escalate', 'review', 'accept'];
function rank(g) { return GATE_ORDER.indexOf(g); }

// ---------------------------------------------------------------------------
// Synthetic label -> answers. Reverse-composes a target Gate from a policy's
// declarative mapping + thresholds (the same mapping/confidence logic as the
// gateway, kept here so the dataset is self-consistent and auditable).
// ---------------------------------------------------------------------------

function answerForQuestion(q, opt, confidence) {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria ?? {});
    const probabilities = {};
    for (const k of keys) probabilities[k] = k === opt ? 1 : 0;
    return { type: 'choice', choice: opt, probabilities, confidence };
  }
  if (q.type === 'score') {
    const idx = Number(opt);
    const probabilities = {};
    for (let i = 0; i < q.criteria.length; i++) probabilities[String(i)] = i === idx ? 1 : 0;
    return {
      type: 'score', score: idx,
      legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), String(l ?? 'level')])),
      probabilities, confidence,
    };
  }
  // noul: `opt` is 'true' | 'false'
  const noul = opt === 'true' ? 0.99 : 0.01;
  return { type: 'noul', noul };
}

/**
 * Build a per-question answer map that composes (via gateway.composeGate) to
 * `gateTarget`, using mapping options that map to `gateTarget` and a confidence
 * high enough that confidence NEVER lowers the semantic outcome. The
 * consequence cap is respected (a consequential policy can never auto-accept).
 * @param {object} spec policy version spec (questions + mapping + thresholds + consequence)
 * @param {'accept'|'review'|'escalate'|'deny'} gateTarget
 */
export function labelledAnswers(spec, gateTarget, confidence = 0.97) {
  const start = spec.consequence !== 'advisory' ? 'review' : 'accept';
  // clamp: we can only reach targets at-or-below the consequence start.
  const effective = rank(gateTarget) <= rank(start) ? gateTarget : start;
  const out = {};
  for (const qid of Object.keys(spec.questions ?? {})) {
    const q = spec.questions[qid];
    const mapping = spec.mapping?.[qid] ?? {};
    // Prefer an option that itself maps to `effective`; fall back to a safe
    // 'accept' option so the semantic signal never forces a more conservative
    // gate than the confidence/target intended.
    const opts = Object.entries(mapping);
    const hit = opts.find(([, g]) => g === effective);
    const opt = hit ? hit[0] : (opts.find(([, g]) => g === 'accept')?.[0] ?? opts[0]?.[0]);
    out[qid] = answerForQuestion(q, opt, confidence);
  }
  return out;
}

/**
 * Deterministic labelled dataset for a policy. `seed` drives the RNG so the
 * same seed always yields the same cases (reproducible reports). Each case is
 * labelled with a target Gate and carries only opaque, answer-level state.
 * @param {object} spec policy version spec
 * @param {number} [n=60]
 * @param {number} [seed=1]
 */
export function syntheticDataset(spec, n = 60, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  // A dataset must only label gates the policy can actually reach. Those are
  // exactly the gate values its declarative mappings can emit, optionally
  // clamped by consequence (a consequential policy caps at review and can never
  // auto-accept). Labelling an unreachable gate manufactures a mismatch that is
  // a data artifact, not a policy error.
  const mappingOutcomes = new Set();
  for (const m of Object.values(spec.mapping ?? {})) {
    for (const g of Object.values(m)) mappingOutcomes.add(g);
  }
  let reachable = [...mappingOutcomes];
  if (spec.consequence !== 'advisory') reachable = reachable.filter((g) => g !== 'accept');
  // Fall back so an empty/invalid mapping never produces an empty dataset.
  if (reachable.length === 0) reachable = ['accept', 'review', 'escalate', 'deny'];
  const cases = [];
  for (let i = 0; i < n; i++) {
    const label = reachable[Math.floor(rnd() * reachable.length)];
    // a minority of cases is deliberately low-confidence to exercise Brier/ECE
    const low = rnd() < 0.1;
    const confidence = low ? 0.55 + rnd() * 0.2 : 0.9 + rnd() * 0.09;
    cases.push({
      id: `${spec.id}-c${i}`,
      state: `case::${spec.id}-${i}`, // opaque, no sensitive content
      label,
      confidence: Math.min(1, confidence),
      answers: labelledAnswers(spec, label, Math.min(1, confidence)),
      seed: i,
    });
  }
  return cases;
}

/** Deterministic adapter that answers each case from a dataset by id match. */
export function makeDatasetAdapter(datasetCases, model) {
  const byId = new Map(datasetCases.map((c) => [c.state, c]));
  return async (state) => {
    const c = byId.get(String(state));
    if (!c) return { model: model ?? 'eval/model', answers: {}, usage: null, latency_ms: 0 };
    return { model: model ?? 'eval/model', answers: c.answers, usage: { input_tokens: 100, output_tokens: 20 }, latency_ms: 2 };
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * @param {Array<{label:string, gate:string, confidence:number|null, coverage:string, latency_ms?:number|null}>} samples
 */
export function metrics(samples) {
  const total = samples.length;
  const done = samples.filter((s) => s.coverage !== 'incomplete');
  const coverage = total ? done.length / total : 0;
  const isAccept = (g) => g === 'accept';

  let accepts = 0, correctAccepts = 0, falseAccepts = 0, shouldAccept = 0, reviews = 0;
  const confSamples = [];
  for (const s of done) {
    if (isAccept(s.gate)) accepts++;
    if (isAccept(s.label)) shouldAccept++;
    if (isAccept(s.gate) && isAccept(s.label)) correctAccepts++;
    if (isAccept(s.gate) && !isAccept(s.label)) falseAccepts++;
    if (s.gate === 'review') reviews++;
    if (typeof s.confidence === 'number') confSamples.push(s);
  }
  const precision = accepts ? correctAccepts / accepts : 0;
  const recall = shouldAccept ? correctAccepts / shouldAccept : 0;
  const falseAccept = total ? falseAccepts / total : 0;
  const reviewRate = total ? reviews / total : 0;
  const latencies = done.map((s) => s.latency_ms).filter((x) => typeof x === 'number' && x !== null);
  const latencyAvg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  return {
    n: total,
    coverage,
    accepts,
    should_accept: shouldAccept,
    precision,
    recall,
    false_accept: falseAccept,
    review_rate: reviewRate,
    brier: brier(confSamples),
    ece: ece(confSamples),
    latency_avg_ms: latencyAvg,
    estimated_cost_per_1k: 0.0002, // ponytail: fixed placeholder documented in runbook
  };
}

/**
 * Brier score over (confidence, correct) pairs; lower is better.
 * @param {Array<{confidence:number|null, correct:boolean}>} samples
 */
export function brier(samples) {
  if (!samples.length) return null;
  let sum = 0;
  for (const s of samples) {
    if (typeof s.confidence !== 'number') continue;
    const p = Math.min(1, Math.max(0, s.confidence));
    sum += (p - (s.correct ? 1 : 0)) ** 2;
  }
  return sum / samples.length;
}

/**
 * Expected calibration error over confidence bins [0..1] step 0.1. Compares each
 * bin's mean confidence to its accuracy. Confidence is never treated as
 * correctness; this is the honest uncertainty check (PRD-27).
 */
export function ece(samples) {
  const usable = samples.filter((s) => typeof s.confidence === 'number');
  if (usable.length < 2) return null;
  const bins = 10;
  const acc = new Array(bins).fill(0);
  const cnt = new Array(bins).fill(0);
  const confSum = new Array(bins).fill(0);
  for (const s of usable) {
    const p = Math.min(0.999, Math.max(0, s.confidence));
    const b = Math.min(bins - 1, Math.floor(p * bins));
    cnt[b]++;
    acc[b] += s.correct ? 1 : 0;
    confSum[b] += p;
  }
  let err = 0;
  let n = 0;
  for (let b = 0; b < bins; b++) {
    if (!cnt[b]) continue;
    const binAcc = acc[b] / cnt[b];
    const binConf = confSum[b] / cnt[b];
    err += (cnt[b] / usable.length) * Math.abs(binAcc - binConf);
    n += cnt[b];
  }
  return n ? err : null;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/** Jensen-Shannon divergence between two normalized distributions p and q. */
export function jensenShannon(p, q) {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  let kl1 = 0, kl2 = 0;
  for (const k of keys) {
    const a = p[k] ?? 0, b = q[k] ?? 0;
    if (Math.abs(a - b) < 1e-12) continue;
    const m = (a + b) / 2;
    if (a > 0) kl1 += a * Math.log2(a / m);
    if (b > 0) kl2 += b * Math.log2(b / m);
  }
  return (kl1 + kl2) / 2;
}

/** Population Stability Index (PSI): sum((a-b)*ln(a/b)) across buckets. */
export function psi(p, q) {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  const EPS = 1e-6; // ponytail: floor epsilon keeps PSI finite on sparse buckets
  let total = 0;
  for (const k of keys) {
    const a = Math.max(EPS, p[k] ?? 0);
    const b = Math.max(EPS, q[k] ?? 0);
    total += (a - b) * Math.log(a / b);
  }
  return total;
}

function distribution(samples, keyFn) {
  const out = {};
  for (const s of samples) {
    const k = keyFn(s);
    out[k] = (out[k] ?? 0) + 1;
  }
  const n = samples.length || 1;
  for (const k of Object.keys(out)) out[k] /= n;
  return out;
}

const MIN_SAMPLES = 30;
const JS_TOLERANCE = 0.05; // outcome-distribution divergence above this => drift
const PSI_TOLERANCE = 0.25; // PSI above 0.25 is a widely cited "check" threshold

/**
 * Compare a baseline run to a current run and produce an honest drift report.
 * @param {Array} baseline samples (label, gate, confidence)
 * @param {Array} current  samples
 * @returns {object} { outcome_js, outcome_psi, conf_cal_shift, status, reasons }
 */
export function driftReport(baseline, current) {
  const reasons = [];
  const insufficient = baseline.length < MIN_SAMPLES || current.length < MIN_SAMPLES;
  if (insufficient) {
    return {
      status: 'non-pass',
      outcome_js: null,
      outcome_psi: null,
      conf_cal_shift: null,
      reasons: ['insufficient_samples: baseline/current < 30 — drift unknown, must not pass'],
    };
  }
  const gate = (s) => s.gate ?? 'unknown';
  const bDist = distribution(baseline, gate);
  const cDist = distribution(current, gate);
  const outcome_js = jensenShannon(bDist, cDist);
  const outcome_psi = psi(bDist, cDist);

  // confidence calibration drift: mean confidence - mean accuracy (a simple,
  // documented-on-the-runbook calibration shift indicator).
  const cal = (samples) => {
    const usable = samples.filter((s) => typeof s.confidence === 'number');
    if (!usable.length) return { conf: null, acc: null, shift: null };
    const conf = usable.reduce((a, s) => a + s.confidence, 0) / usable.length;
    const acc = usable.reduce((a, s) => a + (s.correct ?? false ? 1 : 0), 0) / usable.length;
    return { conf, acc, shift: conf - acc };
  };
  const bc = cal(baseline), cc = cal(current);
  const conf_cal_shift = bc.shift != null && cc.shift != null ? cc.shift - bc.shift : null;

  const status = outcome_js > JS_TOLERANCE || (outcome_psi != null && outcome_psi > PSI_TOLERANCE) || (conf_cal_shift != null && Math.abs(conf_cal_shift) > 0.08)
    ? 'non-pass'
    : 'pass';
  if (outcome_js > JS_TOLERANCE) reasons.push(`outcome divergence (JS=${outcome_js.toFixed(3)})`);
  if (outcome_psi != null && outcome_psi > PSI_TOLERANCE) reasons.push(`outcome PSI=${outcome_psi.toFixed(3)}`);
  if (conf_cal_shift != null && Math.abs(conf_cal_shift) > 0.08) reasons.push(`calibration shift=${conf_cal_shift.toFixed(3)}`);
  if (!reasons.length) reasons.push('no drift signal');
  return { status, outcome_js, outcome_psi, conf_cal_shift, reasons };
}

// ---------------------------------------------------------------------------
// High-level runner (used by the eval CLI)
// ---------------------------------------------------------------------------

/**
 * Run an eval: for each dataset case, call applyPolicy through a gateway with a
 * case-driven fake adapter, gather (label, gate, confidence, coverage,
 * latency), then compute metrics. Offline + deterministic.
 * @param {object} o { registry, policy, version?, cases }
 */
export async function runEval({ registry, policy, version, cases }) {
  const spec = registry.resolve(policy, version);
  const adapter = makeDatasetAdapter(cases, spec.model);
  const gateway = new JevGateway({ evaluateAdapter: adapter, registry });
  const samples = [];
  for (const c of cases) {
    const r = await gateway.applyPolicy({ policy, version, state: c.state });
    const conf = (r.gate_reasons ?? [])[0]?.confidence ?? null;
    samples.push({
      label: c.label,
      gate: r.outcome,
      confidence: conf,
      coverage: r.coverage,
      correct: r.outcome === c.label,
      latency_ms: r.latency_ms ?? null,
    });
  }
  return { spec, cases, metrics: metrics(samples), samples };
}
