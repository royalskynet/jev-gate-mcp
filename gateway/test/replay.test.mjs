import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { loadRegistry } from '../src/registry.js';
import { runDecisionReplay } from '../lib/replay.mjs';

const records = JSON.parse(fs.readFileSync(new URL('../fixtures/replay-baseline.json', import.meta.url), 'utf8'));

test('decision replay: baseline digest and safe/red outcomes stay stable', async () => {
  const report = await runDecisionReplay({ registry: loadRegistry(), records });
  assert.equal(report.status, 'pass');
  assert.equal(report.total, 2);
  assert.equal(report.results.find((row) => row.id.includes('red-line')).actual_outcome, 'deny');
});

test('decision replay: policy digest change is a non-pass even if outcome matches', async () => {
  const changed = [{ ...records[0], expected_policy_digest: 'sha256:changed' }];
  const report = await runDecisionReplay({ registry: loadRegistry(), records: changed });
  assert.equal(report.status, 'non-pass');
  assert.equal(report.results[0].outcome_match, true);
  assert.equal(report.results[0].digest_match, false);
});
