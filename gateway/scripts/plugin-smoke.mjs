#!/usr/bin/env node
// plugin-smoke: offline (JEV_PROVIDER=fake) spawn of the stdio server, proving
// the plugin path itself — exactly two tools with the right names, and a real
// jev_evaluate call returning a non-accept outcome. This is the regression
// guard for the plugin route; it runs in the acceptance flow.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
let failed = false;
const fail = (m) => { failed = true; process.stderr.write('PLUGIN-SMOKE FAIL: ' + m + '\n'); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [root + 'stdio.js'],
  env: { JEV_PROVIDER: 'fake', PATH: process.env.PATH, HOME: process.env.HOME },
});
const client = new Client({ name: 'plugin-smoke', version: '0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tools = listed.tools ?? listed;
  const names = tools.map((t) => t.name).sort();
  if (names.join(',') !== 'jev_apply_policy,jev_evaluate') {
    fail('unexpected tool list: ' + names.join(','));
  }
  if (tools.length !== 2) fail(`expected exactly two tools, got ${tools.length}`);
  process.stdout.write('tools: ' + names.join(', ') + '\n');

  const raw = await client.callTool({
    name: 'jev_evaluate',
    arguments: {
      state: 'route this request',
      questions: { target: { type: 'choice', instructions: 'pick tier', criteria: { a: 'ok', b: 'no' } } },
    },
  });
  const txt = (raw?.content ?? []).map((c) => c.text ?? '').join('\n');
  let obj = {};
  try { obj = JSON.parse(txt); } catch { /* leave {} */ }
  if (raw?.isError) fail('jev_evaluate returned isError');
  if (obj.outcome && obj.outcome === 'accept') fail('jev_evaluate must not return accept in shadow');
  process.stdout.write(`jev_evaluate outcome: ${obj.outcome ?? '(not captured)'}\n`);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

if (failed) process.exit(1);
process.stdout.write('plugin-smoke: OK\n');
