// Teacher corpus: the free Jev tier's own answers, kept so the local Laya
// weights can be distilled offline against a real teacher instead of against
// the routing heuristic's guesses.
//
// This is the mirror of routing-corpus.js. That one records what the local
// weights said (and only when the router actually used them); this one records
// what the provider said, for every judgement the gateway makes. Laya never
// runs in this path — a hook process would cold-load a 540MB ONNX graph per
// prompt and spend the caller's whole deadline on it — so the local answer is
// filled in later, out of band, by scripts/laya-label-corpus.mjs.
//
// Same privacy contract as routing-corpus: private file, 0600, never telemetry,
// never an automatic training feed. `training_eligible` stays false until a
// human or a labelled batch promotes it; a provider answer is a teacher
// suggestion, not gold.
import { appendFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const REAL_TEACHER_CORPUS = join(homedir(), '.jevgate', 'teacher-corpus.jsonl');
export const TEACHER_CORPUS_FILE = process.env.JEV_TEACHER_CORPUS ?? REAL_TEACHER_CORPUS;

// `extra` overrides the trailing bookkeeping fields (label_source, split, …);
// scripts/backtest-teacher.mjs tags its replayed rows with it.
export function recordTeacherSample({ state, questions, result, caller = null }, file = TEACHER_CORPUS_FILE, extra = {}) {
  if (!file || file === 'off') return false;
  // Fakes exist to make tests deterministic; training on them teaches nothing.
  if (/^(fake|mock)(\/|$)/.test(result?.model ?? '')) return false;
  // Real-call tests answer with a real model, so the check above misses them;
  // their probe prompts were 96% of the score/noul rows by 10-05. `node --test`
  // sets this in the test process and every subprocess it spawns.
  if (process.env.NODE_TEST_CONTEXT && file === REAL_TEACHER_CORPUS) return false;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) chmodSync(file, 0o600);
    const question_digest = createHash('sha256').update(JSON.stringify(questions)).digest('hex');
    appendFileSync(file, JSON.stringify({
      id: randomUUID(),
      ts: new Date().toISOString(),
      schema_version: 1,
      question_digest,
      // Who asked: the local lane's whitelist is keyed on it (laya-calibrate.py).
      caller,
      state,
      questions,
      teacher_model: result.model ?? null,
      teacher_answer: result.answers ?? null,
      usage: result.usage ?? null,
      // Filled in later by scripts/laya-label-corpus.mjs; null means "Laya has
      // not been asked yet", which is the normal state for a fresh record.
      local_model: null,
      local_answer: null,
      label: null,
      label_source: null,
      split: 'unassigned',
      training_eligible: false,
      ...extra,
    }) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a provider adapter so every answer it returns is kept as a teacher
 * sample. Recording is best-effort by construction — a corpus write can never
 * fail a judgement, and it never sees the answer before the caller does.
 */
export function withTeacherCorpus(adapter, record = recordTeacherSample) {
  return async (state, questions, opts) => {
    const result = await adapter(state, questions, opts);
    try { record({ state, questions, result, caller: opts?.caller ?? null }); } catch { /* evidence only */ }
    return result;
  };
}
