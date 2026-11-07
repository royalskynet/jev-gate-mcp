/**
 * Scrub PII from judgement state before it leaves to a cloud adapter.
 * Collects all string leaf nodes in order, POSTs to the scrub service,
 * and writes the scrubbed strings back to the same positions.
 *
 * On scrub failure (non-2xx, timeout, length mismatch) throws
 * `{ code: 'upstream' }` — the cloud adapter must never receive original text.
 */

export const DEFAULT_SCRUB_URL = process.env.JEV_CASCADE_SCRUB_URL || 'http://127.0.0.1:4102/scrub';
const DEFAULT_TIMEOUT_MS = 5000;

function flattenStrings(value, list) {
  if (typeof value === 'string') { list.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) flattenStrings(v, list); return; }
  if (value && typeof value === 'object') { for (const k of Object.keys(value)) flattenStrings(value[k], list); }
}

function replaceStrings(value, texts, cursor) {
  if (typeof value === 'string') { const v = texts[cursor.i]; cursor.i += 1; return v; }
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, texts, cursor));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = replaceStrings(value[k], texts, cursor);
    return out;
  }
  return value;
}

export async function scrubState(state, { fetchImpl = fetch, url = process.env.JEV_CASCADE_SCRUB_URL || 'http://127.0.0.1:4102/scrub', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const texts = [];
  flattenStrings(state, texts);
  if (texts.length === 0) return state;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(`scrub request failed: ${e?.message ?? e}`);
    err.code = 'upstream';
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`scrub ${res.status}`);
    err.code = 'upstream';
    throw err;
  }
  let body;
  try { body = await res.json(); } catch (e) {
    const err = new Error(`scrub invalid json: ${e?.message ?? e}`);
    err.code = 'upstream';
    throw err;
  }
  const out = body?.texts;
  if (!Array.isArray(out) || out.length !== texts.length) {
    const err = new Error(`scrub length mismatch: expected ${texts.length} got ${Array.isArray(out) ? out.length : 'non-array'}`);
    err.code = 'upstream';
    throw err;
  }
  return replaceStrings(state, out, { i: 0 });
}

/**
 * Wrap a cloud adapter so state is scrubbed before the call.
 * The adapter (and anything behind it) receives only scrubbed state.
 */
export function withPiiScrub(adapter, opts) {
  return async (state, questions, callOpts) => adapter(await scrubState(state, opts), questions, callOpts);
}
