// Processing-overhead benchmark (item 9): p95 < 50ms for BOTH direct core and
// transport, measured with a deterministic no-I/O provider (provider latency is
// never in the sample). Uses warmup + many samples to avoid jittery one-offs.
import { test } from 'node:test';
import assert from 'node:assert';
import { benchCore, benchTransport } from '../lib/bench.mjs';

const LIMIT_MS = 50;

test('bench: direct core processing overhead p95 < 50ms', async () => {
  const r = await benchCore(300, 40);
  assert.ok(r.p95_ms < LIMIT_MS, `core p95 ${r.p95_ms.toFixed(3)}ms >= ${LIMIT_MS}ms`);
});

test('bench: full transport overhead p95 < 50ms', async () => {
  const r = await benchTransport(150, 20);
  assert.ok(r.p95_ms < LIMIT_MS, `transport p95 ${r.p95_ms.toFixed(3)}ms >= ${LIMIT_MS}ms`);
});

test('bench: importing the bench harness opts its process out of the corpus', async () => {
  // The earlier 10,200 fixture samples in the live sink came from this harness
  // running with collection on. The sink refuses fake samples by itself; this
  // pins the second line of defence, which also covers a named corpus path.
  const { calibrationPath } = await import('../src/calibration.js');
  assert.equal(calibrationPath(), null, 'bench.mjs must set JEV_CALIBRATION_LOG=off on import');
});
