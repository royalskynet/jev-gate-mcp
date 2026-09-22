#!/usr/bin/env node
// Pick `minDropProbability` from evidence instead of taste.
//
// The official TypeSafe skill says thresholds must be evaluated against your own
// data. This is that evaluation for the prune path: feed labelled chunks through
// the SAME batched request `hooks/jev.js` sends, keep the raw `probabilities.drop`
// per chunk, then sweep the threshold over the labels.
//
// Corpus: JSONL, one case per line. Each case is one tool result split into the
// blocks a human can label relative to `request`:
//
//   {"request": "...", "criteria": "Bash",
//    "blocks": [{"label": "keep", "file": "a.txt"},
//               {"label": "drop", "file": "b.txt", "bytes": 12000}]}
//
// `label` is what the chunk SHOULD get. `drop` blocks are the ones a human agrees
// carry nothing for `request`; `keep` blocks are the ones whose loss would break
// the task — those are the expensive mistakes, so they are reported separately.
//
// The corpus itself is not committed: it is this machine's own tool output
// (logs, lockfiles, git history), it is large, and a threshold calibrated on
// someone else's output would be the wrong threshold anyway. Point the script at
// your own; DEVLOG §22.2 records the sweep the shipped 0.7 came from.
//
// ponytail: no train/test split, no bootstrap CI. A dozen hand-labelled cases
// answer "is 0.6 in the right place"; add statistics when the corpus is big
// enough for them to mean something.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { CONFIG, TARGETS, requestTerms, vetoOnTerms } from '../hooks/jev.js';

const SWEEP = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

function readKey() {
  const path = process.env.OPENROUTER_API_KEY_FILE
    ?? `${process.env.HOME}/.creds/kv/OPENROUTER_API_KEY.txt`;
  return readFileSync(path, 'utf8').trim();
}

function loadCase(line, base) {
  const c = JSON.parse(line);
  const blocks = c.blocks.map((b) => {
    if (typeof b.text === 'string') return { label: b.label, text: b.text };
    const full = readFileSync(resolve(base, b.file), 'utf8');
    return { label: b.label, text: b.bytes ? full.slice(0, b.bytes) : full };
  });
  // A string names a shipped criteria row; an object is a candidate wording under
  // test, which is how a criteria change gets A/B'd against the same labels.
  const criteria = typeof c.criteria === 'object' ? c.criteria : TARGETS[c.criteria ?? 'Bash'].criteria;
  return { request: c.request, criteria, blocks };
}

/** One batched request, raw answers kept. Mirrors judgeChunks' wire shape exactly. */
async function ask(key, { request, criteria, blocks }) {
  const chunks = blocks.map((b) => b.text);
  const questions = {};
  chunks.forEach((_, i) => {
    questions[`c${i}`] = {
      type: 'choice',
      instructions:
        "Decide whether the chunk of tool output is relevant to the user's current request/task."
        + ' Keep output that helps answer or complete the task; drop output that is noise,'
        + ` repeated boilerplate, or unrelated. Judge only the chunk at \`chunks[${i}]\`.`,
      criteria,
    };
  });
  const started = Date.now();
  const res = await fetch(CONFIG.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: CONFIG.model, state: { user_request: request, chunks }, questions }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  // Which chunks the shipped keyword veto would hold, so the sweep scores the
  // pipeline that actually runs rather than the raw answers.
  const held = vetoOnTerms(chunks.map(() => 'drop'), chunks, requestTerms(request))
    .map((v) => v === 'unsure');
  return {
    ms: Date.now() - started,
    usage: body.usage ?? {},
    rows: blocks.map((b, i) => {
      const a = body.answers?.[`c${i}`] ?? {};
      return {
        vetoed: held[i],
        label: b.label,
        chars: b.text.length,
        choice: a.choice,
        pDrop: a.probabilities?.drop ?? null,
        confidence: a.confidence ?? null,
      };
    }),
  };
}

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: node scripts/calibrate-prune.mjs <corpus.jsonl>');
  process.exit(2);
}
const base = dirname(resolve(corpusPath));
const cases = readFileSync(corpusPath, 'utf8').split('\n').filter(Boolean).map((l) => loadCase(l, base));
const key = readKey();

const rows = [];
let ms = 0;
let inTok = 0;
let cost = 0;
for (const [i, c] of cases.entries()) {
  const r = await ask(key, c);
  ms += r.ms;
  inTok += r.usage.input_tokens ?? 0;
  cost += r.usage.cost ?? 0;
  for (const row of r.rows) rows.push({ ...row, case: i, request: c.request });
  for (const row of r.rows) {
    console.log(
      `case ${i} ${row.label.padEnd(4)} ${String(row.chars).padStart(6)}c`
      + ` choice=${String(row.choice).padEnd(4)} p(drop)=${String(row.pDrop).padEnd(4)}`
      + ` conf=${String(row.confidence).padEnd(4)}${row.vetoed ? ' veto' : ''}`,
    );
  }
}

console.log(`\n${cases.length} cases, ${rows.length} chunks, ${ms} ms, ${inTok} input tokens, $${cost.toFixed(6)}`);

const keepRows = rows.filter((r) => r.label === 'keep');
const dropRows = rows.filter((r) => r.label === 'drop');
const dropChars = dropRows.reduce((n, r) => n + r.chars, 0);
const allChars = rows.reduce((n, r) => n + r.chars, 0);

console.log('\nthreshold  recall(drop)  false-drops  chars saved  of total');
for (const t of SWEEP) {
  const fired = (r) => r.choice === 'drop' && !r.vetoed && (r.pDrop ?? 1) >= t;
  const hit = dropRows.filter(fired);
  const bad = keepRows.filter(fired);
  const saved = hit.reduce((n, r) => n + r.chars, 0);
  console.log(
    `${t.toFixed(2).padStart(9)}  ${String(`${hit.length}/${dropRows.length}`).padStart(12)}`
    + `  ${String(`${bad.length}/${keepRows.length}`).padStart(11)}`
    + `  ${String(saved).padStart(11)}  ${((saved / allChars) * 100).toFixed(1)}% (max ${((dropChars / allChars) * 100).toFixed(1)}%)`,
  );
}
console.log(`\nshipped minDropProbability = ${CONFIG.minDropProbability}`);
