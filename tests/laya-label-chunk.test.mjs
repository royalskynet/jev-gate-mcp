// `systemOne` puts every question of one record into one ONNX batch, so a wide
// record's activations scale with its question count. The corpus was all 1–4
// question rows until 10-09, when a caller started asking 17–186 at once; one
// such row walked the labeller to 31GB and ram_guard killed the 10-09 night at
// rc=143 before training started. These tests hold the two properties that keep
// that from coming back: no batch ever exceeds the chunk size, and the labeller
// stops at its time budget instead of pushing training into the morning.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SCRIPT = path.join(ROOT, 'scripts/laya-label-corpus.mjs');

const record = (id, nq) => JSON.stringify({
  id,
  state: { s: 'x' },
  questions: Object.fromEntries(Array.from({ length: nq }, (_, i) => [`q${i}`, { choice: ['a', 'b'] }])),
  teacher_answer: Object.fromEntries(Array.from({ length: nq }, (_, i) => [`q${i}`, { choice: 'a' }])),
  question_digest: `d${id}`,
});

// A stub adapter that logs the batch width it was handed and the wall time it
// burns, so the test can assert on both without loading the 540MB graph.
function sandbox({ delayMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-label-'));
  const at = (f) => path.join(dir, f);
  fs.writeFileSync(at('adapter.mjs'), `
import { appendFileSync } from 'node:fs';
export function makeLayaAdapter() {
  return async function laya(state, questions) {
    const ids = Object.keys(questions);
    appendFileSync(${JSON.stringify(at('widths.txt'))}, ids.length + '\\n');
    ${delayMs ? `await new Promise((r) => setTimeout(r, ${delayMs}));` : ''}
    return { model: 'stub', answers: Object.fromEntries(ids.map((k) => [k, { choice: 'a' }])) };
  };
}
`);
  const run = (corpusRows, env = {}) => {
    fs.writeFileSync(at('corpus.jsonl'), corpusRows.join('\n') + '\n');
    return execFileSync('node', [SCRIPT], {
      env: {
        ...process.env,
        JEV_TEACHER_CORPUS: at('corpus.jsonl'),
        JEV_LAYA_ADAPTER_MODULE: at('adapter.mjs'),
        JEV_LAYA_REPORT: at('agreement.json'),
        JEV_LAYA_LABEL_DONE: at('label.done'),
        ...env,
      },
      encoding: 'utf8',
    });
  };
  const widths = () => (fs.existsSync(at('widths.txt'))
    ? fs.readFileSync(at('widths.txt'), 'utf8').trim().split('\n').map(Number) : []);
  const done = () => JSON.parse(fs.readFileSync(at('label.done'), 'utf8'));
  const corpus = () => fs.readFileSync(at('corpus.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // Same env as `run`, but detached so the test can kill it mid-pass.
  const start = (corpusRows, env = {}) => {
    fs.writeFileSync(at('corpus.jsonl'), corpusRows.join('\n') + '\n');
    return spawn('node', [SCRIPT], {
      env: {
        ...process.env,
        JEV_TEACHER_CORPUS: at('corpus.jsonl'),
        JEV_LAYA_ADAPTER_MODULE: at('adapter.mjs'),
        JEV_LAYA_REPORT: at('agreement.json'),
        JEV_LAYA_LABEL_DONE: at('label.done'),
        ...env,
      },
      stdio: 'ignore',
    });
  };
  return { at, run, start, widths, done, corpus };
}

test('a 186-question record is answered in bounded batches, and every question gets an answer', () => {
  const { run, widths, corpus } = sandbox();
  const out = run([record('wide', 186)], { JEV_LAYA_LABEL_CHUNK: '8', JEV_LAYA_LABEL_PER_FAMILY: '0' });
  assert.ok(widths().length > 1, 'answered 186 questions in one batch — this is what hit 31GB');
  assert.equal(Math.max(...widths()), 8, `a batch exceeded the chunk size: ${widths().join(',')}`);
  assert.equal(widths().reduce((a, b) => a + b, 0), 186, 'slicing dropped or duplicated questions');
  // A partially answered row would be counted as scored and skew the agreement
  // report, so the row must come back complete.
  assert.equal(Object.keys(corpus()[0].local_answer).length, 186);
  assert.match(out, /scored=1 .* failed=0 deferred=0/);
});

test('a wide record labels at most PER_FAMILY questions of one family, spread over the record', () => {
  const { at, run, widths, corpus, done } = sandbox();
  // 10-18: a compact record asks call_t1…call_t190; labelling all of them made
  // the backlog 22k questions ≈ 9.9h against a 1.5h budget.
  const row = JSON.parse(record('wide', 186));
  row.questions.other = { choice: ['a', 'b'] };
  run([JSON.stringify(row)], { JEV_LAYA_LABEL_CHUNK: '8' });
  const got = Object.keys(corpus()[0].local_answer);
  assert.deepEqual(got, ['q0', 'q62', 'q123', 'q185', 'other']);
  assert.equal(widths().reduce((a, b) => a + b, 0), 5);
  assert.equal(done().scored, 1);
  // the agreement report only compares questions Laya was asked
  const rep = JSON.parse(fs.readFileSync(at('agreement.json'), 'utf8'));
  assert.equal(rep.groups['dwide/q1'], undefined);
  assert.equal(rep.groups['dwide/q62'].n, 1);
});

test('narrow records stay on the single-batch path', () => {
  const { run, widths } = sandbox();
  // The 557 rows labelled before 10-09 were all 1–4 questions. Slicing them
  // would multiply the per-call overhead for no memory gain.
  run([record('a', 3), record('b', 1)], { JEV_LAYA_LABEL_CHUNK: '8' });
  assert.deepEqual(widths(), [3, 1]);
});

test('the time budget defers the rest instead of failing the night', () => {
  const { run, done, corpus } = sandbox({ delayMs: 120 });
  // Labelling runs before training in laya-nightly.sh. An unbounded backlog
  // pass (43 wide rows ≈ 2.5h) would push training into the working day, and
  // exiting non-zero would skip training altogether.
  const out = run([record('a', 1), record('b', 1), record('c', 1), record('d', 1)],
    { JEV_LAYA_LABEL_CHUNK: '8', JEV_LAYA_LABEL_BUDGET_SEC: '0.2' });
  const d = done();
  assert.ok(d.scored >= 1 && d.scored < 4, `expected a partial pass, got scored=${d.scored}`);
  assert.equal(d.deferred, 4 - d.scored);
  assert.match(out, /budget 0\.2s spent — \d+ records left/);
  // What was scored must be persisted, or the deferred rows are re-done forever.
  assert.equal(corpus().filter((r) => r.local_answer).length, d.scored);
});

test('answers are on disk before the pass ends, so a kill costs one slice', async () => {
  const { start, corpus } = sandbox({ delayMs: 60 });
  // ram_guard (rc=143) and the 5400s timeout both kill mid-pass. With a single
  // write at the end, the 10-09/10 backlog survived every night untouched.
  const rows = Array.from({ length: 20 }, (_, i) => record(`r${i}`, 1));
  const child = start(rows, { JEV_LAYA_LABEL_BUDGET_SEC: '0', JEV_LAYA_LABEL_FLUSH_EVERY: '4' });
  await new Promise((r) => setTimeout(r, 900));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  const labelled = corpus().filter((r) => r.local_answer).length;
  assert.ok(labelled >= 4, `nothing persisted before the kill (got ${labelled})`);
  assert.ok(labelled < 20, `the pass finished before the kill — test is not measuring a kill (${labelled})`);
  assert.equal(labelled % 4, 0, `persisted a partial slice: ${labelled}`);
});

test('the default flushes mid-pass without being told to', () => {
  const { run } = sandbox();
  // laya-nightly.sh passes no flush env, so the default is what protects the
  // backlog. A default of 0 would quietly restore the all-or-nothing write.
  const out = run(Array.from({ length: 110 }, (_, i) => record(`r${i}`, 1)),
    { JEV_LAYA_LABEL_BUDGET_SEC: '0' });
  assert.match(out, /flushed at 100\/110/);
});

test('a flush folds in rows the gateway appended while labelling', () => {
  const { at, run, corpus } = sandbox();
  // The corpus is append-only and the gateway keeps writing during the pass;
  // rewriting the whole file from a stale snapshot would drop those rows.
  fs.writeFileSync(at('adapter.mjs'), `
import { appendFileSync } from 'node:fs';
let n = 0;
export function makeLayaAdapter() {
  return async function laya(state, questions) {
    const ids = Object.keys(questions);
    if (n++ === 0) appendFileSync(${JSON.stringify(at('corpus.jsonl'))},
      JSON.stringify({ id: 'live', state: { s: 'x' }, questions: {}, teacher_answer: {}, question_digest: 'dlive' }) + '\\n');
    return { model: 'stub', answers: Object.fromEntries(ids.map((k) => [k, { choice: 'a' }])) };
  };
}
`);
  run([record('a', 1), record('b', 1), record('c', 1)],
    { JEV_LAYA_LABEL_FLUSH_EVERY: '1', JEV_LAYA_LABEL_BUDGET_SEC: '0' });
  const ids = corpus().map((r) => r.id);
  assert.deepEqual(ids.slice(0, 3), ['a', 'b', 'c']);
  assert.ok(ids.includes('live'), `a row appended mid-pass was overwritten: ${ids.join(',')}`);
  assert.equal(ids.length, 4, `duplicated rows: ${ids.join(',')}`);
});

test('budget 0 disables the budget', () => {
  const { run, done } = sandbox({ delayMs: 50 });
  run([record('a', 1), record('b', 1), record('c', 1)],
    { JEV_LAYA_LABEL_BUDGET_SEC: '0' });
  assert.equal(done().scored, 3);
  assert.equal(done().deferred, 0);
});
