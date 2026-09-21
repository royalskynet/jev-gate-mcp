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

const JEVRUN = {
  name: 'jev (typesafe/jev-1.13 via OpenRouter)',
  base: 'https://openrouter.ai/api',
  model: 'typesafe/jev-1.13',
  keyFile: process.env.JEV_API_KEY_FILE ?? DEFAULTS.apiKeyFile,
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
  const { gateway } = buildGateway({ provider: 'openrouter', apiKeyFile: JEVRUN.keyFile, model: JEVRUN.model });
  const r = await gateway.applyPolicy({ policy: 'completion-claims', state: { claims: ['smoke'], evidence: 'pytest: 1 passed' } });
  assert.ok(['accept', 'review', 'escalate', 'deny'].includes(r.outcome));
  assert.equal(r.coverage, 'complete');
  assert.equal(r.policy.id, 'completion-claims');
  assert.ok(r.model, 'resolved model recorded');
  // Jev/TypeSafe live ALWAYS rides the OpenRouter token, so the resolved model
  // must identify the Jev System One model.
  assert.match(r.model, /typesafe\/jev-1\.13/, `resolved model must be Jev/jev-1.13, got ${r.model}`);
});
