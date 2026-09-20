// Deployment config and gateway wiring. Keys are read from files configured by
// env, never passed as tool arguments and never logged.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killSwitchGlobal, killSwitchPolicy } from './core.js';
import { loadRegistry } from './registry.js';
import { makeFakeAdapter, FakeMode, makeOpenrouterAdapter, makeTypesafeAdapter } from './adapters.js';
import { JevGateway } from './gateway.js';

export const DEFAULTS = Object.freeze({
  provider: process.env.JEV_PROVIDER ?? 'openrouter',
  model: process.env.JEV_MODEL ?? 'typesafe/jev-1.13',
  apiKeyFile: process.env.JEV_API_KEY_FILE ?? path.join(os.homedir(), '.creds', 'kv', 'OPENROUTER_API_KEY.txt'),
  fakeMode: process.env.JEV_FAKE_MODE ?? FakeMode.SUCCESS,
  killSwitch: (process.env.JEV_KILL_SWITCH ?? '') === '1',
  registryDir: process.env.JEV_POLICY_DIR ?? null,
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

  let evaluateAdapter;
  if (cfg.provider === 'fake') {
    evaluateAdapter = fake;
  } else {
    const key = readKey(cfg.apiKeyFile);
    if (cfg.provider === 'typesafe') {
      evaluateAdapter = key ? makeTypesafeAdapter({ apiKey: key, model: cfg.model }) : null;
    } else {
      evaluateAdapter = key ? makeOpenrouterAdapter({ apiKey: key, model: cfg.model }) : null;
    }
  }
  if (!evaluateAdapter) {
    // Fail closed, not silent: a gateway without a provider cannot promise a
    // real judgment, so remote/stdio installs must supply one. Tests use 'fake'.
    throw new Error(`provider ${cfg.provider} has no usable credential (checked ${cfg.apiKeyFile})`);
  }
  const gw = new JevGateway({ evaluateAdapter, registry });
  // Wire a global control handle for operators/admins via env at startup.
  return { gateway: gw, registry, cfg };
}

export { FakeMode };
