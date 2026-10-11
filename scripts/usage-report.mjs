#!/usr/bin/env node
// Who spends the Zen/Jev quota: sums ~/.jevgate/usage*.jsonl by caller.
// Usage: node scripts/usage-report.mjs [--since <ISO>] [--json]
// Zero-token: reads the ledger lines written by agent-glue/src/usage-ledger.js
// and the per-day hook files; never reads prompts (the ledger has none).
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '';
const dir = join(homedir(), '.jevgate');

export function summarize(lines, sinceIso = '') {
  const by = new Map();
  let first = '', last = '';
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.ts !== 'string' || (sinceIso && r.ts < sinceIso)) continue;
    if (!first || r.ts < first) first = r.ts;
    if (!last || r.ts > last) last = r.ts;
    // 'gateway:jev-route' and 'gateway:stdio' stay apart; that split is the point.
    const k = r.caller || 'unknown';
    const s = by.get(k) || { caller: k, calls: 0, ok: 0, rate_limited: 0, errors: 0, input_tokens: 0, output_tokens: 0 };
    s.calls++;
    if (r.status === 429) s.rate_limited++;
    else if (typeof r.status === 'number' && r.status < 400) s.ok++;
    else s.errors++;
    s.input_tokens += Number(r.input_tokens) || 0;
    s.output_tokens += Number(r.output_tokens) || 0;
    by.set(k, s);
  }
  const rows = [...by.values()].sort((a, b) =>
    (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens) || b.calls - a.calls);
  return { first, last, rows };
}

function readLedger() {
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^usage(-hook-.+)?\.jsonl$/.test(n)); } catch {}
  return names.flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = summarize(readLedger(), since);
  if (args.includes('--json')) {
    console.log(JSON.stringify(out));
  } else if (!out.rows.length) {
    console.log('usage ledger empty');
  } else {
    const total = out.rows.reduce((t, r) => t + r.input_tokens + r.output_tokens, 0) || 1;
    console.log(`${out.first} → ${out.last}`);
    for (const r of out.rows) {
      const tok = r.input_tokens + r.output_tokens;
      console.log(`${r.caller}\tcalls=${r.calls}\t429=${r.rate_limited}\terr=${r.errors}\ttokens=${tok}\t${Math.round((tok / total) * 100)}%`);
    }
  }
}
