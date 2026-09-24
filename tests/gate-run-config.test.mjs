import assert from 'node:assert/strict';
import { mapWithConcurrency } from 'jevwire';
import { runConfig } from '../plugin/lib/gate.js';

// Regression: for the first three weeks every Stop-gate observation in
// ~/.jev-gate/gate.log read `not_addressed, confidence 0, usage 0, latency 0`.
// It looked like Jev judging harshly. No request had been sent at all: the
// config handed to `runVerify` carried no `maxConcurrency`, jevwire floors it
// into NaN, and `Array.from({ length: NaN })` opens zero workers. The failure
// mode is a plausible-looking verdict, so only a test that counts actual calls
// catches it.

const config = runConfig();
assert.ok(
  Number.isFinite(config.maxConcurrency) && config.maxConcurrency >= 1,
  `runConfig must carry a finite maxConcurrency, got ${config.maxConcurrency}`,
);

// The failing shape, proven against the real jevwire helper rather than
// described: no limit means the mapper runs the function zero times.
let calls = 0;
await mapWithConcurrency([1, 2], undefined, async () => { calls += 1; });
assert.equal(calls, 0, 'jevwire still opens zero workers for an undefined limit — the guard above is why this config sets one');

calls = 0;
await mapWithConcurrency([1, 2], config.maxConcurrency, async () => { calls += 1; });
assert.equal(calls, 2, 'with the config limit, every piece is actually sent');

console.log('ok: gate runConfig keeps jevwire from silently sending nothing');
