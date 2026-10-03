#!/usr/bin/env node
// noul truth-discrimination eval (issue #10): run each provider's noul head on a
// labeled true/false claim set and report AUROC — the ranking question the
// issue asks ("does noul separate true from false?"), which calibration alone
// cannot fix. Accuracy@0.5 is printed too but is threshold-dependent.
//
//   node gateway/scripts/noul-eval.mjs [set.jsonl] [--providers laya,zen] [--limit N] [--concurrency N] [--out report.json]
//
// Default set: gateway/fixtures/truth-claims-v1.jsonl (build-truth-set.mjs).
// zen reads ~/.creds/kv/OPENCODE_ZEN_API_KEY.txt; laya loads the local bundle.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeLayaAdapter, makeZenAdapter } from '../src/adapters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const setPath = args[0] && !args[0].startsWith('--') ? args[0] : join(ROOT, 'gateway/fixtures/truth-claims-v1.jsonl');
const providers = flag('--providers', 'laya,zen').split(',');
const limit = Number(flag('--limit', Infinity));
const out = flag('--out', null);
const concurrency = Number(flag('--concurrency', 1));

const INSTRUCTIONS = 'Is the claim generally true?';
const QUESTIONS = { q1: { type: 'noul', instructions: INSTRUCTIONS } };

/** Mann-Whitney AUROC; ties count half. O(n·m), fine for a few hundred. */
export function auroc(rows) {
  const pos = rows.filter((r) => r.label).map((r) => r.score);
  const neg = rows.filter((r) => !r.label).map((r) => r.score);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

function makeAdapter(name) {
  if (name === 'laya') return makeLayaAdapter();
  if (name === 'zen') {
    const apiKey = readFileSync(join(homedir(), '.creds/kv/OPENCODE_ZEN_API_KEY.txt'), 'utf8').trim();
    return makeZenAdapter({ apiKey, onStatus: () => {} });
  }
  throw new Error(`unknown provider ${name}`);
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k]); }
  }));
  return res;
}

function summarize(rows) {
  const ok = rows.filter((r) => typeof r.score === 'number');
  const acc = ok.length ? ok.filter((r) => (r.score >= 0.5) === r.label).length / ok.length : null;
  return { n: rows.length, scored: ok.length, errors: rows.length - ok.length, auroc: auroc(ok), acc_at_0_5: acc };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // self-check: perfect, inverted and tied rankings
  console.assert(auroc([{ label: true, score: 0.9 }, { label: false, score: 0.1 }]) === 1);
  console.assert(auroc([{ label: true, score: 0.1 }, { label: false, score: 0.9 }]) === 0);
  console.assert(auroc([{ label: true, score: 0.5 }, { label: false, score: 0.5 }]) === 0.5);

  const set = readFileSync(setPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(0, limit);
  const report = { set: setPath, n: set.length, instructions: INSTRUCTIONS, providers: {} };
  for (const name of providers) {
    const adapter = makeAdapter(name);
    const t = Date.now();
    // ponytail: serial by default — 4-way on the Zen free tier tripped its
    // throttle after ~220 calls (every later request timed out); laya is one
    // local session anyway.
    const rows = await pool(set, name === 'laya' ? 1 : concurrency, async (c) => {
      try {
        const r = await adapter({ claim: c.claim }, QUESTIONS);
        return { id: c.id, source: c.source, label: c.label, score: r?.answers?.q1?.noul };
      } catch (e) {
        return { id: c.id, source: c.source, label: c.label, score: null, error: String(e?.message ?? e).slice(0, 120) };
      }
    });
    const bySource = {};
    for (const s of [...new Set(rows.map((r) => r.source))]) bySource[s] = summarize(rows.filter((r) => r.source === s));
    report.providers[name] = { ...summarize(rows), ms: Date.now() - t, bySource, firstError: rows.find((r) => r.error)?.error ?? null };
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
