// Provider Adapters: isolate native TypeSafe and OpenRouter Decisions behind
// one contract. Real adapters drive jevwire's DecisionModel (extends the
// TypeSafe /v1/systemone shape). Fakes are deterministic and cover the failure
// space the conformance suite exercises — valid, missing, foreign, malformed,
// timeout, rate-limit, upstream failure — with zero provider cost.
import { JevDecisionModel } from 'jevwire';
import { ERR, LIMITS } from './core.js';
import { readZenStatus, recordZenStatus, zenCoolingDown } from './zen-status.js';
import { makeZenDailyTake } from './budget.js';
import { meteredFetch, callerName } from '../../agent-glue/src/usage-ledger.js';

// `gateway:<script>` (jev-route, stdio = MCP, zen-free-probe…) unless
// JEV_USAGE_CALLER names the caller. One usage line per HTTP attempt.
const usageFetch = (fetchImpl) => meteredFetch(callerName('gateway', { fromArgv: true }), fetchImpl);

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
  const m = new JevDecisionModel({ apiKey, baseUrl, model: toTypeSafeId(model), timeoutMs, maxRetries: LIMITS.maxRetries, fetch: usageFetch() });
  return async (state, questions, opts = {}) => m.evaluate({ state, questions, model: toTypeSafeId(opts.model) });
}

export function makeOpenrouterAdapter({ apiKey, baseUrl = 'https://openrouter.ai/api', model = 'typesafe/jev-1.13', timeoutMs = LIMITS.deadlineMs, maxRetries = LIMITS.maxRetries, fetch: fetchImpl, sleep }) {
  // JevDecisionModel appends `/v1/systemone`; the base must stop at `/api`.
  const m = new JevDecisionModel({ apiKey, baseUrl, model, timeoutMs, maxRetries, fetch: usageFetch(fetchImpl), sleep });
  return async (state, questions, opts = {}) => m.evaluate({ state, questions, model: opts.model });
}

// --- Zen: OpenCode Zen's hosted System One endpoint, free tier ---
// Third System One host, same `/v1/systemone` contract as OpenRouter and the
// same account key as the rest of OpenCode — only the base and the pinned
// model id differ, so the shape is the OpenRouter adapter's verbatim. `baseUrl`
// must stop before `/v1`: the client appends `/v1/systemone` itself.
//
// The free tier has a quota (a 429 FreeUsageLimitError whose retry-after ran
// ~15h on 2026-09-30), so `backup` — the OpenRouter adapter — answers while Zen
// cools down, and Zen takes over again once the cooldown lapses. The cooldown
// lives in the status file, so every process (gateway, probe, hooks) sees one
// primary/backup state. Without a backup a Zen failure still fails closed.
const ZEN_RETRY_COOLDOWN_MS = 5 * 60_000; // non-429 failures: stop paying the timeout on every call
const ZEN_QUOTA_DEFAULT_MS = 60 * 60_000; // 429 without a usable retry-after
// 403 FreeTierError: the egress IP is flagged as abusive (10-18, official client too).
// Retrying every 5 min only feeds the flag; same 6h window as dc's ZEN_GATE_S.
const ZEN_ABUSE_COOLDOWN_MS = 6 * 3600_000;
// A ban that is still there after the window doubles it (6h→12h→24h→48h): a
// fixed 6h retry is 4 hits a day of the very traffic the flag counts (10-19).
const ZEN_ABUSE_COOLDOWN_MAX_MS = 48 * 3600_000;

export function makeZenAdapter({ apiKey, baseUrl = 'https://opencode.ai/zen', model = 'jev-1.13-free', timeoutMs = LIMITS.deadlineMs, onStatus = recordZenStatus, readStatus = readZenStatus, backup = null, coolingDown = zenCoolingDown, takeZen = makeZenDailyTake(), fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  // Fail loud on a pasted OpenRouter/TypeSafe id (`typesafe/jev-1.13`,
  // `openrouter/…`): Zen's catalog is bare ids, and a silent 400 from the
  // provider would read as "the free model is broken" instead of "wrong id".
  if (String(model ?? '').includes('/')) {
    throw new Error(`zen model id must be a bare Zen catalog id (e.g. jev-1.13-free), got ${model}`);
  }
  // jevwire honours retry-after by sleeping until its deadline and then throws
  // a JevTimeoutError — a quota 429 used to read as a timeout. So Zen gets no
  // retries, and this fetch keeps the header jevwire drops.
  let retryAfterS = null;
  const peek = async (url, init) => {
    const res = await fetchImpl(url, init);
    retryAfterS = res.status === 429 ? Number(res.headers.get('retry-after')) : null;
    return res;
  };
  // Every policy pins its own provider's id (`typesafe/jev-1.13-20260917`) and
  // `applyPolicy` forwards it verbatim — Zen 422s on a foreign id, which reads
  // as an outage. Translate HERE at the adapter boundary, exactly as
  // makeTypesafeAdapter does in the other direction, so one policy set serves
  // every provider. The substituted model rides back as `resolved_model`, the
  // one audit record left after the substitution.
  const call = makeOpenrouterAdapter({ apiKey, baseUrl, model, timeoutMs, maxRetries: 0, fetch: peek });
  return async (state, questions, opts = {}) => {
    // The backup keeps the caller's model id: OpenRouter wants `typesafe/…`.
    // Cooling skips Zen for every caller: without a backup it fails closed with
    // no network call — a ban fed by backup-less callers never lapses (fix 11052).
    if (coolingDown(now())) {
      if (backup) return backup(state, questions, opts);
      throw ERR.provider(`zen ${model} cooling down; skipped without a network call`, false);
    }
    // Daily cap (JEV_ZEN_DAILY_MAX): over it the backup answers, so our volume never becomes the abuse signal.
    if (backup && !takeZen()) return backup(state, questions, opts);
    try {
      const result = await call(state, questions, { ...opts, model });
      onStatus(true, { model: result.model ?? model });
      return result;
    } catch (e) {
      const quota = e?.status === 429 || e?.cause?.status === 429;
      const abuse = (e?.body ?? e?.cause?.body)?.error?.type === 'FreeTierError';
      // Recorded even without a backup: the probe reports when Zen comes back.
      const prev = abuse ? readStatus() : null;
      const block_streak = abuse ? (prev?.blocked ? (prev.block_streak || 1) + 1 : 1) : 0;
      const cooldown_until = now() + (abuse ? Math.min(ZEN_ABUSE_COOLDOWN_MS * 2 ** (block_streak - 1), ZEN_ABUSE_COOLDOWN_MAX_MS)
        : quota ? (retryAfterS > 0 ? retryAfterS * 1000 : ZEN_QUOTA_DEFAULT_MS) : ZEN_RETRY_COOLDOWN_MS);
      // `blocked` tells the probe an IP ban (needs a human) from a quota swap (heals itself).
      onStatus(false, {
        model, error: e?.message ?? String(e), error_class: e?.name ?? null, cooldown_until, blocked: abuse, block_streak,
        ...(abuse && { remediation: `Zen 免費層 403 FreeTierError：OpenCode 判本機出口 IP 濫用，官方客戶端同樣被擋。冷卻至 ${new Date(cooldown_until).toISOString()}，期間 Jev 走付費 OpenRouter；解封要等上游。` }),
      });
      // No backup: abort, do not degrade — the gateway fails closed.
      if (!backup) throw e;
      return backup(state, questions, opts);
    }
  };
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
