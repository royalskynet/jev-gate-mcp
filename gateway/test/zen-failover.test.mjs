// Zen free → OpenRouter primary/backup swap. Why: Zen's free tier has a quota
// (429 FreeUsageLimitError, retry-after ~15h on 2026-09-30); jevwire slept
// through that retry-after and reported a timeout, and nothing answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZenAdapter } from '../src/adapters.js';
import { makeZenDailyTake } from '../src/budget.js';
import { recordZenStatus, resetZenStatusCache, zenCoolingDown } from '../src/zen-status.js';
import { zenCooling } from '../../agent-glue/claude/env.mjs';

// Default Zen daily counter must never touch the real ~/.jevgate file from a test.
process.env.JEV_ZEN_BUDGET_FILE = join(mkdtempSync(join(tmpdir(), 'zen-budget-')), 'b.json');

const Q = { q: { type: 'noul', instructions: 'true?' } };
const NOW = 1_000_000;
const quota429 = async () => new Response('{"type":"FreeUsageLimitError"}', { status: 429, headers: { 'retry-after': '100' } });
const backupAnswer = { model: 'typesafe/jev-1.13', answers: { q: { type: 'noul', noul: 0.9 } } };

test('429 hands the call to the backup at once and cools Zen for retry-after', async () => {
  const seen = [];
  const zen = makeZenAdapter({
    apiKey: 'k', fetch: quota429, now: () => NOW, coolingDown: () => false,
    onStatus: (ok, d) => seen.push({ ok, ...d }),
    backup: async () => backupAnswer,
  });
  const t = Date.now();
  assert.equal(await zen('s', Q), backupAnswer);
  assert.ok(Date.now() - t < 2000, 'must not sleep through retry-after');
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].cooldown_until, NOW + 100_000);
  assert.equal(seen[0].blocked, false);
});

test('blocked survives the status file (the probe reads it from there)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zen-')), 'status.json');
  resetZenStatusCache();
  recordZenStatus(false, { error: 'ban', cooldown_until: NOW + 1, blocked: true }, file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).blocked, true);
  recordZenStatus(true, {}, file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).blocked, false);
  resetZenStatusCache();
});

test('while cooling, Zen is not asked at all', async () => {
  let zenCalls = 0;
  const zen = makeZenAdapter({
    apiKey: 'k', fetch: async () => { zenCalls += 1; return quota429(); }, coolingDown: () => true,
    onStatus: () => {}, backup: async () => backupAnswer,
  });
  assert.equal(await zen('s', Q), backupAnswer);
  assert.equal(zenCalls, 0);
});

// 10-20 (fix 11052): the cooldown skip used to need a backup, so a caller
// without one kept hitting a banned Zen and fed the abuse flag.
test('while cooling without a backup, Zen is still not asked and the call fails closed', async () => {
  let zenCalls = 0;
  const zen = makeZenAdapter({
    apiKey: 'k', fetch: async () => { zenCalls += 1; return quota429(); }, coolingDown: () => true, onStatus: () => {},
  });
  await assert.rejects(zen('s', Q), (e) => e.code === 'ERR_PROVIDER' && e.retryable === false);
  assert.equal(zenCalls, 0);
});

// 10-18: Zen 403 FreeTierError = IP flagged as abusive. A 5-minute retry kept
// adding to the abuse signal (102 403s that day); cool for hours, like dc's gate.
test('403 FreeTierError cools Zen for the abuse window, not the 5-minute retry', async () => {
  const seen = [];
  const ban403 = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: "we've detected abusive traffic from this IP address" } }), { status: 403 });
  const zen = makeZenAdapter({
    apiKey: 'k', fetch: ban403, now: () => NOW, coolingDown: () => false, readStatus: () => null,
    onStatus: (ok, d) => seen.push(d), backup: async () => backupAnswer,
  });
  assert.equal(await zen('s', Q), backupAnswer);
  assert.equal(seen[0].cooldown_until, NOW + 6 * 3600_000);
  assert.equal(seen[0].blocked, true, 'the probe must tell an IP ban from a quota swap');
});

// 10-19: a fixed 6h window is still 4 hits a day into a ban that does not heal.
test('a ban still there after its window doubles the cooldown, capped at 48h', async () => {
  const ban403 = async () => new Response(JSON.stringify({ error: { type: 'FreeTierError' } }), { status: 403 });
  const after = async (prev) => {
    const seen = [];
    const zen = makeZenAdapter({
      apiKey: 'k', fetch: ban403, now: () => NOW, coolingDown: () => false, readStatus: () => prev,
      onStatus: (ok, d) => seen.push(d), backup: async () => backupAnswer,
    });
    await zen('s', Q);
    return seen[0];
  };
  assert.equal((await after({ ok: false, blocked: true, block_streak: 1 })).cooldown_until, NOW + 12 * 3600_000);
  assert.equal((await after({ ok: false, blocked: true, block_streak: 2 })).block_streak, 3);
  assert.equal((await after({ ok: false, blocked: true, block_streak: 9 })).cooldown_until, NOW + 48 * 3600_000);
  // A quota cooldown before the ban is not a repeat ban.
  assert.equal((await after({ ok: false, blocked: false })).cooldown_until, NOW + 6 * 3600_000);
});

test('without a backup a 429 still fails closed, but the cooldown is recorded', async () => {
  const seen = [];
  // coolingDown pinned: the default reads the real ~/.jevgate status file.
  const zen = makeZenAdapter({ apiKey: 'k', fetch: quota429, now: () => NOW, coolingDown: () => false, onStatus: (ok, d) => seen.push(d) });
  await assert.rejects(zen('s', Q), (e) => e.status === 429);
  assert.equal(seen[0].cooldown_until, NOW + 100_000);
});

test('a new cooldown with the same error is still written (else the swap never re-arms)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zen-')), 'status.json');
  resetZenStatusCache();
  assert.ok(recordZenStatus(false, { error: 'rate', cooldown_until: NOW + 1 }, file));
  assert.ok(recordZenStatus(false, { error: 'rate', cooldown_until: NOW + 2 }, file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).cooldown_until, NOW + 2);
  assert.equal(zenCoolingDown(NOW, file), true);
  assert.equal(zenCoolingDown(NOW + 3, file), false, 'lapsed cooldown hands primary back to Zen');
  resetZenStatusCache();
});

test('hook-side reader agrees with the gateway', () => {
  assert.equal(zenCooling(JSON.stringify({ cooldown_until: NOW + 1 }), NOW), true);
  assert.equal(zenCooling(JSON.stringify({ cooldown_until: NOW - 1 }), NOW), false);
  assert.equal(zenCooling('', NOW), false);
  assert.equal(zenCooling(JSON.stringify({ cooldown_until: NOW + 1 }), NaN), false);
});

// 10-19: 114–365 Zen calls a day preceded the abuse flag; past the cap the backup answers.
test('past the Zen daily cap the backup answers and Zen is not asked', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zen-cap-')), 'b.json');
  let zenCalls = 0;
  const ok = async () => { zenCalls += 1; return new Response(JSON.stringify(backupAnswer), { status: 200 }); };
  const zen = makeZenAdapter({
    apiKey: 'k', fetch: ok, coolingDown: () => false, onStatus: () => {},
    takeZen: makeZenDailyTake({ max: 2, file, now: () => NOW }),
    backup: async () => ({ ...backupAnswer, model: 'backup' }),
  });
  await zen('s', Q); await zen('s', Q);
  assert.equal(zenCalls, 2);
  assert.equal((await zen('s', Q)).model, 'backup');
  assert.equal(zenCalls, 2, 'the third call must not reach Zen');
});

test('the Zen daily counter resets on a new local day', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zen-cap-')), 'b.json');
  let t = new Date(2026, 9, 19, 23, 0).getTime();
  const take = makeZenDailyTake({ max: 1, file, now: () => t });
  assert.equal(take(), true);
  assert.equal(take(), false);
  t = new Date(2026, 9, 20, 0, 30).getTime();
  assert.equal(take(), true);
});
