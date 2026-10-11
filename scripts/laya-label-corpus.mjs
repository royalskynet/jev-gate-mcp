#!/usr/bin/env node
// Offline distillation pass: run the local Laya weights over the teacher corpus
// so each record carries both answers, then report the agreement rate.
//
// This is deliberately a batch job and not part of the request path. A hook
// process would cold-load the 540MB ONNX graph on every prompt and spend the
// caller's whole deadline on it; here the session loads once and answers as
// many records as it is given. Zero tokens: only local weights run here.
//
//   node scripts/laya-label-corpus.mjs --limit 50
//   node scripts/laya-label-corpus.mjs --dry-run     # score, write nothing
//
// It writes `local_model` / `local_answer` and leaves `label` alone: a teacher
// answer is a suggestion, so promotion to a training set stays a human step.
//
// It also writes a cumulative per-question agreement report (JEV_LAYA_REPORT,
// default ~/.jevgate/laya-agreement.json). Grouped by question_digest + question
// id, because a digest is one exact label space: the jev-route question's
// criteria change whenever the route table does, and answers across two label
// spaces do not compare.
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TEACHER_CORPUS_FILE } from '../gateway/src/teacher-corpus.js';

const FILE = process.env.JEV_TEACHER_CORPUS ?? TEACHER_CORPUS_FILE;
const REPORT = process.env.JEV_LAYA_REPORT ?? join(homedir(), '.jevgate', 'laya-agreement.json');
const MODEL_DIR = process.env.JEV_LAYA_MODEL_DIR
  ?? join(homedir(), '.jevgate', 'laya-multilingual-int8');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);
const dryRun = process.argv.includes('--dry-run');
// `systemOne` collates every question of one record into a single ONNX batch
// (receptron laya.js:66 — n = question count, L = longest sequence), so the
// activations grow with the question count. The corpus was all 1–4-question
// records until 10-09, when a caller started asking 17–186 at once; one of
// those rows walked the process to 31GB and ram_guard killed the night at
// rc=143 before training ever started. Answering in slices of CHUNK keeps the
// batch bounded; it does not change an answer (verified below).
const CHUNK = Math.max(1, Number(process.env.JEV_LAYA_LABEL_CHUNK) || 8);
// Clearing a backlog of wide records takes hours (186 questions ≈ 3.5min at
// CHUNK=8). Labelling runs before training in the nightly job, so an unbounded
// pass pushes training into the working day; stop at the budget and leave the
// rest pending for tomorrow. 0 disables the budget.
const BUDGET_SEC = Math.max(0, Number(process.env.JEV_LAYA_LABEL_BUDGET_SEC ?? 5400));
// Tests substitute a stub adapter here; nothing else should.
const ADAPTER_MODULE = process.env.JEV_LAYA_ADAPTER_MODULE ?? '../gateway/src/adapters.js';

if (!existsSync(FILE)) {
  process.stdout.write(`no teacher corpus at ${FILE} — run the gateway with JEV_PROVIDER=zen first\n`);
  process.exit(0);
}

const parse = (text) => text.split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

// The gateway keeps appending while this runs; remember where our snapshot ends
// so those rows can be carried over instead of overwritten.
const initial = readFileSync(FILE);
const records = parse(initial.toString('utf8'));

// Only the records Laya has never been asked about; re-scoring a fixed corpus
// is a different job and needs its own output.
const pending = records.filter((r) => !r.local_answer).slice(0, LIMIT);
process.stdout.write(`corpus=${records.length} pending=${pending.length} model_dir=${MODEL_DIR}\n`);

// How many answers may be in flight before they are on disk. The whole pass
// used to persist once at the very end, so a kill at any point (ram_guard at
// rc=143, the 5400s timeout, a reboot) threw away every answer and the next
// night started from the same backlog. Flushing every FLUSH_EVERY records
// bounds that loss to one slice. 0 keeps the old single write.
const FLUSH_EVERY = Math.max(0, Number(process.env.JEV_LAYA_LABEL_FLUSH_EVERY ?? 100));

// Everything in `records` up to this byte offset is already on disk; whatever
// the gateway appended past it gets folded in on the next flush instead of
// being overwritten.
let writtenLen = initial.length;
const flush = () => {
  if (dryRun) return;
  // ponytail: append-during-rename window is the few ms between this re-read and
  // renameSync; a row written in it is lost. Add a lock shared with
  // recordTeacherSample if the corpus ever gets concurrent writers at 03:10.
  const appended = parse(readFileSync(FILE).subarray(writtenLen).toString('utf8'));
  if (appended.length) records.push(...appended);
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const tmp = `${FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, FILE);
  writtenLen = Buffer.byteLength(body);
};

let scored = 0, agreed = 0, failed = 0, deferred = 0;
if (pending.length) {
  // Lazy: a report-only run (nothing pending) never loads the 540MB graph.
  const { makeLayaAdapter } = await import(ADAPTER_MODULE);
  const laya = makeLayaAdapter({ modelDir: MODEL_DIR });
  const started = Date.now();
  for (const record of pending) {
    if (BUDGET_SEC && (Date.now() - started) / 1000 >= BUDGET_SEC) {
      // Not a failure: these rows stay pending and the night proceeds to
      // training. Exiting non-zero here would skip training altogether.
      deferred = pending.length - scored - failed;
      process.stdout.write(`  budget ${BUDGET_SEC}s spent — ${deferred} records left for the next run\n`);
      break;
    }
    try {
      const r = await answerInChunks(laya, record);
      record.local_model = r.model ?? 'laya';
      record.local_answer = r.answers ?? null;
      scored++;
      if (sameAnswer(r.answers, record.teacher_answer)) agreed++;
    } catch (e) {
      // A local miss is a missing data point, not a job failure: skip the
      // record and keep going so one bad row cannot cost the whole batch.
      failed++;
      process.stdout.write(`  skip ${record.id}: ${e?.message ?? e}\n`);
    }
    if (FLUSH_EVERY && (scored + failed) % FLUSH_EVERY === 0) {
      flush();
      process.stdout.write(`  flushed at ${scored + failed}/${pending.length}\n`);
    }
  }
  await laya.release?.();
}
if (scored) flush();
const rate = scored ? (agreed / scored) : 0;
process.stdout.write(`${dryRun ? '[dry-run] ' : ''}scored=${scored} agree=${agreed} (${(rate * 100).toFixed(1)}%) failed=${failed} deferred=${deferred}\n`);

const groups = agreement(records);
for (const [key, g] of Object.entries(groups)) {
  process.stdout.write(`  ${key} n=${g.n} agree=${g.agree} (${(g.rate * 100).toFixed(1)}%)\n`);
}
if (!dryRun) {
  writeFileSync(REPORT, JSON.stringify({ ts: new Date().toISOString(), corpus: records.length, groups }, null, 2) + '\n', { mode: 0o600 });
}
process.stdout.write('label stays null — promotion to a training set is a human step.\n');

const DONE = process.env.JEV_LAYA_LABEL_DONE ?? join(homedir(), '.jevgate', 'laya-label.done');
writeFileSync(DONE, JSON.stringify({
  ts: new Date().toISOString(),
  epoch: Math.floor(Date.now() / 1000),
  corpus: records.length,
  scored,
  failed,
  deferred,
  pid: process.pid,
}) + '\n', { mode: 0o600 });

/**
 * Answer one record, slicing its questions into batches of at most CHUNK.
 *
 * Slicing is answer-preserving: each item is right-padded to the longest
 * sequence in its own batch and the pad is masked out, so an item's logits do
 * not depend on who shares its batch. Verified on 10-10 against the unsliced
 * call on the two widest records that still fit in memory — 44/44 and 20/20
 * answers byte-identical at CHUNK=4 and CHUNK=8.
 *
 * A record is all-or-nothing: a half-answered row would be counted as scored
 * and skew the agreement report, so one failed slice throws and the caller
 * records the whole row as failed.
 */
async function answerInChunks(laya, record) {
  const ids = Object.keys(record.questions ?? {});
  if (ids.length <= CHUNK) return laya(record.state, record.questions);
  process.stdout.write(`  ${record.id}: ${ids.length} questions, ${Math.ceil(ids.length / CHUNK)} batches of ${CHUNK}\n`);
  let model;
  const answers = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = Object.fromEntries(ids.slice(i, i + CHUNK).map((k) => [k, record.questions[k]]));
    const r = await laya(record.state, slice);
    model ??= r.model;
    Object.assign(answers, r.answers ?? {});
  }
  return { model, answers };
}

/** Cumulative agreement per `<digest12>/<question id>` over records that carry both answers. */
function agreement(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.local_answer || !r.teacher_answer) continue;
    for (const id of Object.keys(r.teacher_answer)) {
      const key = `${String(r.question_digest).slice(0, 12)}/${id}`;
      const g = (out[key] ??= { n: 0, agree: 0, rate: 0 });
      g.n++;
      if (sameOne(r.local_answer[id], r.teacher_answer[id])) g.agree++;
      g.rate = g.agree / g.n;
    }
  }
  return out;
}

function sameAnswer(a, b) {
  if (!a || !b) return false;
  return Object.keys(b).every((id) => sameOne(a[id], b[id]));
}

function sameOne(x, y) {
  if (!x || !y) return false;
  if (x.choice !== undefined) return x.choice === y.choice;
  if (x.score !== undefined) return Math.round(x.score) === Math.round(y.score);
  if (x.noul !== undefined) return Math.abs(x.noul - y.noul) < 0.2;
  return false;
}
