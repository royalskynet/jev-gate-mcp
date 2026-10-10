#!/usr/bin/env node
// Laya 接手 Jev 工作的比例，按日×caller 彙總 ~/.jevgate/laya-handoff.jsonl。
// 計費單位是請求：一題沒接住整次就要付錢，所以「全本地請求%」才是省下的 Jev 呼叫；
// 「題目%」看 Laya 能力在長，兩個都印。未接住的原因拆成 state 過濾／低信心／無效／no_match，
// 看下一步該補哪裡。backtest／replay／probe 不是線上流量，預設排除（--all 納入）。
// 用法：node scripts/laya-handoff-report.mjs [--days N] [--all] [--file PATH]
import { readFileSync } from 'node:fs';
import { handoffFile } from '../agent-glue/src/usage-ledger.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const days = Number(opt('--days', 7));
const file = opt('--file', handoffFile());
const offline = /backtest|replay|probe|selftest/;

export function summarize(lines, { days = 7, all = false, now = Date.now() } = {}) {
  const since = new Date(now - days * 864e5).toISOString().slice(0, 10);
  const groups = new Map();
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const day = String(r.ts ?? '').slice(0, 10);
    if (day < since || (!all && offline.test(r.caller))) continue;
    for (const key of [`${day}\t${r.caller}`, `${day}\t*`]) {
      const g = groups.get(key) ?? { req: 0, full: 0, part: 0, qt: 0, ql: 0, sf: 0, lc: 0, inv: 0, nm: 0 };
      g.req++; g.qt += r.q_total; g.ql += r.q_local;
      if (r.q_total > 0 && r.q_cloud === 0) g.full++; else if (r.q_local > 0) g.part++;
      g.sf += r.by_state_filter; g.lc += r.by_low_conf; g.inv += r.by_invalid; g.nm += r.by_no_match;
      groups.set(key, g);
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
if (import.meta.url === `file://${process.argv[1]}`) {
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch { console.log(`沒有 ${file}（還沒有請求經過 Laya router）`); process.exit(0); }
  console.log('day\tcaller\t請求\t全本地\t部分本地\t題目本地\t未接住原因(state/低信心/無效/no_match)');
  for (const [key, g] of summarize(lines, { days, all: args.includes('--all') })) {
    console.log(`${key}\t${g.req}\t${pct(g.full, g.req)}\t${pct(g.part, g.req)}\t${pct(g.ql, g.qt)} (${g.ql}/${g.qt})\t${g.sf}/${g.lc}/${g.inv}/${g.nm}`);
  }
}
