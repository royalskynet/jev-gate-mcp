#!/usr/bin/env node
// 兩臂重放：Stop gate 要不要把 git state 交給 judge（stateShadow=false）。
//
// 每筆 ~/.jev-gate/state-capture.jsonl 是 Stop 當下記的 state 文字＋transcript 位元組長度
// （fix 10385：git 狀態事後讀會失真，只能當下記）。transcript 只會往後長，截到該長度就是
// 那一輪的宣稱與工具證據。兩臂同一模型、同一時段各判一次：
//   A＝現行（只有工具輸出）  B＝state＋工具輸出（composeEvidence shadow=false）
// 判完套 decisive＋blockDecision，比的是「會不會出聲／擋下」，不是原始 verdict。
//
// 不變式（同 backtest-teacher.mjs）：
//   * 只走 OpenRouter 付費 typesafe/jev-1.13，不碰 zen free、不經 cascade（不佔 JEV_OR_DAILY_MAX）。
//   * 自己的上限 --max-usd，以 usage token 估；到了就停，已判的照樣寫出。
//   * 結果只寫本機 ~/.jev-gate/（含宣稱文字，不進 repo）。
//
//   node scripts/replay-state-capture.mjs --dry          # 只數樣本，不打 Jev
//   node scripts/replay-state-capture.mjs --max-usd 0.05
//   node scripts/replay-state-capture.mjs --selftest
import { openSync, readSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JevDecisionModel, runVerify } from 'jevwire';
import { evidenceFromLines } from '../plugin/lib/transcript.js';
import { atomicClaims, decisive } from '../plugin/lib/claims.js';
import { DEFAULT_CONFIG } from '../plugin/lib/judge.js';
import { runConfig } from '../plugin/lib/gate.js';
import { composeEvidence, blockDecision } from '../plugin/hooks/gate.js';
import { USD_PER_TOKEN } from './backtest-teacher.mjs';

const HOME = homedir();

/** transcript 前 n 位元組的完整行（最後半行丟掉）。 */
export function linesUpTo(path, n) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    const text = buf.subarray(0, got).toString('utf8');
    const lines = text.split('\n');
    lines.pop();  // 結尾是 \n 時是空字串，否則是被截斷的半行
    return lines;
  } finally {
    closeSync(fd);
  }
}

/** Stop payload 的 last_assistant_message：最後一則帶文字的 assistant 紀錄。 */
export function lastAssistantText(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.type === 'user' && typeof e.message?.content === 'string' && !e.isMeta) return '';
    if (e?.type !== 'assistant') continue;
    const c = e.message?.content;
    const text = Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
    if (text.trim()) return text;
  }
  return '';
}

/** 一輪的兩臂輸入；回 null＝線上這輪根本不會判（沒宣稱）。 */
export function armsFor(lines, stateText) {
  const claim = lastAssistantText(lines).slice(0, 4000);
  if (!claim.trim()) return null;
  const tools = evidenceFromLines(lines);
  return {
    claim,
    // 同 plugin/lib/gate.js：拆不出句子就整段當一個宣稱。
    claims: (() => { const c = atomicClaims(claim); return c.length ? c : [claim]; })(),
    A: composeEvidence(tools, stateText, true),
    B: composeEvidence(tools, stateText, false),
  };
}

/** none／feedback／block：線上那一輪會怎麼收尾。 */
export function outcome(out) {
  const d = blockDecision(decisive(out?.claims));
  if (!d) return 'none';
  return d.decision === 'block' ? 'block' : 'feedback';
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const dry = process.argv.includes('--dry');
  const maxUsd = Number(arg('--max-usd', 0.05));
  const src = arg('--capture', DEFAULT_CONFIG.stateCaptureLog);
  const out = arg('--out', join(HOME, '.jev-gate', `state-replay-${new Date().toISOString().slice(0, 10)}.jsonl`));
  const onlyTs = arg('--ts', '') ? new Set(arg('--ts', '').split(',')) : null;
  const recs = readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => !onlyTs || onlyTs.has(r.ts));

  const jobs = [];
  let noClaim = 0, unreadable = 0;
  for (const r of recs) {
    let lines;
    try { lines = linesUpTo(r.transcript_path, r.transcript_bytes); } catch { unreadable++; continue; }
    const arms = armsFor(lines, r.state);
    if (!arms) { noClaim++; continue; }
    jobs.push({ r, arms });
  }
  const calls = jobs.reduce((s, j) => s + (j.arms.A.trim() ? 1 : 0) + 1, 0);
  const tok = jobs.reduce((s, j) => s + (j.arms.A.length + j.arms.B.length + 2 * j.arms.claim.length) / 3.5, 0);
  console.log(`capture=${recs.length} 可重放=${jobs.length} 無宣稱=${noClaim} transcript 讀不到=${unreadable}`);
  console.log(`預估 ${calls} 次呼叫、約 ${Math.round(tok)} input token、約 $${(tok * USD_PER_TOKEN).toFixed(3)}（上限 $${maxUsd}）`);
  if (dry) return 0;

  let key;
  try { key = readFileSync(DEFAULT_CONFIG.backupKeyFile, 'utf8').trim(); } catch { /* 下面報錯 */ }
  if (!key) throw new Error('OpenRouter key 檔讀不到（backupKeyFile）');
  const model = new JevDecisionModel({ apiKey: key, baseUrl: DEFAULT_CONFIG.backupBaseUrl,
    model: DEFAULT_CONFIG.backupModel, timeoutMs: 30000, maxRetries: 1 });
  const cfg = runConfig(DEFAULT_CONFIG);

  let spent = 0, done = 0, errors = 0;
  const rows = [];
  for (const { r, arms } of jobs) {
    if (spent >= maxUsd) { console.log(`stop: max-usd ${maxUsd} reached`); break; }
    const row = { ts: r.ts, session_id: r.session_id, stats: r.stats, claims_n: arms.claims.length };
    for (const arm of ['A', 'B']) {
      const ev = arms[arm];
      if (!ev.trim()) { row[arm] = 'skip'; continue; }  // 線上：沒證據就不判
      try {
        const res = await runVerify(model, { claims: arms.claims, evidence: ev }, cfg);
        const u = res.usage ?? {};
        spent += ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) * USD_PER_TOKEN;
        row[arm] = outcome(res);
        row[`${arm}_summary`] = res.summary;
      } catch (e) {
        errors++;
        row[arm] = 'error';
        row[`${arm}_error`] = String(e.message).slice(0, 200);
        if (/402|payment|insufficient/i.test(e.message)) { spent = maxUsd; break; }
      }
    }
    rows.push(row);
    done++;
  }
  writeFileSync(out, rows.map((x) => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });

  const tally = {};
  for (const x of rows) tally[`${x.A}→${x.B}`] = (tally[`${x.A}→${x.B}`] ?? 0) + 1;
  console.log(`判了 ${done}/${jobs.length} 輪、錯誤 ${errors}、估計花費 $${spent.toFixed(4)} → ${out}`);
  console.log('A(現行)→B(+state)：', JSON.stringify(tally));
  return 0;
}

function selftest() {
  const asst = (t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  const user = (t) => JSON.stringify({ type: 'user', message: { content: t } });
  // 最後一則有文字的 assistant；遇到真人 prompt 就停（那是上一輪）。
  if (lastAssistantText([user('hi'), asst('已修好'), asst('全部完成')]) !== '全部完成') throw new Error('last text');
  if (lastAssistantText([asst('上一輪完成'), user('下一題')]) !== '') throw new Error('crossed prompt');
  if (armsFor([user('hi')], 'S') !== null) throw new Error('no claim must skip');
  if (armsFor([user('hi'), asst('ok')], 'S').claims.join() !== 'ok') throw new Error('empty split must fall back');
  // B 帶 state、A 不帶。
  const a = armsFor([user('hi'), asst('完成')], 'STATE');
  if (a.A.includes('STATE') || a.B !== 'STATE') throw new Error(`arms ${JSON.stringify(a)}`);
  // 截斷：半行要丟掉。
  const p = join(HOME, '.jev-gate', `.replay-selftest-${process.pid}`);
  writeFileSync(p, 'one\ntwo\nthr');
  const l = linesUpTo(p, 13);
  if (l.join('|') !== 'one|two') throw new Error(`lines ${l}`);
  if (linesUpTo(p, 8).join('|') !== 'one|two') throw new Error('exact boundary');
  unlinkSync(p);
  // outcome 走線上的 decisive＋blockDecision。
  if (outcome({ claims: [{ verdict: 'contradicted', gate: 'auto' }] }) !== 'block') throw new Error('block');
  if (outcome({ claims: [{ verdict: 'contradicted', gate: 'review' }] }) !== 'feedback') throw new Error('fb');
  if (outcome({ claims: [{ verdict: 'supported', gate: 'auto' }] }) !== 'none') throw new Error('none');
  console.log('selftest ok');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
