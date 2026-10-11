// Deployment config and gateway wiring. Keys are read from files configured by
// env, never passed as tool arguments and never logged.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killSwitchGlobal, killSwitchPolicy } from './core.js';
import { loadRegistry } from './registry.js';
import { makeFakeAdapter, FakeMode, makeLayaAdapter, makeOpenrouterAdapter, makeTypesafeAdapter, makeZenAdapter } from './adapters.js';
import { JevGateway } from './gateway.js';
import { makeBreaker } from './breaker.js';
import { makeTelemetry } from './telemetry.js';
import { makeMetrics } from './metrics.js';
import { makeLayaRouter } from './laya-routing.js';
import { withTeacherCorpus } from './teacher-corpus.js';
import { withRedaction } from './redact.js';

export const DEFAULTS = Object.freeze({
  provider: process.env.JEV_PROVIDER ?? 'zen',
  model: process.env.JEV_MODEL ?? 'jev-1.13-free',
  apiKeyFile: process.env.JEV_API_KEY_FILE ?? path.join(os.homedir(), '.creds', 'kv', 'OPENCODE_ZEN_API_KEY.txt'),
  // Which cloud provider backs the laya router's fallback / the policy
  // adapter. `null` keeps the legacy behaviour: infer from the key file's
  // basename (TYPESAFE_ -> native TypeSafe, anything else -> OpenRouter).
  // Set it explicitly (e.g. `zen`) when that inference cannot express the
  // provider you actually want, so a Zen key is never built against
  // OpenRouter's host.
  fallbackProvider: process.env.JEV_FALLBACK_PROVIDER ?? null,
  // OpenRouter key that backs Zen during its free-quota cooldown. A missing
  // file just means no backup (Zen failures then fail closed as before).
  zenBackupKeyFile: process.env.JEV_ZEN_BACKUP_KEY_FILE ?? path.join(os.homedir(), '.creds', 'kv', 'OPENROUTER_SECOND_API_KEY.txt'),
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

function makeZen(cfg, key) {
  const backupKey = readKey(cfg.zenBackupKeyFile);
  return makeZenAdapter({ apiKey: key, model: cfg.model, backup: backupKey ? makeOpenrouterAdapter({ apiKey: backupKey }) : null });
}

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

  // Telemetry sink is created before the adapters so the Laya router can
  // emit route/fallback events (no credentials ever go
  // near it — the allowlist in telemetry.js drops anything not named).
  const telemetry = cfg.telemetry
    ? makeTelemetry({ level: cfg.telemetryLevel, destination: process.stderr })
    : undefined;
  let rawAdapter;
  let policyAdapter;
  let policyProvider;
  if (cfg.provider === 'fake') {
    rawAdapter = fake;
  } else if (cfg.provider === 'laya') {
    // Only fixed, short advisory classifications may use local weights.
    // Injection is internal JS wiring for offline tests, never MCP arguments.
    const layaAdapter = cfg.layaAdapter ?? makeLayaAdapter({ modelDir: cfg.layaModelDir });
    const key = readKey(cfg.apiKeyFile);
    // Pick the fallback adapter by the key's type. Inferred from the file
    // basename, never the value: a typesafe key hitting the OpenRouter
    // endpoint 401s (fix 9708 class), so a TYPESAFE_ key uses the native
    // TypeSafe adapter and everything else the OpenRouter adapter. An explicit
    // JEV_FALLBACK_PROVIDER overrides the inference — the basename heuristic
    // has no way to say "zen", whose key is an OpenCode key served from a
    // third System One host.
    const base = path.basename(cfg.apiKeyFile).toUpperCase();
    const keyType = cfg.fallbackProvider
      ?? (base.includes('TYPESAFE') ? 'typesafe' : base.includes('OPENCODE') ? 'zen' : 'openrouter');
    policyProvider = keyType;
    const fallback = cfg.jevAdapter ?? (key
      ? (keyType === 'typesafe'
        ? makeTypesafeAdapter({ apiKey: key, model: cfg.model })
        : keyType === 'zen'
          ? makeZen(cfg, key)
          : makeOpenrouterAdapter({ apiKey: key, model: cfg.model }))
      : null);
    policyAdapter = fallback ?? (async () => { throw new Error('Jev policy provider has no configured credential'); });
    // Any answer this provider gives is the teacher the local weights get
    // distilled against later, so every cloud answer is recorded. A request
    // the router keeps entirely local never reaches here and so contributes
    // no teacher row — that is also what makes it free.
    // No credential -> keep it null: wrapping null yields a function that only
    // fails at call time ("adapter is not a function") and hides the router's
    // own `!cloud` credential error.
    const teacher = !fallback || cfg.teacherCorpus === false ? fallback : withTeacherCorpus(fallback, cfg.recordTeacherSample);
    rawAdapter = makeLayaRouter({ local: layaAdapter, cloud: teacher,
      record: cfg.recordRoutingSample, qtypes: cfg.layaQtypes,
      onRoute: ({ local, cloud, fallback: count }) => telemetry?.record({
        event: count ? 'laya_fallback' : 'provider_route',
        provider: local && cloud ? 'hybrid' : local ? 'laya' : keyType,
      }),
    });
  } else {
    const key = readKey(cfg.apiKeyFile);
    let adapter = null;
    if (cfg.provider === 'typesafe') {
      adapter = key ? makeTypesafeAdapter({ apiKey: key, model: cfg.model }) : null;
    } else if (cfg.provider === 'zen') {
      adapter = key ? makeZen(cfg, key) : null;
    } else {
      adapter = key ? makeOpenrouterAdapter({ apiKey: key, model: cfg.model }) : null;
    }
    // The provider is the only decider here, which makes it the only teacher.
    // policyAdapter stays unset: the single breaker below already covers it.
    rawAdapter = adapter && cfg.teacherCorpus === false
      ? adapter
      : (adapter ? withTeacherCorpus(adapter, cfg.recordTeacherSample) : null);
  }
  if (!rawAdapter) {
    // Fail closed, not silent: a gateway without a provider cannot promise a
    // real judgment, so remote/stdio installs must supply one. Tests use 'fake'.
    throw new Error(`provider ${cfg.provider} has no usable credential (checked ${cfg.apiKeyFile})`);
  }
  // Mask secrets before any provider, Laya or corpus sees the state (src/redact.js).
  rawAdapter = withRedaction(rawAdapter);
  if (policyAdapter) policyAdapter = withRedaction(policyAdapter);
  // One breaker per provider, process-wide: every request on this gateway routes
  // through it. Only retryable provider/timeout/rate-limit failures open it;
  // auth/invalid-request fail closed for the caller but never take the provider
  // offline (see src/breaker.js).
  const breaker = makeBreaker(rawAdapter, cfg.breaker);
  // A failed local load must never divert a pinned policy to local weights.
  const policyBreaker = policyAdapter ? makeBreaker(policyAdapter, cfg.breaker) : breaker;
  const metrics = cfg.metrics ?? makeMetrics();
  const gw = new JevGateway({
    evaluateAdapter: breaker.fire,
    policyAdapter: policyBreaker.fire,
    registry,
    telemetry,
    provider: cfg.provider,
    policyProvider,
    breakerState: breaker.state,
    policyBreakerState: policyBreaker.state,
    metrics,
  });
  // Wire a global control handle for operators/admins via env at startup.
  return {
    gateway: gw, registry, cfg, breaker, telemetry, metrics,
    readiness: () => ({
      ready: breaker.state() !== 'open' && policyBreaker.state() !== 'open',
      provider: cfg.provider,
      breaker_state: breaker.state(),
      policy_breaker_state: policyBreaker.state(),
      policy_count: registry.ids().length,
    }),
  };
}

export { FakeMode };
