// Processing-overhead benchmark (item 9).
//
// Measures the GATEWAY'S OWN overhead, never provider latency. Both paths use a
// deterministic no-I/O provider (a fake that returns instantly), so elapsed
// time is pure validation + gate composition + serialization.
//   - direct core:  JevGateway.applyPolicy end to end in-process.
//   - transport:    the full MCP call over in-process Streamable HTTP.
// p95 is reported from a warmed-up sample set (single-shot timings are jittery
// and explicitly avoided). simple-statistics gives the percentile.
import { quantileSorted } from 'simple-statistics';
import { performance } from 'node:perf_hooks';
import { makeFakeAdapter, FakeMode } from '../src/adapters.js';
import { loadRegistry } from '../src/registry.js';
import { JevGateway } from '../src/gateway.js';

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return quantileSorted([...values].sort((a, b) => a - b), p);
}

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (a) => a[Math.floor(a.length / 2)];
  return {
    n: values.length,
    mean_ms: values.reduce((a, b) => a + b, 0) / values.length,
    median_ms: mid(sorted),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    max_ms: sorted[sorted.length - 1],
  };
}

async function bench(fn, { n = 400, warmup = 50 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return summarize(samples);
}

const ARGS = { policy: 'completion-claims', state: 'case::bench evidence' };

/** Direct core overhead: gateway.applyPolicy with an instant, no-I/O provider. */
export async function benchCore(n, warmup) {
  const registry = loadRegistry();
  const gateway = new JevGateway({ evaluateAdapter: makeFakeAdapter(FakeMode.SUCCESS), registry });
  return bench(() => gateway.applyPolicy(ARGS), { n, warmup });
}

/**
 * Transport overhead: a full MCP tool call over in-process stdio transport,
 * exactly like the conformance suite mounts the production surface.
 * ponytail: previously this measured Streamable HTTP; the HTTP/Docker layer was
 * removed (local plugin needs only stdio), so the stdio transport carries the
 * in-process transport benchmark instead.
 */
export async function benchTransport(n, warmup) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const { fileURLToPath } = await import('node:url');
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/stdio.js', import.meta.url))],
    env: { JEV_PROVIDER: 'fake', PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const client = new Client({ name: 'bench', version: '0' });
  await client.connect(t);
  try {
    const run = () => client.callTool({ name: 'jev_apply_policy', arguments: ARGS });
    for (let i = 0; i < (warmup ?? 30); i++) await run();
    const samples = [];
    for (let i = 0; i < (n ?? 200); i++) {
      const t0 = performance.now();
      await run();
      samples.push(performance.now() - t0);
    }
    return summarize(samples);
  } finally {
    await client.close();
    await t.close();
  }
}
