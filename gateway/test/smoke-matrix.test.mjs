// Provider smoke matrix (item 8): one shared OpenRouter credential drives the
// Jev / System One live path — `typesafe/jev-1.13` over OpenRouter
// `POST /api/v1/systemone`. There is no second, independent TypeSafe key: Jev
// live always rides the repo's single OpenRouter token. The native TypeSafe
// adapter stays for the offline contract fixture and optional config only.
// Ordinary CI stays offline (skips unless JEV_RUN_SMOKE=1 AND the key exists).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, buildGateway } from '../src/config.js';

const provider = process.env.JEV_PROVIDER ?? 'openrouter';
const JEVRUN = {
  name: provider === 'typesafe' ? 'jev (jev-latest via native TypeSafe)' : 'jev (typesafe/jev-1.13 via OpenRouter)',
  base: provider === 'typesafe' ? 'https://api.typesafe.ai' : 'https://openrouter.ai/api',
  model: provider === 'typesafe' ? 'jev-latest' : 'typesafe/jev-1.13',
  keyFile: provider === 'typesafe'
    ? process.env.JEV_API_KEY_FILE ?? 'no-native-key' // no native TypeSafe key exists; JEV_PROVIDER=typesafe without one skips
    : process.env.JEV_API_KEY_FILE ?? DEFAULTS.apiKeyFile,
};

const optIn = process.env.JEV_RUN_SMOKE === '1';
function keyFor(cfg) {
  try { return fs.readFileSync(cfg.keyFile, 'utf8').trim(); } catch { return null; }
}

const key = keyFor(JEVRUN);
const skip = !optIn
  ? `opt-in smoke: set JEV_RUN_SMOKE=1 to hit ${JEVRUN.name}`
  : key ? false : `missing credential: ${JEVRUN.keyFile} (skip; not a failure)`;
test(`smoke ${JEVRUN.name}: real provider round trip`, { skip: skip ? skip : false }, async () => {
  const { gateway } = buildGateway({ provider, apiKeyFile: JEVRUN.keyFile, model: JEVRUN.model });
  const r = await gateway.applyPolicy({ policy: 'completion-claims', state: { claims: ['smoke'], evidence: 'pytest: 1 passed' } });
  assert.ok(['accept', 'review', 'escalate', 'deny'].includes(r.outcome));
  assert.equal(r.coverage, 'complete');
  assert.equal(r.policy.id, 'completion-claims');
  assert.ok(r.model, 'resolved model recorded');
  // The OpenRouter path resolves to the Jev System One model id; native
  // TypeSafe answers `jev-1.13.0`. Both are the provider-side model field —
  // recorded on the result, not forwarded, so drift stays observable.
  assert.match(String(r.model), /jev-1\.13/, `resolved model must be Jev/jev-1.13, got ${r.model}`);
});
