import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, LEDGER, register } from '../hooks/jev.js';

// Its own file on purpose: `apiKey`'s memo and the once-per-session nokey flag
// are module state, and node:test gives each file a fresh process. Folding these
// into hook.live.test.js would let a live test that already read the real key
// decide whether these two ever reach their branch.

/** Collect the three registrations the plugin makes. */
function hooksOf() {
  const got = [];
  register((event, filter, fn) => got.push({ event, filter, fn }));
  return got;
}

/** A `$` whose key file always fails to read, with the ledger captured in memory. */
function hostWithUnreadableKey() {
  const writes = [];
  const reads = [];
  const $ = {
    clock: { now: async () => Date.parse('2026-09-21T00:00:00.000Z') },
    fs: {
      read: async (path) => {
        reads.push(path);
        if (path === CONFIG.apiKeyFile) throw new Error('EPERM');
        return '';
      },
      write: async (path, text) => {
        assert.equal(path, LEDGER);
        writes.push(text);
      },
    },
    ui: { log: () => {} },
    session: { messages: async () => [] },
  };
  return { $, writes, reads };
}

const overThreshold = () => 'x'.repeat(CONFIG.chunkChars + 1);

test('an unreadable key leaves one ledger line, not silence and not one per call', async () => {
  const bash = hooksOf().find((h) => h.filter.tool === 'Bash').fn;
  const { $, writes } = hostWithUnreadableKey();
  const out = overThreshold();
  const call = () => bash($, {}, async () => ({ result: { stdout: out } }));

  const r = await call();
  assert.equal(r.result.stdout, out, 'output must pass through untouched when we cannot judge it');
  assert.equal(writes.length, 1, 'the first unjudged call must be recorded');
  assert.match(writes[0], /\tjev-nokey\(Bash\): \d+ chars unjudged, key file unreadable/);

  // A key we cannot read is a standing condition; appendLedger rewrites the whole
  // file per line, so repeating it per call would be the loudest thing in there.
  await call();
  await call();
  assert.equal(writes.length, 1, 'the condition is logged once per session');
});

test('a failed key read is not memoized, so a key that appears mid-session is picked up', async () => {
  const read = hooksOf().find((h) => h.filter.tool === 'Read').fn;
  const { $, reads } = hostWithUnreadableKey();
  const out = overThreshold();
  const call = () => read($, {}, async () => ({ result: { type: 'text', file: { content: out } } }));
  const keyReads = () => reads.filter((p) => p === CONFIG.apiKeyFile).length;

  await call();
  const afterFirst = keyReads();
  await call();

  assert.ok(afterFirst >= 1, 'the key file must actually be read');
  assert.ok(keyReads() > afterFirst, 'a failed read must not be cached for the session');
});
