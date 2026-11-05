// Laya: the local open-weights lane, kept out of adapters.js so the cloud
// adapters load without it (the public lite build ships without this file).
import os from 'node:os';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { JevDecisionModel } from 'jevwire';
import { ERR, LIMITS } from './core.js';
import { groupByCrop } from './laya-state.js';
// --- Laya: local open-weights Jev (quantized int8 checkpoint, local model dir) ---
// No apiKey. `loadLaya` serves a pre-downloaded bundle from $JEV_LAYA_MODEL_DIR
// (default ~/.jevgate/laya-multilingual-int8) — never hits the network at
// runtime, so the first request loads the ONNX session (a few seconds for the
// 540MB int8 graph). The gateway owns the overall deadline. It also adds the
// `[CLS]/[SEP]/[MASK]/[PAD]` tokenizer aliases in a shadow copy (upstream lacks
// them; receptron's id() requires them) and passes ORT CPU-memory options that
// keep the resident set small. On any load failure (missing files / load
// timeout) this throws; the router may use the configured Jev provider while
// the request still has time. One session is reused until idle unloading;
// a warm answer costs one forward pass. `systemOne` returns the same answer shape
// as Jev (choice/score/noul with probabilities), so the stateless gateway
// contract `(state, questions, opts) => result` applies here unchanged — opts
// is ignored (no model override on local weights).
export function makeLayaAdapter({ modelDir, timeoutMs = LIMITS.deadlineMs, load, cropStates, sessionOptions } = {}) {
  // Upstream laya-serve (official PyTorch runtime, fp32 on MPS) speaks the
  // same /v1/systemone contract, so with JEV_LAYA_SERVE_URL set (e.g.
  // http://127.0.0.1:8019) the local lane is an HTTP client instead of the
  // in-process ONNX bundle. Plain fetch, not usageFetch: a loopback call is
  // not a metered Jev attempt. The action head is quarantined like rl_agent
  // below. ponytail: 並存只為 int8 ONNX vs 上游 fp32 的 A/B 重量，量完擇一收斂成單一路徑
  const serveUrl = process.env.JEV_LAYA_SERVE_URL;
  if (serveUrl && !load) {
    const m = new JevDecisionModel({ apiKey: 'local', baseUrl: serveUrl, model: 'multilingual', timeoutMs, maxRetries: 0, fetch: globalThis.fetch });
    const serveAdapter = async (state, questions, _opts) => {
      const result = await m.evaluate({ state, questions });
      const answers = Object.fromEntries(Object.entries(result.answers ?? {}).map(([id, answer]) => {
        if (!answer || typeof answer !== 'object') return [id, answer];
        const { action, rl_agent, ...typed } = answer;
        return [id, typed];
      }));
      return { model: result.model, answers, usage: result.usage ?? { input_tokens: 0, output_tokens: 0 }, latency_ms: result.latency_ms ?? null };
    };
    serveAdapter.release = async () => {};
    return serveAdapter;
  }
  const loadBundle = async (dir) => {
    const { loadLaya } = await import('./laya-loader.js');
    return loadLaya({
      modelDir: dir,
      // receptron's Laya.load spreads these through (laya.js:46). They
      // keep onnxruntime's CPU memory arena from staging the whole graph.
      sessionOptions: {
        enableCpuMemArena: false,
        enableMemPattern: false,
        intraOpNumThreads: 2,
        ...(sessionOptions ?? {}),
      },
    });
  };
  let sessionPromise = null;
  let idleTimer = null;
  let crop = false;
  // Idle unload: release the ONNX session after JEV_LAYA_IDLE_MS (default
  // 600000ms = 10min) of no calls, so a gateway that triages rarely keeps ~0
  // resident memory between requests. Laya has no idempotent "release then
  // reuse" path — `close()` frees the session and the instance must not be
  // used afterwards — so we drop the cached promise and re-load on the next
  // call. The timer is unref'd so an idle process can still exit.
  const idleMs = Math.max(0, Number(process.env.JEV_LAYA_IDLE_MS) || 600000);
  const unload = async () => {
    idleTimer = null;
    const pending = sessionPromise;
    sessionPromise = null;
    if (!pending) return;
    try {
      const laya = await pending;
      if (laya?.close) await laya.close();
    } catch { /* already gone — nothing to release */ }
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void unload(); }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  const layaAdapter = async function layaAdapter(state, questions, opts = {}) {
    // The router hands the local lane its own slice of the request deadline
    // (laya-routing LOCAL_BUDGET_MS). Honour it: load and inference together
    // must fit, so a slow local run cannot eat the paid fallback's budget.
    const budgetMs = Number.isFinite(opts?.deadlineAtMs)
      ? Math.min(timeoutMs, Math.max(0, opts.deadlineAtMs - Date.now()))
      : timeoutMs;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!sessionPromise) {
      sessionPromise = (async () => {
        // Default bundle: the quantized int8 checkpoint. JEV_LAYA_MODEL_DIR
        // still wins; the fp16 bundle stays available for a manual switch.
        const dir = modelDir
          || process.env.JEV_LAYA_MODEL_DIR
          || path.join(os.homedir(), '.jevgate', 'laya-multilingual-int8');
        const t0 = Date.now();
        const laya = load ? await load() : await loadBundle(dir);
        crop = cropStates ?? (!load && bundleCrops(dir));
        logLayaLoad(dir, Date.now() - t0);
        return laya;
      })();
      // A failed download must not poison every later request: drop the cached
      // promise so the next call retries the load.
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    const laya = await deadline(sessionPromise, budgetMs, 'laya load');
    try {
      const left = Number.isFinite(opts?.deadlineAtMs)
        ? Math.max(0, opts.deadlineAtMs - Date.now()) : budgetMs;
      const result = await deadline(runChunked(laya, state, questions, left, undefined, crop), left, 'laya systemOne');
      // This bundle's action head exposes raw logits under act_probability.
      // It is unused for typed classification and cannot authorize anything.
      // Quarantine the entire extension; never clamp/sigmoid it into fake certainty.
      const answers = Object.fromEntries(Object.entries(result.answers ?? {}).map(([id, answer]) => {
        if (!answer || typeof answer !== 'object') return [id, answer];
        const { rl_agent, ...typed } = answer;
        return [id, typed];
      }));
      return {
        model: result.model,
        answers,
        usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
        latency_ms: null, // local runtime reports no wall time; gateway records its own
      };
    } finally {
      armIdle();
    }
  };
  layaAdapter.release = unload;
  return layaAdapter;
}

// receptron's systemOne pads every question into one [n, max_len] batch, so
// peak memory grows ~330MB per question at max_len 1024: a 190-question
// compact request in shadow reached 31GB (fix 10532). Run at most
// JEV_LAYA_BATCH questions per forward pass and stop between chunks once the
// deadline has passed — the outer deadline() cannot cancel ONNX work.
// With `crop`, questions anchored to one tool call see a per-call crop of the
// state (laya-state.js); a batch never mixes two crops.
export async function runChunked(laya, state, questions, timeoutMs, batch = Number(process.env.JEV_LAYA_BATCH) || 4, crop = false) {
  const stopAt = Date.now() + timeoutMs;
  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let model;
  let first = true;
  for (const group of crop ? groupByCrop(state, questions) : [{ state, questions }]) {
    const entries = Object.entries(group.questions);
    for (let i = 0; i < entries.length; i += batch) {
      if (!first) {
        await new Promise((r) => setImmediate(r));
        if (Date.now() >= stopAt) throw ERR.timeout(`laya systemOne exceeded ${timeoutMs}ms`);
      }
      first = false;
      const r = await laya.systemOne(group.state, Object.fromEntries(entries.slice(i, i + batch)));
      model ??= r.model;
      Object.assign(answers, r.answers ?? {});
      usage.input_tokens += r.usage?.input_tokens ?? 0;
      usage.output_tokens += r.usage?.output_tokens ?? 0;
    }
  }
  return { model, answers, usage };
}

/**
 * Weights trained on cropped states say so in laya_config.json (state_crop,
 * written by laya-export-onnx.py). Cropping for a bundle trained on whole
 * states would feed it inputs it never saw, so the flag rides with the weights.
 */
export function bundleCrops(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'laya_config.json'), 'utf8')).state_crop === true; } catch { return false; }
}

/**
 * One stderr line per Laya session load (cascade: ~/.jevgate/cascade.err.log).
 * Nightly swaps the bundle in place and the idle unload picks it up on the next
 * call; this line is the only record of when the new weights actually went live.
 */
export function logLayaLoad(dir, ms, write = (s) => process.stderr.write(s)) {
  let mtime = '?';
  try { mtime = statSync(path.join(dir, 'laya.onnx')).mtime.toISOString(); } catch { /* injected or missing bundle */ }
  write(`${new Date().toISOString()} laya-load dir=${dir} onnx_mtime=${mtime} ms=${ms}\n`);
}

function deadline(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(ERR.timeout(`${what} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
