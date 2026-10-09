import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeTransport, cascadeUrlFor, TRIAGE_LAYA_QTYPES } from '../../agent-glue/src/live.js';

// The daemon must get the same Laya lane as in-process triage, or switching
// transports silently hands costly_mistake (noul) to Laya.
test('cascadeTransport sends the triage Laya lane and keys answers by question id', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ model: 'laya', answers: { difficulty: { type: 'score', score: 0.2 } } }) };
  };
  const t = cascadeTransport('http://127.0.0.1:8793/', { caller: 'effort:test', fetchImpl });
  const r = await t.evaluate({ state: { user_request: 'x' }, questions: { difficulty: {} } });
  assert.equal(seen.url, 'http://127.0.0.1:8793/v1/systemone');
  assert.equal(seen.headers['x-jev-laya-qtypes'], TRIAGE_LAYA_QTYPES.join(','));
  assert.equal(seen.headers['x-jev-laya-qtypes'].includes('noul'), false);
  assert.equal(r.answers.difficulty.score, 0.2);
});

test('cascadeTransport throws on a non-2xx so the caller can fall back', async () => {
  const t = cascadeTransport('http://127.0.0.1:1', { fetchImpl: async () => ({ ok: false, status: 502 }) });
  await assert.rejects(() => t.evaluate({ questions: {} }), /cascade 502/);
});

test('cascadeUrlFor accepts loopback or tailnet only, per caller', () => {
  assert.equal(cascadeUrlFor('effort', '{"effort":"http://127.0.0.1:8793/"}'), 'http://127.0.0.1:8793');
  assert.equal(cascadeUrlFor('effort', '{"compact":"http://127.0.0.1:8793"}'), '');
  assert.equal(cascadeUrlFor('effort', '{"effort":"http://evil.example:8793"}'), '');
  assert.equal(cascadeUrlFor('effort', 'not json'), '');
  // M2 -> 51mini shared daemon over the tailnet.
  assert.equal(cascadeUrlFor('effort', '{"effort":"http://100.96.184.1:8793"}'), 'http://100.96.184.1:8793');
  assert.equal(cascadeUrlFor('effort', '{"effort":"http://51minidemac-mini.tail5498f5.ts.net:8793"}'), 'http://51minidemac-mini.tail5498f5.ts.net:8793');
  // 100.x outside 100.64.0.0/10 is public address space, not the tailnet.
  assert.equal(cascadeUrlFor('effort', '{"effort":"http://100.1.2.3:8793"}'), '');
  assert.equal(cascadeUrlFor('effort', '{"effort":"http://evil.ts.net.example.com:8793"}'), '');
  assert.equal(cascadeUrlFor('effort', '{"effort":"https://100.96.184.1:8793"}'), '');
});

test('cascadeTransport passes proxy for tailnet URLs only', async () => {
  const seen = [];
  const fetchImpl = async (u, init) => { seen.push(init.proxy); return { ok: true, json: async () => ({ answers: {} }) }; };
  await cascadeTransport('http://100.96.184.1:8793', { fetchImpl, proxy: 'http://localhost:1055' }).evaluate({ questions: {} });
  await cascadeTransport('http://127.0.0.1:8793', { fetchImpl, proxy: 'http://localhost:1055' }).evaluate({ questions: {} });
  assert.deepEqual(seen, ['http://localhost:1055', undefined]);
});
