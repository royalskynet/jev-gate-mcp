// Local cascade daemon: one HTTP surface for every host, Laya-first routing
// behind a shared cache. See docs/prd/PLAN-20261008-laya-first-cascade.md.
//
// The exported factory takes injected cascade/layaOnly/log so tests never load
// ONNX, hit the network, or read ~/.creds. The real chain is wired only when
// this file is executed directly (launchd).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

export function makeCascadeServer({ cascade, layaOnly, cascadeFor, log = logUsage, cacheMax = 2000, cacheTtlMs = 86400000, now = Date.now }) {
  const cache = new Map();
  return createServer(async (req, res) => {
    const started = now();
    const caller = 'cascade:' + (req.headers['x-jev-caller'] || 'unknown');
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const logReq = (status, model, usage = { input_tokens: 0, output_tokens: 0 }) => {
      log({ caller, model, status, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, latency_ms: now() - started });
    };

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
      const mode = req.headers['x-jev-mode'] === 'laya-only' ? 'laya-only' : 'cascade';
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
  const server = makeCascadeServer({ cascade, layaOnly, cascadeFor });
  const port = process.env.JEV_CASCADE_PORT ?? 8793;
  server.listen(port, '127.0.0.1');
}
