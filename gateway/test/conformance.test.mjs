// Conformance (v2 SDK): the two-tool surface over the stdio transport, offline
// with a deterministic fake adapter. Asserts exactly-two tools, tool
// annotations/outputSchema, and that each tool returns a non-accept outcome
// (every starter policy is shadow + uncalibrated, capped at review).
import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SERVER_INSTRUCTIONS } from '../src/server.js';

const root = fileURLToPath(new URL('../src/', import.meta.url));

const SUITE = [
  {
    name: 'evaluate-success',
    tool: 'jev_evaluate',
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
    tool: 'jev_apply_policy',
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

for (const { name, tool, args } of SUITE) {
  test(`conformance: ${name} returns a gate over stdio (${tool})`, async () => {
    const { client, transport } = await makeStdioClient();
    const res = await normalize(await client.callTool({ name: tool, arguments: args }));
    await transport.close();
    assert.equal(res.isError, false, `${tool}: call must not error`);
    assert.ok(res.outcome && res.outcome !== 'accept', `${tool}: outcome must be non-accept, got ${res.outcome}`);
    assert.ok(res.coverage, `${tool}: must report coverage`);
  });
}

test('conformance: server advertises exactly two tools with outputSchema', async () => {
  const { client, transport } = await makeStdioClient();
  const res = await client.listTools();
  await transport.close();
  const tools = res.tools ?? res;
  assert.deepEqual(tools.map((x) => x.name).sort(), ['jev_apply_policy', 'jev_evaluate']);
  for (const tool of tools) {
    assert.ok(tool.outputSchema, `${tool.name} must advertise outputSchema`);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  assert.ok(SERVER_INSTRUCTIONS.length < 512, 'critical Codex instructions must fit the first 512 chars');
});
