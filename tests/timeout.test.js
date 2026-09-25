import test from 'node:test';
import assert from 'node:assert/strict';
import * as jev from '../hooks/jev.js';
import { CONFIG, LEDGER, judgeChunks } from '../hooks/jev.js';

// `$.http.fetch` takes no signal and the engine's hook budget does not meter a
// `$` call in flight, so `judgeChunks` owns its own deadline. These two cases
// are a pair on purpose: the negative one (a hung endpoint must not stall and
// must not read as a judged `keep`) is only meaningful next to the positive one
// (a fetch that answers in time still drops), which is what proves the race did
// not simply switch judging off.

/** A host whose fetch never settles, and whose clock runs on demand. */
function hangingHost(writes) {
  return {
    clock: { now: async () => 1_700_000_000_000, sleep: async () => {} },
    http: { fetch: () => new Promise(() => {}) },
    fs: {
      read: async () => { throw new Error('ENOENT'); },
      write: async (path, text) => { if (path === LEDGER) writes.push(text); },
    },
  };
}

/** A host that answers at once with a `drop` for every chunk. */
function answeringHost(chunkCount) {
  const answers = {};
  for (let i = 0; i < chunkCount; i++) {
    answers[`c${i}`] = { type: 'choice', choice: 'drop', probabilities: { drop: 0.95, keep: 0.05 } };
  }
  return {
    clock: { now: async () => 1_700_000_000_000, sleep: () => new Promise(() => {}) },
    http: { fetch: async () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) }) },
    fs: { read: async () => { throw new Error('ENOENT'); }, write: async () => {} },
  };
}

test('a hung endpoint fails open and says so in the ledger', async () => {
  const writes = [];
  const chunks = ['noise one', 'noise two'];
  const verdicts = await judgeChunks(hangingHost(writes), 'k', 'find the error', chunks);
  assert.deepEqual(verdicts, ['keep', 'keep'], 'a timeout keeps every chunk');
  assert.equal(writes.length, 1, 'a timeout writes exactly one ledger line');
  assert.match(writes[0], /jev-timeout: 2 chunks unjudged after \d+ms/);
  assert.doesNotMatch(writes[0], /jev-prune/, 'a timeout must not read as a judged prune');
});

test('a fetch that answers in time still judges', async () => {
  // Terms from the request that appear in a chunk veto its drop, so the request
  // here shares no word with the chunks.
  const chunks = ['aaaa', 'bbbb'];
  const verdicts = await judgeChunks(answeringHost(2), 'k', 'zzzz', chunks);
  assert.deepEqual(verdicts, ['drop', 'drop'], 'the race must not switch judging off');
});

test('the deadline is configured and each call leaves its latency behind', async () => {
  assert.ok(Number.isFinite(CONFIG.timeoutMs) && CONFIG.timeoutMs > 0, 'CONFIG.timeoutMs is live');
  // The measured number is what a later retune of CONFIG.timeoutMs has to stand
  // on; a deadline with no latency record can only ever be re-guessed.
  await judgeChunks(answeringHost(1), 'k', 'zzzz', ['aaaa']);
  assert.ok(Number.isFinite(jev.lastLatencyMs), 'a completed call records its round trip');
});
