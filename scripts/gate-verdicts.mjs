#!/usr/bin/env node
/**
 * What the Stop gate has actually been deciding. Zero tokens: it only reads
 * the ledger.
 *
 *   node scripts/gate-verdicts.mjs [ledger] [--since 2026-09-24]
 *
 * Lines from before the `gate` label exist are attributed by shape: a verdict
 * object with `claims` came from the Stop gate, one with `next` from the
 * PreToolUse gate.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt === -1 ? '' : args[sinceAt + 1];
const path = args.find((a, i) => !a.startsWith('--') && i !== sinceAt + 1)
  ?? `${process.env.HOME}/.jev-gate/gate.log`;

const rows = [];
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let d;
  try { d = JSON.parse(line); } catch { continue; }
  if (since && d.ts < since) continue;
  const dec = d.decided;
  if (!dec || typeof dec !== 'object') { rows.push({ ts: d.ts, which: d.gate ?? '?', verdict: 'ERROR', note: d.reason }); continue; }
  const which = d.gate ?? (dec.claims ? 'stop' : 'next');
  if (which !== 'stop') continue;
  const c = dec.claims?.[0] ?? {};
  rows.push({
    ts: d.ts,
    acted: d.event === 'gate_decide',
    verdict: c.verdict,
    conf: c.confidence,
    band: c.gate,
    claimChars: (c.claim ?? '').length,
    tokens: dec.usage?.input_tokens ?? 0,
    ms: dec.latency_ms ?? 0,
  });
}

if (rows.length === 0) {
  console.log(`no Stop-gate judgments in ${path}${since ? ` since ${since}` : ''}`);
  process.exit(0);
}

// Hand-fed probe payloads are tiny; real turns are not. Mixing them hides the
// only number that matters — how the gate reads an actual end of turn.
const real = rows.filter((r) => r.claimChars > 200);
const probes = rows.length - real.length;

const tally = (list) => list.reduce((a, r) => {
  const key = `${r.verdict}/${r.band}`;
  a[key] = (a[key] ?? 0) + 1;
  return a;
}, {});

console.log(`${path}${since ? `  since ${since}` : ''}`);
console.log(`${rows.length} Stop-gate judgments — ${real.length} real turns, ${probes} short probes\n`);
console.log('real turns by verdict/band:', tally(real));
const blocking = real.filter((r) => r.acted && r.verdict === 'contradicted' && r.band === 'auto');
const advising = real.filter((r) => r.acted && r.verdict === 'not_addressed' && r.band === 'auto');
console.log(`would block: ${blocking.length}   would advise: ${advising.length}   silent: ${real.length - blocking.length - advising.length}`);
const tok = real.reduce((a, r) => a + r.tokens, 0);
const ms = real.reduce((a, r) => a + r.ms, 0);
console.log(`cost: ${tok} input tokens, ${real.length ? Math.round(ms / real.length) : 0} ms median-ish per turn\n`);
for (const r of real.slice(-12)) {
  console.log(`${r.ts}  ${r.acted ? 'decide' : 'observe'}  ${String(r.verdict).padEnd(14)} conf ${String(r.conf).padEnd(5)} ${String(r.band).padEnd(8)} claim ${r.claimChars}c`);
}
