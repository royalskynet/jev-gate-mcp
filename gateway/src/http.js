#!/usr/bin/env node
// Streamable HTTP transport entry (hosted GPT/Claude clients).
// POST /mcp and GET /mcp (SSE) hit the SAME server that stdio uses.
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { buildGateway } from './config.js';
import { buildServer } from './server.js';

const PORT = Number(process.env.JEV_HTTP_PORT ?? 3456);
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
const { gateway } = buildGateway();
await buildServer(gateway).connect(transport);

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    await transport.handleRequest(req, res, body);
    return;
  }
  if (req.method === 'GET') {
    await transport.handleRequest(req, res);
    return;
  }
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  if (process.env.JEV_HTTP_SILENT !== '1') {
    process.stderr.write(`jev-gate-mcp streamable http listening on :${PORT}\n`);
  }
});
