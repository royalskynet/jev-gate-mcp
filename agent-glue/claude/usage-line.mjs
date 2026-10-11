/**
 * One line of `~/.jevgate/usage.jsonl`: who spent a Jev call, on what model,
 * with what HTTP status, how many tokens and how long. Exists because the Zen
 * free quota ran out on 2026-10-04 and only the gateway path left a trace.
 *
 * Pure and hook-safe (no Node global, no `$`): the hook files and the Node
 * writer (`../src/usage-ledger.js`) both build their line here, so the field
 * list is one place. The record is an allowlist — never a prompt, a state, a
 * response body, a key or a URL.
 */

const text = (v) => (v == null ? null : String(v).slice(0, 80));
const count = (v) => (Number.isFinite(v) ? v : null);

/** The allowlisted record; anything else passed in is dropped. */
export function usageRecord({ caller, model, status, input_tokens, output_tokens, latency_ms } = {}, ts = new Date().toISOString()) {
  return {
    ts,
    caller: text(caller) ?? 'unknown',
    model: text(model),
    status: Number.isFinite(status) ? status : text(status ?? 'error'),
    input_tokens: count(input_tokens),
    output_tokens: count(output_tokens),
    latency_ms: count(latency_ms),
  };
}

/**
 * Where a hook module writes, or null when JEV_USAGE_LOG is `off`. Not the
 * shared file: `$.fs` has no append, and its read rejects past 4 MiB, so a
 * read-then-write on one growing file would one day truncate every Node line.
 * A per-day file next to it stays far under that (~24k calls/day).
 * ponytail: read-then-write can lose a line when two sessions write the same
 * instant; an `$.fs.append` would fix it if the engine ever grows one.
 */
export function hookUsageFile(env, isoTs) {
  if (env.JEV_USAGE_LOG === 'off') return null;
  const shared = env.JEV_USAGE_LOG || `${env.HOME || env.USERPROFILE}/.jevgate/usage.jsonl`;
  return `${shared.slice(0, shared.lastIndexOf('/'))}/usage-hook-${isoTs.slice(0, 10)}.jsonl`;
}

/** `{ input_tokens, output_tokens }` from a System One response body, nulls if absent. */
export function tokensOf(body) {
  try {
    const usage = JSON.parse(body)?.usage;
    return { input_tokens: count(usage?.input_tokens), output_tokens: count(usage?.output_tokens) };
  } catch {
    return { input_tokens: null, output_tokens: null };
  }
}

/** The `model` a request body asked for, or null. Reads nothing else from it. */
export function modelOf(body) {
  try {
    const model = JSON.parse(body)?.model;
    return typeof model === 'string' ? model : null;
  } catch {
    return null;
  }
}
