// 11-06 02:29: Zen answered a caller-side 400 ValidationError (jev-laya prune sent
// a choice with 0 options) and the adapter cooled Zen for 5 min, so every cascade
// caller skipped Zen. Caller errors must not count as a Zen outage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZenAdapter } from '../src/adapters.js';

process.env.JEV_ZEN_BUDGET_FILE = join(mkdtempSync(join(tmpdir(), 'zen-budget-')), 'b.json');

const Q = { q: { type: 'noul', instructions: 'true?' } };
const backupAnswer = { model: 'typesafe/jev-1.13', answers: { q: { type: 'noul', noul: 0.9 } } };

function harness(status) {
  const seen = [];
  let backupCalls = 0;
  const zen = makeZenAdapter({
    apiKey: 'k', now: () => 1, coolingDown: () => false, takeZen: () => true,
    fetch: async () => new Response('{"error":{"type":"ValidationError","message":"Choice question \\"c0\\" has 0 options"}}', { status }),
    onStatus: (ok, d) => seen.push({ ok, ...d }),
    backup: async () => { backupCalls += 1; return backupAnswer; },
  });
  return { zen, seen, backupCalls: () => backupCalls };
}

for (const status of [400, 404, 409, 422]) {
  test(`${status} is the caller's fault: rejects, no cooldown, no backup`, async () => {
    const h = harness(status);
    await assert.rejects(h.zen('s', Q));
    assert.equal(h.seen.length, 0);
    assert.equal(h.backupCalls(), 0);
  });
}

test('500 is still a Zen outage: cools down and hands off to the backup', async () => {
  const h = harness(500);
  assert.equal(await h.zen('s', Q), backupAnswer);
  assert.equal(h.seen.length, 1);
  assert.ok(h.seen[0].cooldown_until > 1);
  assert.equal(h.backupCalls(), 1);
});
