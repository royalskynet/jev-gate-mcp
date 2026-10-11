import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../scripts/usage-report.mjs';

// The report exists to name the biggest quota spender, so ranking by tokens
// (not call count) and keeping gateway sub-callers apart is the intent.
test('ranks callers by tokens and keeps gateway sub-callers apart', () => {
  const l = (caller, status, i, o, ts = '2026-10-06T00:00:00Z') =>
    JSON.stringify({ ts, caller, status, input_tokens: i, output_tokens: o });
  const { rows } = summarize([
    l('gateway:zen-free-probe', 200, 10, 1),
    l('gateway:zen-free-probe', 200, 10, 1),
    l('gateway:zen-free-probe', 200, 10, 1),
    l('cli:hermes-compact', 200, 5000, 400),
    l('gateway:jev-route', 429, null, null),
    'not json',
  ]);
  assert.deepEqual(rows.map((r) => r.caller), ['cli:hermes-compact', 'gateway:zen-free-probe', 'gateway:jev-route']);
  assert.equal(rows[2].rate_limited, 1);
  assert.equal(rows[1].calls, 3);
});

test('--since drops older lines', () => {
  const { rows } = summarize([
    JSON.stringify({ ts: '2026-10-04T00:00:00Z', caller: 'old', status: 200 }),
    JSON.stringify({ ts: '2026-10-06T00:00:00Z', caller: 'new', status: 200 }),
  ], '2026-10-05T00:00:00Z');
  assert.deepEqual(rows.map((r) => r.caller), ['new']);
});
