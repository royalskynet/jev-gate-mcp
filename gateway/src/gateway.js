// JevGateway: the shared application service (Gateway Core).
//
// Deterministic code owns limits, validation, kill switch, gate composition
// and fail-safe behavior. Jev answers typed questions; it never authorizes.
// Advisory evaluation can never produce a Gate that authorizes an action; only
// applyPolicy composes a Gate, and even there an incomplete coverage, provider
// failure, timeout, or low certainty never becomes `accept`.
import { z } from 'zod';
import { answerToSignal } from './adapters.js';
import { ERR, LIMITS, isKillSwitched, stateBytes } from './core.js';
import { applyPolicyInputSchema, evaluateInputSchema, JsonSchema } from './schema.js';

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
    const level = combineLevels(sem, conf, start);
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

export class JevGateway {
  /**
   * @param {object} deps
   * @param {function} deps.evaluateAdapter (state, questions, opts) => EvaluateResult
   * @param {import('./registry.js').Registry} deps.registry
   * @param {(id?: string|null)=>boolean} [deps.killSwitch] default isKillSwitched
   */
  constructor({ evaluateAdapter, registry, killSwitch = isKillSwitched, policyAdapter }) {
    this._eval = evaluateAdapter;
    this._policyEval = policyAdapter ?? evaluateAdapter;
    this._reg = registry;
    this._kill = killSwitch;
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

    let result;
    try {
      result = await deadline(this._eval(state, questions, model ? { model } : {}), LIMITS.deadlineMs);
    } catch (e) {
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

    return {
      outcome: 'advisory', // advisory can never authorize a consequential action
      model: result.model,
      answers: perQuestion.map((p) => ({ question: p.question, answer: p.answer })),
      errors: errs,
      coverage: errs.length === 0 ? 'complete' : 'incomplete',
      usage: result.usage ?? null,
      latency_ms: result.latency_ms ?? null,
    };
  }

  async applyPolicy(input) {
    const parsed = applyPolicyInputSchema.safeParse(input);
    if (!parsed.success) throw ERR.badRequest(schemaIssue(parsed.error));
    const { policy, version, state, correlation } = parsed.data;

    if (this._kill(policy)) throw ERR.killSwitched(`kill-switched: ${policy}`);
    const spec = this._reg.resolve(policy, version);

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
      result = await deadline(this._policyEval(state, questions, { model: spec.model }), LIMITS.deadlineMs);
    } catch (e) {
      // Provider failure / timeout / rate limit / auth => an explicit typed
      // denial the host can branch on, never a fabricated accept.
      return failClosed(spec, correlation, null, { code: e?.code ?? 'ERR_PROVIDER', message: classified(e) });
    }

    // Fail-safe: an upstream error, malformed array, or missing answer is a
    // typed error that cannot silently authorize. None of these reach composeGate.
    const perQuestion = [];
    for (const id of Object.keys(questions)) {
      const sig = answerToSignal(questions[id], result.answers?.[id]);
      if (sig instanceof Error) {
        return failClosed(spec, correlation, result, sig);
      }
      // map comes from the frozen policy spec (declarative answer->outcome),
      // read once per question; the caller cannot supply or weaken it.
      perQuestion.push({ question: id, answer: sig, confidence: confOf(questions[id], sig), map: spec.mapping?.[id] });
    }

    const gate = composeGate(perQuestion, spec);
    return {
      outcome: gate, // 'accept' | 'review' | 'escalate' | 'deny'
      policy: { id: spec.id, version: spec.version },
      mode: spec.mode,
      consequence: spec.consequence,
      gate_reasons: perQuestion.map((p) => ({
        question: p.question,
        confidence: round(p.confidence),
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

function failClosed(spec, correlation, result, sig) {
  // Provider failure / malformed / incomplete coverage => never accept.
  return {
    outcome: 'deny',
    policy: { id: spec.id, version: spec.version },
    mode: spec.mode,
    consequence: spec.consequence,
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
