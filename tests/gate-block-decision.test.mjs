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
// Feedback must reach the agent. Stop `systemMessage` is shown to the user
// only, so the old soft path told nobody who could act on it.
const toAgent = (out) => {
  assert.equal(out?.decision, undefined, 'feedback must not block');
  assert.equal(out.systemMessage, undefined, 'systemMessage never reaches the agent');
  assert.equal(out.hookSpecificOutput?.hookEventName, 'Stop');
  return out.hookSpecificOutput.additionalContext;
};
assert.match(toAgent(blockDecision({ verdict: 'not_addressed', gate: 'auto' })), /does not support/);

// An unsure contradiction is still a contradiction: 191/196 lived here and
// were silent. Ask for a re-check instead of blocking — whatever the gate.
for (const gate of ['review', 'escalate']) {
  assert.match(toAgent(blockDecision({ verdict: 'contradicted', gate })), /may contradict/);
}

assert.equal(blockDecision({ verdict: 'supported', gate: 'auto' }), undefined);
// Unsure absence of support is noise; that stays silent.
assert.equal(blockDecision({ verdict: 'not_addressed', gate: 'review' }), undefined);
assert.equal(blockDecision({ verdict: 'not_addressed', gate: 'escalate' }), undefined);
assert.equal(blockDecision(undefined), undefined, 'a missing judgment says nothing');

console.log('ok: sure contradiction blocks, unsure contradiction and sure not_addressed reach the agent, rest silent');
