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

import { ENV } from '../claude/env.mjs';

let transportPromise;

/**
 * The in-process gateway as an agent-glue transport, or `null` when there is
 * no usable credential. Built once per process.
 * @returns {Promise<object|null>}
 */
export function liveTransport() {
  transportPromise ??= (async () => {
    try {
      const [{ buildGateway }, { makeGatewayTransport }] = await Promise.all([
        import('../../gateway/src/config.js'),
        import('./client.js'),
      ]);
      // Telemetry off by default here: a hook writing JSONL to the host's
      // stderr is noise in a TUI, and the ledger is the durable record.
      const { gateway } = buildGateway({ telemetry: ENV.JEV_TELEMETRY === 'on' });
      return makeGatewayTransport(gateway);
    } catch {
      return null; // no credential / no provider -> caller keeps status quo
    }
  })();
  return transportPromise;
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
 * A local Laya judge for the low-stakes triage questions (difficulty/kind) —
 * 缺口 2 低賭注本地化. Same lazy fail-soft shape as the other live handles:
 * no model dir / failed load -> null, and the caller keeps the cloud answers.
 * @returns {Promise<((state, questions)=>Promise<object>) | null>}
 */
export function localLayaJudge() {
  layaJudgeCache ??= (async () => {
    try {
      const { Laya } = await import('@receptron/laya');
      const { default: path } = await import('node:path');
      const { default: os } = await import('node:os');
      const dir = ENV.JEV_LAYA_MODEL_DIR || path.join(os.homedir(), '.jevgate', 'laya-multilingual');
      const laya = await Laya.load({ modelDir: dir });
      // Idle unload: same contract as gateway makeLayaAdapter — release the
      // session after JEV_LAYA_IDLE_MS (default 600000ms) of no triage calls.
      const idleMs = Math.max(0, Number(ENV.JEV_LAYA_IDLE_MS) || 600000);
      let idleTimer = null;
      let current = laya;
      const unload = async () => {
        idleTimer = null;
        const inst = current;
        current = null;
        if (inst) { try { if (inst.close) await inst.close(); } catch { /* already gone */ } }
      };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { void unload(); }, idleMs);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();
      };
      return async (state, questions) => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        try {
          if (!current) current = await Laya.load({ modelDir: dir });
          const r = await current.systemOne(state, questions);
          return r.answers;
        } finally {
          armIdle();
        }
      };
    } catch {
      return null; // no local model -> caller keeps the status quo transport answers
    }
  })();
  return layaJudgeCache;
}

/** Test seam: drop the memoized provider handles. */
export function resetLive() {
  transportPromise = undefined;
  judgeCache = undefined;
  layaJudgeCache = undefined;
}
