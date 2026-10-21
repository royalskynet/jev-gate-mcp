#!/usr/bin/env node
// Zero-token health probe for the free Jev tier. Deliberately does not use the
// gateway: it must answer "is the free tier still free and alive?" on its own,
// including when the gateway is the thing that is broken.
//
//   node scripts/zen-free-probe.mjs          # print verdict, exit 0 ok / 1 abort / 2 cooling, OpenRouter backs it / 3 IP blocked
//   node scripts/zen-free-probe.mjs --quiet  # exit code only (for launchd/cron)
//
// Exit 1 is the alarm a scheduler watches. It never notifies on its own — the
// caller decides how loud to be, so this stays a mechanical check and no token
// is spent deciding whether the free tier is gone.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeZenAdapter } from '../gateway/src/adapters.js';
import { readZenStatus } from '../gateway/src/zen-status.js';

const quiet = process.argv.includes('--quiet');
const MODEL = process.env.JEV_MODEL ?? 'jev-1.13-free';
const KEY_FILE = process.env.JEV_API_KEY_FILE
  ?? join(homedir(), '.creds', 'kv', 'OPENCODE_ZEN_API_KEY.txt');

const BACKUP_KEY_FILE = process.env.JEV_ZEN_BACKUP_KEY_FILE
  ?? join(homedir(), '.creds', 'kv', 'OPENROUTER_SECOND_API_KEY.txt');
const say = (line) => { if (!quiet) process.stdout.write(line + '\n'); };

const QUESTIONS = {
  liveness: {
    type: 'choice',
    instructions: 'Probe question. Pick the best fit.',
    criteria: { ok: 'the probe reached the provider', fail: 'the probe did not' },
  },
};

async function main() {
  let key;
  try {
    key = readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    return abort(`credential file unreadable: ${KEY_FILE}`);
  }
  if (!key) return abort(`credential file empty: ${KEY_FILE}`);

  // Inside a cooldown the answer is already in the status file. Calling Zen
  // anyway was the only traffic during the 10-18 ban (hourly 403s, each
  // re-arming the abuse flag): consumers skip Zen, the probe did not.
  const until = readZenStatus()?.cooldown_until;
  if (Number.isFinite(until) && until > Date.now()) return abort('cooldown active; probe skipped the network call');

  const call = makeZenAdapter({ apiKey: key, model: MODEL, ...(process.env.JEV_ZEN_BASE_URL && { baseUrl: process.env.JEV_ZEN_BASE_URL }) });
  const started = Date.now();
  try {
    // A one-candidate question: the answer is irrelevant, the round trip is
    // the signal. `a` vs `b` so a provider that always picks the first
    // candidate still returns a well-typed answer.
    const r = await call('health probe', QUESTIONS);
    const ms = Date.now() - started;
    if (!r?.answers?.liveness) return abort('provider returned no answer');
    say(`OK  jev free tier alive  model=${r.model}  latency=${ms}ms`);
    return 0;
  } catch (e) {
    return abort(`free tier unreachable: ${e?.message ?? e}`);
  }
}

function abort(reason) {
  const status = readZenStatus();
  const until = status?.cooldown_until;
  // A quota cooldown with an OpenRouter key is a planned swap, not an outage.
  const backed = Number.isFinite(until) && until > Date.now() && existsSync(BACKUP_KEY_FILE);
  // An IP ban also sets a cooldown, but it does not heal on its own: report it
  // apart from a quota swap so the watcher alerts instead of staying quiet (10-18).
  const blocked = status?.ok === false && status?.blocked === true;
  say(`${blocked ? 'BLOCKED' : backed ? 'COOLING' : 'ABORT'}  ${reason}`);
  if (Number.isFinite(until)) say(`  cooldown_until=${new Date(until).toISOString()}  (${((until - Date.now()) / 3.6e6).toFixed(1)}h)`);
  say(`  judged_by=${backed ? 'openrouter (backup until the cooldown lapses)' : 'nothing (fail-closed; no backup key)'}`);
  if (status && !status.ok && status.error) say(`  last_error=${status.error}`);
  say(`  remediation=${status?.remediation ?? 'restore the free tier, or point JEV_PROVIDER / JEV_FALLBACK_PROVIDER elsewhere, then restart the session'}`);
  return blocked ? 3 : backed ? 2 : 1;
}

process.exitCode = await main();
