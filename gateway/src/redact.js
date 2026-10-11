// Value-level secret masking for judgement state.
//
// telemetry.js keeps secrets out of logs with a field allowlist, but `state`
// is the one payload that must leave the process: it goes to the cloud teacher,
// and both private corpora keep a copy. A user who pastes a key into a prompt
// would otherwise ship it to the provider and persist it on disk. Masking at the
// adapter boundary covers every caller (MCP tools, the jev-route hook) and every
// sink downstream of it (Laya, cloud, teacher corpus, routing corpus).
//
// ponytail: high-confidence token shapes only; a bare high-entropy string with
// no known prefix passes through. Add a shape here when a new provider key
// format shows up, not a generic entropy scanner.
const PATTERNS = [
  ['openrouter', /sk-or-v1-[0-9a-f]{20,}/g],
  ['anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/g],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['groq', /\bgsk_[A-Za-z0-9]{40,}/g],
  ['telegram', /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ['jwt', /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  // Unknown provider, but labelled: "ci key:  <token>" (10-07 incident). The label
  // stays; the value must mix letters and digits so snake_case names pass.
  ['labelled', /(?<![A-Za-z])((?:api[_-]?)?key|token|secret|passw(?:or)?d|密鑰|金鑰|密碼)(\s*[:=：]\s*["']?)(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{20,}/gi, '$1$2[REDACTED:labelled]'],
];

export function redactString(s) {
  let out = s;
  for (const [kind, re, to] of PATTERNS) out = out.replace(re, to ?? `[REDACTED:${kind}]`);
  return out;
}

export function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

/** Wrap a provider adapter so it (and everything behind it) only sees masked state. */
export function withRedaction(adapter) {
  return (state, questions, opts) => adapter(redact(state), questions, opts);
}
