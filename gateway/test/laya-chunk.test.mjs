// Laya forward passes are capped at JEV_LAYA_BATCH questions: one unbounded
// batch of a 190-question compact request reached 31GB (fix 10532).
import test from 'node:test';
import assert from 'node:assert';
import { runChunked } from '../src/adapters.js';

function fakeLaya(delayMs = 0) {
  const sizes = [];
  return {
    sizes,
    systemOne: async (state, questions) => {
      sizes.push(Object.keys(questions).length);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return {
        model: 'local/laya',
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { choice: k }])),
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

const qs = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: 'choice' }]));

test('runChunked splits into batches and merges every answer', async () => {
  const laya = fakeLaya();
  const r = await runChunked(laya, 's', qs(10), 10_000, 4);
  assert.deepEqual(laya.sizes, [4, 4, 2]);
  assert.equal(Object.keys(r.answers).length, 10);
  assert.equal(r.answers.q9.choice, 'q9');
  assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 3 });
  assert.equal(r.model, 'local/laya');
});

test('runChunked stops starting new batches after the deadline', async () => {
  const laya = fakeLaya(40);
  await assert.rejects(runChunked(laya, 's', qs(20), 60, 4), /exceeded/);
  assert.ok(laya.sizes.length < 5, `ran ${laya.sizes.length} of 5 batches after deadline`);
});
