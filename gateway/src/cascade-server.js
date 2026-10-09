// Local cascade daemon: one HTTP surface for every host, Laya-first routing
// behind a shared cache. See docs/prd/PLAN-20261008-laya-first-cascade.md.
//
// The exported factory takes injected cascade/layaOnly/log so tests never load
// ONNX, hit the network, or read ~/.creds. The real chain is wired only when
// this file is executed directly (launchd).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { logUsage } from '../../agent-glue/src/usage-ledger.js';
import { DEFAULTS } from './config.js';
import { makeLayaAdapter, makeOpenrouterAdapter, makeZenAdapter } from './adapters.js';
import { withDailyBudget, withPaymentStop } from './budget.js';
import { makeLayaRouter } from './laya-routing.js';
import { withTeacherCorpus } from './teacher-corpus.js';
import { withRedaction } from './redact.js';

const MAX_BODY_BYTES = 1024 * 1024;

function readKey(file) {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function errorStatus(e) {
  if (e.code === 'JEV_BUDGET_EXCEEDED' || e.code === 'JEV_PAYMENT_REQUIRED') return 402;
  if (e.code === 'LAYA_ABSTAIN') return 503;
  if (e.status === 429) return 429;
  return 502;
}

// `x-jev-laya-qtypes: score,…` narrows which question types Laya may answer for
// this request (the rest go to the cloud), so a caller can keep its own lane
// policy — triage keeps `costly_mistake` (noul) on the cloud judge. Only
// honoured in cascade mode and only when `cascadeFor` is wired.
export function parseQtypesHeader(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const list = [...new Set(v.split(',').map((s) => s.trim()).filter((s) => /^[a-z_]{1,20}$/.test(s)))].sort();
  return list.length ? list : null;
}

// Peer names (HostName or the first DNS label) -> their tailnet IPs, read from
// `tailscale status --json`. The tailnet authenticates each peer with its own
// WireGuard node key, so a source IP from this list is that device.
export function resolveTailnetIps(status, names) {
  const want = new Set(names);
  const ips = [];
  for (const p of Object.values(status?.Peer ?? {})) {
    const label = (p.DNSName ?? '').split('.')[0];
    if (want.has(p.HostName) || want.has(label)) ips.push(...(p.TailscaleIPs ?? []));
  }
  return ips;
}

const normalizeIp = (ip) => (ip ?? '').replace(/^::ffff:/, '');

// allowFrom: source IPs allowed to call (null = no check, loopback-only use).
// mode 'laya-only': the server ignores x-jev-mode and never reaches the paid
// cloud judge, so a remote caller cannot spend money whatever it sends.
export function makeCascadeServer({ cascade, layaOnly, cascadeFor, log = logUsage, cacheMax = 2000, cacheTtlMs = 86400000, now = Date.now, allowFrom = null, mode: forcedMode = null }) {
  const cache = new Map();
  const allowed = allowFrom ? new Set(allowFrom.map(normalizeIp)) : null;
  return createServer(async (req, res) => {
    const started = now();
    // Remote calls are tagged so the usage ledger never mixes them with local ones.
    const caller = (allowed ? 'cascade:tailnet:' : 'cascade:') + (req.headers['x-jev-caller'] || 'unknown');
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const logReq = (status, model, usage = { input_tokens: 0, output_tokens: 0 }) => {
      log({ caller, model, status, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, latency_ms: now() - started });
    };

    if (allowed && !allowed.has(normalizeIp(req.socket.remoteAddress))) {
      send(403, { error: { type: 'forbidden' } });
      logReq(403, null);
      return;
    }

    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      send(200, { ok: true });
      logReq(200, null);
      return;
    }
    if (req.method === 'POST' && path === '/v1/systemone') {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { tooLarge = true; break; }
        chunks.push(chunk);
      }
      if (tooLarge) {
        send(413, { error: { type: 'payload_too_large' } });
        logReq(413, null);
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(422, { error: { type: 'invalid_request' } });
        logReq(422, null);
        return;
      }
      const questions = body?.questions;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !questions || typeof questions !== 'object' || Array.isArray(questions)
        || Object.keys(questions).length === 0) {
        send(422, { error: { type: 'invalid_request' } });
        logReq(422, null);
        return;
      }
      const mode = forcedMode === 'laya-only' || req.headers['x-jev-mode'] === 'laya-only' ? 'laya-only' : 'cascade';
      const lane = mode === 'cascade' && cascadeFor ? parseQtypesHeader(req.headers['x-jev-laya-qtypes']) : null;
      const fn = mode === 'laya-only' ? layaOnly : lane ? cascadeFor(lane) : cascade;
      const key = createHash('sha256').update(mode + (lane ? lane.join(',') : '') + JSON.stringify({ state: body.state, questions })).digest('hex');
      const hit = cache.get(key);
      if (hit && now() - hit.cachedAt >= cacheTtlMs) cache.delete(key);
      else if (hit) {
        send(200, hit.result, { 'x-jev-cache': 'hit' });
        logReq(200, 'cache');
        return;
      }
      try {
        const r = await fn(body.state, body.questions, {});
        const payload = {
          model: r.model ?? 'jev-cascade',
          answers: r.answers,
          usage: r.usage ?? { input_tokens: 0, output_tokens: 0 },
        };
        cache.set(key, { result: payload, cachedAt: now() });
        if (cache.size > cacheMax) cache.delete(cache.keys().next().value);
        send(200, payload);
        logReq(200, r.model ?? null, payload.usage);
      } catch (e) {
        const status = errorStatus(e);
        send(status, { error: { type: e.code ?? 'upstream' } });
        logReq(status, null);
      }
      return;
    }
    send(404, { error: { type: 'not_found' } });
    logReq(404, null);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const local = makeLayaAdapter({});
  const orKey = readKey(DEFAULTS.zenBackupKeyFile);
  const zenKey = readKey(DEFAULTS.apiKeyFile);
  const or = orKey ? withPaymentStop(withDailyBudget(makeOpenrouterAdapter({ apiKey: orKey }))) : null;
  const zen = zenKey ? makeZenAdapter({ apiKey: zenKey, model: 'jev-1.13-free', backup: or }) : or;
  let cascade = withRedaction(makeLayaRouter({ local, cloud: zen ? withTeacherCorpus(zen) : null }));
  const layaOnly = withRedaction(makeLayaRouter({ local, cloud: async () => { const e = new Error('laya abstained'); e.code = 'LAYA_ABSTAIN'; throw e; } }));
  if (process.env.JEV_CASCADE_MODE === 'laya-only') cascade = layaOnly;
  const lanes = new Map();
  const cascadeFor = process.env.JEV_CASCADE_MODE === 'laya-only' ? null : (qtypes) => {
    const k = qtypes.join(',');
    if (!lanes.has(k)) lanes.set(k, withRedaction(makeLayaRouter({ local, cloud: zen ? withTeacherCorpus(zen) : null, qtypes })));
    return lanes.get(k);
  };
  // Shared instance (e.g. for M2): JEV_CASCADE_HOST=<this node's tailnet IP>,
  // JEV_CASCADE_ALLOW_NODES=m2-userspace. Fail closed: a non-loopback bind
  // needs a resolved allow list and runs laya-only.
  const host = process.env.JEV_CASCADE_HOST ?? '127.0.0.1';
  let allowFrom = null;
  if (host !== '127.0.0.1') {
    const names = (process.env.JEV_CASCADE_ALLOW_NODES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    let status = null;
    try {
      status = JSON.parse(execFileSync(process.env.TAILSCALE_BIN ?? 'tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 10000 }));
    } catch {}
    allowFrom = resolveTailnetIps(status, names);
    if (allowFrom.length === 0 || process.env.JEV_CASCADE_MODE !== 'laya-only') {
      console.error(`refusing to bind ${host}: need JEV_CASCADE_MODE=laya-only and tailnet peers for JEV_CASCADE_ALLOW_NODES (got ${allowFrom.length} IPs)`);
      process.exit(78);
    }
  }
  // ponytail: no bearer token; tailnet node keys + source IP + laya-only make a
  // leaked URL worthless. Add one if this ever binds beyond the tailnet.
  const server = makeCascadeServer({ cascade, layaOnly, cascadeFor, allowFrom, mode: process.env.JEV_CASCADE_MODE ?? null });
  const port = process.env.JEV_CASCADE_PORT ?? 8793;
  server.listen(port, host);
}
