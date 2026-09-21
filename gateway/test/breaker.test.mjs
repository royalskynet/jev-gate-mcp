// Circuit-breaker behavior (item 2): failure threshold opens, open short-
// circuits (policy can never accept), half-open recovery, provider isolation,
// and the trust boundary that auth/invalid-request never opens the breaker.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeBreaker, isRetryableError, BreakerState } from '../src/breaker.js';
import { makeFakeAdapter, FakeMode } from '../src/adapters.js';
import { JevGateway } from '../src/gateway.js';
import { loadRegistry } from '../src/registry.js';
import { ERR } from '../src/core.js';

const registry = loadRegistry();

function breakerFor(adapter, opts = {}) {
  return makeBreaker(adapter, { volumeThreshold: 3, errorThresholdPercentage: 50, resetTimeout: 80, ...opts });
}

test('breaker: only retryable failures open; auth never opens', async () => {
  // auth/invalid-request are excluded from the failure budget (fail closed, keep provider up)
  const authBreaker = breakerFor(async () => { throw ERR.auth('bad key'); });
  for (let i = 0; i < 8; i++) {
    await assert.rejects(() => authBreaker.fire());
  }
  assert.equal(authBreaker.state(), BreakerState.CLOSED, 'auth errors must not open the breaker');

  // retryable provider/timeout/rate-limit open it
  const rt = breakerFor(makeFakeAdapter(FakeMode.RATE_LIMIT));
  for (let i = 0; i < 3; i++) await assert.rejects(() => rt.fire('s', {}));
  assert.equal(rt.state(), BreakerState.OPEN, 'rate-limit failures must open the breaker');
});

test('breaker: isRetryableError classifies typed gateway errors correctly', () => {
  assert.equal(isRetryableError(ERR.provider('x')), true);
  assert.equal(isRetryableError(ERR.timeout('x')), true);
  assert.equal(isRetryableError(ERR.rateLimit('x')), true);
  assert.equal(isRetryableError(ERR.auth('x')), false);
  assert.equal(isRetryableError(ERR.badRequest('x')), false);
});

test('breaker: open short-circuits and gateway policy fails closed (never accepts)', async () => {
  const breaker = breakerFor(makeFakeAdapter(FakeMode.RATE_LIMIT));
  const gw = new JevGateway({ evaluateAdapter: breaker.fire, registry });
  // drive it open
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => breaker.fire('s', {}));
  }
  assert.equal(breaker.state(), BreakerState.OPEN);

  // while open, applyPolicy returns deny/unavailable, never accept
  const r = await gw.applyPolicy({ policy: 'completion-claims', state: 'x' });
  assert.equal(r.outcome, 'deny');
  assert.equal(r.coverage, 'incomplete');
  assert.equal(r.unavailable.code, 'EOPENBREAKER', 'open breaker surfaces as typed unavailable');
});

test('breaker: half-open recovery closes on a success', async () => {
  let shouldFail = true;
  const adapter = async () => {
    if (shouldFail) throw ERR.provider('down');
    return { model: 'm', answers: { supported: { type: 'noul', noul: 1 } }, usage: null, latency_ms: 1 };
  };
  const breaker = breakerFor(adapter);
  for (let i = 0; i < 3; i++) await assert.rejects(() => breaker.fire('s', {}));
  assert.equal(breaker.state(), BreakerState.OPEN);
  shouldFail = false; // provider recovers
  await new Promise((r) => setTimeout(r, 130)); // past resetTimeout -> half-open probe
  const res = await breaker.fire('state', {}, {});
  assert.equal(res.model, 'm');
  assert.equal(breaker.state(), BreakerState.CLOSED, 'successful half-open probe closes the breaker');
});

test('breaker: providers are isolated — opening one does not affect another', async () => {
  const good = breakerFor(makeFakeAdapter(FakeMode.SUCCESS));
  const bad = breakerFor(makeFakeAdapter(FakeMode.RATE_LIMIT));
  for (let i = 0; i < 3; i++) await assert.rejects(() => bad.fire('s', {}));
  assert.equal(bad.state(), BreakerState.OPEN);
  assert.equal(good.state(), BreakerState.CLOSED, 'a healthy provider must stay closed');
  const res = await good.fire('state', {}, {});
  assert.equal(res.model, 'fake/jev-1.13');
});
