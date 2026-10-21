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
