#!/usr/bin/env node
/**
 * The verdict on raising `thresholdChars` to one chunk (DEVLOG §23.2), read off
 * the production ledger instead of argued.
 *
 * Two questions, and only one of them is interesting:
 *
 *   1. Did the hit rate go up? It has to — dropping the calls that never dropped
 *      anything raises drops/calls by arithmetic alone. Reported, not evidence.
 *   2. Did we stop judging something that would have paid? That is what the
 *      `jev-skip` lines are for: every output that cleared half a chunk but not
 *      the threshold, i.e. exactly what the change gave up. A week of them in the
 *      12-16 KB band with the old ledger's 0-for-18 record below one chunk is the
 *      argument for keeping 16000; a fat band would be the argument against.
 *
 * Usage:
 *   node scripts/prune-verdict.mjs [--since 2026-09-22T07:00:00Z] [--ledger PATH]
 *   node scripts/prune-verdict.mjs --selftest
 */
import { readFileSync } from 'node:fs';

const DEFAULT_LEDGER = process.env.JEV_LEDGER || `${process.env.HOME}/.openclaw/state/jev-prune.log`;
/** When 16000 went live: commit da28c55, pushed 2026-09-22T07:12Z. */
const DEFAULT_SINCE = '2026-09-22T07:12:00Z';

const PRUNE = /^(\S+)\tjev-prune\((\w+)\): (\d+) → (\d+) chars, (\d+) lines dropped/;
const SKIP = /^(\S+)\tjev-skip\((\w+)\): (\d+) chars/;

export function parseLedger(text) {
  const prunes = [];
  const skips = [];
  for (const line of text.split('\n')) {
    const p = PRUNE.exec(line);
    if (p) {
      prunes.push({ at: p[1], tool: p[2], before: +p[3], after: +p[4], droppedLines: +p[5] });
      continue;
    }
    const s = SKIP.exec(line);
    if (s) skips.push({ at: s[1], tool: s[2], chars: +s[3] });
  }
  return { prunes, skips };
}

export function summarise(prunes) {
  const saved = prunes.reduce((a, r) => a + (r.before - r.after), 0);
  const hits = prunes.filter((r) => r.before !== r.after).length;
  return {
    calls: prunes.length,
    hits,
    hitRate: prunes.length ? hits / prunes.length : 0,
    savedChars: saved,
    judgedChars: prunes.reduce((a, r) => a + r.before, 0),
  };
}

/** Skipped sizes as chunk-relative buckets — the band is the whole point. */
export function bands(skips, chunkChars = 16000) {
  const out = new Map();
  for (const s of skips) {
    const tenth = Math.floor((s.chars / chunkChars) * 10) / 10;
    const key = `${tenth.toFixed(1)}-${(tenth + 0.1).toFixed(1)} chunk`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function report(text, since) {
  const { prunes, skips } = parseLedger(text);
  const before = summarise(prunes.filter((r) => r.at < since));
  const after = summarise(prunes.filter((r) => r.at >= since));
  const row = (label, s) =>
    `${label.padEnd(8)} calls ${String(s.calls).padStart(4)}  hits ${String(s.hits).padStart(3)}`
    + `  hit-rate ${(s.hitRate * 100).toFixed(1).padStart(5)}%  saved ${String(s.savedChars).padStart(7)} chars`
    + `  judged ${String(s.judgedChars).padStart(8)} chars`;
  console.log(`ledger split at ${since}`);
  console.log(row('before', before));
  console.log(row('after', after));
  const near = skips.filter((s) => s.at >= since);
  console.log(`\nskipped (>= half a chunk, would have been judged at the old threshold): ${near.length}`);
  for (const [band, n] of bands(near)) console.log(`  ${band.padEnd(16)} ${n}`);
  if (!near.length) console.log('  (none — nothing in the give-up band yet)');
}

function selftest() {
  const sample = [
    '2026-09-21T00:00:00.000Z\tjev-prune(Bash): 44042 → 16027 chars, 300 lines dropped',
    '2026-09-21T00:01:00.000Z\tjev-prune(Read): 12518 → 12518 chars, 0 lines dropped',
    '2026-09-23T00:00:00.000Z\tjev-prune(Bash): 30000 → 10000 chars, 50 lines dropped',
    '2026-09-23T00:02:00.000Z\tjev-skip(Bash): 12000 chars, under threshold 16000',
    'not a ledger line at all',
  ].join('\n');
  const { prunes, skips } = parseLedger(sample);
  console.assert(prunes.length === 3 && skips.length === 1, 'parse');
  const s = summarise(prunes.filter((r) => r.at < '2026-09-22T00:00:00Z'));
  console.assert(s.calls === 2 && s.hits === 1 && s.savedChars === 28015, `before: ${JSON.stringify(s)}`);
  console.assert(bands(skips)[0][0] === '0.7-0.8 chunk', `bands: ${JSON.stringify(bands(skips))}`);
  console.log('prune-verdict selftest OK');
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

if (process.argv.includes('--selftest')) selftest();
else report(readFileSync(arg('ledger', DEFAULT_LEDGER), 'utf8'), arg('since', DEFAULT_SINCE));
