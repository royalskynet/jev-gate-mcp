import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from './jev-laya.js';

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
