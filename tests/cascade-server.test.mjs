import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeCascadeServer, resolveTailnetIps, tailnetBindAllowed } from '../gateway/src/cascade-server.js';

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
    // 只帶伺服器自己標的 caller（給 laya-handoff.jsonl），呼叫端給的 model 不得進來
    assert.deepEqual(receivedOpts, { caller: 'cascade:unknown' });
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

  test('caller header already prefixed with cascade: is not doubled', async () => {
    await start();
    const body = { state: { user_request: 'test' }, questions: { q1: { type: 'noul' } } };
    await post(body, { 'x-jev-caller': 'cascade:compact' });
    await post({ ...body, state: { user_request: 'test2' } }, { 'x-jev-caller': 'cascade:' });
    assert.deepEqual(logs.map(l => l.caller), ['cascade:compact', 'cascade:unknown']);
  });

  // Triage keeps costly_mistake (noul) on the cloud judge; the header is how it
  // says so to the daemon. Without it the default lane (score,noul) would let
  // Laya call a risky task "safe" and the effort knob would drop on it.
  test('x-jev-laya-qtypes picks a per-request lane, keyed separately in the cache', async () => {
    const lanes = [];
    await start({ serverOpts: { cascadeFor: (q) => { lanes.push(q.join(',')); return async () => ({ model: 'fake/lane', answers: { q1: { type: 'score', score: 1 } } }); } } });
    const body = { state: { user_request: 'x' }, questions: { q1: { type: 'score' } } };
    const r1 = await post(body, { 'x-jev-laya-qtypes': 'score, BAD!,score' });
    assert.equal((await r1.json()).model, 'fake/lane');
    assert.deepEqual(lanes, ['score']);
    assert.equal(cascadeCalls, 0);
    const r2 = await post(body); // no header -> default cascade, not the lane's cache entry
    assert.equal((await r2.json()).model, 'fake/cascade');
    assert.equal(r2.headers.get('x-jev-cache'), null);
  });

  // Shared instance for another tailnet node: anyone else who reaches the port
  // (other tailnet devices, a leaked URL) must be turned away before any judge runs.
  test('allowFrom rejects other source IPs with 403 and never calls a judge', async () => {
    await start({ serverOpts: { allowFrom: ['100.64.0.1'] } });
    const res = await post({ questions: { q1: { type: 'noul' } } });
    assert.equal(res.status, 403);
    assert.equal(cascadeCalls + layaOnlyCalls, 0);
    assert.equal(logs[0].status, 403);
    assert.equal(logs[0].caller, 'cascade:tailnet:unknown');
  });

  test('allowFrom admits a listed IP written in IPv4-mapped form', async () => {
    await start({ serverOpts: { allowFrom: ['::ffff:127.0.0.1'] } });
    const res = await post({ questions: { q1: { type: 'noul' } } });
    assert.equal(res.status, 200);
  });

  // The shared instance must not let the caller opt back into the paid cloud
  // judge: no x-jev-mode header (or any value) still lands on layaOnly.
  test('forced laya-only mode ignores the caller header', async () => {
    await start({ serverOpts: { mode: 'laya-only' } });
    const r1 = await post({ questions: { q1: { type: 'noul' } } });
    const r2 = await post({ questions: { q1: { type: 'score' } } }, { 'x-jev-mode': 'cascade', 'x-jev-laya-qtypes': 'score' });
    assert.equal((await r1.json()).model, 'fake/laya');
    assert.equal((await r2.json()).model, 'fake/laya');
    assert.equal(cascadeCalls, 0);
  });

  test('forced laya-only: Laya abstain is a 503, not a cloud call', async () => {
    await start({ serverOpts: { mode: 'laya-only' }, layaOnlyImpl: async () => { const e = new Error('abstain'); e.code = 'LAYA_ABSTAIN'; throw e; } });
    const res = await post({ questions: { q1: { type: 'noul' } } });
    assert.equal(res.status, 503);
    assert.equal(cascadeCalls, 0);
  });

  test('resolveTailnetIps matches HostName or DNS label only', () => {
    const status = { Peer: {
      a: { HostName: 'm2-userspace', DNSName: 'm2-userspace.tail.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] },
      b: { HostName: 'phone', DNSName: 'phone.tail.ts.net.', TailscaleIPs: ['100.1.1.1'] },
    } };
    assert.deepEqual(resolveTailnetIps(status, ['m2-userspace']), ['100.64.0.1', 'fd7a::1']);
    assert.deepEqual(resolveTailnetIps(status, []), []);
    assert.deepEqual(resolveTailnetIps(null, ['m2-userspace']), []);
  });

  test('cloudCallers: listed caller reaches cascade, others run laya-only', async () => {
    await start({ serverOpts: { cloudCallers: ['compact'] } });
    const body = { questions: { q1: { type: 'noul' } } };
    assert.equal((await post({ ...body, state: 'a' }, { 'x-jev-caller': 'compact' })).status, 200);
    assert.equal(cascadeCalls, 1);
    assert.equal(layaOnlyCalls, 0);
    assert.equal((await post({ ...body, state: 'b' }, { 'x-jev-caller': 'stop-gate' })).status, 200);
    assert.equal((await post({ ...body, state: 'c' }, { 'x-jev-caller': 'effort:opencode' })).status, 200);
    assert.equal((await post({ ...body, state: 'd' })).status, 200);
    assert.equal(cascadeCalls, 1);
    assert.equal(layaOnlyCalls, 3);
  });

  test('x-jev-laya-qtypes is ignored in laya-only mode', async () => {
    await start({ serverOpts: { cascadeFor: () => { throw new Error('must not be called'); } } });
    const r = await post({ questions: { q1: { type: 'score' } } }, { 'x-jev-mode': 'laya-only', 'x-jev-laya-qtypes': 'score' });
    assert.equal((await r.json()).model, 'fake/laya');
  });
});

// A tailnet bind may reach the cloud only on explicit opt-in: without it a
// leaked tailnet URL could spend money, and with laya-only alone a triage
// request (costly_mistake is cloud-only) is refused whole — fix 10321.
describe('tailnetBindAllowed', () => {
  test('no resolved peers -> refuse, whatever the mode', () => {
    assert.equal(tailnetBindAllowed({ allowCount: 0, mode: 'laya-only', cloudOptIn: '1' }), false);
  });
  test('laya-only with peers -> allowed', () => {
    assert.equal(tailnetBindAllowed({ allowCount: 1, mode: 'laya-only' }), true);
  });
  test('cascade (cloud) needs JEV_CASCADE_TAILNET_CLOUD=1', () => {
    assert.equal(tailnetBindAllowed({ allowCount: 1, mode: undefined }), false);
    assert.equal(tailnetBindAllowed({ allowCount: 1, mode: undefined, cloudOptIn: 'true' }), false);
    assert.equal(tailnetBindAllowed({ allowCount: 1, mode: undefined, cloudOptIn: '1' }), true);
  });
});
