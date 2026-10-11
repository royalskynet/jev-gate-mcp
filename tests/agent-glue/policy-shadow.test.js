/**
 * Prevention hardening: the five gateway policies must stay `shadow` +
 * `uncalibrated` with `rollout_percent 0`. Anyone who flips one to
 * active/calibrated/rolling out (before a labelled corpus proves it) turns this
 * test red. This is the guard that keeps an uncalibrated Jev result from ever
 * authorizing or blocking real work.
 *
 * `consequence: "consequential"` on proposed-action-risk is pre-existing and
 * independent of the shadow gate: a policy is only consequential *when active*
 * (registry.js:55-69 rejects an active+uncalibrated policy at startup), and all
 * five stay `shadow`, so none can act. This guard asserts the shadow/uncalibrated/
 * rollout axis, which is the contract the agents depend on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry } from '../../gateway/src/registry.js';

const EXPECTED = [
  'intent-routing',
  'context-screening',
  'proposed-action-risk',
  'completion-claims',
  'diff-risk',
];

test('policy prevention guard: all five policies stay shadow + uncalibrated + rollout 0', async () => {
  const registry = loadRegistry();
  const ids = registry.ids().sort();
  assert.deepEqual(ids, [...EXPECTED].sort(), 'exactly the five starter policies');
  for (const id of EXPECTED) {
    const v = registry.resolve(id); // current resolved version (deepFreeze)
    assert.equal(v.mode, 'shadow', `${id} must stay shadow`);
    assert.equal(v.calibration_status, 'uncalibrated', `${id} must stay uncalibrated`);
    assert.equal(v.activation?.rollout_percent, 0, `${id} must stay rollout 0`);
  }
});
