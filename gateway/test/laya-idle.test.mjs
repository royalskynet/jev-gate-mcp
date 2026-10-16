// Laya idle unload: after JEV_LAYA_IDLE_MS without calls the ONNX session is
// released (close called) and reloaded on the next request.
import test from 'node:test';
import assert from 'node:assert';
import { logLayaLoad, makeLayaAdapter } from '../src/adapters.js';

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

test('every Laya load (first and after idle unload) logs one laya-load line with the bundle mtime', async () => {
  const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'laya-load-'));
  writeFileSync(join(dir, 'laya.onnx'), 'x');
  utimesSync(join(dir, 'laya.onnx'), new Date('2026-10-14T02:02:15Z'), new Date('2026-10-14T02:02:15Z'));
  const lines = [];
  logLayaLoad(dir, 7, (s) => lines.push(s));
  assert.match(lines[0], /laya-load dir=.* onnx_mtime=2026-10-14T02:02:15\.000Z ms=7\n$/);
  logLayaLoad(join(dir, 'missing'), 1, (s) => lines.push(s));
  assert.match(lines[1], /onnx_mtime=\? /, 'missing bundle must not throw');

  process.env.JEV_LAYA_IDLE_MS = '30';
  const orig = process.stderr.write.bind(process.stderr);
  const seen = [];
  process.stderr.write = (s, ...a) => { if (String(s).includes('laya-load')) { seen.push(String(s)); return true; } return orig(s, ...a); };
  try {
    const adapter = makeLayaAdapter({ modelDir: dir, load: () => fakeLaya() });
    const Q = { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'yes', false: 'no' } } };
    await adapter('s', Q);
    await adapter('s', Q);
    assert.equal(seen.length, 1, 'warm calls do not reload');
    await new Promise((r) => setTimeout(r, 90));
    await adapter('s', Q);
    assert.equal(seen.length, 2, 'reload after idle unload is logged');
  } finally {
    process.stderr.write = orig;
    delete process.env.JEV_LAYA_IDLE_MS;
  }
});
