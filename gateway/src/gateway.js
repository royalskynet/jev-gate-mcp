// JevGateway: the shared application service (Gateway Core).
//
// Deterministic code owns limits, validation, kill switch, gate composition
// and fail-safe behavior. Jev answers typed questions; it never authorizes.
// Advisory evaluation can never produce a Gate that authorizes an action; only
// applyPolicy composes a Gate, and even there an incomplete coverage, provider
// failure, timeout, or low certainty never becomes `accept`.
import { randomUUID } from 'node:crypto';
import { answerToSignal } from './adapters.js';
import { recordSample } from './calibration.js';
import { ERR, LIMITS, isKillSwitched } from './core.js';
import { applyPolicyInputSchema, evaluateInputSchema } from './schema.js';
import { applyActivation, decisionQuality, policyDigests, projectPolicyState } from './policy-controls.js';

const GATE_ORDER = ['deny', 'escalate', 'review', 'accept']; // index 0 = most conservative

// The Gate never looks at confidence alone. Each answer also carries a
// policy-owned semantic outcome (which candidate / score level / true-false
// was chosen), and the two are combined by taking the MORE CONSERVATIVE of:
//   - the semantic outcome declared by the policy's `mapping`, and
//   - the confidence outcome derived from the thresholds.
// Across questions the most conservative signal wins. This is the PRD
// invariant that incomplete/uncertain judgments can never authorize an action
// that the answer's own meaning says warrants review or denial.
export function composeGate(perQuestion, policy) {
  const thresholds = policy.thresholds ?? { auto: 0.9, review: 0.6 };
  // policy.consequence drives fail-safe: any non-advisory consequence is
  // consequential — it caps at review and can never auto-accept, even on a
  // confident judgment. Advisory starts at accept; the most conservative
  // signal only ever lowers it.
  const start = policy.consequence !== 'advisory' ? 'review' : 'accept';
  let worst = start;
  for (const q of perQuestion) {
    const sem = q.map ? semanticLevel(q.map, q.answer) : null;
    const conf = confidenceLevel(q.confidence, thresholds);
    const quality = qualityLevel(q.quality, policy.quality_thresholds);
    const level = combineLevels(combineLevels(sem, conf, start), quality, start);
    if (rank(level) < rank(worst)) worst = level; // most conservative wins
  }
  return worst;
}

function rank(g) { return GATE_ORDER.indexOf(g); }

// Declarative mapping: policy-owned answer->outcome table per question.
//   choice: keyed by candidate name  |  score: keyed by level index  |  noul: keyed by true/false
function semanticLevel(map, answer) {
  if (!map || !answer || answer instanceof Error) return null;
  if (answer.type === 'choice') return map[answer.choice] ?? null;
  if (answer.type === 'score') {
    // Jev score is probability-weighted and may fall between rubric levels.
    // Evaluate both adjacent levels and choose the more conservative mapping;
    // never fall back to confidence-only merely because the score is fractional.
    const lower = map[String(Math.floor(answer.score))] ?? null;
    const upper = map[String(Math.ceil(answer.score))] ?? null;
    if (lower == null) return upper;
    if (upper == null) return lower;
    return rank(lower) <= rank(upper) ? lower : upper;
  }
  if (answer.type === 'noul') return map[answer.noul >= 0.5 ? 'true' : 'false'] ?? null;
  return null;
}

// Confidence outcome. A missing/null confidence is uncalibrated: treat it as
// the most conservative signal (escalate) rather than assuming acceptance.
function confidenceLevel(confidence, t) {
  if (confidence == null) return 'escalate';
  if (confidence >= t.auto) return 'accept';
  if (confidence >= t.review) return 'review';
  return 'escalate';
}

function combineLevels(sem, conf, start) {
  if (sem == null) return conf;
  if (conf == null) return sem;
  return rank(sem) <= rank(conf) ? sem : conf; // more conservative wins
}

function qualityLevel(quality, thresholds) {
  if (!quality || !thresholds) return null;
  const breached =
    (Number.isFinite(thresholds.min_margin) && Number.isFinite(quality.margin) && quality.margin < thresholds.min_margin) ||
    (Number.isFinite(thresholds.max_entropy) && Number.isFinite(quality.entropy) && quality.entropy > thresholds.max_entropy) ||
    (Number.isFinite(thresholds.max_variance) && Number.isFinite(quality.variance) && quality.variance > thresholds.max_variance);
  return breached ? 'review' : 'accept';
}

export class JevGateway {
  /**
   * @param {object} deps
   * @param {function} deps.evaluateAdapter (state, questions, opts) => EvaluateResult
   * @param {import('./registry.js').Registry} deps.registry
   * @param {(id?: string|null)=>boolean} [deps.killSwitch] default isKillSwitched
   * @param {{record:(f:object)=>object}} [deps.telemetry] structured telemetry sink (allowlisted)
   * @param {string} [deps.provider] provider label for telemetry
   * @param {()=>string} [deps.breakerState] current breaker state for telemetry
   */
  constructor({ evaluateAdapter, registry, killSwitch = isKillSwitched, policyAdapter, telemetry, provider, policyProvider, breakerState, policyBreakerState, metrics }) {
    this._eval = evaluateAdapter;
    this._policyEval = policyAdapter ?? evaluateAdapter;
    this._reg = registry;
    this._kill = killSwitch;
    this._tel = telemetry;
    this._provider = provider;
    this._policyProvider = policyProvider ?? provider;
    this._breakerState = breakerState;
    this._policyBreakerState = policyBreakerState ?? breakerState;
    this._metrics = metrics;
  }

  // Structured, allowlisted telemetry for one request. correlation_id is always
  // set so operators can trace a decision; everything else is sanitized by the
  // telemetry sink (state/payload/answers never reach the log).
  _emit(fields) {
    if (!this._tel) return fields;
    return this._tel.record({
      correlation_id: fields.correlation_id ?? randomUUID(),
      provider: fields.tool === 'jev_apply_policy' ? this._policyProvider : this._provider,
      breaker_state: fields.tool === 'jev_apply_policy' ? this._policyBreakerState?.() : this._breakerState?.(),
      ...fields,
    });
  }

  listPolicies() {
    return this._reg.ids().map((id) => {
      const s = this._reg.spec(id);
      return { policy: id, versions: s.versions.map((v) => v.version), modes: s.versions.map((v) => v.mode ?? 'active') };
    });
  }

  async evaluate(input) {
    if (this._kill(null)) throw ERR.killSwitched('gateway is kill-switched');
    const parsed = evaluateInputSchema.safeParse(input);
    if (!parsed.success) throw ERR.badRequest(schemaIssue(parsed.error));
    const { state, questions, model } = parsed.data;

    const correlationId = randomUUID();
    let result;
    try {
      result = await deadline(this._eval(state, questions, {
        ...(model ? { model } : {}), deadlineAtMs: Date.now() + LIMITS.deadlineMs,
      }), LIMITS.deadlineMs);
    } catch (e) {
      this._emit({ event: 'evaluate', tool: 'jev_evaluate', correlation_id: correlationId, error_class: 'provider', error_code: e?.code ?? 'ERR_PROVIDER', coverage: 'incomplete' });
      throw ERR.provider(classified(e), isRetryable(e));
    }

    const perQuestion = [];
    // Every accepted answer is validated against the submitted question
    // schema and candidate set (PRD success metric). Foreign/wrong answers are
    // surfaced as typed errors, never folded into a bogus `accept`.
    const errs = [];
    for (const id of Object.keys(questions)) {
      const sig = answerToSignal(questions[id], result.answers[id]);
      if (sig instanceof Error) { errs.push({ question: id, code: sig.code, message: sig.message }); continue; }
      perQuestion.push({ question: id, answer: sig, confidence: confOf(questions[id], sig) });
    }

    const coverage = errs.length === 0 ? 'complete' : 'incomplete';
    this._emit({
      event: 'evaluate', tool: 'jev_evaluate', correlation_id: correlationId,
      resolved_model: result.model ?? null, coverage, gate: 'advisory',
      latency_ms: result.latency_ms ?? null,
    });
    this._metrics?.recordDecision({ policy: 'advisory', outcome: 'advisory', coverage, latency_ms: result.latency_ms });
    return {
      outcome: 'advisory', // advisory can never authorize a consequential action
      model: result.model,
      answers: perQuestion.map((p) => ({ question: p.question, answer: p.answer })),
      errors: errs,
      coverage,
      usage: result.usage ?? null,
      latency_ms: result.latency_ms ?? null,
    };
  }

  async applyPolicy(input) {
    const parsed = applyPolicyInputSchema.safeParse(input);
    if (!parsed.success) throw ERR.badRequest(schemaIssue(parsed.error));
    const { policy, version, state, correlation } = parsed.data;
    const correlationId = correlation?.request_id ?? randomUUID();

    if (this._kill(policy)) {
      this._emit({ event: 'apply_policy', tool: 'jev_apply_policy', correlation_id: correlationId, policy, gate: 'deny', error_class: 'kill-switch', error_code: 'ERR_KILL_SWITCH' });
      throw ERR.killSwitched(`kill-switched: ${policy}`);
    }
    const spec = this._reg.resolve(policy, version);
    const digests = policyDigests(spec);
    // Only the policy-declared state projection crosses the provider boundary.
    // Validation occurs after projection, so undeclared caller fields are
    // removed rather than accidentally becoming model context.
    const projectedState = projectPolicyState(spec, state);

    const questions = spec.questions; // server-owned; caller cannot supply these
    if (!questions || Object.keys(questions).length === 0) {
      throw ERR.badRequest(`policy ${policy} declares no questions`);
    }

    let result;
    try {
      // The immutable, server-owned spec.model is pinned for this policy and
      // forwarded to the provider adapter; the caller cannot override it (the
      // strict input schema rejects a model field, and the resolved model is
      // recorded on the result so drift is observable).
      result = await deadline(this._policyEval(projectedState, questions, { model: spec.model }), LIMITS.deadlineMs);
    } catch (e) {
      // Provider failure / timeout / rate limit / auth => an explicit typed
      // denial the host can branch on, never a fabricated accept.
      this._emit({
        event: 'apply_policy', tool: 'jev_apply_policy', correlation_id: correlationId,
        policy: spec.id, policy_version: spec.version, mode: spec.mode ?? 'active',
        calibration_status: spec.calibration_status ?? 'unknown',
        evaluation_dataset_version: spec.evaluation_dataset_version ?? null,
        gate: 'deny', coverage: 'incomplete', error_class: 'provider', error_code: e?.code ?? 'ERR_PROVIDER',
        breaker_state: this._policyBreakerState?.(), ...digests,
      });
      const failed = failClosed(spec, correlation, null, { code: e?.code ?? 'ERR_PROVIDER', message: classified(e) }, digests);
      this._metrics?.recordDecision({ policy: spec.id, outcome: 'deny', mode: spec.mode, coverage: 'incomplete' });
      return failed;
    }

    // Fail-safe: an upstream error, malformed array, or missing answer is a
    // typed error that cannot silently authorize. None of these reach composeGate.
    const perQuestion = [];
    for (const id of Object.keys(questions)) {
      const sig = answerToSignal(questions[id], result.answers?.[id]);
      if (sig instanceof Error) {
        this._emit({
          event: 'apply_policy', tool: 'jev_apply_policy', correlation_id: correlationId,
          policy: spec.id, policy_version: spec.version, mode: spec.mode ?? 'active',
          calibration_status: spec.calibration_status ?? 'unknown',
          evaluation_dataset_version: spec.evaluation_dataset_version ?? null,
          gate: 'deny', coverage: 'incomplete', error_class: sig.category ?? 'malformed', error_code: sig.code ?? 'ERR_MISSING_ANSWER',
          breaker_state: this._policyBreakerState?.(), ...digests,
        });
        const failed = failClosed(spec, correlation, result, sig, digests);
        this._metrics?.recordDecision({ policy: spec.id, outcome: 'deny', mode: spec.mode, coverage: 'incomplete', latency_ms: result.latency_ms });
        return failed;
      }
      // map comes from the frozen policy spec (declarative answer->outcome),
      // read once per question; the caller cannot supply or weaken it.
      perQuestion.push({
        question: id,
        answer: sig,
        confidence: confOf(questions[id], sig),
        quality: decisionQuality(questions[id], sig),
        map: spec.mapping?.[id],
      });
    }

    const gate = composeGate(perQuestion, spec);
    const activation = applyActivation(gate, spec, correlation?.request_id);
    const outcome = activation.outcome;
    const shadowCapped = activation.reason === 'shadow_or_uncalibrated';
    const capped = outcome !== gate;
    const payload = {
      event: 'apply_policy', tool: 'jev_apply_policy', correlation_id: correlationId,
      policy: spec.id, policy_version: spec.version, mode: spec.mode ?? 'active',
      calibration_status: spec.calibration_status ?? 'unknown',
      evaluation_dataset_version: spec.evaluation_dataset_version ?? null,
      resolved_model: result.model ?? null, gate: outcome, shadow_outcome: shadowCapped ? gate : null, coverage: 'complete',
      latency_ms: result.latency_ms ?? null,
      error_class: null,
      breaker_state: this._policyBreakerState?.(),
      activation_reason: activation.reason,
      ...digests,
    };
    this._emit(payload);
    // Shadow corpus (JEV_CALIBRATION_LOG=off to stop) in calibrate.mjs JSONL
    // shape. Telemetry cannot carry state by design, and a policy cannot leave
    // shadow without labelled state. `gate` is the raw composed gate, not the
    // shadow-capped public outcome: capping is a rollout control, not a
    // judgement the model made, so scoring against it would measure the fuse.
    const confs = perQuestion.map((p) => p.confidence).filter((c) => typeof c === 'number');
    recordSample({
      // provenance -- calibrate.mjs requires these and rejects a file where
      // they disagree across records
      policy: spec.id,
      policy_version: spec.version,
      model: result.model ?? spec.model ?? null,
      provider: this._policyProvider ?? 'unknown',
      // A sample's dataset is where the SAMPLE came from, not the fixture set
      // the spec was smoke-tested against. Stamping the spec's
      // `synthetic-harness-*` here made calibrate.mjs mark every live record
      // harness-only, so no amount of real traffic could ever leave shadow.
      dataset_version: `live-${spec.id}-v1`,
      // sample
      gate,
      coverage: 'complete',
      confidence: confs.length ? round(Math.min(...confs)) : null,
      // context for whoever fills in `label` -- not read by calibrate.mjs
      ts: new Date().toISOString(),
      correlation_id: correlationId,
      policy_digest: digests.policy_digest,
      public_outcome: outcome,
      state: projectedState,
      answers: perQuestion.map((p) => ({ question: p.question, answer: p.answer, confidence: round(p.confidence) })),
    });
    this._metrics?.recordDecision({ policy: spec.id, outcome, mode: spec.mode, coverage: 'complete', latency_ms: result.latency_ms });
    return {
      outcome,
      policy: { id: spec.id, version: spec.version },
      mode: spec.mode,
      calibration_status: spec.calibration_status ?? 'unknown',
      consequence: spec.consequence,
      shadow_outcome: shadowCapped ? gate : undefined,
      raw_outcome: capped ? gate : undefined,
      activation: {
        reason: activation.reason,
        cohort: activation.cohort,
        rollout_percent: spec.activation.rollout_percent,
      },
      ...digests,
      gate_reasons: perQuestion.map((p) => ({
        question: p.question,
        confidence: round(p.confidence),
        decision_quality: p.quality,
        quality_level: qualityLevel(p.quality, spec.quality_thresholds),
        semantic_level: p.map ? semanticLevel(p.map, p.answer) : null,
        level: confidenceLevel(p.confidence, spec.thresholds ?? { auto: 0.9, review: 0.6 }),
      })),
      coverage: 'complete',
      model: result.model, // resolved model (pinned to spec.model by the adapter)
      answers: perQuestion.map((p) => ({ question: p.question, answer: p.answer })),
      usage: result.usage ?? null,
      latency_ms: result.latency_ms ?? null,
      correlation: correlation ?? null,
    };
  }
}

function failClosed(spec, correlation, result, sig, digests = policyDigests(spec)) {
  // Provider failure / malformed / incomplete coverage => never accept.
  return {
    outcome: 'deny',
    policy: { id: spec.id, version: spec.version },
    mode: spec.mode,
    calibration_status: spec.calibration_status ?? 'unknown',
    consequence: spec.consequence,
    ...digests,
    gate_reasons: [],
    coverage: 'incomplete',
    unavailable: { code: sig.code, message: sig.message },
    model: result?.model ?? null,
    correlation: correlation ?? null,
  };
}

function confOf(q, a) {
  if (q.type === 'choice') return typeof a.confidence === 'number' ? a.confidence : null;
  if (q.type === 'score') return typeof a.confidence === 'number' ? a.confidence : null;
  if (q.type === 'noul') return typeof a.noul === 'number' ? Math.max(a.noul, 1 - a.noul) : null;
  return null;
}

function schemaIssue(e) {
  const first = e.issues?.[0];
  return first ? `${first.path.join('.')}: ${first.message}` : 'invalid input';
}

function round(n) { return typeof n === 'number' ? Math.round(n * 100) / 100 : n; }

function deadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(ERR.timeout('provider deadline exceeded')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function classified(e) {
  const c = e?.code;
  if (c === 'ERR_TIMEOUT' || /timed? ?out|deadline/i.test(e?.message ?? '')) return 'timeout';
  if (c === 'ERR_RATE_LIMIT' || /rate|429/i.test(e?.message ?? '')) return 'rate-limit';
  if (c === 'ERR_AUTH' || /401|403|unauthor|key/i.test(e?.message ?? '')) return 'auth';
  return e?.message ?? 'unavailable';
}

function isRetryable(e) {
  if (e instanceof Error && e.retryable === false) return false;
  return !(classified(e) === 'auth');
}
