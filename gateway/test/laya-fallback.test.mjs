// Laya dual-channel fallback: the fallback adapter must match the key's type.
// A TYPESAFE_ key file must route to the native TypeSafe adapter (typesafe 401s
// on the OpenRouter endpoint, fix 9708 class); anything else to OpenRouter.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGateway } from '../src/config.js';

function tmpKey(name, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-laya-fb-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, value);
  return f;
}

function fetchTo(url) {
  return async (u) => new Response(JSON.stringify({
    model: 'mock',
    answers: { q: { type: 'noul', noul: 1 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Point Laya's model dir at a nonexistent path so the local load throws and the
// dual-channel falls through to the remote fallback. All requests are faked.
test('laya fallback with a TYPESAFE key routes to the native TypeSafe endpoint', async () => {
  const keyFile = tmpKey('TYPESAFE_API_KEY.txt', 'sk-test');
  let seenUrl = null;
  const realFetch = global.fetch;
  global.fetch = async (u, ...rest) => { seenUrl = String(u); return fetchTo(u)(u, ...rest); };
  process.env.JEV_LAYA_MODEL_DIR = path.join(os.tmpdir(), 'jev-laya-does-not-exist-xyz');
  try {
    const { gateway } = buildGateway({ provider: 'laya', model: 'jev-latest', apiKeyFile: keyFile });
    await gateway.evaluate({ state: 'x', questions: { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'yes', false: 'no' } } } });
    assert.ok(seenUrl.startsWith('https://api.typesafe.ai'), `expected typesafe URL, got ${seenUrl}`);
  } finally {
    global.fetch = realFetch;
    delete process.env.JEV_LAYA_MODEL_DIR;
  }
});

test('laya fallback with a non-TYPESAFE key routes to OpenRouter', async () => {
  const keyFile = tmpKey('OPENROUTER_API_KEY.txt', 'sk-or-test');
  let seenUrl = null;
  const realFetch = global.fetch;
  global.fetch = async (u, ...rest) => { seenUrl = String(u); return fetchTo(u)(u, ...rest); };
  process.env.JEV_LAYA_MODEL_DIR = path.join(os.tmpdir(), 'jev-laya-does-not-exist-abc');
  try {
    const { gateway } = buildGateway({ provider: 'laya', model: 'typesafe/jev-1.13', apiKeyFile: keyFile });
    await gateway.evaluate({ state: 'x', questions: { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'yes', false: 'no' } } } });
    assert.ok(seenUrl.startsWith('https://openrouter.ai'), `expected openrouter URL, got ${seenUrl}`);
  } finally {
    global.fetch = realFetch;
    delete process.env.JEV_LAYA_MODEL_DIR;
  }
});

// No key: the router's own `!cloud` credential error must surface. Wrapping a
// null fallback in the teacher corpus used to turn it into a TypeError
// ("adapter is not a function") that callers could not tell from a bug.
test('laya without a key fails with the credential error, not a TypeError', async () => {
  process.env.JEV_LAYA_MODEL_DIR = path.join(os.tmpdir(), 'jev-laya-does-not-exist-nokey');
  try {
    const { gateway } = buildGateway({ provider: 'laya', model: 'jev-latest', apiKeyFile: '/nonexistent/no-key.txt' });
    const err = await gateway.evaluate({ state: 'x', questions: { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'yes', false: 'no' } } } })
      .then((r) => r, (e) => e);
    const text = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
    assert.ok(!/is not a function/.test(text), `credential error was masked: ${text}`);
    assert.match(text, /credential|auth/i);
  } finally {
    delete process.env.JEV_LAYA_MODEL_DIR;
  }
});
