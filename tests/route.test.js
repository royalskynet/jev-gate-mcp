import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, EmptyCandidatesError } from '../plugin/lib/route.js';

function fakeScorer(probsFor) {
  return async (state, choices) => {
    const probs = probsFor(choices);
    const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    return { choice: top, probabilities: probs };
  };
}

test('empty candidates throw, not return null', async () => {
  await assert.rejects(route({ candidates: [] }), EmptyCandidatesError);
  await assert.rejects(route({}), EmptyCandidatesError);
});

test('no_match wins -> returns no_match and does not force a pick', async () => {
  const r = await route({
    candidates: ['Bash', 'Read'],
    userRequest: 'weird request',
    scorer: fakeScorer((c) => ({ Bash: 0.1, Read: 0.2, no_match: 0.7 })),
  });
  assert.equal(r.no_match, true);
  assert.equal(r.dispatch, null);
});

test('top-3 returned with probabilities, dispatch chosen', async () => {
  const r = await route({
    candidates: ['a', 'b', 'c', 'd'],
    userRequest: 'task',
    scorer: fakeScorer((c) => {
      const p = {};
      c.forEach((x, i) => (p[x] = 1 - i * 0.1));
      return p;
    }),
  });
  assert.equal(r.no_match, false);
  assert.equal(r.top.length, 3);
  assert.equal(r.top[0].candidate, 'a');
  assert.ok(r.top[0].probability >= r.top[1].probability);
});

test('prefilter drops unavailable candidates deterministically', async () => {
  const r = await route({
    candidates: ['a', 'b', 'c'],
    userRequest: 'task',
    prefilter: (c) => c.filter((x) => x !== 'b'),
    // only a and c remain -> no_match included
    scorer: fakeScorer((c) => {
      const p = {};
      c.forEach((x, i) => (p[x] = 1 - i * 0.2));
      return p;
    }),
  });
  assert.equal(r.top.some((t) => t.candidate === 'b'), false);
});
