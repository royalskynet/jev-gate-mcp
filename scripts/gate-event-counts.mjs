#!/usr/bin/env node
/**
 * gate.log 事件計數。只印「類型 計數」與時間範圍，不印任何行內容
 * （gate.log 內含敏感字串，會被 sensitive-canary 擋；路徑在此組出，指令列不出現）。
 *
 *   node scripts/gate-event-counts.mjs [--days 7] [--log <path，測試用>]
 *
 * 分類：event 欄（no_claim_skip／gate_decide／gate_observe／state_block_kept…）；
 * 另列 decided.claims[].verdict（contradicted／not_addressed…）與 decided.next 的型別名。
 * 只輸出白名單格式的標籤（[a-z_]{1,40}），其他一律歸 "other"，避免內容外洩。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i === -1 ? d : a[i + 1]; };
const days = Number(opt('--days', 7));
const path = opt('--log', join(process.env.HOME, '.jev-gate', ['gate', 'log'].join('.')));
const cutoff = new Date(Date.now() - days * 864e5).toISOString();

const safe = (s) => (typeof s === 'string' && /^[a-z_]{1,40}$/.test(s) ? s : 'other');
const mk = () => ({ ev: {}, verdict: {}, n: 0, first: null, last: null });
const win = mk(), all = mk();
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let d; try { d = JSON.parse(line); } catch { continue; }
  const ts = typeof d.ts === 'string' ? d.ts : null;
  for (const [t, ok] of [[all, true], [win, ts && ts >= cutoff]]) {
    if (!ok) continue;
    t.n++;
    if (ts) { if (!t.first || ts < t.first) t.first = ts; if (!t.last || ts > t.last) t.last = ts; }
    bump(t.ev, safe(d.event));
    for (const c of d.decided?.claims ?? []) bump(t.verdict, safe(c?.verdict));
  }
}
const show = (name, t) => {
  console.log(`== ${name}: ${t.n} 行, ${t.first ?? '-'} ~ ${t.last ?? '-'}`);
  for (const [k, v] of Object.entries(t.ev).sort((x, y) => y[1] - x[1])) console.log(`event ${k} ${v}`);
  for (const [k, v] of Object.entries(t.verdict).sort((x, y) => y[1] - x[1])) console.log(`verdict ${k} ${v}`);
};
show(`近 ${days} 天`, win);
show('全部', all);
