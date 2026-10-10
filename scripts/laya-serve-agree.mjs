#!/usr/bin/env node
// A/B 重量：同一批線上題目，上游 laya-serve（fp32/MPS）vs 語料裡的 local_answer（base int8 ONNX）
// 各自跟 Jev（teacher_answer）的一致率。走 makeLayaAdapter 的 JEV_LAYA_SERVE_URL 開關，
// 所以同時驗了並存 adapter。只印彙總：語料含使用者 state（甚至夾帶過金鑰），不得進 transcript。
// 用法：JEV_LAYA_SERVE_URL=http://127.0.0.1:8019 node scripts/laya-serve-agree.mjs [--limit N] [--out file.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { TEACHER_CORPUS_FILE } from '../gateway/src/teacher-corpus.js';
import { makeLayaAdapter } from '../gateway/src/adapters.js';

if (!process.env.JEV_LAYA_SERVE_URL) { console.error('需要 JEV_LAYA_SERVE_URL'); process.exit(2); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', Infinity));
const OUT = arg('--out', null);

// 一致口徑同 laya-label-corpus.mjs sameOne（fix 9859：score 四捨五入、noul 差 <0.2）
function sameOne(x, y) {
  if (!x || !y) return false;
  if (x.choice !== undefined) return x.choice === y.choice;
  if (x.score !== undefined) return Math.round(x.score) === Math.round(y.score);
  if (x.noul !== undefined) return Math.abs(x.noul - y.noul) < 0.2;
  return false;
}
const conf = (a) => a?.x_jev_confidence ?? a?.confidence ?? null;

const rows = readFileSync(TEACHER_CORPUS_FILE, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.local_answer && r.teacher_answer && r.questions && (r.questions.route || r.questions.claim_0))
  .slice(0, LIMIT);

const run = makeLayaAdapter({});
const g = {};
const errs = {};
const lat = [];
let done = 0;
for (const r of rows) {
  const kind = r.questions.route ? 'route' : 'claim';
  const src = r.label_source === 'backtest:transcripts' ? 'backtest' : 'live';
  const t0 = Date.now();
  let fp;
  try {
    fp = (await run(r.state, r.questions)).answers;
    lat.push(Date.now() - t0);
  } catch (e) {
    const k = `${e?.name ?? 'Error'}:${e?.status ?? e?.code ?? ''}`;
    errs[k] = (errs[k] ?? 0) + 1;
  }
  for (const id of Object.keys(r.teacher_answer)) {
    const e = (g[`${kind}/${id}/${src}`] ??= { n: 0, int8: 0, fp32: 0, same: 0, err: 0, hi_n: 0, hi_agree: 0 });
    const T = r.teacher_answer[id];
    if (!fp) { e.err++; continue; }
    e.n++;
    if (sameOne(r.local_answer[id], T)) e.int8++;
    const ok = sameOne(fp[id], T);
    if (ok) e.fp32++;
    if (sameOne(fp[id], r.local_answer[id])) e.same++;
    if ((conf(fp[id]) ?? 0) >= 0.8) { e.hi_n++; if (ok) e.hi_agree++; }
  }
  if (++done % 50 === 0) console.error(`${done}/${rows.length}`);
}
lat.sort((a, b) => a - b);
const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
const pct = (a, n) => (n ? `${(100 * a / n).toFixed(1)}%` : '—');
const out = { rows: rows.length, latency_ms: { p50: q(0.5), p95: q(0.95), max: lat.at(-1) ?? null }, errors: errs, groups: g };
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2), { mode: 0o600 });
console.log(`rows=${rows.length} latency p50=${out.latency_ms.p50}ms p95=${out.latency_ms.p95}ms errors=${JSON.stringify(errs)}`);
console.log('| 題組/題目/來源 | n | int8 vs Jev | fp32 vs Jev | fp32==int8 | fp32 高信心(≥0.8) 一致 |');
console.log('|---|---|---|---|---|---|');
for (const k of Object.keys(g).sort()) {
  const e = g[k];
  console.log(`| ${k} | ${e.n} | ${pct(e.int8, e.n)} | ${pct(e.fp32, e.n)} | ${pct(e.same, e.n)} | ${pct(e.hi_agree, e.hi_n)}（${e.hi_agree}/${e.hi_n}） |`);
}
