/**
 * agent-glue live wiring — the one place a host adapter gets a real provider.
 *
 * Every core module takes its transport/judge injected, which is what makes
 * them testable. The cost of that is the failure this file exists to stop: an
 * adapter that forgets to inject one still *works* — it fail-opens on every
 * turn and looks exactly like a healthy no-op. `scripts/live-probe.mjs` reports
 * that as NOT-LIVE.
 *
 * Everything here is lazy and fail-soft:
 *   - the gateway (pino, opossum, the policy registry) is imported on first
 *     use, not at hook-load time, so a session that never triages pays nothing;
 *   - no credential -> `null`, and the caller keeps its status quo. A missing
 *     key is never an error a host has to handle.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV } from '../claude/env.mjs';

const transportPromises = new Map();

/**
 * Question types triage lets the local Laya lane answer: `score` (difficulty).
 * `kind` rides the task-kind-v1 profile lane, which needs no type here.
 * `costly_mistake` is noul and deliberately absent — the cost of a wrong
 * "this is safe" stays with the cloud judge, whatever the MCP lane admits.
 */
export const TRIAGE_LAYA_QTYPES = Object.freeze(['score']);

const CLOUD_PROVIDERS = new Set(['zen', 'typesafe', 'openrouter']);

/**
 * Gateway overrides for the triage transport. With a Laya bundle on disk,
 * triage runs the laya router. A cloud JEV_PROVIDER (zen / typesafe /
 * openrouter — ~/.claude/settings.json sets `zen` for every Claude Code child)
 * is read as the router's cloud fallback, not as an opt-out: it was set to
 * pick the cloud host, before triage had a local lane. No bundle -> `{}`, the
 * gateway's own default (zen): a missing model is never a triage failure.
 * The bundle is the same one the MCP serves (JEV_LAYA_MODEL_DIR, else the
 * nightly-exported ~/.jevgate/laya-trained-onnx). Enabled by the bundle's
 * presence, not a flag (fix 9310).
 * @returns {object}
 */
export function triageGatewayConfig(env = ENV, exists = existsSync) {
  const qtypes = { layaQtypes: TRIAGE_LAYA_QTYPES };
  const p = env.JEV_PROVIDER;
  if (p === 'laya') return qtypes;
  if (p && !CLOUD_PROVIDERS.has(p)) return {}; // fake / anything unknown: leave it alone
  const dir = env.JEV_LAYA_MODEL_DIR || path.join(os.homedir(), '.jevgate', 'laya-trained-onnx');
  if (!exists(path.join(dir, 'laya.onnx'))) return {};
  return { provider: 'laya', layaModelDir: dir, ...qtypes,
    ...(p && !env.JEV_FALLBACK_PROVIDER ? { fallbackProvider: p } : {}) };
}

/**
 * The in-process gateway as an agent-glue transport, or `null` when there is
 * no usable credential. Built once per process and flavour. `{ triage: true }`
 * is the triage caller's gateway (Laya for difficulty/kind when the bundle is
 * there); every other caller (verify, retriever, jev-route) keeps the plain
 * env-configured gateway, so their score/noul questions do not move lanes.
 * @returns {Promise<object|null>}
 */
export function liveTransport({ triage = false } = {}) {
  const slot = triage ? 'triage' : 'default';
  if (!transportPromises.has(slot)) transportPromises.set(slot, (async () => {
    try {
      const [{ buildGateway }, { makeGatewayTransport }] = await Promise.all([
        import('../../gateway/src/config.js'),
        import('./client.js'),
      ]);
      // Telemetry off by default here: a hook writing JSONL to the host's
      // stderr is noise in a TUI, and the ledger is the durable record.
      const { gateway } = buildGateway({
        telemetry: ENV.JEV_TELEMETRY === 'on',
        ...(triage ? triageGatewayConfig() : {}),
      });
      return makeGatewayTransport(gateway);
    } catch {
      return null; // no credential / no provider -> caller keeps status quo
    }
  })());
  return transportPromises.get(slot);
}

let judgeCache;

/**
 * A live keep/drop judge for compaction and pruning, or a judge that always
 * answers `keep` when there is no credential (fail-open toward verbatim).
 * @returns {Promise<(state:object)=>Promise<'keep'|'drop'>>}
 */
export function liveJudge() {
  judgeCache ??= (async () => {
    try {
      const { makeJudge } = await import('../../plugin/lib/judge.js');
      return makeJudge();
    } catch {
      return async () => 'keep';
    }
  })();
  return judgeCache;
}

let layaJudgeCache;

/**
 * Legacy local judge entry: restricted to the same classification pilot as
 * the gateway. Other questions fail; difficulty/verification cannot bypass
 * provider routing through this helper. Loading remains lazy.
 * @returns {Promise<((state, questions)=>Promise<object>) | null>}
 */
export function localLayaJudge() {
  layaJudgeCache ??= (async () => {
    try {
      const { makeLayaAdapter } = await import('../../gateway/src/adapters.js');
      const { makeLayaRouter } = await import('../../gateway/src/laya-routing.js');
      const run = makeLayaRouter({ local: makeLayaAdapter({ modelDir: ENV.JEV_LAYA_MODEL_DIR }), cloud: null });
      return async (state, questions) => {
        return (await run(state, questions)).answers;
      };
    } catch {
      return null; // no local model -> caller keeps the status quo transport answers
    }
  })();
  return layaJudgeCache;
}

/** Test seam: drop the memoized provider handles. */
export function resetLive() {
  transportPromises.clear();
  judgeCache = undefined;
  layaJudgeCache = undefined;
}

/**
 * The local cascade daemon (gateway/src/cascade-server.js) as a triage
 * transport: one shared Laya load and a 24 h answer cache instead of a 522 MB
 * model per host process. Laya may answer only `TRIAGE_LAYA_QTYPES` (sent as
 * `x-jev-laya-qtypes`), so `costly_mistake` stays with the cloud judge exactly
 * as in-process. Any HTTP failure throws, and the caller falls back.
 */
// `proxy`: a tailscaled in userspace-networking mode cannot route to tailnet IPs
// directly; JEV_CASCADE_PROXY (its --outbound-http-proxy-listen) is used for
// this fetch only. Bun's fetch honours `proxy`; Node ignores it.
// `laneQtypes: null` sends no lane header: the daemon then uses its own router
// (state filter, whitelist lane, shadow) — route-judge, whose Laya lane is the
// calibrated whitelist, not a fixed question-type list.
export function cascadeTransport(url, { caller = 'triage', timeoutMs = 4000, fetchImpl = fetch, proxy = process.env.JEV_CASCADE_PROXY, laneQtypes = TRIAGE_LAYA_QTYPES } = {}) {
  const base = String(url).replace(/\/+$/, '');
  return {
    async evaluate(input) {
      const res = await fetchImpl(`${base}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jev-caller': caller,
          ...(laneQtypes ? { 'x-jev-laya-qtypes': laneQtypes.join(',') } : {}) },
        body: JSON.stringify({ state: input?.state, questions: input?.questions }),
        signal: AbortSignal.timeout(timeoutMs),
        ...(proxy && !base.startsWith('http://127.0.0.1') ? { proxy } : {}),
      });
      if (!res.ok) throw new Error(`cascade ${res.status}`);
      const j = await res.json();
      return { answers: j?.answers ?? {}, model: j?.model ?? null, coverage: 'complete', latency_ms: null };
    },
  };
}

// Loopback, or a tailnet peer (100.64.0.3/10 or a MagicDNS *.ts.net name): the
// shared daemon on another node (laya-only, source-IP allow list).
const CASCADE_URL = /^http:\/\/(127\.0\.0\.1|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.[a-z0-9-]+\.ts\.net):\d+\/?$/;

/** `~/.jevgate/cascade-callers.json` entry for `caller`, loopback or tailnet URLs only. */
export function cascadeUrlFor(caller, raw) {
  try {
    const url = JSON.parse(raw)?.[caller];
    return typeof url === 'string' && CASCADE_URL.test(url) ? url.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}
