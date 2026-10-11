#!/usr/bin/env node
// Processing-overhead benchmark CLI. Reports direct core and transport p95
// separately and exits non-zero if the p95 <50ms requirement is not met.
import { benchCore, benchTransport } from '../lib/bench.mjs';

const LIMIT_MS = 50;
const core = await benchCore();
const transport = await benchTransport();
const report = { limit_ms: LIMIT_MS, direct_core_ms: core, transport_ms: transport };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

const ok = core.p95_ms < LIMIT_MS && transport.p95_ms < LIMIT_MS;
if (!ok) {
  process.stderr.write(`FAIL: p95 must be < ${LIMIT_MS}ms (core=${core.p95_ms.toFixed(3)}, transport=${transport.p95_ms.toFixed(3)})\n`);
  process.exit(1);
}
process.stderr.write(`bench OK: core p95=${core.p95_ms.toFixed(3)}ms, transport p95=${transport.p95_ms.toFixed(3)}ms (<${LIMIT_MS}ms)\n`);
