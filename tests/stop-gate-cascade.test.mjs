import test from 'node:test';
import assert from 'node:assert/strict';
import { getStopModel, DEFAULT_CONFIG } from '../plugin/lib/judge.js';

// The Stop gate is the busiest Jev caller (~150/day) and used to bypass the
// usage ledger. It now goes through the local cascade daemon. The risk this
// guards: if the daemon is down, the gate must still reach Jev directly —
// otherwise every Stop fails open and the gate is silently off.

test('stop gate tags cascade requests and falls back to direct Jev when the daemon is down', async () => {
  const calls = [];
  let daemonUp = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body && JSON.parse(init.body) });
    if (url.startsWith('http://127.0.0.1:8793') && !daemonUp) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ error: { type: 'stub' } }), { status: 400 });
  };
  const cfg = { ...DEFAULT_CONFIG, stopCascadeUrl: 'http://127.0.0.1:8793/', zenStatusFile: '/nonexistent' };
  const model = getStopModel(cfg, fetchImpl);
  const ask = () => model.choice('state', { instructions: 'x', criteria: { a: 'a', b: 'b' } }).catch(() => null);

  await ask();
  assert.equal(calls[0].url, 'http://127.0.0.1:8793/v1/systemone');
  assert.equal(calls[0].headers['x-jev-caller'], 'stop-gate');
  assert.equal(calls.length, 2, 'daemon down must fall through to a direct call');
  assert.equal(calls[1].url, DEFAULT_CONFIG.baseUrl + '/v1/systemone');
  assert.equal(calls[1].body.model, DEFAULT_CONFIG.model);
  assert.notEqual(calls[1].headers.Authorization, 'Bearer cascade-local');

  calls.length = 0;
  daemonUp = true;
  await ask();
  assert.equal(calls.length, 1, 'daemon up must not also call Jev directly');
});
