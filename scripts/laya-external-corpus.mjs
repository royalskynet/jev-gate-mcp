#!/usr/bin/env node
// 把公開語料轉成 teacher-corpus 的列格式，給 Laya 當外部考卷與低權重訓練料。
//
// 兩份來源，各自只對應線上的一題：
//   SWE-bench Verified（HF princeton-nlp/SWE-bench_Verified，`difficulty` 欄是 OpenAI
//     標註）→ triage 的 `difficulty`（score，4 級 rubric，lowest first）。兩邊都是四級
//     由低到高，逐級對照：<15 min fix→trivial、15 min - 1 hour→simple、
//     1-4 hours→moderate、>4 hours→hard。
//   CLAMBER（github.com/zt991211/CLAMBER，require_clarification 0/1）→ jev-route 的
//     `ambiguous`（noul）。標註是硬標籤，所以 teacher 答案是 0.0／1.0。
//
// 不變式：
//   * questions 整組逐字取自 teacher-corpus 裡該題最新那一列（含同組其他題），
//     question_digest 用 gateway/src/teacher-corpus.js 的同一算法，所以跟線上那組
//     的 digest 相同；只有對應的那一題有 teacher_answer，其他題 build_units 會跳過。
//   * state 照線上 caller 的形狀：triage 是 {user_request: sliceText, char_bucket}，
//     jev-route 是 {user_request: slice(0,2500), dirty_paths: [], phase: 'unknown'}。
//   * label_source = `external:<name>`；split = 'eval'（考卷）或 'train'，兩邊不重疊。
//     訓練端只讀 split==='train'，並把 external:* 擋在 OOF 與線上 lane 評估之外。
//
// 原始資料與產物都在 ~/.jevgate/external/（repo 外）。CLAMBER 沒有授權條款，
// 只能本機用，不得 commit 或上傳。
//
//   node scripts/laya-external-corpus.mjs                # 預設路徑
//   node scripts/laya-external-corpus.mjs --clamber-eval 1000 --clamber-train 800
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sliceText, contextBucket } from '../agent-glue/src/triage.js';

export const SWEBENCH_LEVEL = Object.freeze({
  '<15 min fix': 0,
  '15 min - 1 hour': 1,
  '1-4 hours': 2,
  '>4 hours': 3,
});

const sha = (s) => createHash('sha256').update(s).digest('hex');
// gateway/src/teacher-corpus.js 的同一算法；兩邊不同步 digest 就對不上。
export const questionDigest = (questions) => sha(JSON.stringify(questions));

/** teacher-corpus 裡含 `qid` 的最新一列的整組 questions（逐字）。 */
export function pickTemplate(rows, qid) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const q = rows[i]?.questions;
    if (q && typeof q === 'object' && q[qid]) return q;
  }
  throw new Error(`teacher corpus 沒有 ${qid} 題，無法取得逐字題目`);
}

function record({ source, srcId, state, questions, qid, answer, label, split }) {
  return {
    id: `${source}:${srcId}`,
    ts: null,
    schema_version: 1,
    question_digest: questionDigest(questions),
    state,
    questions,
    teacher_model: source,
    teacher_answer: { [qid]: answer },
    usage: null,
    local_model: null,
    local_answer: null,
    label,
    label_source: source,
    split,
    training_eligible: split === 'train',
  };
}

export function swebenchRecord(row, questions, split) {
  const level = SWEBENCH_LEVEL[row.difficulty];
  if (level === undefined) throw new Error(`未知的 difficulty 標註：${row.difficulty}`);
  const text = row.problem_statement ?? '';
  return record({
    source: 'external:swebench-verified', srcId: row.instance_id, questions, qid: 'difficulty',
    // triage.js 的慣例：送出前 sliceText 截到 ask_chars，bucket 看長度。
    state: { user_request: sliceText(text), char_bucket: contextBucket(text.length) },
    answer: { type: 'score', score: level }, label: row.difficulty, split,
  });
}

export function clamberRecord(row, questions, split) {
  const y = Number(row.require_clarification);
  if (y !== 0 && y !== 1) throw new Error(`require_clarification 不是 0/1：${row.require_clarification}`);
  const text = [row.context, row.question].filter((s) => s && String(s).trim()).join('\n');
  return record({
    source: 'external:clamber', srcId: sha(row.question).slice(0, 16), questions, qid: 'ambiguous',
    // jev-route.mjs 的慣例：prompt.slice(0, 2500)，外部資料沒有工作樹與上一輪。
    state: { user_request: text.slice(0, 2500), dirty_paths: [], phase: 'unknown' },
    answer: { type: 'noul', noul: y }, label: y, split,
  });
}

/**
 * 分層、確定性的切分：每層照 sha256(key) 排序，前段給考卷、接著給訓練、其餘不用。
 * 各層名額按比例分配（最大餘數法），總數剛好等於要求。
 */
export function stratifiedSplit(items, { key, stratum, nEval, nTrain }) {
  const groups = new Map();
  for (const it of items) {
    const s = stratum(it);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(it);
  }
  const total = items.length;
  const alloc = (want) => {
    const raw = [...groups].map(([s, g]) => [s, (g.length * want) / total]);
    const out = new Map(raw.map(([s, x]) => [s, Math.floor(x)]));
    let left = want - [...out.values()].reduce((a, b) => a + b, 0);
    for (const [s] of raw.sort((a, b) => (b[1] % 1) - (a[1] % 1) || String(a[0]).localeCompare(String(b[0])))) {
      if (left <= 0) break;
      out.set(s, out.get(s) + 1);
      left--;
    }
    return out;
  };
  const ev = alloc(Math.min(nEval, total));
  const tr = alloc(Math.min(nTrain, total - Math.min(nEval, total)));
  const evalSet = [], trainSet = [];
  for (const [s, g] of [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const sorted = [...g].sort((a, b) => (sha(key(a)) < sha(key(b)) ? -1 : 1));
    const e = Math.min(ev.get(s), sorted.length);
    evalSet.push(...sorted.slice(0, e));
    trainSet.push(...sorted.slice(e, e + Math.min(tr.get(s), sorted.length - e)));
  }
  return { evalSet, trainSet };
}

/** CLAMBER 有 5 題文字重複（標註一致）；同一句不能一邊在考卷一邊在訓練。 */
export function dedupeBy(items, key) {
  const seen = new Set();
  return items.filter((it) => (seen.has(key(it)) ? false : (seen.add(key(it)), true)));
}

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
  const v = JSON.parse(l);
  return typeof v === 'string' ? JSON.parse(v) : v; // CLAMBER 每行是二次編碼的字串
});
const writeJsonl = (p, rows) => writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });

function main(argv) {
  const ext = join(homedir(), '.jevgate', 'external');
  const opt = {
    teacher: process.env.JEV_TEACHER_CORPUS ?? join(homedir(), '.jevgate', 'teacher-corpus.jsonl'),
    swebench: join(ext, 'swebench-verified', 'swebench-verified.jsonl'),
    clamber: join(ext, 'clamber', 'repo', 'clamber_benchmark.jsonl'),
    out: ext, 'swebench-eval': 200, 'swebench-train': 300, 'clamber-eval': 1000, 'clamber-train': 800,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    if (!(k in opt)) throw new Error(`未知參數 ${argv[i]}`);
    opt[k] = typeof opt[k] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  const teacher = readJsonl(opt.teacher);
  mkdirSync(opt.out, { recursive: true, mode: 0o700 });
  const summary = {};
  if (existsSync(opt.swebench)) {
    const q = pickTemplate(teacher, 'difficulty');
    const { evalSet, trainSet } = stratifiedSplit(readJsonl(opt.swebench), {
      key: (r) => r.instance_id, stratum: (r) => r.difficulty,
      nEval: opt['swebench-eval'], nTrain: opt['swebench-train'] });
    writeJsonl(join(opt.out, 'eval-swebench-verified.jsonl'), evalSet.map((r) => swebenchRecord(r, q, 'eval')));
    writeJsonl(join(opt.out, 'train-swebench-verified.jsonl'), trainSet.map((r) => swebenchRecord(r, q, 'train')));
    summary.swebench = { eval: evalSet.length, train: trainSet.length };
  }
  if (existsSync(opt.clamber)) {
    const q = pickTemplate(teacher, 'ambiguous');
    const rows = dedupeBy(readJsonl(opt.clamber), (r) => r.question);
    const { evalSet, trainSet } = stratifiedSplit(rows, {
      key: (r) => r.question, stratum: (r) => `${r.require_clarification}/${r.subclass}`,
      nEval: opt['clamber-eval'], nTrain: opt['clamber-train'] });
    writeJsonl(join(opt.out, 'eval-clamber.jsonl'), evalSet.map((r) => clamberRecord(r, q, 'eval')));
    writeJsonl(join(opt.out, 'train-clamber.jsonl'), trainSet.map((r) => clamberRecord(r, q, 'train')));
    summary.clamber = { source_rows: rows.length, eval: evalSet.length, train: trainSet.length };
  }
  console.log(JSON.stringify(summary));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
