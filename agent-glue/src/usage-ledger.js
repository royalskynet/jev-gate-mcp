/**
 * Node writer for `~/.jevgate/usage.jsonl` (override: JEV_USAGE_LOG, `off`
 * disables). One line per outbound Jev/Zen/OpenRouter call, success or not,
 * so a spent quota can be traced to its caller. The line itself is built by
 * `../claude/usage-line.mjs` — an allowlist, never content.
 *
 * Hook modules cannot import this (no Node there); they write the same line
 * through their own `$.fs` to `usage-hook-<date>.jsonl` beside this file (see
 * hookUsageFile). Count both: `cat ~/.jevgate/usage*.jsonl`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename, extname } from 'node:path';
import { usageRecord, tokensOf, modelOf } from '../claude/usage-line.mjs';

/** Read at call time so tests and hosts can redirect per run. */
export function usageFile(env = process.env) {
  return env.JEV_USAGE_LOG ?? join(homedir(), '.jevgate', 'usage.jsonl');
}

/** Append one usage line. Never throws; returns whether it wrote. */
export function logUsage(rec, file = usageFile()) {
  try {
    if (!file || file === 'off') return false;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify(usageRecord(rec)) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * `base:<who>` where <who> is JEV_USAGE_CALLER (set by the parent, e.g. the
 * Hermes plugins) or, when `fromArgv`, the running script's name — which is
 * how a gateway built in-process by jev-route / the probe / the MCP stdio
 * server tells itself apart without any config.
 */
export function callerName(base, { fromArgv = false, env = process.env } = {}) {
  const who = env.JEV_USAGE_CALLER
    || (fromArgv && process.argv[1] ? basename(process.argv[1], extname(process.argv[1])) : '');
  return who ? `${base}:${who}` : base;
}

/**
 * Wrap a WHATWG fetch so every call leaves one usage line, including 429s and
 * thrown network errors. `fetchImpl` is resolved per call so a later stub of
 * globalThis.fetch is still the one used.
 */
export function meteredFetch(caller, fetchImpl) {
  return async (url, init) => {
    const started = Date.now();
    const model = modelOf(init?.body);
    let res;
    try {
      res = await (fetchImpl ?? globalThis.fetch)(url, init);
    } catch (e) {
      logUsage({ caller, model, status: 'error', latency_ms: Date.now() - started });
      throw e;
    }
    let tokens = {};
    try {
      if (typeof res?.clone === 'function') tokens = tokensOf(await res.clone().text());
    } catch { /* tokens are optional */ }
    logUsage({ caller, model, status: res?.status, ...tokens, latency_ms: Date.now() - started });
    return res;
  };
}
