#!/usr/bin/env node
/**
 * Zero-token savings report over every prune / compact ledger (#31):
 * events, how many carry before/after sizes, and chars saved over the last N
 * days. Read-only. A line without sizes counts as `unmeasured`, never as 0
 * saved, so a ledger gap shows up instead of shrinking the ratio.
 *
 * Usage: node scripts/savings-report.mjs [--days 7] [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const days = Number(argv[argv.indexOf('--days') + 1]) || 7;
const json = argv.includes('--json');
const since = Date.now() - days * 86400_000;
const HOME = os.homedir();
const STATE = path.join(HOME, '.openclaw', 'state');
const HERMES = process.env.HERMES_HOME || path.join(HOME, '.hermes');

const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const recent = (ts) => Date.parse(ts) >= since;
const ARROW = /(\d+) → (\d+) chars/;

/** Tab-separated `<iso>\t<text>` ledgers; `pick(text)` → null (skip) | {} (unmeasured) | {before, after}. */
function textLedger(file, pick) {
  return lines(file).flatMap((l) => {
    const [ts, text = ''] = l.split('\t');
    if (!recent(ts)) return [];
    const r = pick(text);
    return r ? [r] : [];
  });
}
const sized = (text) => {
  const m = text.match(ARROW);
  return m ? { before: +m[1], after: +m[2] } : {};
};

function hermesJsonl(name, map) {
  const homes = [HERMES, ...(existsSync(path.join(HERMES, 'profiles'))
    ? readdirSync(path.join(HERMES, 'profiles')).map((p) => path.join(HERMES, 'profiles', p)) : [])];
  return homes.flatMap((h) => lines(path.join(h, 'logs', name)).flatMap((l) => {
    try { const e = JSON.parse(l); return recent(e.ts ?? e.time) ? map(e) : []; } catch { return []; }
  }));
}
const num = (v) => (Number.isFinite(v) ? v : undefined);

const surfaces = {
  // Claude Code in-process prune hook: every line is `X → Y chars`.
  'prune:claude-hook': textLedger(path.join(STATE, 'jev-prune.log'), (t) => (t.startsWith('jev-prune(') ? sized(t) : null)),
  // CLI prune (opencode / Hermes via cli.mjs): only `judged` outcomes count;
  // lines before #31 have no sizes and land in `unmeasured`.
  'prune:cli': textLedger(path.join(STATE, 'jev-prune-cli.log'), (t) => (/: judged\b/.test(t) ? sized(t) : null)),
  'prune:hermes': hermesJsonl('jev-prune.jsonl', (e) => (e.reason === 'judged'
    ? [{ before: num(e.before ?? e.chars_before), after: num(e.after ?? e.chars_after) }] : [])),
  // Claude compact hook + openclaw provider share this file; fallbacks saved 0.
  'compact:claude+openclaw': textLedger(path.join(STATE, 'jev-compact.log'), (t) => {
    if (/fell back/.test(t)) { const m = t.match(/reducedBy (\d+) of (\d+)/); return m ? { before: +m[2], after: +m[2] } : {}; }
    return ARROW.test(t) ? sized(t) : null;
  }),
  'compact:opencode': textLedger(path.join(HOME, '.jevgate', 'opencode-compact.log'), sized),
  'compact:hermes': hermesJsonl('jev-compact.jsonl', (e) => [{ before: num(e.before_chars), after: num(e.after_chars) }]),
};

const rows = Object.entries(surfaces).map(([surface, ev]) => {
  const m = ev.filter((e) => e.before !== undefined && e.after !== undefined);
  const before = m.reduce((a, e) => a + e.before, 0);
  const after = m.reduce((a, e) => a + e.after, 0);
  return { surface, events: ev.length, measured: m.length, unmeasured: ev.length - m.length, before, after, saved: before - after, saved_pct: before ? +((100 * (before - after)) / before).toFixed(1) : null };
});

if (json) {
  console.log(JSON.stringify({ days, rows }, null, 2));
} else {
  console.log(`savings, last ${days} days (chars; tokens ≈ chars/4, not measured)`);
  console.log(['surface', 'events', 'measured', 'unmeasured', 'before', 'after', 'saved', 'saved%'].join('\t'));
  for (const r of rows) console.log([r.surface, r.events, r.measured, r.unmeasured, r.before, r.after, r.saved, r.saved_pct ?? '-'].join('\t'));
}
