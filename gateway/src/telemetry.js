// Structured telemetry with a default Pino JSONL sink on **stderr**.
//
// stderr (never stdout) is a hard rule: the stdio MCP transport owns stdout for
// JSON-RPC, so any log line there corrupts the protocol. Redaction is an
// allowlist, not a blocklist: `record()` emits only the explicitly named fields
// and silently drops everything else, so a caller can never leak state,
// questions, answers, or API keys regardless of what object it passes in. The
// canary test in telemetry-canary.test.mjs scans both the returned record shape
// and the bytes actually written to the sink with secret-looking values.
//
// OpenTelemetry is deliberately not forced in: the task scopes telemetry to one
// tiny structured interface (correlation id, tool/provider/model, policy
// metadata, latency, cost when present, gate, error class, breaker state).
// Pino satisfies that without an agent, a collector contract, or a heavier
// dependency tree. See docs/research/issue-1-prior-art.md.
import pino from 'pino';

// The entire telemetry field surface. Only these top-level keys survive
// `record()`. Adding a field here is the explicit act of choosing to transmit
// it; secret/state payloads have no key on this list.
const ALLOWLIST = new Set([
  'ts', 'level', 'event', 'correlation_id',
  'tool', 'provider', 'resolved_model',
  'policy', 'policy_version', 'mode', 'calibration_status', 'evaluation_dataset_version',
  'latency_ms', 'usage_tokens_input', 'usage_tokens_output', 'estimated_cost',
  'coverage', 'gate', 'shadow_outcome', 'error_class', 'error_code', 'breaker_state',
  'eval_id', 'eval_dataset', 'eval_correct', 'eval_duration_ms',
]);

const LEVEL_ORDER = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function clampLevel(level) {
  return LEVEL_ORDER.includes(level) ? level : 'info';
}

/**
 * @param {object} [opts]
 * @param {import('stream').Writable} [opts.destination=process.stderr]
 * @param {string} [opts.level=info]
 * @returns {{
 *   record:(fields:object)=>object,
 *   child:(bindings:object)=>{record:(fields:object)=>object},
 *   close:()=>void
 * }}
 */
export function makeTelemetry(opts = {}) {
  const destination = opts.destination ?? process.stderr;
  const level = clampLevel(opts.level);
  // `base: undefined` drops pid/hostname noise; `isoTime` gives a scan-friendly
  // timestamp. The destination is stderr so stdio stdout stays protocol-clean.
  const logger = pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, destination);

  // Allowlist: pick only explicitly sanctioned fields, in stable order.
  function safeRecord(fields) {
    const safe = {};
    for (const k of ALLOWLIST) {
      if (Object.prototype.hasOwnProperty.call(fields ?? {}, k)) safe[k] = fields[k];
    }
    return safe;
  }

  function record(fields) {
    const safe = safeRecord(fields);
    logger.info(safe);
    return safe;
  }

  return {
    record,
    child: (bindings) => ({
      record: (fields) => record({ ...(bindings ?? {}), ...(fields ?? {}) }),
    }),
    close: () => logger[Symbol.for('pino.flush')]?.(),
  };
}
