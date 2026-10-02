// Closed, advisory-only pilot. Exact question schemas, not caller-supplied
// question ids or confidence, select the local path. Policies bypass this router.
//
// Second eligibility lane (JEV_LAYA_QTYPE_PILOT): whole question *types* whose
// local accuracy was calibrated on the teacher corpus, kept behind the model's
// own post-temperature max-softmax. Still not caller-supplied — the caller
// cannot name a type or hand us a confidence; the allowlist and the threshold
// are both server-side, and anything under the threshold falls back to cloud.
// Calibration (scripts/laya-train.py, cross-fit OOF; never in-sample) is the
// only thing that may move these defaults, per AGENTS.md
// "不把 confidence 當正確率；所有自動化門檻必須經目標資料校準".
import { isDeepStrictEqual } from 'node:util';
import { answerToSignal } from './adapters.js';
import { ERR, LIMITS } from './core.js';
import { recordRoutingSample } from './routing-corpus.js';
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

export function makeLayaRouter({ local, cloud, record = recordRoutingSample, onRoute = () => {} }) {
  return async (state, questions, opts = {}) => {
    const deadlineAtMs = opts.deadlineAtMs ?? Date.now() + LIMITS.deadlineMs;
    const checkDeadline = () => {
      if (Date.now() >= deadlineAtMs) throw ERR.timeout('routing deadline exceeded');
    };
    checkDeadline();
    const localQs = {}, cloudQs = {}, samples = [];
    const eligible = !opts.model && shortStandaloneState(state);
    for (const [id, q] of Object.entries(questions)) {
      (eligible && (profile(q) || QTYPE_PILOT.has(q?.type)) ? localQs : cloudQs)[id] = q;
    }
    let localResult;
    const answers = {};
    if (Object.keys(localQs).length) {
      let error;
      try { localResult = await local(state, localQs, opts); }
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
        const lowConf = !profile(q) && !(invalid instanceof Error) && !noMatch && !(conf >= confMin(q?.type));
        const fallback = invalid instanceof Error || noMatch || lowConf;
        if (fallback) cloudQs[id] = q;
        else answers[id] = a;
        samples.push({ question_id: id, profile: profile(q), question: q, state,
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
      try { onRoute({ local: Object.keys(localQs).length, cloud: Object.keys(cloudQs).length,
        fallback: samples.filter(s => s.fallback_reason).length }); } catch { /* telemetry only */ }
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
