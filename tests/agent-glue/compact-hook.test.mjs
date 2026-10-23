import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairState, userRequestOf, judgePair, rivalCompactor, apiKey, CONFIG, shouldCompact, register,
  refreshConfig,
} from '../../agent-glue/claude/compact-hook.mjs';
import { ENV } from '../../agent-glue/claude/env.mjs';
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
  assert.equal(host.written.lastBody.model, CONFIG.model || 'jev-1.13-free');
  assert.equal(host.written.lastBody.state.user_request, 'why is the build slow');
});

test('compact-hook: stands down when the standalone fast-jev plugin is also enabled', () => {
  assert.equal(rivalCompactor({ enabledPlugins: { 'fast-jev-compaction@fast-jev-compaction-openrouter': true } }), true);
  assert.equal(rivalCompactor({ enabledPlugins: { 'fast-jev-compaction@fast-jev-compaction-openrouter': false } }), false);
  assert.equal(rivalCompactor({ enabledPlugins: { 'jev-gate@jev-gate': true } }), false);
  assert.equal(rivalCompactor({}), false);
});

test('compact-hook: the key comes from the option, then the file, then env', async () => {
  // This box exports OPENROUTER_API_KEY from the shell profile, so the suite
  // is polluted with a live key on dev machines; pin it to absent so the
  // assertion measures the precedence, not the ambient env (same save/restore
  // hygiene as the spawn-hook and prune-cli-ledger tests).
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const host = fakeHost({ files: { [CONFIG.apiKeyFile]: 'from-file\n' } });
    assert.equal(await apiKey(host, { apiKey: 'from-option' }), 'from-option');
    assert.equal(await apiKey(host, {}), 'from-file');
    const noFile = fakeHost();
    assert.equal(await apiKey(noFile, {}), null);
    // An inherited stale env key must not beat the dedicated key file: that
    // ordering made every judge call 401 and compaction reduce nothing.
    process.env.OPENROUTER_API_KEY = 'stale-env';
    assert.equal(await apiKey(host, {}), 'from-file');
    // With no file the environment is still a fallback.
    assert.equal(await apiKey(noFile, {}), 'stale-env');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
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

test('compact-hook: on a 1M window the absolute token ceiling fires long before the percentage', () => {
  // 60% of 1M is 600k — past where long-context quality falls off. The
  // ceiling is what keeps a big-window session in the good range.
  const oneM = 1_000_000;
  assert.equal(shouldCompact({ tokens: 150_000, window: oneM, percent: 15 }), false);
  assert.equal(shouldCompact({ tokens: CONFIG.compactAtTokens, window: oneM, percent: 20 }), true);
  // On a 200k window the percentage still fires first (120k < 200k).
  assert.equal(shouldCompact({ tokens: 120_000, window: 200_000, percent: 60 }), true);
  // A ceiling of 0 turns the absolute trigger off, leaving the percentage alone.
  const saved = CONFIG.compactAtTokens;
  CONFIG.compactAtTokens = 0;
  try {
    assert.equal(shouldCompact({ tokens: 900_000, window: oneM, percent: 50 }), false);
  } finally {
    CONFIG.compactAtTokens = saved;
  }
});

// Why: the primary defaults were empty strings, so the vendored core fell back
// to its own OpenRouter decisions URL while `apiKeyFile` still pointed at the
// Zen key — every compact answered 401 `Missing Authentication header` and fell
// back to the built-in summary, silently, for days (2026-10-01).
// The defaults are what is under test, so a machine that exports the overrides
// (passed on host, failed on M2 2026-10-09) must not leak them in.
test('the primary endpoint/model defaults name the same host as the primary key file', () => {
  const saved = { ...ENV };
  try {
    for (const k of ['JEV_ENDPOINT', 'JEV_MODEL', 'JEV_API_KEY_FILE']) delete ENV[k];
    refreshConfig();
    assert.equal(CONFIG.endpoint, 'https://opencode.ai/zen/v1/systemone');
    assert.equal(CONFIG.model, 'jev-1.13-free');
    assert.match(CONFIG.apiKeyFile, /OPENCODE_ZEN_API_KEY\.txt$/);
    // Backup is the OpenRouter pair, and all three must switch together.
    refreshConfig(true);
    assert.match(CONFIG.endpoint, /^https:\/\/openrouter\.ai\//);
    assert.match(CONFIG.apiKeyFile, /OPENROUTER_SECOND_API_KEY\.txt$/);
  } finally {
    for (const k of Object.keys(ENV)) delete ENV[k];
    Object.assign(ENV, saved);
    refreshConfig();
  }
});

// Why: the retired fast-jev-compaction plugin exposed these four as userConfig;
// this module only inherited them as core defaults, so a machine that wanted a
// stricter keep threshold or a smaller state budget had no way to say so.
// Unset must stay `undefined`, not 0 — `Number('')` is 0, and a 0 threshold
// keeps everything while a 0 state budget sends nothing.
test('the four core knobs read their env names and stay undefined when unset', () => {
  refreshConfig();
  for (const k of ['keepThreshold', 'maxStateTokens', 'maxRequestTokens', 'truncateHeadChars']) {
    assert.equal(CONFIG[k], undefined, `${k} must defer to the core default`);
  }
  const saved = { ...ENV };
  try {
    Object.assign(ENV, {
      JEV_COMPACT_KEEP_THRESHOLD: '0.8',
      JEV_COMPACT_MAX_STATE_TOKENS: '12000',
      JEV_COMPACT_MAX_REQUEST_TOKENS: '15000',
      JEV_COMPACT_TRUNCATE_HEAD: '0',
    });
    refreshConfig();
    assert.equal(CONFIG.keepThreshold, 0.8);
    assert.equal(CONFIG.maxStateTokens, 12000);
    assert.equal(CONFIG.maxRequestTokens, 15000);
    // 0 is a real setting here: keep only the note, no head.
    assert.equal(CONFIG.truncateHeadChars, 0);
    // Garbage is not 0 and not NaN — it falls back to the core default.
    ENV.JEV_COMPACT_KEEP_THRESHOLD = 'high';
    refreshConfig();
    assert.equal(CONFIG.keepThreshold, undefined);
  } finally {
    for (const k of Object.keys(ENV)) delete ENV[k];
    Object.assign(ENV, saved);
    refreshConfig();
  }
});

// Why: P2 moves compact onto the local cascade daemon by flipping one file,
// with no restart; a dead daemon or a bad flag file must never stop compaction.
test('compact-hook: cascade-callers.json routes the judge via the daemon, falls back when it is down', async () => {
  const { readCascadeUrl, fetchVia } = await import('../../agent-glue/claude/compact-hook.mjs');
  const flag = `${ENV.HOME || ENV.USERPROFILE}/.jevgate/cascade-callers.json`;
  const calls = [];
  let daemonUp = true;
  const host = (files) => ({
    fs: { async read(p) { if (p in files) return files[p]; throw new Error('ENOENT'); } },
    http: { async fetch(url, init) {
      calls.push({ url, caller: init?.headers?.['x-jev-caller'], auth: init?.headers?.Authorization });
      if (url.startsWith('http://127.0.0.1:8793') && !daemonUp) throw new TypeError('fetch failed');
      return { status: 200, ok: true, text: '{}' };
    } },
  });
  const direct = 'https://opencode.ai/zen/v1/systemone';
  const init = { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' };

  assert.equal(await readCascadeUrl(host({})), '', 'no flag file = off');
  await fetchVia(host({}), direct, init);
  assert.equal(calls.at(-1).url, direct);
  assert.equal(await readCascadeUrl(host({ [flag]: '{not json' })), '', 'bad json = off');
  assert.equal(await readCascadeUrl(host({ [flag]: '{"compact":"https://evil.example"}' })), '', 'non-loopback = off');
  assert.equal(await readCascadeUrl(host({ [flag]: '{"stop-gate":"http://127.0.0.1:8793"}' })), '', 'other caller only = off');

  const $ = host({ [flag]: '{"compact":"http://127.0.0.1:8793/"}' });
  assert.equal(await readCascadeUrl($), 'http://127.0.0.1:8793');
  calls.length = 0;
  await fetchVia($, direct, init);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:8793/v1/systemone', caller: 'compact', auth: 'Bearer k' }]);

  daemonUp = false;
  calls.length = 0;
  await fetchVia($, direct, init);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, direct, 'dead daemon falls back to the original host');
  assert.equal(calls[1].caller, undefined);
  await readCascadeUrl(host({}));
});

test('compact-hook: a Jev pass that leaves too much makes the next compaction the built-in, then Jev resumes', async () => {
  const saved = { ...ENV };
  Object.assign(ENV, { JEV_COMPACT_PIN_LAST: '1', JEV_COMPACT_MIN_REDUCTION: '1000', JEV_COMPACT_RESET_ABOVE: '60000', JEV_COMPACT_AT_PERCENT: '101', JEV_COMPACT_AT_TOKENS: '0', JEV_COMPACT_BACKEND: 'openai' });
  refreshConfig();
  try {
    const on = {};
    register((name, fn) => { on[name] = fn; }, { apiKey: 'k' });
    let live = 0;
    const host = { ...fakeHost({ choice: 'drop' }), session: { async usage() { return { context: { tokens: live, percent: 10 } }; }, async compact() {} } };
    const bulk = 'x'.repeat(9000);
    const messages = [
      { role: 'user', content: 'find the slow step' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'a', function: { name: 'Bash', arguments: bulk } }] },
      { role: 'tool', tool_call_id: 'a', content: bulk },
      { role: 'user', content: 'and now?' },
    ];
    const BUILTIN = Symbol('builtin');
    const compact = () => on['session.compact'](host, { messages, trigger: 'auto' }, () => BUILTIN);
    const turn = () => on['turn.complete'](host, {}, () => null);

    assert.notEqual(await compact(), BUILTIN, 'unmeasured: Jev runs');
    live = 50000; await turn();
    assert.notEqual(await compact(), BUILTIN, 'Jev left 50k (under 60k): Jev again');
    live = 70000; await turn();
    live = 90000; await turn(); // only the first turn after a pass is the residual
    assert.equal(await compact(), BUILTIN, 'Jev left 70k: built-in resets');
    live = 40000; await turn(); // the built-in result is never measured as a Jev residual
    assert.notEqual(await compact(), BUILTIN, 'after the reset: Jev resumes');

    ENV.JEV_COMPACT_RESET_ABOVE = '0'; refreshConfig();
    live = 99000; await turn();
    assert.notEqual(await compact(), BUILTIN, 'reset off: always Jev');
  } finally {
    for (const k of Object.keys(ENV)) if (!(k in saved)) delete ENV[k];
    Object.assign(ENV, saved);
    refreshConfig();
  }
});
