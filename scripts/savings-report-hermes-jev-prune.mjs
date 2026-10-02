#!/usr/bin/env node
/**
 * Unified savings report: Hermes jev-prune + OpenClaw model routing.
 *
 * Read-only over `<profile home>/logs/jev-prune.jsonl` for every profile that
 * has `jev-prune` symlinked under `<profile home>/plugins/`, and print a table
 * of calls / judged / dropped / errors / chars_saved / estimated_tokens_saved.
 *
 * `estimated_tokens_saved` is `chars_saved / 4` — a coarse, optimistic
 * conversion, NOT a measured claim. The report says so. Actual savings require
 * measuring the real tokenizer of the model that consumed the context.
 *
 * The mechanisms deliberately stay separate: pruned characters cannot be
 * added to model-routing decisions. OpenClaw's ledger has no token usage or
 * prices, so this report does not invent a net-cost number.
 *
 * Usage: node scripts/savings-report-hermes-jev-prune.mjs [--json] [profiles...]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const PROFILES_DIR = path.join(HERMES_HOME, 'profiles');
const OPENCLAW_LEDGER = path.join(OPENCLAW_HOME, 'logs', 'jev-gate.jsonl');
const DEFAULT_PROFILES = ['coco', 'mannie', 'xuanjun'];

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const argProfiles = argv.filter((a) => a !== '--json');
const profiles = argProfiles.length ? argProfiles : DEFAULT_PROFILES;

function profileHome(name) {
  // Profile homes: most live at $HERMES_HOME/profiles/<name>; the default
  // profile lives at HERMES_HOME itself.
  return name === 'default' || name === '__default__'
    ? HERMES_HOME
    : path.join(PROFILES_DIR, name);
}

function readLedger(home) {
  const p = path.join(home, 'logs', 'jev-prune.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function readJsonl(file) {
  if (!existsSync(file)) return { entries: [], invalid_lines: 0 };
  let invalid_lines = 0;
  const entries = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); }
      catch { invalid_lines += 1; return null; }
    })
    .filter(Boolean);
  return { entries, invalid_lines };
}

const hermesSummary = { calls: 0, judged: 0, dropped: 0, errors: 0, chars_saved: 0, estimated_tokens_saved: 0 };
const rows = [];

for (const name of profiles) {
  const home = profileHome(name);
  const installed = existsSync(path.join(home, 'plugins', 'jev-prune'));
  const entries = readLedger(home);

  // Calls: count every line that recorded an eligible decision. `before` and
  // `after` are present on judged/kept/error lines; dropped_lines marks real
  // prunes. lines without a duration are pre-gate skips.
  const calls = entries.length;
  // `reason` is the current schema; older ledgers wrote `outcome`. Read both so a
  // mixed ledger does not report judged=0 alongside dropped>0.
  const verdict = (e) => e.reason ?? e.outcome;
  const judged = entries.filter((e) => verdict(e) === 'judged').length;
  const dropped = entries.reduce((a, e) => a + (Number(e.dropped_lines) || 0), 0);
  const errors = entries.filter((e) => verdict(e) === 'error').length;
  const chars_saved = entries.reduce((a, e) => {
    const before = Number(e.before ?? e.chars_before) || 0;
    const after = Number(e.after ?? e.chars_after) || before;
    return a + Math.max(0, before - after);
  }, 0);

  hermesSummary.calls += calls;
  hermesSummary.judged += judged;
  hermesSummary.dropped += dropped;
  hermesSummary.errors += errors;
  hermesSummary.chars_saved += chars_saved;

  rows.push({
    profile: name,
    installed,
    calls,
    judged,
    dropped,
    errors,
    chars_saved,
    estimated_tokens_saved: Math.round(chars_saved / 4),
  });
}

hermesSummary.estimated_tokens_saved = Math.round(hermesSummary.chars_saved / 4);

const { entries: openclawEntries, invalid_lines } = readJsonl(OPENCLAW_LEDGER);
const outcome_counts = {};
for (const entry of openclawEntries) {
  const outcome = typeof entry.outcome === 'string' ? entry.outcome : 'unknown';
  outcome_counts[outcome] = (outcome_counts[outcome] ?? 0) + 1;
}
const noRequestOutcomes = new Set(['too-short', 'off', 'no-cheap-model']);
const triage_calls = openclawEntries.filter((e) => !noRequestOutcomes.has(e.outcome)).length;
const downgrades = outcome_counts.cheap ?? 0;
const skipped = openclawEntries.length - triage_calls;
const dates = openclawEntries.map((e) => e.at).filter((v) => typeof v === 'string').sort();
const openclawSummary = {
  ledger_found: existsSync(OPENCLAW_LEDGER),
  decisions: openclawEntries.length,
  triage_calls,
  downgrades,
  retained: Math.max(0, triage_calls - downgrades),
  skipped,
  downgrade_rate: triage_calls ? downgrades / triage_calls : 0,
  outcome_counts,
  invalid_lines,
  first_decision_at: dates[0] ?? null,
  last_decision_at: dates.at(-1) ?? null,
  net_cost_savings: null,
};

const result = {
  generated_at: new Date().toISOString(),
  notes: [
    'Hermes estimated_tokens_saved = chars_saved / 4 — coarse estimate, not a measured token count.',
    'OpenClaw net_cost_savings is null: its ledger does not contain token usage, baseline model price, or actual model price.',
    'Hermes pruning and OpenClaw routing are different mechanisms and are not added into one synthetic total.',
  ],
  hermes: { profiles_dir: PROFILES_DIR, summary: hermesSummary, rows },
  openclaw: { ledger: OPENCLAW_LEDGER, summary: openclawSummary },
};

if (json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write('Jev unified savings report\n');
  process.stdout.write(`generated_at: ${result.generated_at}\n`);
  for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
  process.stdout.write('\nHERMES / jev-prune\n');
  process.stdout.write('profile  installed  calls  judged  dropped  errors  chars_saved  est_tokens\n');
  for (const r of rows) {
    process.stdout.write(
      `${r.profile.padEnd(11)} ${String(r.installed).padEnd(9)} ${String(r.calls).padStart(5)} ${String(r.judged).padStart(6)} ${String(r.dropped).padStart(7)} ${String(r.errors).padStart(6)} ${String(r.chars_saved).padStart(12)} ${String(r.estimated_tokens_saved).padStart(10)}\n`,
    );
  }
  process.stdout.write('\nHERMES TOTAL\n');
  process.stdout.write(
    `  calls=${hermesSummary.calls} judged=${hermesSummary.judged} dropped=${hermesSummary.dropped} errors=${hermesSummary.errors} chars_saved=${hermesSummary.chars_saved} est_tokens=${hermesSummary.estimated_tokens_saved}\n`,
  );
  process.stdout.write('\nOPENCLAW / model routing\n');
  process.stdout.write(
    `  decisions=${openclawSummary.decisions} triage_calls=${openclawSummary.triage_calls} downgrades=${openclawSummary.downgrades} retained=${openclawSummary.retained} skipped=${openclawSummary.skipped} downgrade_rate=${(openclawSummary.downgrade_rate * 100).toFixed(1)}%\n`,
  );
  process.stdout.write(`  outcomes=${JSON.stringify(openclawSummary.outcome_counts)}\n`);
  process.stdout.write(`  range=${openclawSummary.first_decision_at ?? 'n/a'}..${openclawSummary.last_decision_at ?? 'n/a'} net_cost_savings=unknown\n`);
}
process.exit(0);
