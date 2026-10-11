// Laya idle unload: after JEV_LAYA_IDLE_MS without calls the ONNX session is
// released (close called) and reloaded on the next request.
import test from 'node:test';
import assert from 'node:assert';
import { makeLayaAdapter } from '../src/adapters.js';

function fakeLaya() {
  let closed = false;
  return {
    closed: () => closed,
    close: async () => { closed = true; },
    systemOne: async (state, questions) => ({
      model: 'local/laya',
      answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: q.type, noul: 1 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
}

test('laya idle unload releases the session after JEV_LAYA_IDLE_MS and reloads', async () => {
  process.env.JEV_LAYA_IDLE_MS = '50';
  const instances = [];
  const adapter = makeLayaAdapter({ load: () => { const l = fakeLaya(); instances.push(l); return l; } });
  const QUESTIONS = { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'yes', false: 'no' } } };
  try {
    await adapter('state', QUESTIONS);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].closed(), false, 'still warm right after a call');

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(instances[0].closed(), true, 'session released after idle window');

    await adapter('state', QUESTIONS);
    assert.equal(instances.length, 2, 'a new instance was loaded on the next call');
    assert.equal(instances[1].closed(), false, 'fresh instance is warm');
  } finally {
    delete process.env.JEV_LAYA_IDLE_MS;
  }
});
