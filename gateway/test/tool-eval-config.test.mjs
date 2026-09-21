// Tool-selection eval config (item 7, offline half): the dataset and its
// validation must be well-formed WITHOUT any key. The live (costing) half stays
// opt-in behind JEV_RUN_EVAL=1 and is exercised only against a real model.
import { test } from 'node:test';
import assert from 'node:assert';
import { buildDataset, validateEvalConfig, VALID_EXPECT } from '../scripts/tool-eval.mjs';

test('eval dataset is well-formed with both positive and negative cases', () => {
  const ds = buildDataset();
  const cfg = validateEvalConfig(ds);
  assert.equal(cfg.ok, true, JSON.stringify(cfg.errors));
  assert.ok(cfg.positive >= 5, `expected positive cases, got ${cfg.positive}`);
  assert.ok(cfg.negative >= 4, `expected negative cases, got ${cfg.negative}`);
  for (const c of ds) {
    assert.ok(c.id && c.prompt && VALID_EXPECT.has(c.expect));
  }
});

test('eval dataset covers evaluation, apply-policy, and non-call expectations', () => {
  const exp = new Set(buildDataset().map((c) => c.expect));
  for (const e of VALID_EXPECT) assert.ok(exp.has(e), `expectation ${e} missing from dataset`);
});

test('malformed config is rejected', () => {
  const bad = validateEvalConfig([]);
  assert.equal(bad.ok, false);
  const dup = validateEvalConfig([
    { id: 'a', prompt: 'p', expect: 'none' },
    { id: 'a', prompt: 'p', expect: 'jev_evaluate' },
    { id: 'b', prompt: 'p', expect: 'jev_apply_policy' },
  ]);
  assert.equal(dup.ok, false);
  const noPos = validateEvalConfig([
    { id: 'a', prompt: 'p', expect: 'none' },
    { id: 'b', prompt: 'p', expect: 'none' },
  ]);
  assert.equal(noPos.ok, false, 'dataset with no positive case must fail');
});
