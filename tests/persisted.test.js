import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, LEDGER, resolvePersisted, register } from '../hooks/jev.js';

// Its own file, same reason as nokey.test.js: `apiKey` memoizes at module scope,
// and these cases need a host whose key file reads cleanly.

const PERSISTED_FILE = '/tmp/claude-501/sess/tool-results/bzyo66y37.txt';

/** What core hands the hook in place of a large Bash result. */
const preview = (bytes) =>
  `<persisted-output>\nOutput too large (${bytes}KB). Full output saved to: ${PERSISTED_FILE}\n\nPreview (first 2KB):\n${'p'.repeat(1800)}\n...\n</persisted-output>`;

function hostWith(files, fetch) {
  const writes = [];
  const $ = {
    clock: { now: async () => Date.parse('2026-09-23T00:00:00.000Z') },
    fs: {
      read: async (path) => {
        if (path in files) return files[path];
        throw new Error(`ENOENT ${path}`);
      },
      write: async (path, text) => {
        assert.equal(path, LEDGER);
        writes.push(text);
      },
    },
    http: { fetch },
    ui: { log: () => {} },
    session: { messages: async () => [{ role: 'user', text: 'find the error' }] },
  };
  return { $, writes };
}

test('resolvePersisted reads the file core wrote and reports it did', async () => {
  const full = 'real output\n'.repeat(4000);
  const { $ } = hostWith({ [PERSISTED_FILE]: full });
  const got = await resolvePersisted($, preview(48));
  assert.equal(got.persisted, true);
  assert.equal(got.text, full);
});

test('an unreadable persisted file falls back to the preview', async () => {
  const { $ } = hostWith({});
  const p = preview(48);
  const got = await resolvePersisted($, p);
  assert.equal(got.persisted, false);
  assert.equal(got.text, p);
});

test('a persisted file smaller than the preview is not used', async () => {
  const { $ } = hostWith({ [PERSISTED_FILE]: 'tiny' });
  const p = preview(48);
  assert.deepEqual(await resolvePersisted($, p), { text: p, persisted: false });
});

test('ordinary output passes through untouched', async () => {
  const { $ } = hostWith({});
  assert.deepEqual(await resolvePersisted($, 'plain'), { text: 'plain', persisted: false });
  assert.deepEqual(await resolvePersisted($, undefined), { text: undefined, persisted: false });
});

test('a persisted Bash result reaches the judge at full length', async () => {
  const full = 'noise line\n'.repeat(3000) + 'ERROR: the one line that matters\n';
  let judgedChars = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const chunks = body.state.chunks;
    for (const c of chunks) judgedChars += c.length;
    const answers = {};
    // Keep the first chunk, drop the rest: a real prune, so droppedLines > 0.
    chunks.forEach((_, i) => {
      answers[`c${i}`] = i === 0
        ? { choice: 'keep' }
        : { choice: 'drop', probabilities: { drop: 0.99 } };
    });
    return { ok: true, text: JSON.stringify({ answers }) };
  };
  const { $, writes } = hostWith(
    { [PERSISTED_FILE]: full, [CONFIG.apiKeyFile]: 'sk-test\n' },
    fetch,
  );
  const hooks = [];
  register((event, filter, fn) => hooks.push({ filter, fn }));
  const bash = hooks.find((h) => h.filter.tool === 'Bash');

  const p = preview(33);
  const out = await bash.fn($, {}, async () => ({ result: { stdout: p } }));

  assert.ok(judgedChars > p.length * 2, `judge saw ${judgedChars} chars, preview was ${p.length}`);
  assert.match(writes.join(''), /jev-prune\(Bash\): \d{4,} \u2192 /);
  // Pruned below one chunk, so the preview is replaced rather than left alone.
  assert.ok(out.result.stdout.length <= CONFIG.chunkChars, 'write-back must stay under a chunk');
});

test('an under-pruned persisted result leaves core\'s preview alone', async () => {
  const full = 'still very long line of output\n'.repeat(4000);
  const fetch = async (_url, init) => {
    const answers = {};
    JSON.parse(init.body).state.chunks.forEach((_, i) => {
      // Drop exactly one chunk: something was dropped, but what is left is huge.
      answers[`c${i}`] = i === 0
        ? { choice: 'drop', probabilities: { drop: 0.99 } }
        : { choice: 'keep' };
    });
    return { ok: true, text: JSON.stringify({ answers }) };
  };
  const { $ } = hostWith(
    { [PERSISTED_FILE]: full, [CONFIG.apiKeyFile]: 'sk-test\n' },
    fetch,
  );
  const hooks = [];
  register((event, filter, fn) => hooks.push({ filter, fn }));
  const bash = hooks.find((h) => h.filter.tool === 'Bash');

  const p = preview(120);
  const out = await bash.fn($, {}, async () => ({ result: { stdout: p } }));
  assert.equal(out.result.stdout, p, 'a still-huge prune must not replace the preview');
});
