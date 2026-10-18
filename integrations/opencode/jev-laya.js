import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { MIN_CHARS, shrink, lastUserText, defaultJevEnv, compactParts, lowerEffort, effortTiers } from './prune-core.js';

export default {
  id: 'jev-laya',
  async setup(ctx) {
    defaultJevEnv(process.env, existsSync);
    // Read by usage-ledger at import time, so it must be set before the import.
    process.env.JEV_USAGE_CALLER ??= 'opencode';
    const glue = () => import('../../agent-glue/src/prune.js').catch(() => null);
    let mod;
    const decisions = new Map(); // callID -> 'keep' | 'drop', for the life of the TUI
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
    const compactLog = process.env.JEV_OPENCODE_COMPACT_LOG ?? `${process.env.HOME}/.jevgate/opencode-compact.log`;
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
          const prune = (await mod)?.pruneCommand;
          const request = lastUserText(await ctx.session.context({ sessionID: event.sessionID }));
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
          mod ??= glue();
          const judgeSegments = (await mod)?.judgeSegments;
          const r = await compactParts(event?.messages, { judge: judgeSegments, decisions });
          // One line per judging pass (not per turn: drops are re-applied every turn).
          if (r?.judged) {
            try {
              appendFileSync(compactLog, `${new Date().toISOString()}\tjev-compact(opencode): ${r.before} → ${r.before - r.dropped} chars, ${r.judged} judged\n`);
            } catch { /* observation only */ }
          }
        } catch {
          // Fail open: the model sees the history verbatim.
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
  },
};
