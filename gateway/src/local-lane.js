// JEV_PROVIDER=laya wiring: local Laya weights first, the configured Jev
// provider as fallback and teacher. Loaded optionally by config.js.
import path from 'node:path';
import { makeLayaAdapter } from './laya-adapter.js';
import { makeLayaRouter } from './laya-routing.js';

export function buildLayaProvider(cfg, { readKey, makeZen, makeTypesafeAdapter, makeOpenrouterAdapter, withTeacherCorpus, telemetry }) {
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
  const policyProvider = keyType;
  const fallback = cfg.jevAdapter ?? (key
    ? (keyType === 'typesafe'
      ? makeTypesafeAdapter({ apiKey: key, model: cfg.model })
      : keyType === 'zen'
        ? makeZen(cfg, key)
        : makeOpenrouterAdapter({ apiKey: key, model: cfg.model }))
    : null);
  const policyAdapter = fallback ?? (async () => { throw new Error('Jev policy provider has no configured credential'); });
  // Any answer this provider gives is the teacher the local weights get
  // distilled against later, so every cloud answer is recorded. A request
  // the router keeps entirely local never reaches here and so contributes
  // no teacher row — that is also what makes it free.
  // No credential -> keep it null: wrapping null yields a function that only
  // fails at call time ("adapter is not a function") and hides the router's
  // own `!cloud` credential error.
  const teacher = !fallback || cfg.teacherCorpus === false ? fallback : withTeacherCorpus(fallback, cfg.recordTeacherSample);
  const rawAdapter = makeLayaRouter({ local: layaAdapter, cloud: teacher,
    record: cfg.recordRoutingSample, qtypes: cfg.layaQtypes,
    onRoute: ({ local, cloud, fallback: count }) => telemetry?.record({
      event: count ? 'laya_fallback' : 'provider_route',
      provider: local && cloud ? 'hybrid' : local ? 'laya' : keyType,
    }),
  });
  return { rawAdapter, policyAdapter, policyProvider };
}
