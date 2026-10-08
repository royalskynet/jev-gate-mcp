#!/usr/bin/env node
// Zero-token summary of the Stop gate's first day behind the cascade daemon.
// Reads ~/.jevgate/usage.jsonl (cascade:stop-gate rows) and ~/.jev-gate/gate.log
// (one gate_decide line per judged Stop). Stops judged without a cascade row
// went straight to Zen/OR because the daemon was unreachable.
// Usage: node scripts/cascade-stopgate-report.mjs [--since ISO]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argSince = process.argv.indexOf('--since');
const since = argSince > 0 ? Date.parse(process.argv[argSince + 1]) : Date.now() - 86400000;

function rows(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    }).filter((r) => Date.parse(r.ts) >= since);
  } catch {
    return [];
  }
}

function tier(model) {
  if (model === 'cache') return 'cache';
  if (!model) return 'error';
  if (model.startsWith('typesafe/')) return 'openrouter';
  if (model.includes('jev-1.13')) return 'zen';
  return 'laya';
}

const pct = (xs, p) => xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0;

const usage = rows(join(homedir(), '.jevgate', 'usage.jsonl')).filter((r) => r.caller === 'cascade:stop-gate');
const decides = rows(join(homedir(), '.jev-gate', 'gate.log')).filter((r) => r.gate === 'stop' && r.event === 'gate_decide');
const byTier = {};
for (const r of usage) byTier[tier(r.model)] = (byTier[tier(r.model)] ?? 0) + 1;
const statuses = {};
for (const r of usage) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
const tokens = usage.reduce((s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
const lat = usage.filter((r) => r.model !== 'cache').map((r) => r.latency_ms ?? 0);
let budget = null;
try { budget = JSON.parse(readFileSync(join(homedir(), '.jevgate', 'or-budget.json'), 'utf8')); } catch { /* none yet */ }

const lines = [
  `Stop gate via cascade since ${new Date(since).toISOString().slice(0, 16)}Z`,
  `judged Stops (gate.log): ${decides.length}  cascade rows: ${usage.length}  direct fallback ≈ ${Math.max(0, decides.length - usage.length)}`,
  `by tier: ${Object.entries(byTier).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
  `status: ${Object.entries(statuses).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
  `tokens: ${tokens}  latency p50=${pct(lat, 0.5)}ms p95=${pct(lat, 0.95)}ms`,
  `OR daily budget file: ${budget ? JSON.stringify(budget) : 'absent'}`,
];
process.stdout.write(lines.join('\n') + '\n');
