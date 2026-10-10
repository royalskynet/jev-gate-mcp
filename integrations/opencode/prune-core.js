/**
 * opencode prune core — L0 first, then the same Jev keep/drop judge the Claude
 * hook and the Hermes CLI use (`agent-glue/src/prune.js`), never a second one.
 *
 * Kept apart from `jev-laya.js` because opencode calls every function a plugin
 * module exports as a plugin: helpers exported from there would be invoked
 * with the plugin context and break the load.
 */
import { l0Prune } from '../../agent-glue/src/l0-prune.js';

export const MIN_CHARS = 2000;

// opencode tool id → `hooks/jev.js` TARGETS key (whose keep/drop criteria the
// judge uses). Tools not listed (edit, write, task…) are never sent to Jev:
// their output is the model's own work, not bulk to trim.
export const JEV_TOOLS = { bash: 'Bash', read: 'Read', grep: 'Grep', glob: 'Grep', webfetch: 'Bash' };

/**
 * A machine whose only Jev key is a TypeSafe one (M2) has no JEV_* in the
 * environment opencode's TUI was started from. The three fields move together
 * — the model id differs per host (hooks/jev.js refreshConfig), so pointing
 * the endpoint alone would fail open as a silent keep.
 */
export function defaultJevEnv(env, exists) {
  if (env.JEV_ENDPOINT) return false;
  const keyFile = `${env.HOME}/.creds/kv/TYPESAFE_API_KEY.txt`;
  if (!exists(keyFile)) return false;
  env.JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
  env.JEV_MODEL = 'jev-latest';
  env.JEV_API_KEY_FILE = keyFile;
  // The in-process gateway (triage) reads the provider, not the endpoint.
  env.JEV_PROVIDER ??= 'typesafe';
  return true;
}

/** Text of the newest user message in an opencode `session.messages` list. */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info?.role !== 'user') continue;
    const text = (m.parts ?? [])
      .filter((p) => p?.type === 'text' && typeof p.text === 'string' && !p.synthetic)
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

// Same wording as agent-glue/claude/compact-hook.mjs, so Claude and opencode
// compaction answer the same question.
export const COMPACT_CRITERIA = {
  keep: 'The call or its output still carries information the current task depends on — a file the work is being done in, an error being fixed, a result later steps refer back to.',
  drop: 'The payload has served its purpose: exploratory listing, a search that led nowhere, output already summarised into the conversation, or a check that has since been superseded.',
};

export const COMPACT_DEFAULTS = {
  atChars: 80000, // tool output in history before a pass runs (~20k tokens)
  minPartChars: 2000, // smaller outputs are not worth a judgment
  pinLast: 4, // newest messages are never touched
  headChars: 800, // how much of each output the judge sees
  maxPerPass: 48,
};

function completedTool(part) {
  return part?.type === 'tool' && part.state?.status === 'completed' && typeof part.state.output === 'string';
}

/**
 * Verbatim compaction over opencode's `experimental.chat.messages.transform`
 * payload: user/assistant text is never touched, only old tool outputs that
 * Jev judged `drop` are replaced by a marker. `decisions` (callID → verdict)
 * outlives the pass, so each output is judged once and a dropped one stays
 * dropped on every later turn — the prompt-cache prefix changes once per
 * pass, not once per turn. Mutates `messages` in place by swapping in copies
 * of the touched parts (opencode rebuilds the list from storage each turn).
 */
export async function compactParts(messages, { judge, decisions, opts = {} }) {
  const o = { ...COMPACT_DEFAULTS, ...opts };
  if (!Array.isArray(messages) || !decisions) return { dropped: 0, judged: 0, before: 0 };
  const editable = messages.slice(0, Math.max(0, messages.length - o.pinLast));
  const sites = [];
  let total = 0;
  for (const m of editable) {
    (m?.parts ?? []).forEach((p, i) => {
      if (!completedTool(p) || p.state.time?.compacted) return;
      total += p.state.output.length;
      if (p.state.output.length >= o.minPartChars && p.callID) sites.push({ m, i, p });
    });
  }
  let judged = 0;
  const fresh = sites.filter((s) => !decisions.has(s.p.callID)).slice(0, o.maxPerPass);
  if (total >= o.atChars && fresh.length && judge) {
    const request = lastUserText(messages);
    const segments = fresh.map(({ p }) => {
      const args = JSON.stringify(p.state.input ?? {}).slice(0, 300);
      return `tool: ${p.tool}\nargs: ${args}\noutput (${p.state.output.length} chars):\n${p.state.output.slice(0, o.headChars)}`;
    });
    const verdicts = await judge({ request, segments, criteria: COMPACT_CRITERIA }).catch(() => null);
    if (Array.isArray(verdicts) && verdicts.length === fresh.length) {
      fresh.forEach((s, k) => decisions.set(s.p.callID, verdicts[k] === 'drop' ? 'drop' : 'keep'));
      judged = fresh.length;
    }
  }
  let dropped = 0;
  for (const { m, i, p } of sites) {
    if (decisions.get(p.callID) !== 'drop') continue;
    const n = p.state.output.length;
    m.parts[i] = { ...p, state: { ...p.state, output: `[jev-compact: dropped ${n} chars; rerun the tool if it is needed again]` } };
    dropped += n;
  }
  // `before` = tool-output chars in the editable span, for the savings ledger.
  return { dropped, judged, before: total };
}

/**
 * Returns the text the model should see. `prune` is `pruneCommand`; it applies
 * its own 16 KB threshold, so the request is only fetched past that point.
 * Every failure answers with the L0 text — never less than the original.
 */
export async function shrink({ tool, text }, { prune, getRequest, jevMinChars = 16000 }) {
  const l0 = l0Prune(text).text;
  const target = JEV_TOOLS[tool];
  if (!target || !prune || l0.length < jevMinChars) return l0;
  try {
    const request = getRequest ? await getRequest() : '';
    if (!request) return l0;
    const r = await prune({ tool: target, request, text: l0 });
    return r?.judged && typeof r.text === 'string' ? r.text : l0;
  } catch {
    return l0;
  }
}

/** Thinking budget an easy turn is capped at (Anthropic / Gemini options). */
export const EASY_THINKING_BUDGET = 4000;

/**
 * Lower a provider's reasoning options for a turn triage called `cheap`.
 * Only ever lowers, never raises, and only touches knobs the model already
 * has set (a model without reasoning options is left alone). Nested objects
 * are replaced, not mutated: they may be the model config's own.
 * @returns {boolean} whether anything changed
 */
export function lowerEffort(options, tier) {
  if (tier !== 'cheap' || !options || typeof options !== 'object') return false;
  let changed = false;
  if (['medium', 'high', 'xhigh', 'max'].includes(options.reasoningEffort)) {
    options.reasoningEffort = 'low';
    changed = true;
  }
  const t = options.thinking;
  if (t && typeof t.budgetTokens === 'number' && t.budgetTokens > EASY_THINKING_BUDGET) {
    options.thinking = { ...t, budgetTokens: EASY_THINKING_BUDGET };
    changed = true;
  }
  const g = options.thinkingConfig;
  if (g && typeof g.thinkingBudget === 'number' && g.thinkingBudget > EASY_THINKING_BUDGET) {
    options.thinkingConfig = { ...g, thinkingBudget: EASY_THINKING_BUDGET };
    changed = true;
  }
  return changed;
}

/**
 * One triage per user message: `tierOf(text)` runs at most once per message
 * id (opencode calls chat.params once per model step, many per message), and
 * a slow or failing judgment answers `null` — status quo — after `timeoutMs`.
 */
export function effortTiers({ tierOf, timeoutMs = 1500, max = 200 }) {
  const seen = new Map();
  return (id, getText) => {
    if (!id) return Promise.resolve(null);
    if (!seen.has(id)) {
      if (seen.size >= max) seen.delete(seen.keys().next().value);
      const run = (async () => {
        const text = await getText();
        return text ? await tierOf(text) : null;
      })().catch(() => null);
      let timer;
      const late = new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); timer.unref?.(); });
      seen.set(id, Promise.race([run, late]).finally(() => clearTimeout(timer)));
    }
    return seen.get(id);
  };
}
