// Telemetry canary (item 3): the allowlist redaction is proven end to end — a
// secret-looking payload passed as a forbidden field must never appear in the
// bytes actually written to the sink, while sanctioned operator fields do.
import { test } from 'node:test';
import assert from 'node:assert';
import { Writable } from 'node:stream';
import { makeTelemetry } from '../src/telemetry.js';
import { makeFakeAdapter, FakeMode } from '../src/adapters.js';
import { loadRegistry } from '../src/registry.js';
import { JevGateway } from '../src/gateway.js';

function captureSink() {
  const chunks = [];
  const sink = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  return { sink, text: () => chunks.join('') };
}

const CANARY = 'sk-canary-7f3a9c2e-4f1b-4a1e-9c3a-1b2e3d4f5a6b';

test('canary: forbidden fields and secret values never reach the sink', async () => {
  const { sink, text } = captureSink();
  const tel = makeTelemetry({ destination: sink });
  tel.record({
    event: 'apply_policy', correlation_id: 'corr-1', policy: 'completion-claims', gate: 'accept',
    // forbidden fields containing a canary secret + raw state
    state: { secret: CANARY }, questions: { q: 'what' }, answers: [{ a: CANARY }],
    api_key: CANARY, token: CANARY, payload: CANARY,
  });
  await new Promise((r) => setImmediate(r));
  const out = text();
  assert.ok(!out.includes(CANARY), 'canary secret leaked into telemetry output');
  for (const k of ['state', 'questions', 'answers', 'api_key', 'token', 'payload']) {
    assert.ok(!out.includes(`"${k}"`), `forbidden field ${k} appeared in telemetry`);
  }
  assert.ok(out.includes('"correlation_id":"corr-1"'), 'sanctioned correlation_id missing');
  assert.ok(out.includes('"policy":"completion-claims"'), 'sanctioned policy missing');
  assert.ok(out.includes('"gate":"accept"'), 'sanctioned gate missing');
});

test('canary: gateway integration leaks nothing and records operator fields', async () => {
  const { sink, text } = captureSink();
  const tel = makeTelemetry({ destination: sink });
  const registry = loadRegistry();
  const gw = new JevGateway({
    evaluateAdapter: makeFakeAdapter(FakeMode.SUCCESS), registry,
    telemetry: tel, provider: 'openrouter', breakerState: () => 'closed',
  });
  await gw.applyPolicy({
    policy: 'completion-claims',
    state: { claims: ['pass'], evidence: 'pytest: 1 passed' },
    correlation: { request_id: 'req-42' },
  });
  await new Promise((r) => setImmediate(r));
  const out = text();
  assert.ok(!out.includes('pytest'), 'state payload leaked');
  assert.ok(!out.includes('1 passed'), 'state payload leaked');
  for (const k of ['resolved_model', 'gate', 'policy', 'calibration_status', 'breaker_state', 'correlation_id']) {
    assert.ok(out.includes(`"${k}"`), `operator field ${k} not recorded`);
  }
});

test('telemetry: record returns only allowlisted fields regardless of input', () => {
  const { sink } = captureSink();
  const tel = makeTelemetry({ destination: sink });
  const safe = tel.record({ correlation_id: 'c', provider: 'p', secret: CANARY, state: 'x' });
  assert.deepEqual(safe, { correlation_id: 'c', provider: 'p' });
});
