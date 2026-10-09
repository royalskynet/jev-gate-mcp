import { appendFileSync, existsSync } from 'node:fs';
import { MIN_CHARS, shrink, lastUserText, defaultJevEnv, compactParts, lowerEffort, effortTiers } from './prune-core.js';

// Only the plugin is exported: opencode runs every exported function as one.
export const JevLaya = async ({ client } = {}) => {
  defaultJevEnv(process.env, existsSync);
  // Read by usage-ledger at import time, so it must be set before the import.
  process.env.JEV_USAGE_CALLER ??= 'prune:opencode';
  const glue = () => import('../../agent-glue/src/prune.js').catch(() => null);
  let mod;
  const decisions = new Map(); // callID -> 'keep' | 'drop', for the life of the TUI
  const requestOf = async (sessionID) => {
    if (!client?.session?.messages || !sessionID) return '';
    const r = await client.session.messages({ path: { id: sessionID } });
    return lastUserText(r?.data ?? r);
  };
  const triageCache = new Map();
  // Built in the background at load: a cold gateway took 2.3 s, past the
  // per-message deadline, so the first turn would always miss.
  const ready = process.env.JEV_EFFORT_ENABLED === '0' ? null : Promise.all([
    import('../../agent-glue/src/triage.js'),
    import('../../agent-glue/src/live.js').then((m) => m.liveTransport({ triage: true })),
  ]).catch(() => null);
  // Log-only (the default) never holds the turn, so it can wait for the answer.
  const applyEffort = process.env.JEV_EFFORT_APPLY === '1';
  const tierFor = effortTiers({
    timeoutMs: applyEffort ? 1500 : 15000,
    tierOf: async (text) => {
      const [{ triage }, transport] = (await ready) ?? [{}, null];
      if (!transport) return null;
      const d = await triage({ text }, { transport, cache: triageCache });
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
        const prune = (await mod)?.pruneCommand;
        const getRequest = () => requestOf(input?.sessionID);
        const text = await shrink({ tool: input?.tool, text: output.output }, { prune, getRequest });
        if (text.length < output.output.length) output.output = text;
      } catch {
        // fail-open: leave original output untouched
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      if (process.env.JEV_COMPACT_ENABLED === '0') return;
      try {
        mod ??= glue();
        const judgeSegments = (await mod)?.judgeSegments;
        await compactParts(output?.messages, { judge: judgeSegments, decisions });
      } catch {
        // fail-open: the model sees the history verbatim
      }
    },
    'chat.message': async (input, output) => {
      if (process.env.JEV_EFFORT_ENABLED === '0') return;
      try {
        const id = output?.message?.id;
        const text = lastUserText([{ info: { role: 'user' }, parts: output?.parts }]);
        if (!id || !text) return;
        if (msgText.size >= 200) msgText.delete(msgText.keys().next().value);
        msgText.set(id, text);
        // start judging now, so chat.params usually finds the answer waiting
        void Promise.resolve(ready).then(() => tierFor(id, textOf(id, input?.sessionID)));
      } catch {
        /* fail-open */
      }
    },
    // Easy turns think less: one triage per user message, only ever lowers.
    // Log-only until JEV_EFFORT_APPLY=1: measure how often it would fire first.
    'chat.params': async (input, output) => {
      if (process.env.JEV_EFFORT_ENABLED === '0') return;
      try {
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
