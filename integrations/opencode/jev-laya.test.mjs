import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import plugin, { makeCascadeJudge, createCompactRuntime } from './jev-laya.js';

test('Jev Laya server() returns the opencode hooks it relies on', async () => {
  const previous = new Map(['JEV_EFFORT_ENABLED', 'JEV_COMPACT_ENABLED'].map((k) => [k, process.env[k]]));
  process.env.JEV_EFFORT_ENABLED = '0';
  process.env.JEV_COMPACT_ENABLED = '0';
  try {
    const hooks = await plugin.server({}, { liveMod: { cascadeUrlFor: () => '' } });
    assert.deepEqual(Object.keys(hooks).sort(), [
      'chat.message', 'chat.params', 'experimental.chat.messages.transform', 'tool.execute.after',
    ]);
    await hooks['chat.params']({ message: { id: 'm' }, model: { id: 'x' } }, { options: {} });
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's' }, { output: 'short' });
  } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('Jev Laya registers its V2 context and tool hooks', async () => {
  const envKeys = [
    'JEV_EFFORT_ENABLED', 'JEV_COMPACT_ENABLED', 'JEV_USAGE_CALLER',
    'JEV_ENDPOINT', 'JEV_MODEL', 'JEV_API_KEY_FILE', 'JEV_PROVIDER',
  ];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.JEV_EFFORT_ENABLED = '0';
  process.env.JEV_COMPACT_ENABLED = '0';

  const hooks = { session: [], tool: [] };
  const callbacks = {};
  const ctx = {
    session: {
      hook: async (name, callback) => {
        hooks.session.push(name);
        callbacks[`session.${name}.${hooks.session.length}`] = callback;
        return { dispose: async () => {} };
      },
      context: async () => [],
    },
    tool: {
      hook: async (name, callback) => {
        hooks.tool.push(name);
        callbacks[`tool.${name}`] = callback;
        return { dispose: async () => {} };
      },
    },
  };

  try {
    await plugin.setup(ctx, { liveMod: { cascadeUrlFor: () => '' } });
    assert.deepEqual(hooks.session, ['context', 'context']);
    assert.deepEqual(hooks.tool, ['execute.after']);
    await callbacks['session.context.1']({ messages: [], sessionID: 'test', system: [], tools: {}, options: {} });
    await callbacks['session.context.2']({ messages: [], sessionID: 'test', system: [], tools: {}, options: {} });
    await callbacks['tool.execute.after']({ status: 'error', tool: 'bash', sessionID: 'test' });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('compact uses cascade transport with caller=compact:opencode when callers file has compact', async () => {
  const calls = [];
  const judge = makeCascadeJudge({
    caller: 'compact:opencode',
    readCallers: () => JSON.stringify({ compact: 'http://127.0.0.1:8793' }),
    cascadeUrlFor: (c, raw) => JSON.parse(raw)?.[c] || '',
    cascadeTransport: (url, opts) => {
      calls.push({ url, opts });
      return {
        evaluate: async ({ questions }) => ({
          answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'choice', choice: 'keep', probabilities: { keep: 1, drop: 0 } }])),
        }),
      };
    },
  });
  const v = await judge({ request: 'req', segments: ['a', 'b'], criteria: { keep: 'k', drop: 'd' } });
  assert.deepEqual(v, ['keep', 'keep']);
  assert.equal(calls[0].opts.caller, 'compact:opencode');
  assert.equal(calls[0].opts.laneQtypes, null);
});

test('prune:opencode resolves the compact cascade key (callers file has no prune key)', async () => {
  const calls = [];
  const judge = makeCascadeJudge({
    caller: 'prune:opencode',
    readCallers: () => JSON.stringify({ compact: 'http://127.0.0.1:8793' }),
    cascadeUrlFor: (c, raw) => JSON.parse(raw)?.[c] || '',
    cascadeTransport: (url, opts) => {
      calls.push({ url, opts });
      return {
        evaluate: async ({ questions }) => ({
          answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'choice', choice: 'drop' }])),
        }),
      };
    },
  });
  const v = await judge({ request: 'req', segments: ['a'], criteria: { keep: 'k', drop: 'd' } });
  assert.deepEqual(v, ['drop']);
  assert.equal(calls[0].url, 'http://127.0.0.1:8793');
  assert.equal(calls[0].opts.caller, 'prune:opencode');
});

test('judge without criteria still sends keep/drop options (prune path passes none)', async () => {
  let sent;
  const judge = makeCascadeJudge({
    caller: 'prune:opencode',
    readCallers: () => JSON.stringify({ compact: 'http://x' }),
    cascadeUrlFor: (c, raw) => JSON.parse(raw)?.[c] || '',
    cascadeTransport: () => ({
      evaluate: async ({ questions }) => {
        sent = questions;
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { choice: 'keep' }])) };
      },
    }),
  });
  await judge({ request: 'req', segments: ['a', 'b'], criteria: undefined });
  for (const q of Object.values(sent)) {
    assert.equal(q.type, 'choice');
    assert.ok(q.criteria?.keep && q.criteria?.drop, 'choice needs keep and drop options');
  }
});

test('compact runtime skips judge when callers file has no compact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jlc-'));
  const log = join(dir, 'compact.log');
  let calls = 0;
  const rt = createCompactRuntime({
    callersFile: join(dir, 'nope.json'),
    compactLog: log,
    liveMod: {
      cascadeUrlFor: () => '',
      cascadeTransport: () => ({ evaluate: async () => { calls++; return { answers: {} }; } }),
    },
  });
  const judge = await rt.judgeFor('compact:opencode');
  assert.equal(judge, null);
  assert.equal(await rt.skipNoCascade(), true);
  assert.equal(calls, 0);
  assert.match(readFileSync(log, 'utf8'), /skip no-cascade/);
});

test('compact runtime rejudges same callID after latest user message changes', async () => {
  const rt = createCompactRuntime({ liveMod: { cascadeUrlFor: () => 'http://x' } });
  const { decisionKey } = await import('./prune-core.js');
  rt.decisions.set(decisionKey('c1', 'first'), 'drop');
  assert.equal(rt.decisions.has(decisionKey('c1', 'first')), true);
  assert.equal(rt.decisions.has(decisionKey('c1', 'second')), false);
});

test('compact runtime disables after 3 failures and does not call judge on 4th', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jlc-'));
  const log = join(dir, 'compact.log');
  let calls = 0;
  const rt = createCompactRuntime({
    callersFile: join(dir, 'c.json'),
    compactLog: log,
    env: { JEV_COMPACT_TIMEOUT_MS: '1', HOME: dir },
    liveMod: {
      cascadeUrlFor: (c) => c === 'compact' ? 'http://127.0.0.1:8793' : '',
      cascadeTransport: () => ({
        evaluate: async () => { calls++; throw new Error('boom'); },
      }),
    },
  });
  for (let i = 0; i < 3; i++) {
    const judge = await rt.judgeFor('compact:opencode');
    const v = await judge({ request: 'r', segments: ['a'], criteria: { keep: 'k', drop: 'd' } });
    assert.deepEqual(v, ['keep']);
  }
  assert.equal(rt.disabled, true);
  const judge4 = await rt.judgeFor('compact:opencode');
  assert.equal(judge4, null);
  assert.equal(calls, 3);
  assert.match(readFileSync(log, 'utf8'), /disabled after 3 failures/);
});
