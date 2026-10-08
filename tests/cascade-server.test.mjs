import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeCascadeServer } from '../gateway/src/cascade-server.js';

describe('cascade-server', () => {
  let server;
  let baseUrl;
  let logs;
  let cascadeCalls;
  let layaOnlyCalls;
  let cascadeImpl;
  let layaOnlyImpl;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    server = null;
  });

  const start = async (opts = {}) => {
    logs = [];
    cascadeCalls = 0;
    layaOnlyCalls = 0;
    cascadeImpl = opts.cascadeImpl || (async () => ({ model: 'fake/cascade', answers: { q1: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 2 } }));
    layaOnlyImpl = opts.layaOnlyImpl || (async () => ({ model: 'fake/laya', answers: { q1: { type: 'noul', noul: 0 } }, usage: { input_tokens: 3, output_tokens: 4 } }));
    const cascade = async (state, questions, o) => { cascadeCalls++; return cascadeImpl(state, questions, o); };
    const layaOnly = async (state, questions, o) => { layaOnlyCalls++; return layaOnlyImpl(state, questions, o); };
    const log = (rec) => { logs.push(rec); };
    server = makeCascadeServer({ cascade, layaOnly, log, ...opts.serverOpts });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  };

  const post = (body, headers = {}) => fetch(`${baseUrl}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  test('health returns ok', async () => {
    await start();
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('second identical request is served from cache', async () => {
    await start();
    const body = { state: { user_request: 'test' }, questions: { q1: { type: 'noul' } } };
    const r1 = await post(body);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-jev-cache'), null);
    const r2 = await post(body);
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-jev-cache'), 'hit');
    assert.equal(cascadeCalls, 1);
  });

  // A cached answer older than cacheTtlMs must go back upstream; otherwise a
  // stale judgment outlives the 24h the plan promises.
  test('expired cache entry is not served', async () => {
    let t = 0;
    await start({ serverOpts: { cacheTtlMs: 1000, now: () => t } });
    const body = { state: { user_request: 'ttl' }, questions: { q1: { type: 'noul' } } };
    await post(body);
    t = 1000;
    const r2 = await post(body);
    assert.equal(r2.headers.get('x-jev-cache'), null);
    assert.equal(cascadeCalls, 2);
  });

  test('x-jev-mode laya-only routes to layaOnly', async () => {
    await start();
    const body = { state: { user_request: 'test' }, questions: { q1: { type: 'noul' } } };
    const res = await post(body, { 'x-jev-mode': 'laya-only' });
    assert.equal(res.status, 200);
    assert.equal(layaOnlyCalls, 1);
    assert.equal(cascadeCalls, 0);
  });

  test('LAYA_ABSTAIN maps to 503', async () => {
    await start({ layaOnlyImpl: async () => { const e = new Error('abstain'); e.code = 'LAYA_ABSTAIN'; throw e; } });
    const body = { state: { user_request: 'test' }, questions: { q1: { type: 'noul' } } };
    const res = await post(body, { 'x-jev-mode': 'laya-only' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: { type: 'LAYA_ABSTAIN' } });
  });

  test('JEV_BUDGET_EXCEEDED maps to 402', async () => {
    await start({ cascadeImpl: async () => { const e = new Error('budget'); e.code = 'JEV_BUDGET_EXCEEDED'; throw e; } });
    const body = { state: { user_request: 'test' }, questions: { q1: { type: 'noul' } } };
    const res = await post(body);
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), { error: { type: 'JEV_BUDGET_EXCEEDED' } });
  });

  test('body.model is not forwarded to fn opts', async () => {
    let receivedOpts;
    await start({ cascadeImpl: async (s, q, o) => { receivedOpts = o; return { model: 'm', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; } });
    const body = { state: { user_request: 'test' }, questions: { q1: { type: 'noul' } }, model: 'evil-model' };
    await post(body);
    assert.deepEqual(receivedOpts, {});
  });

  test('log receives caller cascade:test', async () => {
    await start();
    const body = { state: { user_request: 'test' }, questions: { q1: { type: 'noul' } } };
    await post(body, { 'x-jev-caller': 'test' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].caller, 'cascade:test');
    assert.equal(logs[0].status, 200);
    assert.equal(logs[0].model, 'fake/cascade');
  });
});
