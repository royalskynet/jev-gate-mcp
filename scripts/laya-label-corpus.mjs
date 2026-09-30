#!/usr/bin/env node
// Offline distillation pass: run the local Laya weights over the teacher corpus
// so each record carries both answers, then report the agreement rate.
//
// This is deliberately a batch job and not part of the request path. A hook
// process would cold-load the 540MB ONNX graph on every prompt and spend the
// caller's whole deadline on it; here the session loads once and answers as
// many records as it is given.
//
//   node scripts/laya-label-corpus.mjs --limit 50
//   node scripts/laya-label-corpus.mjs --dry-run     # score, write nothing
//
// It writes `local_model` / `local_answer` and leaves `label` alone: a teacher
// answer is a suggestion, so promotion to a training set stays a human step.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeLayaAdapter } from '../gateway/src/adapters.js';
import { TEACHER_CORPUS_FILE } from '../gateway/src/teacher-corpus.js';

const FILE = process.env.JEV_TEACHER_CORPUS ?? TEACHER_CORPUS_FILE;
const MODEL_DIR = process.env.JEV_LAYA_MODEL_DIR
  ?? join(homedir(), '.jevgate', 'laya-multilingual-int8');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(FILE)) {
  process.stdout.write(`no teacher corpus at ${FILE} — run the gateway with JEV_PROVIDER=zen first\n`);
  process.exitCode = 0;
}

const records = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

// Only the records Laya has never been asked about; re-scoring a fixed corpus
// is a different job and needs its own output.
const pending = records.filter((r) => !r.local_answer).slice(0, LIMIT);
process.stdout.write(`corpus=${records.length} pending=${pending.length} model_dir=${MODEL_DIR}\n`);
if (!pending.length) process.exit(0);

const laya = makeLayaAdapter({ modelDir: MODEL_DIR });
let scored = 0, agreed = 0, failed = 0;
for (const record of pending) {
  try {
    const r = await laya(record.state, record.questions);
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
}
if (!dryRun) {
  writeFileSync(FILE, records.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  chmodSync(FILE, 0o600);
}
const rate = scored ? (agreed / scored) : 0;
process.stdout.write(`${dryRun ? '[dry-run] ' : ''}scored=${scored} agree=${agreed} (${(rate * 100).toFixed(1)}%) failed=${failed}\n`);
process.stdout.write('label stays null — promotion to a training set is a human step.\n');

function sameAnswer(a, b) {
  if (!a || !b) return false;
  return Object.keys(b).every((id) => {
    const x = a[id], y = b[id];
    if (!x || !y) return false;
    if (x.choice !== undefined) return x.choice === y.choice;
    if (x.score !== undefined) return Math.round(x.score) === Math.round(y.score);
    if (x.noul !== undefined) return Math.abs(x.noul - y.noul) < 0.2;
    return false;
  });
}
