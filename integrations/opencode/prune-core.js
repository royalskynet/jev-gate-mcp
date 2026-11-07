/**
 * opencode prune core — L0 first, then the same Jev keep/drop judge the Claude
 * hook and the Hermes CLI use (`agent-glue/src/prune.js`), never a second one.
 *
 * Kept apart from the plugin entry module because opencode calls every function a plugin
 * module exports as a plugin: helpers exported from there would be invoked
 * with the plugin context and break the load.
 */
import { createHash } from 'node:crypto';
import { l0Prune } from '../../agent-glue/src/l0-prune.js';

export const MIN_CHARS = 2000;

// opencode tool id → `hooks/jev.js` TARGETS key (whose keep/drop criteria the
// judge uses). Tools not listed (edit, write, task…) are never sent to Jev:
// their output is the model's own work, not bulk to trim.
export const JEV_TOOLS = { bash: 'Bash', read: 'Read', grep: 'Grep', glob: 'Grep', webfetch: 'Bash' };

// Only read-only, re-runnable tool outputs may be dropped by compaction.
export const DROPPABLE_TOOLS = new Set(['read', 'grep', 'glob']);

export function decisionKey(callID, latestUserMsg = '') {
  return `${callID}\x00${createHash('sha1').update(String(latestUserMsg)).digest('hex')}`;
}

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

/**
 * Text of the newest user message. Three shapes: V1 `session.messages`
 * (`{info:{role}, parts}`), V2 `ctx.session.context()` (`{type:'user', text}`)
 * and the V2 context hook's model messages (`{role:'user', content:[…]}`).
 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  const textParts = (parts) => (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string' && !p.synthetic)
    .map((p) => p.text)
    .join('\n');
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    let text = '';
    if (m?.info?.role === 'user') text = textParts(m.parts);
    else if (m?.type === 'user' && typeof m.text === 'string') text = m.text;
    else if (m?.role === 'user') text = typeof m.content === 'string' ? m.content : textParts(m.content);
    text = text.trim();
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

// V2 `tool-result.result`: only text-bearing results are measured and dropped.
function resultText(result) {
  if (result?.type === 'text' && typeof result.value === 'string') return result.value;
  if (result?.type === 'content' && Array.isArray(result.value)) {
    return result.value.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  }
  return null;
}

function toolArgHint(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['filePath', 'path', 'pattern', 'query', 'url', 'command']) {
    if (typeof input[k] === 'string' && input[k]) return input[k].slice(0, 120);
  }
  return '';
}

/**
 * Tool outputs in either payload shape, as `{ id, tool, input, text, drop }`.
 * V1 (`experimental.chat.messages.transform`): `parts[]` with
 * `{type:'tool', callID, state:{output}}`. V2 (`ctx.session.hook('context')`):
 * model messages whose `content[]` holds `{type:'tool-result', id, name,
 * result}`, the call's input sitting on the matching `tool-call` part.
 */
function toolOutputs(messages, editable) {
  const calls = new Map();
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) if (p?.type === 'tool-call' && p.id) calls.set(p.id, { input: p.input, tool: p.name });
  }
  const out = [];
  for (const m of editable) {
    (Array.isArray(m?.parts) ? m.parts : []).forEach((p, i) => {
      if (!completedTool(p) || p.state.time?.compacted) return;
      out.push({ id: p.callID, tool: p.tool, input: p.state.input, text: p.state.output,
        drop: (marker) => { m.parts[i] = { ...p, state: { ...p.state, output: marker, time: { ...(p.state.time || {}), compacted: true } } }; },
        restore: (orig) => { m.parts[i] = { ...p, state: { ...p.state, output: orig } }; } });
    });
    (Array.isArray(m?.content) ? m.content : []).forEach((p, i) => {
      if (p?.type !== 'tool-result') return;
      const text = resultText(p.result);
      if (text === null) return;
      const call = calls.get(p.id) || {};
      out.push({ id: p.id, tool: p.name || call.tool, input: call.input, text,
        drop: (marker) => { m.content = m.content.map((q, k) => (k === i ? { ...p, result: { type: 'text', value: marker } } : q)); },
        restore: (orig) => { m.content = m.content.map((q, k) => (k === i ? { ...p, result: { type: 'text', value: orig } } : q)); } });
    });
  }
  return out;
}

export function dropMarker(tool, input, chars) {
  const hint = toolArgHint(input);
  return `[jev-compact: dropped ${chars} chars of ${tool || 'tool'}${hint ? ` ${hint}` : ''}; re-run the tool to see it]`;
}

/**
 * Verbatim compaction over the plugin's message payload (V1 transform or V2
 * context hook): user/assistant text is never touched, only old tool outputs
 * that Jev judged `drop` are replaced by a marker. `decisions` (key →
 * verdict) outlives the pass; key includes latest user message sha1 so a new
 * user message triggers re-judgment. `originals` preserves dropped text in
 * memory so a later keep verdict can restore it. Mutates `messages` in place.
 */
export async function compactParts(messages, { judge, decisions, originals, opts = {} }) {
  const o = { ...COMPACT_DEFAULTS, ...opts };
  if (!Array.isArray(messages) || !decisions) return { dropped: 0, judged: 0, before: 0 };
  if (!(originals instanceof Map)) originals = new Map();
  const latestUser = lastUserText(messages);
  const editable = messages.slice(0, Math.max(0, messages.length - o.pinLast));
  const outputs = toolOutputs(messages, editable);
  const total = outputs.reduce((n, t) => n + t.text.length, 0);
  const sites = outputs.filter((t) => t.text.length >= o.minPartChars && t.id);
  const droppable = sites.filter((t) => DROPPABLE_TOOLS.has(String(t.tool || '').toLowerCase()));
  let judged = 0;
  const fresh = droppable.filter((s) => !decisions.has(decisionKey(s.id, latestUser))).slice(0, o.maxPerPass);
  if (total >= o.atChars && fresh.length && judge) {
    const request = latestUser;
    const segments = fresh.map((t) => {
      const args = JSON.stringify(t.input ?? {}).slice(0, 300);
      return `tool: ${t.tool}\nargs: ${args}\noutput (${t.text.length} chars):\n${t.text.slice(0, o.headChars)}`;
    });
    const verdicts = await judge({ request, segments, criteria: COMPACT_CRITERIA }).catch(() => null);
    if (Array.isArray(verdicts) && verdicts.length === fresh.length) {
      fresh.forEach((s, k) => decisions.set(decisionKey(s.id, latestUser), verdicts[k] === 'drop' ? 'drop' : 'keep'));
      judged = fresh.length;
    }
  }
  let dropped = 0;
  for (const t of sites) {
    const key = decisionKey(t.id, latestUser);
    const verdict = decisions.get(key);
    if (verdict === 'drop' && DROPPABLE_TOOLS.has(String(t.tool || '').toLowerCase())) {
      originals.set(key, t.text);
      t.drop(dropMarker(t.tool, t.input, t.text.length));
      dropped += t.text.length;
    } else if (verdict === 'keep' && originals.has(key) && typeof t.restore === 'function') {
      t.restore(originals.get(key));
    }
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
