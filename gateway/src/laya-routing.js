// Closed, advisory-only pilot. Exact question schemas, not caller-supplied
// question ids or confidence, select the local path. Policies bypass this router.
//
// Second eligibility lane (JEV_LAYA_QTYPE_PILOT): whole question *types* whose
// local accuracy was calibrated on the teacher corpus, kept behind the model's
// own post-temperature max-softmax. Still not caller-supplied — the caller
// cannot name a type or hand us a confidence; the allowlist and the threshold
// are both server-side, and anything under the threshold falls back to cloud.
// Calibration (laya-train/scripts/laya-train.py, cross-fit OOF; never in-sample) is the
// only thing that may move these defaults, per AGENTS.md
// "不把 confidence 當正確率；所有自動化門檻必須經目標資料校準".
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { answerToSignal } from './adapters.js';
import { ERR, LIMITS } from './core.js';
import { recordRoutingSample } from './routing-corpus.js';
import { logHandoff, callerName } from '../../agent-glue/src/usage-ledger.js';
import { TASK_KIND, MESSAGE_TOPIC } from './classification-profiles.js';
export { TASK_KIND, MESSAGE_TOPIC } from './classification-profiles.js';

function profile(q) {
  if (isDeepStrictEqual(q, TASK_KIND)) return 'task-kind-v1';
  if (isDeepStrictEqual(q, MESSAGE_TOPIC)) return 'message-topic-v1';
  return null;
}

// Question types the local model may answer on its own, and the post-temperature
// max-softmax it must clear. Both are calibrated numbers, not preferences:
// see docs/adr/0002-laya-qtype-confidence-lane.md for the measurement that set them.
const QTYPE_PILOT = new Set(
  (process.env.JEV_LAYA_QTYPE_PILOT ?? 'score,noul').split(',').map(s => s.trim()).filter(Boolean));
// The knee is not in the same place for every type: score holds 100% OOF down
// to 0.65 while noul breaks below 0.70, so one shared number has to give up
// score coverage or let noul through unsupported.
export function parseConfMin(spec) {
  const flat = Number(spec);
  if (Number.isFinite(flat)) return () => flat;
  const byType = new Map(spec.split(',').filter(Boolean).map(pair => {
    const [type, floor] = pair.split('=').map(s => s.trim());
    return [type, Number(floor)];
  }));
  // An unlisted type has no calibrated floor, so nothing clears it.
  return type => byType.get(type) ?? Infinity;
}
const confMin = parseConfMin(process.env.JEV_LAYA_CONF_MIN ?? 'score=0.65,noul=0.70');

// Laya reports `probabilities` for choice/score but only `noul` (= P(true)) for
// noul, which is binary, so its max-softmax is recoverable from that one number.
export function maxSoftmax(a) {
  if (a?.probabilities && typeof a.probabilities === 'object') {
    const ps = Object.values(a.probabilities).filter(p => typeof p === 'number');
    return ps.length ? Math.max(...ps) : null;
  }
  if (typeof a?.noul === 'number') return Math.max(a.noul, 1 - a.noul);
  return null;
}

function shortStandaloneState(state) {
  let text = state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    if (Object.keys(state).some(k => !['user_request', 'char_bucket'].includes(k))) return false;
    if (state.char_bucket != null && state.char_bucket !== 's') return false;
    text = state.user_request;
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 320) return false;
  // Conservative exclusions, not a claim that regex detects all ambiguity.
  return !/[\r\n]|不要|別|别|不是|並且|并且|然後|然后|先.*再|剛才|刚才|上述|前面|照.*說|照.*说|刪除|删除|部署|付款|密碼|密码|\b(not|don't|never|then|previous|delete|deploy|password|payment)\b/i.test(text);
}

// Third lane (JEV_LAYA_WHITELIST=live): (caller, question family) pairs that
// laya-train/scripts/laya-calibrate.py certified on shadow traffic — strict fixed-sequence
// over thresholds, Clopper–Pearson lower bound ≥ 0.90. It replaces the state
// filter for those pairs: the filter was a proxy for "which caller is this"
// (ADR-0002), and the caller is known here. Default 'off': the file is written
// nightly, but nothing serves from it until a human has read the shadow report.
const LOCAL_TYPES = new Set(['choice', 'score', 'noul']);
const WHITELIST_FILE = process.env.JEV_LAYA_WHITELIST_FILE ?? join(homedir(), '.jevgate', 'laya-whitelist.json');
const WHITELIST_MAX_AGE_MS = 3 * 86400000;
// Mirror of laya-train.py `_family`: trailing digits are a sequence number (call_t1, result_t27).
export const family = qid => String(qid).replace(/\d+$/, '#');

// A stale or unreadable file is an empty whitelist — the lane may only keep
// work local on fresh positive evidence.
export function loadWhitelist(file = WHITELIST_FILE, now = Date.now()) {
  try {
    const wl = JSON.parse(readFileSync(file, 'utf8'));
    if (!(now - Date.parse(wl.generated) <= WHITELIST_MAX_AGE_MS)) return new Map();
    return new Map((wl.entries ?? []).filter(e => Number.isFinite(e.threshold))
      .map(e => [`${e.caller}\t${e.family}`, e.threshold]));
  } catch { return new Map(); }
}
let wlCache = { mtimeMs: -1, at: 0, map: new Map() };
function cachedWhitelist() {
  try {
    const { mtimeMs } = statSync(WHITELIST_FILE);
    // Re-read on change, and hourly anyway so the staleness check keeps running.
    if (mtimeMs !== wlCache.mtimeMs || Date.now() - wlCache.at > 3600000) {
      wlCache = { mtimeMs, at: Date.now(), map: loadWhitelist() };
    }
    return wlCache.map;
  } catch { return new Map(); }
}

// Shadow digestion queue, one per `local` adapter so every router (cascade and
// each qtypes lane) shares it. A compact request carries 80–190 questions; run
// in one go it pinned the event loop for minutes and peaked at 31GB (fix
// 10532/10543). Instead each request contributes at most `maxQ` sampled
// questions, the queue holds at most `queueMax` questions (the rest are
// dropped — nobody waits on shadow), and one worker digests `batch` questions
// per local call with `gapMs` between calls so live traffic gets the session.
const shadowQueues = new WeakMap();
const envInt = (k, d) => { const v = Number(process.env[k]); return process.env[k] && Number.isFinite(v) && v >= 0 ? v : d; };
// Local-lane budget. LOCAL_BUDGET_MS is how long Laya may run on the request
// path; LOCAL_RESERVE_MS is what is held back for Jev no matter what, so a slow
// or failing local lane can only lose its own share of the deadline.
export const LOCAL_BUDGET_MS = envInt('JEV_LAYA_LOCAL_BUDGET_MS', 5000);
export const LOCAL_RESERVE_MS = envInt('JEV_LAYA_CLOUD_RESERVE_MS', 8000);
export const SHADOW_LIMITS = Object.freeze({
  maxQ: envInt('JEV_LAYA_SHADOW_MAX_Q', 16),
  queueMax: envInt('JEV_LAYA_SHADOW_QUEUE', 64),
  gapMs: envInt('JEV_LAYA_SHADOW_GAP_MS', 500),
  batch: envInt('JEV_LAYA_BATCH', 4) || 4,
});

function sample(entries, n) {
  if (entries.length <= n) return entries;
  const a = [...entries];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function shadowQueueFor(local, limits) {
  let q = shadowQueues.get(local);
  if (q) return q;
  const jobs = [];
  let pending = 0, running = false;
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
  const drain = async () => {
    running = true;
    let ran = false;
    try {
      while (jobs.length) {
        const job = jobs.shift();
        const entries = Object.entries(job.questions);
        const answers = {};
        let model;
        for (let i = 0; i < entries.length; i += limits.batch) {
          if (ran && limits.gapMs) await sleep(limits.gapMs);
          ran = true;
          const res = await Promise.resolve().then(() => local(job.state, Object.fromEntries(entries.slice(i, i + limits.batch)), {})).catch(() => null);
          if (res) { model ??= res.model; Object.assign(answers, res.answers ?? {}); }
        }
        pending -= entries.length;
        try { job.done({ model, answers }); } catch { /* evidence only */ }
      }
    } finally { running = false; }
  };
  q = {
    // Returns the questions actually queued ({} when the queue is full).
    push(state, questions, done) {
      const picked = sample(Object.entries(questions), limits.maxQ);
      if (!picked.length || pending + picked.length > limits.queueMax) return {};
      const qs = Object.fromEntries(picked);
      jobs.push({ state, questions: qs, done });
      pending += picked.length;
      if (!running) void drain();
      return qs;
    },
    get pending() { return pending; },
  };
  shadowQueues.set(local, q);
  return q;
}

// `qtypes` narrows the question-type lane per caller. The MCP keeps the env
// default; agent-glue's triage passes ['score'] so its costly_mistake (noul)
// always goes to the cloud (agent-glue/src/live.js).
//
// Shadow (cascade-server turns it on; JEV_LAYA_SHADOW=0 turns it off): questions that go to
// the cloud anyway are also run locally, in the background, so every request
// leaves a (caller, family, local confidence, teacher answer) row — the only
// calibration data drawn from the traffic the lane would actually serve.
// The response never waits for it: once the teacher answer is in, a sample of
// the questions goes to the shared digestion queue above.
export function makeLayaRouter({ local, cloud, record = recordRoutingSample, onRoute = () => {}, qtypes = QTYPE_PILOT, handoff = logHandoff,
  shadow = false, shadowLimits = SHADOW_LIMITS, localBudgetMs = LOCAL_BUDGET_MS, cloudReserveMs = LOCAL_RESERVE_MS,
  whitelist = process.env.JEV_LAYA_WHITELIST === 'live' ? cachedWhitelist : () => new Map() }) {
  const pilot = new Set(qtypes);
  const shadowQueue = shadow ? shadowQueueFor(local, shadowLimits) : null;
  return async (state, questions, opts = {}) => {
    const deadlineAtMs = opts.deadlineAtMs ?? Date.now() + LIMITS.deadlineMs;
    const checkDeadline = () => {
      if (Date.now() >= deadlineAtMs) throw ERR.timeout('routing deadline exceeded');
    };
    checkDeadline();
    const caller = opts.caller ?? callerName('gateway', { fromArgv: true });
    const localQs = {}, cloudQs = {}, samples = [], wlFloor = {};
    const eligible = !opts.model && shortStandaloneState(state);
    const wl = opts.model ? new Map() : whitelist();
    for (const [id, q] of Object.entries(questions)) {
      const floor = LOCAL_TYPES.has(q?.type) ? wl.get(`${caller}\t${family(id)}`) : undefined;
      if (floor !== undefined) wlFloor[id] = floor;
      (floor !== undefined || (eligible && (profile(q) || pilot.has(q?.type))) ? localQs : cloudQs)[id] = q;
    }
    const shadowQs = shadowQueue && !opts.model
      ? Object.fromEntries(Object.entries(cloudQs).filter(([, q]) => LOCAL_TYPES.has(q?.type))) : {};
    let localResult;
    const answers = {};
    if (Object.keys(localQs).length) {
      let error;
      // The local attempt may never spend the budget the paid fallback needs.
      // Laya costs ~5s per batch of 4 on a compact-sized state, so a 62-question
      // whitelisted request used to burn the whole 15s deadline and the request
      // then died before Jev was ever called — a local miss turned into a total
      // outage (fix 10628). Cap the local lane at its own slice and keep the
      // rest for the cloud, which still has to answer whatever Laya misses.
      const localDeadlineAtMs = Math.min(deadlineAtMs - cloudReserveMs, Date.now() + localBudgetMs);
      try {
        if (localDeadlineAtMs <= Date.now()) throw ERR.timeout('no budget left for the local lane');
        localResult = await local(state, localQs, { ...opts, deadlineAtMs: localDeadlineAtMs });
      }
      catch (e) { error = e; }
      for (const [id, q] of Object.entries(localQs)) {
        const a = localResult?.answers?.[id];
        const invalid = error ?? answerToSignal(q, a);
        const noMatch = a?.choice === 'no_match' || (profile(q) === 'task-kind-v1' && a?.choice === 'general');
        // The threshold guards the question-type lane only. The older profile
        // lane keeps its own no_match fallback: gating it too would push most of
        // its traffic back to the cloud, which is the opposite of the point.
        // An unreadable confidence counts as too low — the lane may only keep
        // work local on positive evidence.
        const conf = maxSoftmax(a);
        const floor = Object.hasOwn(wlFloor, id) ? wlFloor[id] : confMin(q?.type);
        const lowConf = (!profile(q) || Object.hasOwn(wlFloor, id)) && !(invalid instanceof Error) && !noMatch && !(conf >= floor);
        const fallback = invalid instanceof Error || noMatch || lowConf;
        if (fallback) cloudQs[id] = q;
        else answers[id] = a;
        samples.push({ question_id: id, caller, profile: profile(q), question: q, state,
          local_model: localResult?.model ?? 'laya', local_answer: a ?? null,
          local_confidence: conf,
          fallback_reason: invalid instanceof Error ? 'local-error-or-invalid' : noMatch ? 'no-match'
            : lowConf ? 'low-confidence' : null,
          teacher_model: null, teacher_answer: null, label: null });
      }
    }
    let remote;
    try {
      // The outer timeout cannot cancel ONNX work. Never start a new paid
      // request once that caller's absolute deadline has already expired.
      checkDeadline();
      if (Object.keys(cloudQs).length) {
        if (!cloud) throw ERR.auth('Jev provider has no configured credential');
        remote = await cloud(state, cloudQs, opts);
        for (const id of Object.keys(cloudQs)) {
          if (remote?.answers?.[id] !== undefined) answers[id] = remote.answers[id];
        }
      }
    } finally {
      for (const sample of samples) {
        if (sample.fallback_reason && remote?.answers?.[sample.question_id]) {
          sample.teacher_model = remote.model;
          sample.teacher_answer = remote.answers[sample.question_id];
        }
        try { record(sample); } catch { /* evidence collection cannot fail a request */ }
      }
      // Only questions the teacher answered are worth a local run.
      const teacher = remote;
      const taught = Object.fromEntries(Object.entries(shadowQs).filter(([id]) => teacher?.answers?.[id] !== undefined));
      if (Object.keys(taught).length) {
        // No state in the row: the teacher corpus already keeps it, and the
        // calibration only needs confidence against the teacher's answer.
        const request_id = randomUUID();
        const queued = shadowQueue.push(state, taught, (res) => {
          for (const [id, q] of Object.entries(queued)) {
            const a = res?.answers?.[id], t = teacher.answers[id];
            if (a === undefined) continue;
            try {
              record({ shadow: true, request_id, question_id: id, caller, family: family(id), profile: null, question: q,
                local_model: res.model ?? 'laya', local_answer: a, local_confidence: maxSoftmax(a),
                fallback_reason: null, teacher_model: teacher.model ?? null, teacher_answer: t });
            } catch { /* evidence only */ }
          }
        });
      }
      try { onRoute({ local: Object.keys(localQs).length, cloud: Object.keys(cloudQs).length,
        fallback: samples.filter(s => s.fallback_reason).length }); } catch { /* telemetry only */ }
      const why = (r) => samples.filter(s => s.fallback_reason === r).length;
      const qTotal = Object.keys(questions).length, qCloud = Object.keys(cloudQs).length;
      handoff({ caller,
        q_total: qTotal, q_local: qTotal - qCloud, q_cloud: qCloud,
        by_state_filter: qTotal - Object.keys(localQs).length,
        by_low_conf: why('low-confidence'), by_invalid: why('local-error-or-invalid'), by_no_match: why('no-match') });
    }
    const usedLocal = Object.keys(localQs).some(id => !Object.hasOwn(cloudQs, id));
    const model = usedLocal && remote ? `hybrid:${localResult.model}+${remote.model}`
      : usedLocal ? localResult.model : remote?.model ?? null;
    return { model, answers, latency_ms: null, usage: {
      input_tokens: (localResult?.usage?.input_tokens ?? 0) + (remote?.usage?.input_tokens ?? 0),
      output_tokens: (localResult?.usage?.output_tokens ?? 0) + (remote?.usage?.output_tokens ?? 0),
    } };
  };
}
