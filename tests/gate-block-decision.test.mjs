import assert from 'node:assert/strict';
import { blockDecision } from '../plugin/hooks/gate.js';

// Regression: the block branch used to test `String(decided).includes('not_addressed')`
// against an object, so it read '[object Object]' and never fired. The gate
// could not have blocked anything even once shadow was lifted.

assert.equal(blockDecision({ verdict: 'not_addressed', gate: 'auto' })?.decision, 'block');
assert.equal(blockDecision({ verdict: 'contradicted', gate: 'auto' })?.decision, 'block');
assert.equal(blockDecision({ verdict: 'supported', gate: 'auto' }), undefined);
// Below the auto threshold the gate records and stays out of the way.
assert.equal(blockDecision({ verdict: 'not_addressed', gate: 'review' }), undefined);
assert.equal(blockDecision(undefined), undefined, 'a missing judgment never blocks');

console.log('ok: block fires on a confident unsupported verdict and on nothing else');
