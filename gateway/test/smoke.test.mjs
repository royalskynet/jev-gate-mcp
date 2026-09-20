// Opt-in real-provider smoke test. Requires a configured key file; without one
// the test is SKIPPED so ordinary CI passes offline. Only runs a real
// provider round-trip when a credential actually exists.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { buildGateway } from '../src/config.js';

const keyFile = process.env.JEV_API_KEY_FILE ?? DEFAULTS.apiKeyFile;
const hasKey = fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8').trim().length > 0;
// Opt-in only: ordinary `npm test`/CI must stay offline. Run a real provider
// round-trip only when JEV_RUN_SMOKE=1 AND a credential exists (otherwise skip).
const optIn = process.env.JEV_RUN_SMOKE === '1';
const skipReason = !optIn ? 'opt-in smoke test: set JEV_RUN_SMOKE=1 to run a real provider call' : 'no provider key configured; skipping live smoke';

test('real-provider smoke: apply a governed policy end to end', { skip: optIn && hasKey ? false : skipReason }, async () => {
  const provider = process.env.JEV_PROVIDER ?? DEFAULTS.provider;
  const { gateway } = buildGateway({ provider, apiKeyFile: keyFile });
  const r = await gateway.applyPolicy({ policy: 'completion-claims', state: { claims: ['smoke test'], evidence: 'pytest: 1 passed' } });
  assert.ok(['accept', 'review', 'escalate', 'deny'].includes(r.outcome));
  assert.equal(r.coverage, 'complete');
  assert.equal(r.policy.id, 'completion-claims');
  assert.ok(r.model, 'resolved model must be recorded');
});
