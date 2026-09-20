// Conformance: the SAME suite runs over stdio and Streamable HTTP and must
// return equivalent normalized results. Offline (deterministic fake adapter).
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildGateway } from '../src/config.js';
import { buildServer } from '../src/server.js';

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
  // Minimal child env: a full process.env spread can carry vars that break the
  // child's JSON-RPC framing; the child only needs a provider override.
  const base = { JEV_PROVIDER: 'fake', PATH: process.env.PATH, HOME: process.env.HOME };
  const transport = new StdioClientTransport({ command: process.execPath, args: [root + 'stdio.js'], env: base });
  const client = new McpClient({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function makeHttpClient() {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => Math.random().toString(36).slice(2) });
  const { gateway } = buildGateway({ provider: 'fake' });
  await buildServer(gateway).connect(transport);
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        try { res.writeHead(400).end(); } catch { /* ignore */ }
      }
      return;
    }
    if (req.method === 'GET') { await transport.handleRequest(req, res); return; }
    try { res.writeHead(405).end(); } catch { /* ignore */ }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const client = new McpClient({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return { client, transport, srv };
}

for (const tool of ['jev_evaluate', 'jev_apply_policy']) {
  const name = tool.includes('evaluate') ? 'evaluate-success' : 'apply-policy-accept';
  test(`conformance: ${name} equivalent over stdio and HTTP (${tool})`, async () => {
    const st = await makeStdioClient();
    const args = name === 'evaluate-success' ? SUITE[0].args : SUITE[1].args;
    const stRes = await normalize(await st.client.callTool({ name: tool, arguments: args }));
    await st.transport.close();

    const ht = await makeHttpClient();
    const htRes = await normalize(await ht.client.callTool({ name: tool, arguments: args }));
    await ht.client.close();
    ht.srv.close();

    assert.deepEqual(stRes, htRes, `${tool}: stdio and HTTP diverged`);
  });
}
