// withPaymentStop: 402 and OpenRouter's 403 key cap both hold the backup off.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPaymentStop } from '../src/budget.js';

const fail = (status, body) => async () => { const e = new Error('TypeSafe returned an unexpected status'); e.status = status; e.body = body; throw e; };
const run = async (adapter) => {
  const file = join(mkdtempSync(join(tmpdir(), 'ps-')), 'or-status.json');
  const notes = [];
  const f = withPaymentStop(adapter, { file, notify: (m) => notes.push(m), now: () => 1000 });
  await assert.rejects(f({}, {}));
  return { file, notes, f };
};

test('403 key limit sets the hold and later calls skip the network', async () => {
  let calls = 0;
  const inner = async (...a) => { calls++; return fail(403, { error: { message: 'Key limit exceeded (total limit).', metadata: { limit_source: 'openrouter_key_limit' } } })(...a); };
  const { file, notes, f } = await run(inner);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).blocked_until, 1000 + 3600000);
  assert.equal(notes.length, 1);
  await assert.rejects(f({}, {}), { code: 'JEV_PAYMENT_REQUIRED' });
  assert.equal(calls, 1);
});

test('other 403s do not set the hold', async () => {
  const { file } = await run(fail(403, { error: { message: 'Forbidden' } }));
  assert.equal(existsSync(file), false);
});
