// Zen free → OpenRouter primary/backup swap. Why: Zen's free tier has a quota
// (429 FreeUsageLimitError, retry-after ~15h on 2026-09-30); jevwire slept
// through that retry-after and reported a timeout, and nothing answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZenAdapter } from '../src/adapters.js';
import { recordZenStatus, resetZenStatusCache, zenCoolingDown } from '../src/zen-status.js';
import { zenCooling } from '../../agent-glue/claude/env.mjs';

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

test('without a backup a 429 still fails closed, but the cooldown is recorded', async () => {
  const seen = [];
  const zen = makeZenAdapter({ apiKey: 'k', fetch: quota429, now: () => NOW, onStatus: (ok, d) => seen.push(d) });
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
