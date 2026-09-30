import { readFileSync } from 'node:fs';
import { JevDecisionModel } from 'jevwire';

const RAW_CONFIG = (await import('../config.default.json', { with: { type: 'json' } })).default;
// ponytail: static import path keeps config colocated; replace with a real config loader if a CLI override is ever wanted.
// ponytail: expand ${VAR} in string values so config.default.json stays portable across machines.
const expandEnv = (v) => typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '') : v;
export const DEFAULT_CONFIG = Object.fromEntries(Object.entries(RAW_CONFIG).map(([k, v]) => [k, expandEnv(v)]));

export function loadKey(file, cfgKey = 'apiKeyFile') {
  const path = DEFAULT_CONFIG[cfgKey];
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Zen free is in its quota cooldown (the gateway/probe write `cooldown_until`). */
export function zenCooling(file = DEFAULT_CONFIG.zenStatusFile, now = Date.now()) {
  try {
    const until = JSON.parse(readFileSync(file, 'utf8')).cooldown_until;
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

let modelCache = null;
export function getModel(cfg = DEFAULT_CONFIG) {
  if (modelCache) return modelCache;
  // ponytail: chosen once per process — hooks are short-lived. This side only
  // reads the cooldown; a Zen 429 here fails open and the gateway/probe set it.
  const backupKey = zenCooling(cfg.zenStatusFile) ? loadKey(cfg, 'backupKeyFile') : null;
  const apiKey = backupKey ?? loadKey(cfg);
  if (!apiKey) return null;
  modelCache = new JevDecisionModel({
    apiKey,
    baseUrl: backupKey ? cfg.backupBaseUrl : cfg.baseUrl,
    model: backupKey ? cfg.backupModel : cfg.model,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
  });
  return modelCache;
}

/**
 * Build a fail-open judge: `(state) => Promise<'keep'|'drop'>`.
 * Any error (missing key, API error, timeout, bad schema) -> 'keep'
 * (original output passes through unchanged).
 */
export function makeJudge(cfg = DEFAULT_CONFIG) {
  const model = getModel(cfg);
  if (!model) return async () => 'keep';
  return async function judge(state) {
    const answer = await model.choice(state, {
      instructions:
        "Decide whether the chunk of tool output is relevant to the user's current request/task. Keep output that helps answer or complete the task; drop output that is noise, repeated boilerplate, or unrelated.",
      criteria: {
        keep: 'The chunk contains information directly needed to complete the user’s current request/task.',
        drop: 'The chunk is unrelated noise, duplicated boilerplate, or otherwise does not help complete the user’s current request/task.',
      },
    });
    if (!answer || typeof answer.choice !== 'string') return 'keep';
    if (answer.choice !== 'drop') return 'keep';
    return 'drop';
  };
}
