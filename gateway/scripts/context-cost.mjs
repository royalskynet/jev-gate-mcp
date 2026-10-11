#!/usr/bin/env node
// context-cost: measure the standing per-session context cost of mounting this
// MCP plugin. The host serializes `tools/list` plus the server's initialization
// instructions into the system prompt before any tool runs, so this is the only
// quantifyable number behind the "fewer tools, smaller context" design goal.
// Estimates tokens as bytes/4 (a standard English approx) and prints three lines.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { SERVER_INSTRUCTIONS } from '../src/server.js';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
const est = (b) => Math.ceil(b / 4);

// instructions: the exact string this server sends to the host at init (from
// server.js), so the number is real even though the MCP client hides it.
const instructionsB = bytes(SERVER_INSTRUCTIONS);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [root + 'stdio.js'],
  env: { JEV_PROVIDER: 'fake', PATH: process.env.PATH, HOME: process.env.HOME },
});
const client = new Client({ name: 'context-cost', version: '0' });

let toolsB = 0;
try {
  await client.connect(transport);
  const listed = await client.listTools();
  toolsB = bytes(listed.tools ?? listed);
  // sanity: the spawned stdio server must agree with the imported surface
  if ((listed.tools ?? listed).length !== 2) {
    process.stderr.write('CONTEXT-COST FAIL: unexpected tool count\n');
    process.exit(1);
  }
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

const totalB = toolsB + instructionsB;
process.stdout.write(`tools/list: ${toolsB} B / ${est(toolsB)} tokens\n`);
process.stdout.write(`instructions: ${instructionsB} B / ${est(instructionsB)} tokens\n`);
process.stdout.write(`total: ${totalB} B / ${est(totalB)} tokens\n`);
