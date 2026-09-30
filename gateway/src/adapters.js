// Provider Adapters: isolate native TypeSafe and OpenRouter Decisions behind
// one contract. Real adapters drive jevwire's DecisionModel (extends the
// TypeSafe /v1/systemone shape). Fakes are deterministic and cover the failure
// space the conformance suite exercises — valid, missing, foreign, malformed,
// timeout, rate-limit, upstream failure — with zero provider cost.
import os from 'node:os';
import path from 'node:path';
import { JevDecisionModel } from 'jevwire';
import { ERR, LIMITS } from './core.js';
import { recordZenStatus } from './zen-status.js';

// --- Shared helper: normalize a jevwire answer or annotate a typed error ---

function answerToSignal(q, a) {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria ?? {});
    if (typeof a?.choice !== 'string') return ERR.missingAnswer('choice answer missing');
    if (!Object.prototype.hasOwnProperty.call(q.criteria ?? {}, a.choice)) {
      return ERR.foreignChoice(`choice ${a.choice} not among candidates`);
    }
    if (!a.probabilities || typeof a.probabilities !== 'object') {
      return ERR.malformed('choice answer lacks probabilities');
    }
    const foreign = Object.keys(a.probabilities).filter((key) => !keys.includes(key));
    if (foreign.length > 0) return ERR.badGate(`probabilities include foreign keys: ${foreign.join(',')}`);
    const invalid = validateDistribution(a.probabilities, keys);
    if (invalid) return ERR.malformed(`choice probabilities ${invalid}`);
    if (a.confidence != null && (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1)) {
      return ERR.malformed('choice confidence outside 0..1');
    }
    return a;
  }
  if (q.type === 'score') {
    if (typeof a?.score !== 'number' || Number.isNaN(a.score)) return ERR.missingAnswer('score answer missing');
    const n = q.criteria.length;
    // deterministic code owns the count check (PRD invariant 5)
    if (a.score < 0 || a.score > n - 1) return ERR.badGate(`score ${a.score} outside level range 0..${n - 1}`);
    if (a.legend && typeof a.legend !== 'object') return ERR.malformed('score legend malformed');
    const invalid = validateDistribution(a.probabilities, q.criteria.map((_, i) => String(i)));
    if (invalid) return ERR.malformed(`score probabilities ${invalid}`);
    if (a.confidence != null && (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1)) {
      return ERR.malformed('score confidence outside 0..1');
    }
    return a;
  }
  if (q.type === 'noul') {
    if (typeof a?.noul !== 'number' || Number.isNaN(a.noul)) return ERR.missingAnswer('noul answer missing');
    if (a.noul < 0 || a.noul > 1) return ERR.badGate(`noul ${a.noul} outside 0..1`);
    return a;
  }
  return ERR.badRequest(`unknown question type ${q.type}`);
}

function validateDistribution(probabilities, keys) {
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return 'missing';
  const actual = Object.keys(probabilities);
  const missing = keys.filter((key) => !actual.includes(key));
  const foreign = actual.filter((key) => !keys.includes(key));
  if (missing.length > 0) return `missing keys: ${missing.join(',')}`;
  if (foreign.length > 0) return `include foreign keys: ${foreign.join(',')}`;
  const values = keys.map((key) => probabilities[key]);
  if (values.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) return 'must be finite numbers in 0..1';
  const sum = values.reduce((total, p) => total + p, 0);
  if (Math.abs(sum - 1) > 0.02) return `must sum to 1 (got ${sum})`;
  return null;
}

// --- Real adapters (require credentials; only constructed when configured) ---

export function makeTypesafeAdapter({ apiKey, baseUrl = 'https://api.typesafe.ai', model = 'jev-latest', timeoutMs = LIMITS.deadlineMs }) {
  // Native TypeSafe only accepts `jev-latest` today. Policies pin `typesafe/…`
  // ids — those are OpenRouter/response ids and 400 on the native path — so
  // translate HERE at the adapter boundary only. Stripping anywhere shared
  // would break OpenRouter, where `typesafe/jev-1.13` is the correct request
  // id (fix 0007 §13). The response's `model` field still rides through to the
  // result as `resolved_model`, the one audit record left after translation.
  const toTypeSafeId = (id) => {
    const bare = String(id ?? '').replace(/^typesafe\//, '');
    return bare === 'jev-latest' ? bare : 'jev-latest';
  };
  const m = new JevDecisionModel({ apiKey, baseUrl, model: toTypeSafeId(model), timeoutMs, maxRetries: LIMITS.maxRetries });
  return async (state, questions, opts = {}) => m.evaluate({ state, questions, model: toTypeSafeId(opts.model) });
}

export function makeOpenrouterAdapter({ apiKey, baseUrl = 'https://openrouter.ai/api', model = 'typesafe/jev-1.13', timeoutMs = LIMITS.deadlineMs, fetch: fetchImpl, sleep }) {
  // JevDecisionModel appends `/v1/systemone`; the base must stop at `/api`.
  const m = new JevDecisionModel({ apiKey, baseUrl, model, timeoutMs, maxRetries: LIMITS.maxRetries, fetch: fetchImpl, sleep });
  return async (state, questions, opts = {}) => m.evaluate({ state, questions, model: opts.model });
}

// --- Zen: OpenCode Zen's hosted System One endpoint, free tier ---
// Third System One host, same `/v1/systemone` contract as OpenRouter and the
// same account key as the rest of OpenCode — only the base and the pinned
// model id differ, so the shape is the OpenRouter adapter's verbatim. `baseUrl`
// must stop before `/v1`: the client appends `/v1/systemone` itself.
//
// The free tier is the whole point and also the whole risk: it is the only
// configured credential, so there is deliberately no paid sibling to fail over
// to. Every outcome therefore lands in the status file — a dead free tier must
// read as "judging stopped", never as a quiet downgrade.
export function makeZenAdapter({ apiKey, baseUrl = 'https://opencode.ai/zen', model = 'jev-1.13-free', timeoutMs = LIMITS.deadlineMs, onStatus = recordZenStatus }) {
  // Fail loud on a pasted OpenRouter/TypeSafe id (`typesafe/jev-1.13`,
  // `openrouter/…`): Zen's catalog is bare ids, and a silent 400 from the
  // provider would read as "the free model is broken" instead of "wrong id".
  if (String(model ?? '').includes('/')) {
    throw new Error(`zen model id must be a bare Zen catalog id (e.g. jev-1.13-free), got ${model}`);
  }
  // Every policy pins its own provider's id (`typesafe/jev-1.13-20260917`) and
  // `applyPolicy` forwards it verbatim — Zen 422s on a foreign id, which reads
  // as an outage. Translate HERE at the adapter boundary, exactly as
  // makeTypesafeAdapter does in the other direction, so one policy set serves
  // every provider. The substituted model rides back as `resolved_model`, the
  // one audit record left after the substitution.
  const call = makeOpenrouterAdapter({ apiKey, baseUrl, model, timeoutMs });
  return async (state, questions, opts = {}) => {
    try {
      const result = await call(state, questions, { ...opts, model });
      onStatus(true, { model: result.model ?? model });
      return result;
    } catch (e) {
      onStatus(false, { model, error: e?.message ?? String(e), error_class: e?.name ?? null });
      // Abort, do not degrade: rethrown unchanged so the gateway fails closed
      // and the caller sees a provider error instead of an unsourced answer.
      throw e;
    }
  };
}

// --- Laya: local open-weights Jev (quantized int8 checkpoint, local model dir) ---
// No apiKey. `loadLaya` serves a pre-downloaded bundle from $JEV_LAYA_MODEL_DIR
// (default ~/.jevgate/laya-multilingual-int8) — never hits the network at
// runtime, so the first request loads the ONNX session (a few seconds for the
// 540MB int8 graph). The gateway owns the overall deadline. It also adds the
// `[CLS]/[SEP]/[MASK]/[PAD]` tokenizer aliases in a shadow copy (upstream lacks
// them; receptron's id() requires them) and passes ORT CPU-memory options that
// keep the resident set small. On any load failure (missing files / load
// timeout) this throws; the router may use the configured Jev provider while
// the request still has time. One session is reused until idle unloading;
// a warm answer costs one forward pass. `systemOne` returns the same answer shape
// as Jev (choice/score/noul with probabilities), so the stateless gateway
// contract `(state, questions, opts) => result` applies here unchanged — opts
// is ignored (no model override on local weights).
export function makeLayaAdapter({ modelDir, timeoutMs = LIMITS.deadlineMs, load, sessionOptions } = {}) {
  let sessionPromise = null;
  let idleTimer = null;
  // Idle unload: release the ONNX session after JEV_LAYA_IDLE_MS (default
  // 600000ms = 10min) of no calls, so a gateway that triages rarely keeps ~0
  // resident memory between requests. Laya has no idempotent "release then
  // reuse" path — `close()` frees the session and the instance must not be
  // used afterwards — so we drop the cached promise and re-load on the next
  // call. The timer is unref'd so an idle process can still exit.
  const idleMs = Math.max(0, Number(process.env.JEV_LAYA_IDLE_MS) || 600000);
  const unload = async () => {
    idleTimer = null;
    const pending = sessionPromise;
    sessionPromise = null;
    if (!pending) return;
    try {
      const laya = await pending;
      if (laya?.close) await laya.close();
    } catch { /* already gone — nothing to release */ }
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void unload(); }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  return async function layaAdapter(state, questions, _opts) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!sessionPromise) {
      sessionPromise = (async () => {
        if (load) return load();
        const { loadLaya } = await import('./laya-loader.js');
        // Default bundle: the quantized int8 checkpoint. JEV_LAYA_MODEL_DIR
        // still wins; the fp16 bundle stays available for a manual switch.
        const dir = modelDir
          || process.env.JEV_LAYA_MODEL_DIR
          || path.join(os.homedir(), '.jevgate', 'laya-multilingual-int8');
        return loadLaya({
          modelDir: dir,
          // receptron's Laya.load spreads these through (laya.js:46). They
          // keep onnxruntime's CPU memory arena from staging the whole graph.
          sessionOptions: {
            enableCpuMemArena: false,
            enableMemPattern: false,
            intraOpNumThreads: 2,
            ...(sessionOptions ?? {}),
          },
        });
      })();
      // A failed download must not poison every later request: drop the cached
      // promise so the next call retries the load.
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    const laya = await deadline(sessionPromise, timeoutMs, 'laya load');
    try {
      const result = await deadline(laya.systemOne(state, questions), timeoutMs, 'laya systemOne');
      // This bundle's action head exposes raw logits under act_probability.
      // It is unused for typed classification and cannot authorize anything.
      // Quarantine the entire extension; never clamp/sigmoid it into fake certainty.
      const answers = Object.fromEntries(Object.entries(result.answers ?? {}).map(([id, answer]) => {
        if (!answer || typeof answer !== 'object') return [id, answer];
        const { rl_agent, ...typed } = answer;
        return [id, typed];
      }));
      return {
        model: result.model,
        answers,
        usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
        latency_ms: null, // local runtime reports no wall time; gateway records its own
      };
    } finally {
      armIdle();
    }
  };
}

function deadline(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(ERR.timeout(`${what} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// --- Deterministic fakes ---

export const FakeMode = Object.freeze({
  SUCCESS: 'success',
  MALFORMED: 'malformed', // well-shaped answers with bleeding foreign keys
  MISSING: 'missing', // answers absent for some questions
  PROVIDER_FAILURE: 'provider-failure', // upstream throws
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate-limit',
});

const ID_BY_TYPE = { choice: 'choice', score: 'score', noul: 'noul' };

function makeFakeAnswer(q, idx) {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria ?? {});
    const choose = keys[idx % keys.length];
    return {
      type: 'choice',
      choice: choose,
      probabilities: Object.fromEntries(keys.map((k, i) => [k, k === choose ? 1 : 0])),
      confidence: 1,
    };
  }
  if (q.type === 'score') {
    return {
      type: 'score',
      score: idx % q.criteria.length,
      legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), String(l ?? 'level')])),
      probabilities: Object.fromEntries(q.criteria.map((l, i) => [String(i), i === idx % q.criteria.length ? 1 : 0])),
      confidence: 1,
    };
  }
  return { type: 'noul', noul: idx % 2 === 0 ? 1 : 0 };
}

/**
 * Build a deterministic fake adapter.
 * @param {string} mode FakeMode
 * @param {object} opts { failQuestionId: 'q2' } to make exactly one answer wrong/missing
 */
export function makeFakeAdapter(mode = FakeMode.SUCCESS, opts = {}) {
  return async function fakeAdapter(state, questions) {
    const qids = Object.keys(questions);
    if (mode === FakeMode.TIMEOUT) throw ERR.timeout('fake timeout');
    if (mode === FakeMode.RATE_LIMIT) throw ERR.rateLimit('fake rate limit');
    if (mode === FakeMode.PROVIDER_FAILURE) throw ERR.provider('fake upstream failure');

    const answers = {};
    qids.forEach((id, i) => {
      const q = questions[id];
      let a = makeFakeAnswer(q, i);
      if (opts.failQuestionId && opts.failQuestionId === id) {
        if (mode === FakeMode.MISSING) return; // leave absent
        if (mode === FakeMode.MALFORMED && q.type === 'choice') {
          // a foreign probability key bleeds in
          a = { ...a, probabilities: { ...a.probabilities, not_a_candidate: 0.5 } };
        }
        if (mode === FakeMode.MALFORMED && q.type === 'score') {
          a = { ...a, score: -1 }; // below the level range — code must reject
        }
        if (mode === FakeMode.MALFORMED && q.type === 'noul') {
          a = { ...a, noul: 2 }; // out of 0..1 — code must reject
        }
      }
      answers[id] = a;
    });
    return {
      model: 'fake/jev-1.13',
      answers,
      usage: { input_tokens: 10, output_tokens: 5 },
      latency_ms: 3,
    };
  };
}

export { answerToSignal };
