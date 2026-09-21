import test from 'node:test';
import assert from 'node:assert';
import { makeMetrics } from '../src/metrics.js';

test('metrics: decision and end-to-end workflow signals render with bounded labels', async () => {
  const metrics = makeMetrics();
  metrics.recordDecision({ policy: 'completion-claims', outcome: 'review', mode: 'shadow', coverage: 'complete', latency_ms: 12 });
  metrics.recordWorkflow({
    policy: 'completion-claims', boundary: 'before_finish', gate: 'accept', resolution: 'approved',
    retry_cost: 2, false_accept_severity: 0.4,
  });
  const text = await metrics.render();
  assert.match(text, /jev_decisions_total\{policy="completion-claims",outcome="review",mode="shadow",coverage="complete"\} 1/);
  assert.match(text, /jev_host_retry_cost_total/);
  assert.match(text, /jev_false_accept_severity/);
});
