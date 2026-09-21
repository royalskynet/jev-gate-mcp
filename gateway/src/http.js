#!/usr/bin/env node
// Production Streamable HTTP entry. The MCP surface remains exactly /mcp;
// health/readiness/metrics are operational endpoints, not MCP tools.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { buildGateway } from './config.js';
import { buildServer } from './server.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const LOCAL_NAMES = ['localhost', '127.0.0.1', '[::1]'];

export const HTTP_DEFAULTS = Object.freeze({
  port: positiveInt(process.env.JEV_HTTP_PORT, 3456),
  host: process.env.JEV_HTTP_HOST ?? '127.0.0.1',
  maxBodyBytes: positiveInt(process.env.JEV_MAX_BODY_BYTES, 256 * 1024),
  rateLimit: positiveInt(process.env.JEV_HTTP_RATE_LIMIT, 60),
  rateWindowSeconds: positiveInt(process.env.JEV_HTTP_RATE_WINDOW_SECONDS, 60),
  maxInFlight: positiveInt(process.env.JEV_HTTP_MAX_IN_FLIGHT, 16),
  allowedHosts: csv(process.env.JEV_HTTP_ALLOWED_HOSTS),
  allowedOrigins: csv(process.env.JEV_HTTP_ALLOWED_ORIGINS),
  authTokenFile: process.env.JEV_HTTP_AUTH_TOKEN_FILE ?? null,
  shutdownMs: positiveInt(process.env.JEV_HTTP_SHUTDOWN_MS, 10_000),
  silent: process.env.JEV_HTTP_SILENT === '1',
});

/** Mount the production HTTP surface with injectable runtime/config for tests. */
export function createHttpServer(opts = {}) {
  const {
    port = 0,
    host = '127.0.0.1',
    maxBodyBytes = HTTP_DEFAULTS.maxBodyBytes,
    rateLimit = HTTP_DEFAULTS.rateLimit,
    rateWindowSeconds = HTTP_DEFAULTS.rateWindowSeconds,
    maxInFlight = HTTP_DEFAULTS.maxInFlight,
    allowedHosts = [],
    allowedOrigins = [],
    authToken = null,
    runtimeFactory = () => buildGateway(),
    // Backward-compatible test seam; production uses runtimeFactory so
    // readiness and metrics come from the same gateway runtime.
    gatewayFactory,
  } = opts;

  const loopback = LOOPBACK.has(host);
  if (!loopback && !authToken) throw new Error('non-loopback HTTP requires JEV_HTTP_AUTH_TOKEN_FILE');
  if (!loopback && authToken.length < 32) throw new Error('non-loopback HTTP bearer token must be at least 32 characters');
  if (!loopback && allowedHosts.length === 0) throw new Error('non-loopback HTTP requires JEV_HTTP_ALLOWED_HOSTS');

  const runtime = gatewayFactory
    ? { ...buildGateway({ provider: 'fake', telemetry: false }), gateway: gatewayFactory() }
    : runtimeFactory();
  const handler = createMcpHandler(() => buildServer(runtime.gateway));
  const nodeHandler = toNodeHandler(handler);
  const hostnames = loopback && allowedHosts.length === 0 ? LOCAL_NAMES : allowedHosts;
  const originNames = loopback && allowedOrigins.length === 0 ? LOCAL_NAMES : allowedOrigins;
  const validateHost = hostnames === LOCAL_NAMES ? localhostHostValidation() : hostHeaderValidation(hostnames);
  const validateOrigin = originNames === LOCAL_NAMES ? localhostOriginValidation() : originValidation(originNames);
  const limiter = new RateLimiterMemory({ points: rateLimit, duration: rateWindowSeconds });
  let inFlight = 0;

  const server = http.createServer(async (req, res) => {
    let route = 'unknown';
    let countedInFlight = false;
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      runtime.metrics?.recordHttp(route, res.statusCode);
      if (countedInFlight) {
        inFlight -= 1;
        runtime.metrics?.changeInFlight(-1);
      }
    };
    res.once('finish', record);
    res.once('close', record);

    // Official MCP SDK guards protect DNS rebinding before URL parsing.
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    route = routeName(url.pathname);

    if (url.pathname === '/health') {
      json(res, 200, { status: 'alive' });
      return;
    }
    if (!['/mcp', '/ready', '/metrics'].includes(url.pathname)) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req, authToken)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const rateKey = authToken ? tokenFingerprint(authToken) : (req.socket.remoteAddress ?? 'unknown');
    try {
      const limit = await limiter.consume(rateKey);
      res.setHeader('x-ratelimit-limit', String(rateLimit));
      res.setHeader('x-ratelimit-remaining', String(limit.remainingPoints));
    } catch (limit) {
      const waitSeconds = Math.max(1, Math.ceil((limit?.msBeforeNext ?? 1000) / 1000));
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(waitSeconds) })
        .end(JSON.stringify({ error: 'rate_limited' }));
      return;
    }

    if (url.pathname === '/ready') {
      const readiness = runtime.readiness?.() ?? { ready: true };
      json(res, readiness.ready ? 200 : 503, readiness);
      return;
    }
    if (url.pathname === '/metrics') {
      const body = await runtime.metrics.render();
      res.writeHead(200, { 'content-type': runtime.metrics.contentType }).end(body);
      return;
    }

    if (inFlight >= maxInFlight) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
        .end(JSON.stringify({ error: 'concurrency_limit' }));
      return;
    }
    inFlight += 1;
    countedInFlight = true;
    runtime.metrics?.changeInFlight(1);

    if ((req.method ?? 'GET').toUpperCase() === 'POST') {
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

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, port: server.address().port, host, runtime });
    });
  });
}

export async function closeHttpServer(server, timeoutMs = HTTP_DEFAULTS.shutdownMs) {
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

function authorized(req, expected) {
  if (!expected) return true;
  const value = req.headers.authorization ?? '';
  if (!value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function tokenFingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function routeName(pathname) {
  return ['/health', '/ready', '/metrics', '/mcp'].includes(pathname) ? pathname.slice(1) : 'unknown';
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

function csv(value) {
  return (value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function readSecret(file) {
  if (!file) return null;
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const authToken = readSecret(HTTP_DEFAULTS.authTokenFile);
  if (HTTP_DEFAULTS.authTokenFile && !authToken) throw new Error('HTTP auth token file is missing or empty');
  const started = await createHttpServer({ ...HTTP_DEFAULTS, authToken, runtimeFactory: () => buildGateway() });
  if (!HTTP_DEFAULTS.silent) {
    process.stderr.write(`jev-gate-mcp streamable http listening on ${started.host}:${started.port}/mcp\n`);
  }
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    if (!HTTP_DEFAULTS.silent) process.stderr.write(`jev-gate-mcp received ${signal}; draining\n`);
    await closeHttpServer(started.server);
    started.runtime.telemetry?.close();
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}
