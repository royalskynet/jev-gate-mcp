import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairState, userRequestOf, judgePair, rivalCompactor, apiKey, CONFIG,
} from '../../agent-glue/claude/compact-hook.mjs';
import { compactMessages } from '../../agent-glue/src/compact.js';

function fakeHost({ status = 200, choice = 'drop', files = {} } = {}) {
  const written = {};
  return {
    written,
    http: {
      async fetch(url, init) {
        written.lastBody = JSON.parse(init.body);
        written.lastUrl = url;
        return { status, ok: status >= 200 && status < 300, text: JSON.stringify({ answers: { q: { choice } } }) };
      },
    },
    fs: {
      async read(p) {
        if (p in files) return files[p];
        throw new Error(`ENOENT ${p}`);
      },
      async write(p, v) { written[p] = v; },
    },
    clock: { async now() { return 0; } },
    ui: { log() {} },
  };
}

test('compact-hook: judges the newest real user turn, not the first', () => {
  const messages = [
    { role: 'user', content: 'the old question' },
    { role: 'assistant', content: 'answering' },
    { role: 'user', content: 'the current question' },
  ];
  assert.equal(userRequestOf(messages), 'the current question');
  assert.equal(userRequestOf([]), '');
  assert.equal(userRequestOf([{ role: 'user', content: '   ' }]), '', 'a blank turn is not a request');
});

test('compact-hook: pairState carries heads and sizes, never a whole payload', () => {
  const state = pairState({
    calls: [{ name: 'Bash', argsChars: 900, argsHead: '{"command":"npm ls"}' }],
    results: [{ chars: 40000, resultHead: 'line 0\nline 1' }],
  });
  assert.deepEqual(state.tools, ['Bash']);
  assert.equal(state.arguments, '{"command":"npm ls"}');
  assert.equal(state.result, 'line 0\nline 1');
  assert.equal(state.result_chars, 40000);
});

test('compact-hook: a non-2xx or a bad body answers keep (fail-open toward verbatim)', async () => {
  const bad = fakeHost({ status: 500 });
  assert.equal(await judgePair(bad, 'k', 'why', { calls: [], results: [] }), 'keep');
  const thrower = { http: { async fetch() { throw new Error('offline'); } } };
  assert.equal(await judgePair(thrower, 'k', 'why', { calls: [], results: [] }), 'keep');
});

test('compact-hook: a drop answer is passed through as drop', async () => {
  const host = fakeHost({ choice: 'drop' });
  assert.equal(await judgePair(host, 'k', 'why is the build slow', { calls: [{ name: 'Bash' }], results: [] }), 'drop');
  assert.equal(host.written.lastBody.model, CONFIG.model);
  assert.equal(host.written.lastBody.state.user_request, 'why is the build slow');
});

test('compact-hook: stands down when the standalone fast-jev plugin is also enabled', () => {
  assert.equal(rivalCompactor({ enabledPlugins: { 'fast-jev-compaction@fast-jev-compaction-openrouter': true } }), true);
  assert.equal(rivalCompactor({ enabledPlugins: { 'fast-jev-compaction@fast-jev-compaction-openrouter': false } }), false);
  assert.equal(rivalCompactor({ enabledPlugins: { 'jev-gate@jev-gate': true } }), false);
  assert.equal(rivalCompactor({}), false);
});

test('compact-hook: the key comes from the option, then env, then the file', async () => {
  const host = fakeHost({ files: { [CONFIG.apiKeyFile]: 'from-file\n' } });
  assert.equal(await apiKey(host, { apiKey: 'from-option' }), 'from-option');
  assert.equal(await apiKey(host, {}), 'from-file');
  const noFile = fakeHost();
  assert.equal(await apiKey(noFile, {}), null);
});

// End to end over the core with the hook's own judge: prose stays byte-for-byte,
// the tool payloads go, and the call/result pair goes together.
test('compact-hook: a drop-everything judge still keeps prose verbatim and pairs intact', async () => {
  const bulk = 'x'.repeat(9000);
  const messages = [
    { role: 'user', content: 'find the slow step' },
    { role: 'assistant', content: 'checking the tree', tool_calls: [{ id: 'a', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm ls --all' }) + bulk } }] },
    { role: 'tool', tool_call_id: 'a', content: bulk },
    { role: 'user', content: 'and now?' },
  ];
  const host = fakeHost({ choice: 'drop' });
  const out = await compactMessages({
    messages,
    minReductionChars: 1000,
    pinFirst: 1,
    pinLast: 1,
    judgeHeadChars: CONFIG.askChars,
    judge: (pair) => judgePair(host, 'k', 'find the slow step', pair),
  });
  assert.equal(out.compacted, true);
  assert.ok(out.reducedBy > 9000, `reducedBy=${out.reducedBy}`);
  assert.equal(out.messages[0].content, 'find the slow step');
  assert.equal(out.messages[1].content, 'checking the tree', 'assistant prose is verbatim');
  assert.equal(out.messages[3].content, 'and now?');
  // the call arguments and its paired result are both reduced, never one alone
  assert.match(out.messages[1].tool_calls[0].function.arguments, /^\[jev-compact: dropped/);
  assert.match(out.messages[2].content, /^\[jev-compact: dropped/);
  // and the judge was shown a head, not the whole payload
  assert.ok(host.written.lastBody.state.pair.arguments.length <= CONFIG.askChars);
});

test('compact-hook: judgeHeadChars defaults to 0 — no payload reaches the judge', async () => {
  let seen = null;
  await compactMessages({
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', tool_calls: [{ id: 'a', function: { name: 'Bash', arguments: 'secret-argument-value' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'secret-result-value' },
      { role: 'user', content: 'z' },
    ],
    pinFirst: 1,
    pinLast: 1,
    judge: async (pair) => { seen = pair; return 'keep'; },
  });
  assert.equal(JSON.stringify(seen).includes('secret-argument-value'), false);
  assert.equal(JSON.stringify(seen).includes('secret-result-value'), false);
});
