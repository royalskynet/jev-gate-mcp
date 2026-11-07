import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubState, withPiiScrub } from '../src/pii-scrub.js';

test('pii-scrub replaces string leaf nodes and cloud adapter receives scrubbed state', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.texts, ['hello', 'secret@example.com', '42']);
    return new Response(JSON.stringify({ texts: ['hello', '[EMAIL]', '42'] }), { status: 200 });
  };
  const adapter = withPiiScrub(async (state) => {
    seen.push(state);
    return { answers: {} };
  }, { fetchImpl, url: 'http://127.0.0.1:4102/scrub' });
  await adapter({ a: 'hello', nested: [{ b: 'secret@example.com' }], n: 42, c: '42' }, {});
  assert.deepEqual(seen[0], { a: 'hello', nested: [{ b: '[EMAIL]' }], n: 42, c: '42' });
});

test('pii-scrub throws on 503 and cloud adapter is not called', async () => {
  let called = 0;
  const adapter = withPiiScrub(async () => { called++; return {}; }, {
    fetchImpl: async () => new Response('no', { status: 503 }),
    url: 'http://127.0.0.1:4102/scrub',
  });
  await assert.rejects(() => adapter({ a: 'x' }, {}), (e) => e && e.code === 'upstream');
  assert.equal(called, 0);
});

test('pii-scrub throws on length mismatch', async () => {
  await assert.rejects(() => scrubState({ a: 'x', b: 'y' }, {
    fetchImpl: async () => new Response(JSON.stringify({ texts: ['only-one'] }), { status: 200 }),
    url: 'http://127.0.0.1:4102/scrub',
  }), (e) => e && e.code === 'upstream' && /length mismatch/i.test(e.message));
});
