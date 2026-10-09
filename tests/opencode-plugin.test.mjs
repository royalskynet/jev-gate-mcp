import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevLaya } from '../integrations/opencode/jev-laya.js';
import * as plugin from '../integrations/opencode/jev-laya.js';
import { MIN_CHARS, shrink, lastUserText, defaultJevEnv } from '../integrations/opencode/prune-core.js';

test('plugin module exports nothing but the plugin (opencode calls every export)', () => {
  assert.deepEqual(Object.keys(plugin), ['JevLaya']);
});

test('prunes long output with repeated lines', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const repeated = 'npm WARN x\n'.repeat(50);
  const filler = 'a'.repeat(MIN_CHARS);
  const out = { output: filler + '\n' + repeated };
  await fn({ tool: 'bash' }, out);
  assert.ok(out.output.includes('[l0: repeated'));
  assert.ok(out.output.length < filler.length + repeated.length);
});

test('leaves short output untouched', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const out = { output: 'short output' };
  await fn({ tool: 'bash' }, out);
  assert.equal(out.output, 'short output');
});

test('does not throw when output field missing', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const out = {};
  await fn({ tool: 'bash' }, out);
  assert.deepEqual(out, {});
});

const big = Array.from({ length: 2000 }, (_, i) => `line ${i} payload`).join('\n');

test('big output goes to the Jev judge with the mapped tool and the user request', async () => {
  const calls = [];
  const prune = async (p) => { calls.push(p); return { judged: true, text: 'kept' }; };
  const text = await shrink({ tool: 'bash', text: big }, { prune, getRequest: async () => 'fix the build' });
  assert.equal(text, 'kept');
  assert.equal(calls[0].tool, 'Bash');
  assert.equal(calls[0].request, 'fix the build');
});

test('the judge is only asked past its own threshold, so short outputs never fetch the request', async () => {
  let asked = false;
  const text = await shrink({ tool: 'bash', text: 'x'.repeat(5000) }, {
    prune: async () => { throw new Error('must not run'); },
    getRequest: async () => { asked = true; return 'r'; },
  });
  assert.equal(text.length, 5000);
  assert.equal(asked, false);
});

test('edit/write output is the model\'s own work and is never judged', async () => {
  const text = await shrink({ tool: 'edit', text: big }, {
    prune: async () => { throw new Error('must not run'); },
    getRequest: async () => 'r',
  });
  assert.equal(text, big);
});

test('no request means no judge (a request-free prune drops the needle, DEVLOG §22.3)', async () => {
  let called = false;
  const text = await shrink({ tool: 'bash', text: big }, { prune: async () => { called = true; }, getRequest: async () => '' });
  assert.equal(called, false);
  assert.equal(text, big);
});

test('a throwing or unjudged prune falls back to the L0 text', async () => {
  const thrown = await shrink({ tool: 'read', text: big }, { prune: async () => { throw new Error('net'); }, getRequest: async () => 'r' });
  assert.equal(thrown, big);
  const unjudged = await shrink({ tool: 'read', text: big }, { prune: async () => ({ judged: false, text: '' }), getRequest: async () => 'r' });
  assert.equal(unjudged, big);
});

test('lastUserText picks the newest real user text, skipping synthetic parts', () => {
  const msgs = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'old ask' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'reply' }] },
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'injected', synthetic: true }, { type: 'text', text: 'new ask' }] },
  ];
  assert.equal(lastUserText(msgs), 'new ask');
  assert.equal(lastUserText(undefined), '');
});

test('defaultJevEnv sets endpoint, model and key file together, and only when unset', () => {
  const env = { HOME: '/h' };
  assert.equal(defaultJevEnv(env, () => true), true);
  assert.equal(env.JEV_MODEL, 'jev-latest');
  assert.equal(env.JEV_API_KEY_FILE, '/h/.creds/kv/TYPESAFE_API_KEY.txt');
  const preset = { HOME: '/h', JEV_ENDPOINT: 'x' };
  assert.equal(defaultJevEnv(preset, () => true), false);
  assert.equal(preset.JEV_MODEL, undefined);
  assert.equal(defaultJevEnv({ HOME: '/h' }, () => false), false);
});
