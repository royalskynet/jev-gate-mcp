// External corpora (SWE-bench Verified → difficulty, CLAMBER → ambiguous) feed
// Laya two ways: an exam it never trains on, and a low-weight slice of the
// nightly training folds. Three things can silently rot: the question text
// drifting from the live one (the model then learns a question nobody asks),
// the exam leaking into training, and external rows reaching the out-of-fold
// rows that the nightly's "do not export a regression" gate reads.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  pickTemplate, swebenchRecord, clamberRecord, stratifiedSplit, dedupeBy, questionDigest, SWEBENCH_LEVEL,
} from '../scripts/laya-external-corpus.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const DIFF = { type: 'score', instructions: 'Rate the difficulty…', criteria: ['trivial', 'simple', 'moderate', 'hard'] };
const TRIAGE = { difficulty: DIFF, kind: { type: 'choice', instructions: 'k', criteria: { a: 'a' } } };
const ROUTE = { tier: { type: 'choice', instructions: 't', criteria: { L0: 'x' } },
  ambiguous: { type: 'noul', instructions: 'Two or more readings?', criteria: { true: 'y', false: 'n' } } };
const TEACHER = [
  { questions: { difficulty: { ...DIFF, instructions: 'an older wording' } } },
  { questions: TRIAGE },
  { questions: ROUTE },
];

test('questions are copied verbatim from the newest live row, so the digest matches the live one', () => {
  const q = pickTemplate(TEACHER, 'difficulty');
  assert.equal(q, TRIAGE, 'took a stale wording instead of the current one');
  const rec = swebenchRecord({ instance_id: 'a__b-1', problem_statement: 'fix it', difficulty: '1-4 hours' }, q, 'train');
  assert.deepEqual(rec.questions, TRIAGE);
  assert.equal(rec.question_digest, questionDigest(TRIAGE));
  // Only the mapped question carries an answer; the trainer skips the rest.
  assert.deepEqual(Object.keys(rec.teacher_answer), ['difficulty']);
  assert.throws(() => pickTemplate(TEACHER, 'nope'));
});

test('labels map onto the live rubric and are marked removable by source', () => {
  // Both scales are four levels, lowest first.
  assert.deepEqual(Object.values(SWEBENCH_LEVEL), [0, 1, 2, 3]);
  const s = swebenchRecord({ instance_id: 'x', problem_statement: 'p'.repeat(9000), difficulty: '<15 min fix' }, TRIAGE, 'eval');
  assert.deepEqual(s.teacher_answer.difficulty, { type: 'score', score: 0 });
  assert.equal(s.label_source, 'external:swebench-verified');
  assert.equal(s.training_eligible, false, 'an exam row must never be training-eligible');
  // triage.js convention: sliced to ask_chars, bucket by length, no other keys.
  assert.deepEqual(Object.keys(s.state), ['user_request', 'char_bucket']);
  assert.ok(s.state.user_request.length < 2600);
  assert.equal(s.state.char_bucket, 'm');
  assert.throws(() => swebenchRecord({ instance_id: 'x', problem_statement: 'p', difficulty: 'soon' }, TRIAGE, 'eval'));

  const c = clamberRecord({ question: 'What is a fork?', context: '', require_clarification: 1 }, ROUTE, 'train');
  assert.deepEqual(c.teacher_answer.ambiguous, { type: 'noul', noul: 1 });
  assert.equal(c.label_source, 'external:clamber');
  // jev-route convention: the state carries dirty_paths and phase, empty here.
  assert.deepEqual(c.state, { user_request: 'What is a fork?', dirty_paths: [], phase: 'unknown' });
  assert.throws(() => clamberRecord({ question: 'q', require_clarification: 2 }, ROUTE, 'train'));
});

test('the exam and the training slice never overlap, per stratum and deterministically', () => {
  const items = dedupeBy([...Array(300)].map((_, i) => ({ id: `q${i % 290}`, y: i % 3 })), (r) => r.id);
  assert.equal(items.length, 290, 'a duplicated sentence could land on both sides');
  const run = () => stratifiedSplit(items, { key: (r) => r.id, stratum: (r) => r.y, nEval: 90, nTrain: 120 });
  const { evalSet, trainSet } = run();
  assert.equal(evalSet.length, 90);
  assert.equal(trainSet.length, 120);
  const ev = new Set(evalSet.map((r) => r.id));
  assert.ok(trainSet.every((r) => !ev.has(r.id)), 'exam rows leaked into training');
  for (const y of [0, 1, 2]) {
    const n = evalSet.filter((r) => r.y === y).length;
    assert.ok(n >= 29 && n <= 31, `stratum ${y} got ${n}/90`);
  }
  assert.deepEqual(run().evalSet.map((r) => r.id), evalSet.map((r) => r.id), 'split is not reproducible');
});

// The trainer is Python; drive its pure helpers directly (stdlib only, no torch).
const PY = `
import importlib.util, json, sys, tempfile, os
spec = importlib.util.spec_from_file_location("t", sys.argv[1]); T = importlib.util.module_from_spec(spec); spec.loader.exec_module(T)
q = {"type": "score", "criteria": ["a", "b", "c", "d"]}
own = [{"questions": {"d": q}, "teacher_answer": {"d": {"type": "score", "score": 1}}, "state": {"user_request": f"r{i}"}} for i in range(20)]
ext = [{"questions": {"d": q}, "teacher_answer": {"d": {"type": "score", "score": 3}}, "state": {"user_request": f"x{i}"},
        "label_source": "external:t", "split": s} for i, s in enumerate(["train"] * 6 + ["eval"] * 3)]
d = tempfile.mkdtemp(); p = os.path.join(d, "train-t.jsonl")
open(p, "w").write("".join(json.dumps(r) + "\\n" for r in ext + own))
loaded = T.load_external(p, 0.2)
units, _ = T.build_units(own + loaded, external_weight=0.2)
folds = T.cv_splits(units, 5)
print(json.dumps({
  "loaded": len(loaded), "off": len(T.load_external(p, 0)), "off_spec": len(T.load_external("off", 0.2)),
  "weights": sorted({u["weight"] for u in units if u["external"]}),
  "val_external": sum(u["external"] for _, va in folds for u in va),
  "val_total": sum(len(va) for _, va in folds),
  "train_external": [sum(u["external"] for u in tr) for tr, _ in folds],
}))
`;

function python() {
  for (const bin of ['python3', 'python']) {
    try { execFileSync(bin, ['-c', 'pass']); return bin; } catch { /* next */ }
  }
  return null;
}

test('external rows train every fold at low weight and never reach the out-of-fold rows', { skip: !python() && 'no python' }, () => {
  const out = JSON.parse(execFileSync(python(), ['-c', PY, path.join(ROOT, 'scripts/laya-train.py')], { encoding: 'utf8' }));
  // Only split=train external:* rows load; the exam is filtered even when globbed.
  assert.equal(out.loaded, 6, 'exam rows (split=eval) or own rows were loaded as external training data');
  assert.equal(out.off, 0, 'weight 0 must switch external data off');
  assert.equal(out.off_spec, 0);
  assert.deepEqual(out.weights, [0.2]);
  // OOF logits feed temperatures and live_gated, which the nightly export gate
  // reads. An external row there would grade the model on questions no live
  // caller sent and move the "regressed against the champion" comparison.
  assert.equal(out.val_external, 0, 'external rows reached the out-of-fold rows the export gate reads');
  assert.equal(out.val_total, 20, 'every live row must still be scored out of fold exactly once');
  assert.deepEqual(out.train_external, [6, 6, 6, 6, 6]);
});
