import assert from 'node:assert/strict';
import { blockDecision } from '../plugin/hooks/gate.js';

// Regression: the branch used to test `String(decided).includes('not_addressed')`
// against an object, so it read '[object Object]' and never fired. The gate
// could not have blocked anything even once shadow was lifted.

// Evidence that actively says otherwise is worth stopping for.
assert.equal(blockDecision({ verdict: 'contradicted', gate: 'auto' })?.decision, 'block');

// Absence of support is not. The first real block this gate ever issued landed
// on a report that said, in its own words, which part was still unproven — the
// house rules require writing that, so blocking it trains the wrong lesson.
const soft = blockDecision({ verdict: 'not_addressed', gate: 'auto' });
assert.equal(soft.decision, undefined, 'not_addressed must not block');
assert.equal(soft.continue, true);
assert.match(soft.systemMessage, /does not support/);

assert.equal(blockDecision({ verdict: 'supported', gate: 'auto' }), undefined);
// Below the auto threshold the gate records and stays out of the way entirely.
assert.equal(blockDecision({ verdict: 'contradicted', gate: 'review' }), undefined);
assert.equal(blockDecision({ verdict: 'not_addressed', gate: 'review' }), undefined);
assert.equal(blockDecision(undefined), undefined, 'a missing judgment says nothing');

console.log('ok: contradicted blocks, not_addressed advises, everything else is silent');
