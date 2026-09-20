// Gateway core: limits, runtime flags (kill switch), typed error classes.
// Deterministic, importable offline. No provider, no I/O, no secrets.

export const LIMITS = Object.freeze({
  maxStateBytes: 32 * 1024, // oversized requests are rejected, never truncated
  maxQuestions: 16,
  maxChoicesPerQuestion: 64,
  deadlineMs: 15_000,
  maxLatencyMs: 8_000,
  maxRetries: 2,
});

/** Typed gateway errors, classified for telemetry and fail-safe routing. */
export class GatewayError extends Error {
  constructor(message, { code = 'ERR_INTERNAL', category = 'invalid-request', retryable = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.category = category;
    this.retryable = retryable;
  }
}

export const ERR = Object.freeze({
  killSwitched: (m) => new GatewayError(m, { code: 'ERR_KILL_SWITCH', category: 'unavailable', retryable: false }),
  oversized: (m) => new GatewayError(m, { code: 'ERR_TOO_LARGE', category: 'invalid-request', retryable: false }),
  badRequest: (m) => new GatewayError(m, { code: 'ERR_BAD_REQUEST', category: 'invalid-request', retryable: false }),
  noMatch: (m) => new GatewayError(m, { code: 'ERR_NO_MATCH', category: 'no-match', retryable: false }),
  provider: (m, retryable = true) => new GatewayError(m, { code: 'ERR_PROVIDER', category: 'provider', retryable }),
  malformed: (m) => new GatewayError(m, { code: 'ERR_MALFORMED_RESPONSE', category: 'provider', retryable: true }),
  timeout: (m) => new GatewayError(m, { code: 'ERR_TIMEOUT', category: 'timeout', retryable: true }),
  rateLimit: (m) => new GatewayError(m, { code: 'ERR_RATE_LIMIT', category: 'rate-limit', retryable: true }),
  auth: (m) => new GatewayError(m, { code: 'ERR_AUTH', category: 'auth', retryable: false }),
  missingAnswer: (m) => new GatewayError(m, { code: 'ERR_MISSING_ANSWER', category: 'malformed', retryable: false }),
  foreignChoice: (m) => new GatewayError(m, { code: 'ERR_FOREIGN_CHOICE', category: 'malformed', retryable: false }),
  badGate: (m) => new GatewayError(m, { code: 'ERR_FOREIGN_CHOICE', category: 'malformed', retryable: false }),
});

// Runtime flags are module state by intent: a kill switch must be server-wide.
let killSwitched = false;
const killGlobalExemptId = new Set();

export function killSwitchGlobal() { killSwitched = true; }
export function killSwitchPolicy(id) { killGlobalExemptId.add(id); }
export function isKillSwitched(policyId) {
  // A per-policy kill switch takes the policy out of service; a global switch
  // takes everything out unless a policy is explicitly exempted.
  if (killGlobalExemptId.has(policyId)) return false;
  return killSwitched;
}
export function resetRuntime() { killSwitched = false; killGlobalExemptId.clear(); }

export function stateBytes(s) {
  if (typeof s === 'string') return Buffer.byteLength(s, 'utf8');
  const txt = JSON.stringify(s);
  return Buffer.byteLength(txt, 'utf8');
}
