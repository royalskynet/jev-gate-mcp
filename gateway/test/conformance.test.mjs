// Conformance (v2 SDK): the SAME suite runs over stdio and Streamable HTTP and
// must return equivalent normalized results. Offline (deterministic fake
// adapter). Also verifies the production HTTP surface via `createHttpServer`:
// exactly-two-tools, /health, unknown path 404, oversize body 413, and
// Host/Origin 403 guards.
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildGateway } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';

const root = fileURLToPath(new URL('../src/', import.meta.url));

const SUITE = [
  {
    name: 'evaluate-success',
    args: {
      state: 'route this request',
      questions: {
        target: {
          type: 'choice',
          instructions: 'pick the best tier',
          criteria: { main: 'routine', deep: 'long', review: 'risky', no_match: 'none' },
        },
      },
    },
  },
  {
    name: 'apply-policy-accept',
    args: {
      policy: 'completion-claims',
      state: { claims: ['tests pass'], evidence: 'pytest: 42 passed, 0 failed' },
    },
  },
];

async function normalize(raw) {
  const txt = (raw?.content ?? []).map((c) => c.text ?? '').join('\n');
  let obj = {};
  try { obj = JSON.parse(txt); } catch { /* leave {} */ }
  return {
    isError: !!raw?.isError,
    outcome: obj.outcome,
    policy: obj.policy,
    coverage: obj.coverage,
    errorCode: obj.error?.code ?? obj.unavailable?.code ?? null,
    answers: (obj.answers ?? []).map((a) => a.question),
    reasons: (obj.gate_reasons ?? []).map((r) => r.question),
  };
}

async function makeStdioClient() {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [root + 'stdio.js'],
    env: { JEV_PROVIDER: 'fake', PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(t);
  return { client, transport: t };
}

/** Boot the production HTTP server (fake gateway) and a client bound to /mcp. */
async function makeHttp(serverTest) {
  const { server, port } = await createHttpServer({ gatewayFactory: () => buildGateway({ provider: 'fake' }).gateway });
  serverTest.after(() => new Promise((r) => server.close(r)));
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return { client, base: `http://127.0.0.1:${port}` };
}

for (const tool of ['jev_evaluate', 'jev_apply_policy']) {
  const name = tool.includes('evaluate') ? 'evaluate-success' : 'apply-policy-accept';
  test(`conformance: ${name} equivalent over stdio and HTTP (${tool})`, async (t) => {
    const st = await makeStdioClient();
    const args = name === 'evaluate-success' ? SUITE[0].args : SUITE[1].args;
    const stRes = await normalize(await st.client.callTool({ name: tool, arguments: args }));
    await st.transport.close();

    const ht = await makeHttp(t);
    const htRes = await normalize(await ht.client.callTool({ name: tool, arguments: args }));
    await ht.client.close();

    assert.deepEqual(stRes, htRes, `${tool}: stdio and HTTP diverged`);
  });
}

test('conformance: server advertises exactly two tools with outputSchema', async (t) => {
  const ht = await makeHttp(t);
  const res = await ht.client.listTools();
  await ht.client.close();
  const tools = res.tools ?? res;
  assert.deepEqual(tools.map((x) => x.name).sort(), ['jev_apply_policy', 'jev_evaluate']);
  for (const tool of tools) {
    assert.ok(tool.outputSchema, `${tool.name} must advertise outputSchema`);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  assert.ok(SERVER_INSTRUCTIONS.length < 512, 'critical Codex instructions must fit the first 512 chars');
});

test('http: /health answers 200, unknown path answers 404', async (t) => {
  const ht = await makeHttp(t);
  assert.equal((await fetch(`${ht.base}/health`)).status, 200);
  assert.equal((await fetch(`${ht.base}/other`)).status, 404);
  assert.equal((await fetch(`${ht.base}/mcp/extra`)).status, 404);
});

test('http: oversize body answers 413', async (t) => {
  const ht = await makeHttp(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jev_evaluate', arguments: { state: 'y'.repeat(512 * 1024), questions: {} } } });
  const status = await rawRequest('POST', `${ht.base}/mcp`, {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': String(Buffer.byteLength(body)),
  }, body);
  assert.equal(status, 413, 'oversize body must be rejected');
});

test('http: POST without Content-Length is rejected before a chunked body can bypass the cap', async (t) => {
  const ht = await makeHttp(t);
  const status = await rawRequest('POST', `${ht.base}/mcp`, {
    'content-type': 'application/json',
    'transfer-encoding': 'chunked',
  }, '{}');
  assert.equal(status, 411);
});

test('http: non-localhost Host and Origin are rejected 403', async (t) => {
  const ht = await makeHttp(t);
  const badHost = await rawRequest('GET', `${ht.base}/mcp`, { host: 'evil.example.com' });
  assert.equal(badHost, 403, 'non-localhost Host must be rejected');
  const badOrigin = await rawRequest('POST', `${ht.base}/mcp`, {
    origin: 'https://evil.example.com',
    'content-type': 'application/json',
    'content-length': '2',
  }, '{}');
  assert.equal(badOrigin, 403, 'non-localhost Origin must be rejected');
  // A request without Origin is a normal non-browser client and must pass the guard.
  const okOrigin = await rawRequest('POST', `${ht.base}/mcp`, {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': String(Buffer.byteLength(JSON.stringify(SUITE[1].args))),
  }, JSON.stringify(SUITE[1].args));
  assert.notEqual(okOrigin, 403, 'request without Origin must pass the guard');
});

test('http: auth protects ready/metrics while health stays secret-free', async (t) => {
  const { server, port } = await createHttpServer({
    authToken: 'test-bearer-token',
    gatewayFactory: () => buildGateway({ provider: 'fake', telemetry: false }).gateway,
  });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'alive' });
  assert.equal((await fetch(`${base}/ready`)).status, 401);
  const headers = { authorization: 'Bearer test-bearer-token' };
  assert.equal((await fetch(`${base}/ready`, { headers })).status, 200);
  const metrics = await fetch(`${base}/metrics`, { headers });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /jev_http_requests_total/);
});

test('http: rate limit rejects excess protected requests with 429', async (t) => {
  const { server, port } = await createHttpServer({
    rateLimit: 1,
    authToken: 'rate-token',
    gatewayFactory: () => buildGateway({ provider: 'fake', telemetry: false }).gateway,
  });
  t.after(() => new Promise((r) => server.close(r)));
  const opts = { headers: { authorization: 'Bearer rate-token' } };
  assert.equal((await fetch(`http://127.0.0.1:${port}/ready`, opts)).status, 200);
  const limited = await fetch(`http://127.0.0.1:${port}/metrics`, opts);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('http: non-loopback bind fails loud without auth and explicit hosts', () => {
  assert.throws(() => createHttpServer({ host: '0.0.0.0' }), /requires JEV_HTTP_AUTH_TOKEN_FILE/);
  assert.throws(() => createHttpServer({ host: '0.0.0.0', authToken: 'x' }), /at least 32 characters/);
  assert.throws(() => createHttpServer({ host: '0.0.0.0', authToken: 'x'.repeat(32) }), /requires JEV_HTTP_ALLOWED_HOSTS/);
});

/** Issue a raw request so Host/Origin headers can be set arbitrarily. */
function rawRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}
