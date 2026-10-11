// Low-cardinality Prometheus metrics for gateway and host-workflow outcomes.
// A private Registry avoids process-global duplicate registration in tests and
// lets each deployed gateway expose exactly its own counters at /metrics.
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

export function makeMetrics() {
  const registry = new Registry();
  const decisions = new Counter({
    name: 'jev_decisions_total',
    help: 'Governed decisions by policy and outcome.',
    labelNames: ['policy', 'outcome', 'mode', 'coverage'],
    registers: [registry],
  });
  const decisionLatency = new Histogram({
    name: 'jev_decision_latency_seconds',
    help: 'Provider-backed decision latency.',
    labelNames: ['policy', 'outcome'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
    registers: [registry],
  });
  const httpRequests = new Counter({
    name: 'jev_http_requests_total',
    help: 'HTTP requests by bounded route and response status.',
    labelNames: ['route', 'status'],
    registers: [registry],
  });
  const inFlight = new Gauge({
    name: 'jev_http_in_flight',
    help: 'MCP requests currently in flight.',
    registers: [registry],
  });
  const workflows = new Counter({
    name: 'jev_host_workflows_total',
    help: 'Host-enforced workflow resolutions by lifecycle boundary.',
    labelNames: ['policy', 'boundary', 'gate', 'resolution'],
    registers: [registry],
  });
  const retries = new Counter({
    name: 'jev_host_retry_cost_total',
    help: 'Host-reported retry cost units after a governed decision.',
    labelNames: ['policy', 'boundary'],
    registers: [registry],
  });
  const falseAcceptSeverity = new Histogram({
    name: 'jev_false_accept_severity',
    help: 'Host-reported severity of accepted decisions later found incorrect (0..1).',
    labelNames: ['policy', 'boundary'],
    buckets: [0, 0.1, 0.25, 0.5, 0.75, 1],
    registers: [registry],
  });

  return {
    recordDecision({ policy = 'advisory', outcome, mode = 'n/a', coverage = 'unknown', latency_ms }) {
      decisions.inc({ policy, outcome, mode, coverage });
      if (Number.isFinite(latency_ms)) decisionLatency.observe({ policy, outcome }, latency_ms / 1000);
    },
    recordHttp(route, status) {
      httpRequests.inc({ route, status: String(status) });
    },
    changeInFlight(delta) {
      delta > 0 ? inFlight.inc(delta) : inFlight.dec(Math.abs(delta));
    },
    recordWorkflow({ policy, boundary, gate, resolution, retry_cost = 0, false_accept_severity = null }) {
      const boundedResolution = RESOLUTIONS.has(resolution) ? resolution : 'unknown';
      workflows.inc({ policy, boundary, gate, resolution: boundedResolution });
      if (Number.isFinite(retry_cost) && retry_cost > 0) retries.inc({ policy, boundary }, retry_cost);
      if (gate === 'accept' && Number.isFinite(false_accept_severity)) {
        falseAcceptSeverity.observe({ policy, boundary }, Math.max(0, Math.min(1, false_accept_severity)));
      }
    },
    render: () => registry.metrics(),
    contentType: registry.contentType,
    registry,
  };
}

const RESOLUTIONS = new Set(['approved', 'rejected', 'retried', 'corrected', 'executed', 'stopped', 'execution_error', 'unknown']);
