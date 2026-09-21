// Circuit breaker: one shared, process-wide breaker per provider.
//
// The breaker exists so a flaky provider cannot stall agents indefinitely and
// cannot turn a healthy policy into a string of fabricated judgments. A provider
// call is wrapped once at wiring time (config.js) and every gateway request on
// that provider routes through the same instance, so open/half-open/closed is
// observable and short-circuits make subsequent calls cheap.
//
// Which failures open the breaker is the trust boundary here. opossum@9's
// `errorFilter` semantics (verified from its source, circuit.js:944): returning
// true filters the error OUT (counted as a success, never opens); returning
// false counts it as a failure. We want ONLY retryable provider / timeout /
// rate-limit failures to open it, so we filter out (return true) everything
// else — auth and invalid-request errors fail closed for the caller but are
// deliberately excluded from the breaker's failure budget. A breaker that
// opened on auth would take the whole provider offline on one bad key, which
// is the wrong signal.
//
// ponytail: half-open recovery and the failure thresholds are delegated to the
// mature library (opossum) rather than reimplemented. Tuning knobs live in
// `opts`; if a provider needs per-provider sensitivity, pass distinct
// threshold/reset values at wiring time.
import CircuitBreaker from 'opossum';
import { LIMITS } from './core.js';

/** True for failures that should open the breaker: retryable provider, timeout,
 *  rate-limit. Auth and invalid-request are excluded (fail closed, never open). */
export function isRetryableError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.retryable === true) return true;
  const cat = e.category;
  return cat === 'provider' || cat === 'timeout' || cat === 'rate-limit';
}

export const BreakerState = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' });

/**
 * Wrap a provider action in one opossum breaker.
 * @param {(state, questions, opts)=>Promise} action the raw provider call
 * @param {object} [opts]
 * @param {number} [opts.errorThresholdPercentage=60]
 * @param {number} [opts.volumeThreshold=5] minimum calls before the breaker evaluates
 * @param {number} [opts.resetTimeout=30000] ms in open state before half-open probe
 * @param {number} [opts.rollingCountTimeout=30000] rolling window
 * @returns {{fire,state,stats,on,circuit}}
 */
export function makeBreaker(action, opts = {}) {
  const circuit = new CircuitBreaker(action, {
    errorThresholdPercentage: opts.errorThresholdPercentage ?? 60,
    volumeThreshold: opts.volumeThreshold ?? 5,
    resetTimeout: opts.resetTimeout ?? 30_000,
    rollingCountTimeout: opts.rollingCountTimeout ?? 30_000,
    timeout: false, // the total deadline is owned by the caller/gateway, not here
    // v9 semantics: return true => filter out (not a failure); false => failure.
    errorFilter: (e) => !isRetryableError(e),
  });
  // Map opossum's toJSON().state booleans to a stable string for telemetry.
  function state() {
    const s = circuit.toJSON().state;
    if (s.open) return BreakerState.OPEN;
    if (s.halfOpen) return BreakerState.HALF_OPEN;
    return BreakerState.CLOSED;
  }
  return {
    fire: circuit.fire.bind(circuit),
    state,
    stats: () => circuit.stats,
    on: circuit.on.bind(circuit),
    circuit,
    limitMs: LIMITS.deadlineMs,
  };
}
