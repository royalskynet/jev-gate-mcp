/**
 * agent-glue compact — verbatim context compaction shared by Claude and Codex.
 *
 * Pure, injectable, host-agnostic. Rules (the contract, not a tuning knob):
 *   - user / assistant *text* is verbatim: never dropped, never truncated.
 *   - only tool *call* and *result* records may be dropped/truncated.
 *   - a dropped tool call and its matching tool result stay paired: both are
 *     reduced together, never one without the other.
 *   - the first `pinFirst` and last `pinLast` messages are never touched.
 *   - if the total reduction is below `minReductionChars`, or any judge call
 *     fails (fail-open toward verbatim), `compacted` is false and the host
 *     falls back to its built-in compaction / leaves context untouched.
 *
 * `judge` is injected: `(pair) => Promise<'drop'|'keep'>`. Anything other than
 * `'drop'` (including a throw) is treated as `keep` — a broken judge can only
 * leak verbatim context, never silently destroy it.
 */

function textLength(m) {
  let n = 0;
  if (typeof m?.content === 'string') n += m.content.length;
  if (Array.isArray(m?.tool_calls)) {
    for (const tc of m.tool_calls) {
      if (tc?.function?.arguments) n += tc.function.arguments.length;
    }
  }
  return n;
}

function callSummary(m) {
  if (!Array.isArray(m?.tool_calls)) return [];
  return m.tool_calls.map((tc) => ({
    id: tc?.id,
    name: tc?.function?.name ?? 'unknown',
    argsChars: tc?.function?.arguments?.length ?? 0,
  }));
}

/** Only strip a payload this big or larger — smaller would grow context. */
export const MIN_STRIP_CHARS = 48;

function marker(n) {
  return `[jev-compact: dropped ${n} chars]`;
}

function stripPayload(m) {
  const c = { ...m };
  // Assistant prose (content) stays verbatim — only the call arguments are
  // reduced; a tool *result* record (role 'tool') gets its content reduced.
  // A payload shorter than the marker would grow context, so it is left
  // verbatim (no marker) — a judge-deemed drop only pays off on bulk.
  if (Array.isArray(c.tool_calls)) {
    c.tool_calls = c.tool_calls.map((tc) => {
      if (tc?.function?.arguments !== undefined && tc.function.arguments.length >= MIN_STRIP_CHARS) {
        return { ...tc, function: { ...tc.function, arguments: marker(tc.function.arguments.length) } };
      }
      return tc;
    });
    return c;
  }
  if (typeof c.content === 'string' && c.content.length >= MIN_STRIP_CHARS) {
    c.content = marker(m.content.length);
  }
  return c;
}

/**
 * @param {object} opts
 * @param {object[]} opts.messages
 * @param {(pair:object)=>Promise<'keep'|'drop'>} opts.judge
 * @param {number} [opts.minReductionChars=4000]  below this -> compacted:false
 * @param {number} [opts.pinFirst=1]  leading messages never touched
 * @param {number} [opts.pinLast=8]   trailing messages never touched
 * @param {number} [opts.maxDroppedChars]  hard cap on total chars dropped per pass
 */
export async function compactMessages(opts = {}) {
  const {
    messages = [],
    judge,
    minReductionChars = 4000,
    pinFirst = 1,
    pinLast = 8,
    maxDroppedChars = Infinity,
  } = opts;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, compacted: false, reason: 'empty', reducedBy: 0 };
  }
  const n = messages.length;
  const pinned = (i) => i < pinFirst || i >= n - pinLast;

  // Pair tool results to their call by tool_call_id.
  const pairOf = new Map(); // callId -> { callIdx, resultIdxs: [] }
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (m?.role === 'assistant' && Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && !pairOf.has(tc.id)) pairOf.set(tc.id, { callIdx: i, resultIdxs: [] });
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (m?.role === 'tool' && m?.tool_call_id && pairOf.has(m.tool_call_id)) {
      pairOf.get(m.tool_call_id).resultIdxs.push(i);
    }
  }

  // One judgment per call site (an assistant message may carry several calls).
  // Any judge throw is a whole-pass fail-open: a broken judge can only leak
  // verbatim context, never silently destroy part of it, so we do not keep the
  // sites that answered and drop the rest.
  const drop = new Map(); // callIdx -> bool
  for (const [, p] of pairOf) {
    if (pinned(p.callIdx) || drop.has(p.callIdx)) continue;
    let keep = false;
    try {
      keep = (await judge({
        calls: callSummary(messages[p.callIdx]),
        results: p.resultIdxs.map((i) => ({
          tool_call_id: messages[i].tool_call_id,
          chars: textLength(messages[i]),
        })),
      })) === 'drop';
    } catch {
      return { messages, compacted: false, reason: 'judge-failed', reducedBy: 0, droppedIds: [], maxed: false };
    }
    drop.set(p.callIdx, keep);
  }

  // Sort drop candidates by cost ascending and respect the per-pass budget;
  // a budget overflow leaves the surplus sites verbatim.
  const sites = [...drop.entries()]
    .filter(([, d]) => d)
    .map(([idx]) => {
      const ids = [...pairOf].filter(([, p]) => p.callIdx === idx).map(([k]) => k);
      const cost = ids.reduce((a, k) => {
        const p = pairOf.get(k);
        return a + textLength(messages[p.callIdx]) + p.resultIdxs.reduce((x, i) => x + textLength(messages[i]), 0);
      }, 0);
      return { idx, cost };
    })
    .sort((a, b) => a.cost - b.cost);

  let budget = maxDroppedChars;
  let maxed = false;
  const dropSet = new Set();
  for (const s of sites) {
    if (s.cost > budget) { maxed = true; continue; }
    budget -= s.cost;
    dropSet.add(s.idx);
  }
  const droppedIds = [...dropSet];

  // A dropped call site strips BOTH the call message and its paired results
  // (pairing), so a call is never elided while its result survives (or vice
  // versa).
  const stripIdxs = new Set(dropSet);
  for (const [callId, p] of pairOf) {
    if (!dropSet.has(p.callIdx)) continue;
    for (const i of p.resultIdxs) stripIdxs.add(i);
  }

  const rebuilt = messages.map((m, i) => (stripIdxs.has(i) ? stripPayload(m) : m));

  // Positive-only reduction: a marker that is longer than the payload it
  // replaced contributes nothing, so context can never grow from a pass.
  let reducedBy = 0;
  for (let i = 0; i < messages.length; i++) {
    reducedBy += Math.max(0, textLength(messages[i]) - textLength(rebuilt[i]));
  }

  return {
    // Below the minimum reduction the rewritten transcript is not worth the
    // risk of a half-stripped context: hand the host the *original* messages
    // so it falls back to its built-in compaction, never a partial rewrite.
    messages: reducedBy >= minReductionChars && reducedBy > 0 ? rebuilt : messages,
    compacted: reducedBy >= minReductionChars && reducedBy > 0,
    reducedBy,
    droppedIds,
    maxed,
  };
}
