// Deployment config and gateway wiring. Keys are read from files configured by
// env, never passed as tool arguments and never logged.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killSwitchGlobal, killSwitchPolicy } from './core.js';
import { loadRegistry } from './registry.js';
import { makeFakeAdapter, FakeMode, makeLayaAdapter, makeOpenrouterAdapter, makeTypesafeAdapter } from './adapters.js';
import { JevGateway } from './gateway.js';
import { makeBreaker } from './breaker.js';
import { makeTelemetry } from './telemetry.js';
import { makeMetrics } from './metrics.js';

export const DEFAULTS = Object.freeze({
  provider: process.env.JEV_PROVIDER ?? 'openrouter',
  model: process.env.JEV_MODEL ?? 'typesafe/jev-1.13',
  apiKeyFile: process.env.JEV_API_KEY_FILE ?? path.join(os.homedir(), '.creds', 'kv', 'OPENROUTER_API_KEY.txt'),
  fakeMode: process.env.JEV_FAKE_MODE ?? FakeMode.SUCCESS,
  killSwitch: (process.env.JEV_KILL_SWITCH ?? '') === '1',
  registryDir: process.env.JEV_POLICY_DIR ?? null,
  // Structured telemetry: JSONL to stderr by default (never stdout). Set
  // JEV_TELEMETRY=off to silence, JEV_TELEMETRY_LEVEL=warn to dampen.
  telemetry: (process.env.JEV_TELEMETRY ?? 'on') !== 'off',
  telemetryLevel: process.env.JEV_TELEMETRY_LEVEL ?? 'info',
  // Circuit breaker (opossum) tuning — see operations runbook for guidance.
  breaker: Object.freeze({
    errorThresholdPercentage: Number(process.env.JEV_BREAKER_ERROR_THRESHOLD ?? 60),
    volumeThreshold: Number(process.env.JEV_BREAKER_VOLUME ?? 5),
    resetTimeout: Number(process.env.JEV_BREAKER_RESET_MS ?? 30_000),
  }),
});

function readKey(file) {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function buildGateway(cfg = {}) {
  cfg = { ...DEFAULTS, ...cfg }; // merges over defaults; env spread may override
  if (cfg.killSwitch) killSwitchGlobal();
  const registry = loadRegistry(cfg.registryDir);
  const fake = cfg.fakeMode === FakeMode.SUCCESS
    ? makeFakeAdapter(FakeMode.SUCCESS)
    : () => { throw new Error('invalid fake mode'); };

  let rawAdapter;
  if (cfg.provider === 'fake') {
    rawAdapter = fake;
  } else if (cfg.provider === 'laya') {
    // Laya is local and needs no credential. Dual-channel: Laya answers the
    // request directly; on any Laya failure (load timeout while the bundle
    // warms, throw, breaker open) the OpenRouter adapter retries once. A Laya
    // result is used as-is (its answers can still be malformed → the gateway's
    // per-question validation rejects them, exactly as for a remote provider).
    // The whole rawAdapter sits inside the breaker, so a throwing Laya opens
    // the breaker — open state then short-circuits the next call straight to
    // the fallback until the breaker closes. Both channels share the gateway's
    // total deadline; the Laya attempt spends part of it on load, the fallback
    // the rest.
    const layaAdapter = makeLayaAdapter();
    const key = readKey(cfg.apiKeyFile);
    const fallback = key ? makeOpenrouterAdapter({ apiKey: key, model: cfg.model }) : null;
    rawAdapter = async (state, questions, opts = {}) => {
      try {
        return await layaAdapter(state, questions, opts);
      } catch (err) {
        if (!fallback) {
          // No usable OpenRouter key (checked at startup; a missing file makes
          // fallback null) → Laya is the only channel; surface its failure so
          // the gateway fail-closes like any other provider error.
          throw err;
        }
        // OpenRouter failing here → the gateway sees the (classified) error
        // and fail-closes exactly as today.
        return fallback(state, questions, opts);
      }
    };
  } else {
    const key = readKey(cfg.apiKeyFile);
    if (cfg.provider === 'typesafe') {
      rawAdapter = key ? makeTypesafeAdapter({ apiKey: key, model: cfg.model }) : null;
    } else {
      rawAdapter = key ? makeOpenrouterAdapter({ apiKey: key, model: cfg.model }) : null;
    }
  }
  if (!rawAdapter) {
    // Fail closed, not silent: a gateway without a provider cannot promise a
    // real judgment, so remote/stdio installs must supply one. Tests use 'fake'.
    throw new Error(`provider ${cfg.provider} has no usable credential (checked ${cfg.apiKeyFile})`);
  }
  // One breaker per provider, process-wide: every request on this gateway routes
  // through it. Only retryable provider/timeout/rate-limit failures open it;
  // auth/invalid-request fail closed for the caller but never take the provider
  // offline (see src/breaker.js).
  const breaker = makeBreaker(rawAdapter, cfg.breaker);
  const telemetry = cfg.telemetry
    ? makeTelemetry({ level: cfg.telemetryLevel, destination: process.stderr })
    : undefined;
  const metrics = cfg.metrics ?? makeMetrics();
  const gw = new JevGateway({
    evaluateAdapter: breaker.fire,
    policyAdapter: breaker.fire,
    registry,
    telemetry,
    provider: cfg.provider,
    breakerState: breaker.state,
    metrics,
  });
  // Wire a global control handle for operators/admins via env at startup.
  return {
    gateway: gw, registry, cfg, breaker, telemetry, metrics,
    readiness: () => ({
      ready: breaker.state() !== 'open',
      provider: cfg.provider,
      breaker_state: breaker.state(),
      policy_count: registry.ids().length,
    }),
  };
}

export { FakeMode };
