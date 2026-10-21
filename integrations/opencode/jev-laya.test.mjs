import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from './jev-laya.js';

test('Jev Laya server() returns the opencode hooks it relies on', async () => {
  const previous = new Map(['JEV_EFFORT_ENABLED', 'JEV_COMPACT_ENABLED'].map((k) => [k, process.env[k]]));
  process.env.JEV_EFFORT_ENABLED = '0';
  process.env.JEV_COMPACT_ENABLED = '0';
  try {
    const hooks = await plugin.server({});
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
    await plugin.setup(ctx);
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
