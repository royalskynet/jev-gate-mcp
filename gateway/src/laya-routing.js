// Closed, advisory-only pilot. Exact question schemas, not caller-supplied
// question ids or confidence, select the local path. Policies bypass this router.
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
      (eligible && profile(q) ? localQs : cloudQs)[id] = q;
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
        const fallback = invalid instanceof Error || noMatch;
        if (fallback) cloudQs[id] = q;
        else answers[id] = a;
        samples.push({ question_id: id, profile: profile(q), question: q, state,
          local_model: localResult?.model ?? 'laya', local_answer: a ?? null,
          fallback_reason: invalid instanceof Error ? 'local-error-or-invalid' : noMatch ? 'no-match' : null,
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
