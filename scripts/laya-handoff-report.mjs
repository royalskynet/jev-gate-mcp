#!/usr/bin/env node
// Laya 接手 Jev 工作的比例，按日×caller。分母＝原本會發給 Jev 的全部請求，三個來源合併：
//   1. laya-handoff.jsonl：經 Laya router 的請求（含 Laya 全接、沒在 usage.jsonl 留痕跡的）
//   2. usage.jsonl 的 model=cache：cascade 快取命中，在 router 之前就回了
//   3. usage.jsonl＋usage-hook-*.jsonl 其他 status=200 的 Jev 呼叫：沒經 router 的 caller
// 同一 caller 從它第一筆 handoff 起只用 handoff 計，之前的 usage 行按 model 分類（laya／hybrid／
// 其他），避免重算。gateway:cascade-server 是 cascade 往上游的那一跳，與 cascade:* 重複，排除。
// 計費按請求：一題送雲端整次就付費，所以「Laya 全接%」才是省下的 Jev 呼叫。
// ponytail: zen 429→OR 備援同一請求只有一行 200，重試多算的情況目前沒有；有了再按 ts 去重。
// 用法：node scripts/laya-handoff-report.mjs [--days N] [--all] [--dir ~/.jevgate]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { handoffFile } from '../agent-glue/src/usage-ledger.js';

const OFFLINE = /backtest|replay|probe|selftest|smoke|\.test\b/;
const UPSTREAM_HOP = 'gateway:cascade-server';

const parse = (lines) => lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** handoff: router 行；usage: usage.jsonl＋hook 行。回傳 [[`day\tcaller`, counts]]，含 `day\t*` 合計。 */
export function summarize({ handoff = [], usage = [] }, { days = 7, all = false, now = Date.now() } = {}) {
  const since = new Date(now - days * 864e5).toISOString().slice(0, 10);
  const firstRouted = new Map();
  for (const r of handoff) if (!(firstRouted.get(r.caller) <= r.ts)) firstRouted.set(r.caller, r.ts);
  const groups = new Map();
  const add = (r, f) => {
    const day = String(r.ts ?? '').slice(0, 10);
    if (day < since || (!all && OFFLINE.test(r.caller))) return;
    for (const key of [`${day}\t${r.caller}`, `${day}\t*`]) {
      const g = groups.get(key) ?? { denom: 0, laya: 0, part: 0, cache: 0, jev: 0, qt: 0, ql: 0, sf: 0, lc: 0, inv: 0, nm: 0 };
      g.denom++; f(g); groups.set(key, g);
    }
  };
  for (const r of handoff) add(r, (g) => {
    if (r.q_total > 0 && r.q_cloud === 0) g.laya++; else if (r.q_local > 0) g.part++; else g.jev++;
    g.qt += r.q_total; g.ql += r.q_local;
    g.sf += r.by_state_filter; g.lc += r.by_low_conf; g.inv += r.by_invalid; g.nm += r.by_no_match;
  });
  for (const r of usage) {
    if (r.status !== 200 || !r.model || r.caller === UPSTREAM_HOP) continue;
    if (r.model === 'cache') { add(r, (g) => g.cache++); continue; }
    if (firstRouted.has(r.caller) && r.ts >= firstRouted.get(r.caller)) continue;
    add(r, (g) => { if (r.model === 'laya') g.laya++; else if (r.model.startsWith('hybrid:')) g.part++; else g.jev++; });
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const dir = opt('--dir', dirname(handoffFile()));
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const usageFiles = readdirSync(dir).filter((f) => f === 'usage.jsonl' || /^usage-hook-.*\.jsonl$/.test(f));
  const rows = summarize({ handoff: parse(read('laya-handoff.jsonl')), usage: parse(usageFiles.flatMap(read)) },
    { days: Number(opt('--days', 7)), all: args.includes('--all') });
  console.log('day\tcaller\t原本送Jev\tLaya全接\t部分本地\t快取\t仍走Jev\t題目本地(經router)\t未接住(state/低信心/無效/no_match)');
  for (const [key, g] of rows) {
    console.log(`${key}\t${g.denom}\t${pct(g.laya, g.denom)} (${g.laya})\t${g.part}\t${g.cache}\t${g.jev}\t`
      + `${g.qt ? `${pct(g.ql, g.qt)} (${g.ql}/${g.qt})` : '-'}\t${g.sf}/${g.lc}/${g.inv}/${g.nm}`);
  }
}
