// Per-question state for Laya. Laya reads at most max_len=1024 tokens and the
// upstream build_sequence keeps the head of the state, so a 40KB compact
// history (oldest first) is cut long before the call a question asks about:
// 12 real compact requests kept 7.4% of their state tokens (fix 10632).
// The teacher still sees the whole state; only Laya's input is cropped, and
// training (scripts/laya_state.py) must crop the same way or it learns from
// inputs the live lane never sends. tests/fixtures/laya-crop-golden.json pins
// both implementations to the same output.
//
// ponytail: only the compact caller's call_tN/result_tN questions are cropped.
// Another wide caller needs its own anchor rule here and in laya_state.py.

// input: the asked call; otherInput: every other kept call. Sized on real compact
// traffic so the crop fits Laya's 1024-token window (fix 10649).
export const CROP = { goal: 200, text: 200, input: 200, otherInput: 60, near: 2, tail: 3 };

const TOOL_QID = /^(?:call|result)_(t\d+)$/;

const cut = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

// fast-jev's state.js writes a call either as {id, tool, input, result} or, on
// its compact tier, as one line "t12 Bash command=… → ok 340ch".
const callId = (c) => (typeof c === 'string' ? c.split(' ', 1)[0] : c?.id);

/** The tool id a question is anchored to, or null when it is not croppable. */
export function cropKey(state, qid) {
  const m = TOOL_QID.exec(qid);
  if (!m || !state || typeof state !== 'object' || !Array.isArray(state.history)) return null;
  return m[1];
}

function slim(entry, keepId) {
  const out = { i: entry.i, role: entry.role, text: cut(entry.text ?? '', CROP.text) };
  if (Array.isArray(entry.tool_calls)) {
    const calls = keepId ? entry.tool_calls.filter((c) => callId(c) === keepId) : entry.tool_calls;
    const n = keepId ? CROP.input : CROP.otherInput;
    out.tool_calls = calls.map((c) => (typeof c === 'string' ? cut(c, n)
      : { id: c.id, tool: c.tool, input: cut(c.input ?? '', n), result: c.result }));
  }
  return out;
}

/**
 * Crop a compact state to what one tool id's questions need: context, a short
 * goal, the entry holding that call with `near` neighbours, and the last
 * `tail` entries. Gaps become {"omitted": n}. Returns the state unchanged when
 * the call is not in the history.
 */
export function cropState(state, toolId) {
  const h = state.history;
  const at = h.findIndex((e) => Array.isArray(e.tool_calls) && e.tool_calls.some((c) => callId(c) === toolId));
  if (at === -1) return state;
  const keep = new Set();
  for (let j = Math.max(0, at - CROP.near); j <= Math.min(h.length - 1, at + CROP.near); j++) keep.add(j);
  for (let j = Math.max(0, h.length - CROP.tail); j < h.length; j++) keep.add(j);
  const history = [];
  let prev = -1;
  for (const j of [...keep].sort((a, b) => a - b)) {
    if (j > prev + 1) history.push({ omitted: j - prev - 1 });
    history.push(slim(h[j], j === at ? toolId : null));
    prev = j;
  }
  if (prev < h.length - 1) history.push({ omitted: h.length - 1 - prev });
  const out = { ...state, history };
  if (typeof state.goal === 'string') out.goal = cut(state.goal, CROP.goal);
  return out;
}

/**
 * Group questions by the state Laya should see: croppable questions by tool
 * id (call_tN and result_tN share one crop), the rest together on the full
 * state. Order of groups follows first appearance.
 */
export function groupByCrop(state, questions) {
  const groups = new Map();
  for (const [qid, q] of Object.entries(questions)) {
    const key = cropKey(state, qid);
    if (!groups.has(key)) groups.set(key, { state: key ? cropState(state, key) : state, questions: {} });
    groups.get(key).questions[qid] = q;
  }
  return [...groups.values()];
}
