/**
 * jev-gate for openclaw — one Jev triage per turn, cheapest-model-only.
 *
 * Why this hook and not the others: openclaw's async *modify* points are
 * `before_model_resolve` (provider/model), `before_prompt_build` (context and
 * the turn's tool surface) and `before_tool_call` (params, block, approval).
 * Prune is still NOT portable: `tool_result_persist` is declared synchronous
 * (an async handler's result is logged and discarded) and `after_tool_call`
 * is observe-only. Compaction now is — openclaw 2026.9 added
 * `registerCompactionProvider()`, see compact-provider.mjs, selected with
 * `agents.defaults.compaction.provider = "jev-compact"`.
 *
 * Downgrade-only on purpose. The triage ladder maps cheap/medium/hard, but
 * only the `cheap` rung is wired: a wrong downgrade costs one weak answer on a
 * turn Jev scored as mechanical, while a wrong upgrade silently bills opus for
 * every ambiguous turn. `medium` and `hard` therefore resolve to
 * "no-model-map" -> status quo, which is also what happens with no credential,
 * no transport, a low-confidence answer, a risky turn or a large context (the
 * floors live in agent-glue/src/triage.js).
 *
 * `JEV_OPENCLAW_TRIAGE=off` or plugin config `triage: false` is the escape
 * hatch — use it when the default model is already the cheapest rung (a free
 * router) or the cheap provider is not configured, where a downgrade can only
 * route the turn onto a provider that does not exist. Every decision — change or
 * not — appends one line to ~/.openclaw/logs/jev-gate.jsonl, because a hook
 * that fires and decides "status quo" is otherwise indistinguishable from a
 * hook that never loaded (DEVLOG §17).
 */
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { spawnDecision } from '../../agent-glue/claude/spawn-hook.mjs';
import { makeProvider } from './compact-provider.mjs';

/**
 * The cheap rung, as this machine's openclaw config already spells it
 * (`agents.defaults.subagents.model = omniroute/Deepseek cheap`), so the
 * plugin ships able to decide instead of shipping an empty ladder that
 * resolves to "off" everywhere (DEVLOG §18.2).
 */
export const DEFAULT_CHEAP = { provider: 'omniroute', model: 'Deepseek cheap' };

/**
 * The plugin's own config block (plugins.entries["jev-gate"].config). api.config
 * and a hook's ctx.config are the whole openclaw config, so reading those made
 * every cheapProvider / cheapModel / minChars setting silently ineffective.
 */
export function pluginConfigOf(api) {
  return api?.pluginConfig ?? {};
}

/** Turns shorter than this are not worth a Jev request of their own. */
export const DEFAULT_MIN_CHARS = 200;

export const LEDGER = join(homedir(), '.openclaw', 'logs', 'jev-gate.jsonl');

/** One JSONL line per decision; never throws (observation only). */
export async function logDecision(entry, path = LEDGER) {
  try {
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  } catch {
    /* a ledger failure must not change the turn */
  }
}

/**
 * Decide one turn. Injected deps keep it testable: `{ transport, modelMap,
 * now }` go straight through to the shared triage core.
 * @returns {Promise<{override: {providerOverride?: string, modelOverride?: string}|null, entry: object}>}
 */
export async function decideTurn(event = {}, cfg = {}, deps = {}) {
  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  const cheap = {
    provider: cfg.cheapProvider ?? DEFAULT_CHEAP.provider,
    model: cfg.cheapModel ?? DEFAULT_CHEAP.model,
  };
  const minChars = Number(cfg.minChars ?? DEFAULT_MIN_CHARS);
  const base = { at: deps.now ?? new Date().toISOString(), chars: prompt.length };
  if ((deps.env ?? process.env).JEV_OPENCLAW_TRIAGE === 'off' || cfg.triage === false) {
    return { override: null, entry: { ...base, outcome: 'off' } };
  }
  if (!cheap.model) return { override: null, entry: { ...base, outcome: 'no-cheap-model' } };
  if (prompt.length < minChars) return { override: null, entry: { ...base, outcome: 'too-short' } };

  const d = await spawnDecision(
    { prompt, has_images: Boolean(event.attachments?.length) },
    { ...deps, forceEnabled: true, modelMap: { cheap: cheap.model } },
  );
  const entry = {
    ...base,
    outcome: d.change ? 'cheap' : d.reason,
    tier: d.decision?.tier ?? null,
    confidence: d.decision?.confidence ?? null,
    model: d.change ? `${cheap.provider}/${cheap.model}` : null,
  };
  if (!d.change) return { override: null, entry };
  return { override: { providerOverride: cheap.provider, modelOverride: cheap.model }, entry };
}

export default {
  id: 'jev-gate',
  name: 'Jev Gate',
  description: 'Jev triage onto the cheapest model, and Jev verbatim compaction.',
  register(api) {
    // Registered unconditionally: it only runs when the operator selects it
    // with agents.defaults.compaction.provider, and older hosts lack the API.
    api.registerCompactionProvider?.(makeProvider(pluginConfigOf(api)));
    // triage:false skips the hook entirely: a non-bundled plugin's
    // before_model_resolve needs hooks.allowConversationAccess, and granting
    // conversation access for a hook that is switched off buys nothing.
    if (pluginConfigOf(api).triage === false) return;
    api.on('before_model_resolve', async (event, ctx) => {
      // ponytail: config read per turn rather than cached — openclaw reloads
      // plugin config without restarting, and a triage is a network call
      // anyway, so one object read costs nothing measurable.
      const cfg = pluginConfigOf(api);
      const { override, entry } = await decideTurn(event ?? {}, cfg, {});
      await logDecision(entry);
      return override ?? undefined;
    });
  },
};
