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
