import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MIN_CHARS, shrink, lastUserText, defaultJevEnv, compactParts, lowerEffort, effortTiers } from './prune-core.js';

// Both plugin APIs are exported from one module: opencode-ai 1.x (1.19 strict)
// calls `server` and rejects a module without it; @opencode/cli 2.x calls
// `setup`. Each ignores the other key (probed on 1.19.3 and 2.1.2, fix 11190).

const DEFAULT_COMPACT_TIMEOUT_MS = 8000;

// Build a judgeSegments-compatible function that routes via cascade daemon.
// Returns null only if no cascade URL; on transport errors returns 'keep' for
// all segments (fail-open, no paid fallback).
// A choice question without options is rejected upstream (Zen: "has 0 options"),
// and prune:opencode has none of its own; same pair as hooks/jev.js TARGETS.Bash.
const CHUNK_CRITERIA = {
  keep: "The chunk contains information directly needed to complete the user's current request/task.",
  drop: "The chunk is unrelated noise, duplicated boilerplate, or otherwise does not help complete the user's current request/task.",
};

export function makeCascadeJudge({ caller, readCallers, cascadeUrlFor, cascadeTransport, timeoutMs = 90000, log, transportImpl }) {
  return async ({ request, segments, criteria = CHUNK_CRITERIA }) => {
    const keepAll = (segments ?? []).map(() => 'keep');
    try {
      // Both prune:opencode and compact:opencode route via the `compact` key; caller is only the usage label.
      const url = cascadeUrlFor('compact', readCallers());
      if (!url) return null;
      const transport = transportImpl ?? cascadeTransport(url, { caller, laneQtypes: null, timeoutMs });
      if (!keepAll.length || !String(request ?? '').trim()) return keepAll;
      const INSTRUCTIONS = 'You are a context compactor. For each chunk, answer "drop" if the chunk is not needed to satisfy the user request, or "keep" if it may be needed. Prefer keep when unsure.';
      const verdictOf = (answer) => {
        if (answer?.choice === 'drop' || answer?.choice === 'keep') return answer.choice;
        const p = answer?.probabilities?.drop;
        return typeof p === 'number' && p >= 0.7 ? 'drop' : 'keep';
      };
      const per = 8;
      const starts = [];
      for (let i = 0; i < segments.length; i += per) starts.push(i);
      const parts = await Promise.all(starts.map(async (s) => {
        const batch = segments.slice(s, s + per);
        const questions = {};
        batch.forEach((_, i) => {
          questions[`c${i}`] = { type: 'choice', instructions: `${INSTRUCTIONS} Judge only the chunk at \`chunks[${i}]\`.`, criteria };
        });
        const r = await transport.evaluate({ state: { user_request: request, chunks: batch }, questions });
        return batch.map((_, i) => verdictOf(r?.answers?.[`c${i}`]));
      }));
      return parts.flat();
    } catch (e) {
      const reason = e?.name === 'AbortError' || /timeout|timed out/i.test(String(e?.message || e)) ? 'timeout' : String(e?.message || e).slice(0, 120);
      try { log?.(`fail-open ${reason}`); } catch {}
      throw e;
    }
  };
}

export function compactTimeoutMs(env = process.env) {
  const n = Number(env.JEV_COMPACT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPACT_TIMEOUT_MS;
}

export function createCompactRuntime({ callersFile, compactLog, liveMod, env = process.env, now = () => new Date().toISOString() } = {}) {
  const decisions = new Map();
  const originals = new Map();
  let failures = 0;
  let disabled = false;
  let skipLogged = false;
  const file = callersFile ?? `${env.HOME}/.jevgate/cascade-callers.json`;
  const logFile = compactLog ?? env.JEV_OPENCODE_COMPACT_LOG ?? `${env.HOME}/.jevgate/opencode-compact.log`;
  const writeLog = (msg) => { try { appendFileSync(logFile, `${now()}\tjev-compact(opencode): ${msg}\n`); } catch {} };
  const readCallers = () => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  const getLive = async () => liveMod ?? await import('../../agent-glue/src/live.js');
  const hasCascade = async () => {
    const m = await getLive();
    return Boolean(m.cascadeUrlFor('compact', readCallers()));
  };
  const skipNoCascade = async () => {
    if (skipLogged) return true;
    if (await hasCascade()) return false;
    skipLogged = true;
    writeLog('skip no-cascade');
    return true;
  };
  const recordFailure = (reason) => {
    writeLog(`fail-open ${String(reason).slice(0, 120)}`);
    failures += 1;
    if (failures >= 3 && !disabled) {
      disabled = true;
      writeLog('disabled after 3 failures');
    }
  };
  const judgeFor = async (usageCaller) => {
    if (disabled) return null;
    const m = await getLive();
    if (!m.cascadeUrlFor('compact', readCallers())) return null;
    const base = makeCascadeJudge({
      caller: usageCaller,
      readCallers,
      cascadeUrlFor: m.cascadeUrlFor,
      cascadeTransport: m.cascadeTransport,
      timeoutMs: compactTimeoutMs(env),
    });
    return async (args) => {
      if (disabled) return (args?.segments ?? []).map(() => 'keep');
      try {
        const v = await base(args);
        if (v === null) return null;
        failures = 0;
        return v;
      } catch (e) {
        const reason = e?.name === 'AbortError' || /timeout|timed out/i.test(String(e?.message || e)) ? 'timeout' : String(e?.message || e).slice(0, 120);
        recordFailure(reason);
        return (args?.segments ?? []).map(() => 'keep');
      }
    };
  };
  return { decisions, originals, judgeFor, skipNoCascade, hasCascade, writeLog, recordFailure, get disabled() { return disabled; }, get failures() { return failures; } };
}

// V1 hooks: server().
const JevLaya = async ({ client } = {}, deps = {}) => {
  defaultJevEnv(process.env, existsSync);
  // Read by usage-ledger at import time, so it must be set before the import.
  process.env.JEV_USAGE_CALLER ??= 'opencode';
  const glue = deps.glue ?? (() => import('../../agent-glue/src/prune.js').catch(() => null));
  let mod;
  const compact = createCompactRuntime(deps);
  if (!process.env.NODE_TEST_CONTEXT) compact.writeLog(`load v1 pid=${process.pid}`); // proves the host loaded the plugin
  const requestOf = async (sessionID) => {
    if (!client?.session?.messages || !sessionID) return '';
    const r = await client.session.messages({ path: { id: sessionID } });
    return lastUserText(r?.data ?? r);
  };
  const triageCache = new Map();
  // `{"effort": "http://127.0.0.1:8793"}` in cascade-callers.json sends triage
  // to the shared cascade daemon; re-read per turn, so switching needs no
  // restart. Without it (M2: no Laya) every judgment would be a paid Jev
  // call that buys nothing on free-pool models, so effort stays off unless
  // JEV_EFFORT_ENABLED=1 forces the in-process gateway.
  const forceEffort = process.env.JEV_EFFORT_ENABLED === '1';
  const callersFile = `${process.env.HOME}/.jevgate/cascade-callers.json`;
  const effortCascade = () => { try { return readFileSync(callersFile, 'utf8'); } catch { return ''; } };
  const live = process.env.JEV_EFFORT_ENABLED === '0' ? null : import('../../agent-glue/src/live.js').catch(() => null);
  let inProcess;
  const inProcessTransport = () => (inProcess ??= live.then((m) => m?.liveTransport({ triage: true }) ?? null));
  // Built in the background at load unless the daemon serves triage: a cold
  // gateway (with Laya in-process) took 2.3 s, past the per-message deadline.
  const ready = live && Promise.all([import('../../agent-glue/src/triage.js'), live]).catch(() => null);
  if (live && forceEffort) live.then((m) => { if (!m?.cascadeUrlFor('effort', effortCascade())) inProcessTransport(); });
  const effortUrl = async () => (await live)?.cascadeUrlFor('effort', effortCascade()) ?? '';
  const effortOn = async () => Boolean(live) && (forceEffort || Boolean(await effortUrl()));
  // Applied by default; JEV_EFFORT_APPLY=0 is log-only, which never holds the turn.
  const applyEffort = process.env.JEV_EFFORT_APPLY !== '0';
  const tierFor = effortTiers({
    timeoutMs: applyEffort ? 1500 : 15000,
    tierOf: async (text) => {
      const [{ triage }, m] = (await ready) ?? [{}, null];
      if (!triage || !m) return null;
      const url = m.cascadeUrlFor('effort', effortCascade());
      let d;
      if (url) {
        try { d = await triage({ text }, { transport: m.cascadeTransport(url, { caller: 'effort:opencode' }), cache: triageCache }); } catch { d = null; }
        if (d?.failOpen) d = null; // daemon down -> in-process below, only when forced
      }
      if (!d) {
        if (!forceEffort) return null;
        const transport = await inProcessTransport();
        if (!transport) return null;
        d = await triage({ text }, { transport, cache: triageCache });
      }
      return d.unchanged || d.failOpen ? null : d.tier;
    },
  });
  // chat.params gets the user message without its parts, and session.messages
  // does not list it yet, so the text is taken from chat.message.
  const msgText = new Map(); // user message id -> text
  const textOf = (id, sessionID) => () => msgText.get(id) ?? requestOf(sessionID);
  const logged = new Set(); // message ids already written to the effort log
  const effortLog = process.env.JEV_EFFORT_LOG ?? `${process.env.HOME}/.jevgate/opencode-effort.log`;
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (typeof output?.output !== 'string' || output.output.length < MIN_CHARS) return;
        mod ??= glue();
        const getRequest = () => requestOf(input?.sessionID);
        let prune = null;
        if (!compact.disabled && !(await compact.skipNoCascade())) {
          const cj = await compact.judgeFor('prune:opencode');
          if (cj) prune = (payload) => (mod ?? glue()).then(async (m) => m?.pruneCommand
            ? m.pruneCommand(payload, { judge: async (chunks) => (await cj({ request: payload.request, segments: chunks, criteria: undefined })) ?? chunks.map(() => 'keep') })
            : { text: payload.text, judged: false });
        }
        // No cascade -> L0 only (prune null). Never fall back to direct judge.
        const text = await shrink({ tool: input?.tool, text: output.output }, { prune, getRequest });
        if (text.length < output.output.length) output.output = text;
      } catch {
        // fail-open: leave original output untouched
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      if (process.env.JEV_COMPACT_ENABLED === '0') return;
      try {
        if (compact.disabled || await compact.skipNoCascade()) return;
        const judge = await compact.judgeFor('compact:opencode');
        if (!judge) return;
        const r = await compactParts(output?.messages, { judge, decisions: compact.decisions, originals: compact.originals });
        // One line per judging pass (not per turn: drops are re-applied every turn).
        if (r?.judged) compact.writeLog(`${r.before} → ${r.before - r.dropped} chars, ${r.judged} judged`);
      } catch (e) {
        const reason = e?.name === 'AbortError' || /timeout|timed out/i.test(String(e?.message || e)) ? 'timeout' : String(e?.message || e).slice(0, 120);
        compact.recordFailure(reason);
      }
    },
    'chat.message': async (input, output) => {
      if (process.env.JEV_EFFORT_ENABLED === '0') return;
      try {
        const id = output?.message?.id;
        const text = lastUserText([{ info: { role: 'user' }, parts: output?.parts }]);
        if (!id || !text || !(await effortOn())) return;
        if (msgText.size >= 200) msgText.delete(msgText.keys().next().value);
        msgText.set(id, text);
        // start judging now, so chat.params usually finds the answer waiting
        void Promise.resolve(ready).then(() => tierFor(id, textOf(id, input?.sessionID)));
      } catch {
        /* fail-open */
      }
    },
    // Easy turns think less: one triage per user message, only ever lowers.
    // JEV_EFFORT_APPLY=0 logs what it would lower without touching the options.
    'chat.params': async (input, output) => {
      if (process.env.JEV_EFFORT_ENABLED === '0') return;
      try {
        if (!(await effortOn())) return;
        const id = input?.message?.id;
        const model = input?.model?.id ?? '?';
        // one line per (message, model): the title model asks first, under the same id
        const fresh = Boolean(id) && !logged.has(`${id}\t${model}`);
        if (fresh) logged.add(`${id}\t${model}`);
        const knobs = ['reasoningEffort', 'thinking', 'thinkingConfig'].filter((k) => output?.options?.[k] !== undefined);
        const log = (tier, changed) => {
          if (!fresh) return;
          try {
            appendFileSync(effortLog, `${new Date().toISOString()}\t${model}\ttier=${tier ?? 'none'}\tknobs=${knobs.join(',') || '-'}\t${applyEffort ? 'lowered' : 'would_lower'}=${changed}\n`);
          } catch {
            /* observation only */
          }
        };
        if (!applyEffort) {
          const copy = { ...output?.options };
          void Promise.resolve(ready).then(() => tierFor(id, textOf(id, input?.sessionID))).then((t) => log(t, lowerEffort(copy, t)), () => {});
          return;
        }
        // a cold gateway is waited for once (capped), outside the per-message deadline
        if (ready) await Promise.race([ready, new Promise((r) => setTimeout(r, 4000).unref?.())]);
        const tier = await tierFor(id, textOf(id, input?.sessionID));
        log(tier, lowerEffort(output?.options, tier));
      } catch {
        // fail-open: the model's own reasoning settings stand
      }
    },
  };
};

// V2 hooks: setup(ctx), registered through ctx.session/ctx.tool.
async function setup(ctx, deps = {}) {
  defaultJevEnv(process.env, existsSync);
  // Read by usage-ledger at import time, so it must be set before the import.
  process.env.JEV_USAGE_CALLER ??= 'opencode';
  const glue = deps.glue ?? (() => import('../../agent-glue/src/prune.js').catch(() => null));
  let mod;
  const compact = createCompactRuntime(deps);
  if (!process.env.NODE_TEST_CONTEXT) compact.writeLog(`load v2 pid=${process.pid}`);
  const triageCache = new Map();
  // `{"effort": "http://127.0.0.1:8793"}` in cascade-callers.json sends triage
  // to the shared cascade daemon; re-read per turn, so switching needs no
  // restart. Without it (M2: no Laya) every judgment would be a paid Jev
  // call that buys nothing on free-pool models, so effort stays off unless
  // JEV_EFFORT_ENABLED=1 forces the in-process gateway.
  const forceEffort = process.env.JEV_EFFORT_ENABLED === '1';
  const callersFile = `${process.env.HOME}/.jevgate/cascade-callers.json`;
  const effortCascade = () => { try { return readFileSync(callersFile, 'utf8'); } catch { return ''; } };
  const live = process.env.JEV_EFFORT_ENABLED === '0' ? null : import('../../agent-glue/src/live.js').catch(() => null);
  let inProcess;
  const inProcessTransport = () => (inProcess ??= live.then((m) => m?.liveTransport({ triage: true }) ?? null));
  // Built in the background at load unless the daemon serves triage: a cold
  // gateway (with Laya in-process) took 2.3 s, past the per-message deadline.
  const ready = live && Promise.all([import('../../agent-glue/src/triage.js'), live]).catch(() => null);
  if (live && forceEffort) live.then((m) => { if (!m?.cascadeUrlFor('effort', effortCascade())) inProcessTransport(); });
  const effortUrl = async () => (await live)?.cascadeUrlFor('effort', effortCascade()) ?? '';
  const effortOn = async () => Boolean(live) && (forceEffort || Boolean(await effortUrl()));
  // Applied by default; JEV_EFFORT_APPLY=0 is log-only, which never holds the turn.
  const applyEffort = process.env.JEV_EFFORT_APPLY !== '0';
  const tierFor = effortTiers({
    timeoutMs: applyEffort ? 1500 : 15000,
    tierOf: async (text) => {
      const [{ triage }, m] = (await ready) ?? [{}, null];
      if (!triage || !m) return null;
      const url = m.cascadeUrlFor('effort', effortCascade());
      let d;
      if (url) {
        try { d = await triage({ text }, { transport: m.cascadeTransport(url, { caller: 'effort:opencode' }), cache: triageCache }); } catch { d = null; }
        if (d?.failOpen) d = null; // daemon down -> in-process below, only when forced
      }
      if (!d) {
        if (!forceEffort) return null;
        const transport = await inProcessTransport();
        if (!transport) return null;
        d = await triage({ text }, { transport, cache: triageCache });
      }
      return d.unchanged || d.failOpen ? null : d.tier;
    },
  });
  const textOf = (_id, text) => () => text;
  const logged = new Set(); // message ids already written to the effort log
  const effortLog = process.env.JEV_EFFORT_LOG ?? `${process.env.HOME}/.jevgate/opencode-effort.log`;
  await ctx.tool.hook('execute.after', async (event) => {
      try {
        if (event.status !== 'completed') return;
        const result = event.result;
        const content = result?.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
            : '';
        if (text.length < MIN_CHARS) return;
        mod ??= glue();
        const request = lastUserText(await ctx.session.context({ sessionID: event.sessionID }));
        let prune = null;
        if (!compact.disabled && !(await compact.skipNoCascade())) {
          const cj = await compact.judgeFor('prune:opencode');
          if (cj) prune = (payload) => (mod ?? glue()).then(async (m) => m?.pruneCommand
            ? m.pruneCommand(payload, { judge: async (chunks) => (await cj({ request: payload.request, segments: chunks, criteria: undefined })) ?? chunks.map(() => 'keep') })
            : { text: payload.text, judged: false });
        }
        // No cascade -> L0 only (prune null). Never fall back to direct judge.
        const shrunk = await shrink({ tool: event.tool, text }, { prune, getRequest: () => request });
        if (shrunk.length >= text.length) return;
        let firstText = true;
        event.result = {
          ...result,
          content: typeof content === 'string'
            ? shrunk
            : content.map((part) => {
              if (part?.type !== 'text') return part;
              const updated = { ...part, text: firstText ? shrunk : '' };
              firstText = false;
              return updated;
            }),
        };
      } catch {
        // Fail open: leave the tool result untouched.
      }
    });

  await ctx.session.hook('context', async (event) => {
      if (process.env.JEV_COMPACT_ENABLED === '0') return;
      try {
        if (compact.disabled || await compact.skipNoCascade()) return;
        const judge = await compact.judgeFor('compact:opencode');
        if (!judge) return;
        const r = await compactParts(event?.messages, { judge, decisions: compact.decisions, originals: compact.originals });
        // One line per judging pass (not per turn: drops are re-applied every turn).
        if (r?.judged) compact.writeLog(`${r.before} → ${r.before - r.dropped} chars, ${r.judged} judged`);
      } catch (e) {
        const reason = e?.name === 'AbortError' || /timeout|timed out/i.test(String(e?.message || e)) ? 'timeout' : String(e?.message || e).slice(0, 120);
        compact.recordFailure(reason);
      }
    });

  // V2 context runs immediately before each model dispatch. Reuse the newest
  // persisted user message and only lower reasoning settings on cheap turns.
  await ctx.session.hook('context', async (event) => {
      if (process.env.JEV_EFFORT_ENABLED === '0') return;
      try {
        if (!(await effortOn())) return;
        const lastUser = [...(event.messages ?? [])].reverse().find((m) => m?.info?.role === 'user');
        const id = lastUser?.info?.id;
        const text = lastUserText(lastUser ? [lastUser] : []);
        if (!id || !text) return;
        const model = event.model?.id ?? '?';
        const fresh = !logged.has(`${id}\t${model}`);
        if (fresh) logged.add(`${id}\t${model}`);
        const knobs = ['reasoningEffort', 'thinking', 'thinkingConfig'].filter((k) => event.options?.[k] !== undefined);
        const log = (tier, changed) => {
          if (!fresh) return;
          try {
            appendFileSync(effortLog, `${new Date().toISOString()}\t${model}\ttier=${tier ?? 'none'}\tknobs=${knobs.join(',') || '-'}\t${applyEffort ? 'lowered' : 'would_lower'}=${changed}\n`);
          } catch {
            /* observation only */
          }
        };
        const getText = textOf(id, text);
        if (!applyEffort) {
          const copy = { ...event.options };
          void Promise.resolve(ready).then(() => tierFor(id, getText)).then((t) => log(t, lowerEffort(copy, t)), () => {});
          return;
        }
        if (ready) await Promise.race([ready, new Promise((r) => setTimeout(r, 4000).unref?.())]);
        const tier = await tierFor(id, getText);
        log(tier, lowerEffort(event.options, tier));
      } catch {
        // Fail open: retain the model's configured reasoning settings.
      }
    });
}

export default { id: 'jev-laya', server: JevLaya, setup };
