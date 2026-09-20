#!/usr/bin/env node
// Streamable HTTP transport entry (v2 `createMcpHandler` + Node adapter).
//
// Mounts exactly `/mcp` (everything else but `/health` is 404), answers
// `/health` without a provider round-trip, enforces localhost Host/Origin
// guards (DNS rebinding protection) and a transport-level request body limit,
// and serves both transports from the SAME Gateway core as stdio.
//
// The entry is also a normal export so the conformance suite mounts the real
// server (guards, routing, body limit included) in process — one source of
// truth for the HTTP surface.
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { buildGateway } from './config.js';
import { buildServer } from './server.js';

export const HTTP_DEFAULTS = Object.freeze({
  port: Number(process.env.JEV_HTTP_PORT ?? 3456),
  // Transport-level upper bound on any request body. The installed Node
  // adapter (2.0.0) has no built-in body cap, so it is enforced here; the
  // tool schemas additionally cap state size, so an oversized body never
  // reaches Jev and is never truncated.
  maxBodyBytes: Number(process.env.JEV_MAX_BODY_BYTES ?? 256 * 1024),
  silent: process.env.JEV_HTTP_SILENT === '1',
});

/**
 * Build the HTTP server exactly as the entry mounts it: Host/Origin guards,
 * `/health`, `/mcp`-only routing, and a request body limit. Reused by the
 * conformance suite so tests exercise the production surface.
 */
export function createHttpServer({ port = 0, maxBodyBytes = HTTP_DEFAULTS.maxBodyBytes, gatewayFactory = () => buildGateway().gateway } = {}) {
  const handler = createMcpHandler(() => buildServer(gatewayFactory()));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = http.createServer(async (req, res) => {
    // DNS rebinding protection first: non-localhost Host/Origin => 403.
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') {
      // Liveness for remote deployments; exposes no secrets, needs no provider.
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if ((req.method ?? 'GET').toUpperCase() === 'POST') {
      // Transport-level body cap. The Node adapter (2.0.0) has no built-in
      // limit, so reject an over-limit declared body here, before any Jev
      // work; a body is never truncated. Tool schemas additionally cap state
      // size, so an undersized-but-huge-state request is still rejected.
      const contentLength = Number(req.headers['content-length']);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        res.writeHead(411, { 'content-type': 'text/plain', connection: 'close' }).end('content-length required');
        return;
      }
      if (contentLength > maxBodyBytes) {
        res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' }).end('request body too large');
        return;
      }
    }
    await nodeHandler(req, res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Only listen when run directly (`node gateway/src/http.js`), not on import.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const { server, port } = await createHttpServer({ port: HTTP_DEFAULTS.port, silent: HTTP_DEFAULTS.silent });
  if (!HTTP_DEFAULTS.silent) {
    process.stderr.write(`jev-gate-mcp streamable http listening on :${port}/mcp\n`);
  }
}
