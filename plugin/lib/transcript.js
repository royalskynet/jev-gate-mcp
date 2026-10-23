import { readFileSync } from 'node:fs';

/**
 * Evidence for the Stop gate: the tool output produced since the user's last
 * prompt.
 *
 * A real Stop payload carries no `tool_response` — only `transcript_path` —
 * so without this the gate judged every completion claim against an empty
 * string and returned `not_addressed` at 0.97 confidence every single time.
 * That is fine while the gate only records; once it blocks it would stop
 * every turn forever.
 *
 * Walks the JSONL backwards, collecting `tool_result` text, and stops at the
 * user turn that started this round. Returns '' on any problem — the caller
 * treats no evidence as "nothing to judge" and lets the turn end.
 *
 * `allRounds` keeps walking past the prompt boundary and also keeps the user's
 * own words. The identifier check needs that wider window: a claim may quote a
 * commit hash from three turns ago, and judging it against this round alone
 * would call an honest quote a fabrication.
 */
export function readEvidence(transcriptPath, maxChars = 8000, { allRounds = false } = {}) {
  if (!transcriptPath) return '';
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return '';
  }
  return evidenceFromLines(lines, maxChars, { allRounds });
}

/**
 * Parsed records with compaction replays dropped.
 *
 * A compaction appends a `compact_boundary` and then re-appends the session's
 * older messages under new uuids but their ORIGINAL timestamps. A backwards
 * walk then meets a replayed copy of some old prompt before it reaches this
 * round's real one, and calls a round that edited four files empty — a Stop
 * after a mid-turn compact saw no tool output and no edits at all. Anything
 * stamped earlier than the boundary before it is such a copy; the original
 * sits earlier in the file and is kept.
 */
export function liveRecords(lines) {
  const recs = [];
  let boundaryTs = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // A truncated or half-written line says nothing.
      continue;
    }
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
      boundaryTs = rec.timestamp ?? boundaryTs;
      continue;
    }
    // ISO-8601 UTC strings order lexically, so no Date parsing is needed.
    if (boundaryTs && typeof rec.timestamp === 'string' && rec.timestamp < boundaryTs) continue;
    recs.push(rec);
  }
  return recs;
}

/**
 * Same walk over lines already in memory. scripts/backtest-teacher.mjs replays
 * every past round of a transcript, so it hands in the lines up to that round's
 * end instead of re-reading a file per round.
 */
export function evidenceFromLines(lines, maxChars = 8000, { allRounds = false } = {}) {
  const recs = liveRecords(lines);
  // tool_use_id -> what ran, so a silent success can be named in the evidence.
  const uses = new Map();
  for (const rec of recs) {
    if (rec.type !== 'assistant' || !Array.isArray(rec.message?.content)) continue;
    for (const b of rec.message.content) if (b?.type === 'tool_use' && b.id) uses.set(b.id, b);
  }
  const parts = [];
  let total = 0;
  for (let i = recs.length - 1; i >= 0 && total < maxChars; i--) {
    const rec = recs[i];
    // Hook context (recent-sessions, latest-fixes) is something the model reads
    // and may quote, e.g. a session id prefix — issue #12's 5th false positive.
    if (allRounds && rec.type === 'attachment' && rec.attachment?.type === 'hook_additional_context') {
      const c = rec.attachment.content;
      const text = Array.isArray(c) ? c.join('\n') : String(c ?? '');
      if (text) { parts.unshift(text); total += text.length; }
      continue;
    }
    if (rec.type !== 'user') continue;
    const content = rec.message?.content;
    // A plain-string user message is the prompt that opened this round.
    if (typeof content === 'string') {
      if (!allRounds) break;
      parts.unshift(content);
      total += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const results = content.filter((p) => p?.type === 'tool_result');
    // a structured user turn with no tool results is also a prompt
    if (results.length === 0) {
      if (!allRounds) break;
      continue;
    }
    for (const r of results) {
      const text = typeof r.content === 'string'
        ? r.content
        : Array.isArray(r.content)
          ? r.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : '';
      if (!text) {
        // A write-type command that succeeds prints nothing (`wheel_registry.py
        // add`, `cat >> f`), and an empty result used to leave the claim "card
        // registered" with no evidence at all. 10-22 sample: ~40% of deferred
        // not-supported notes were such claims. Say that the call ran and did
        // not fail; weaker than output, stronger than nothing.
        const use = uses.get(r.tool_use_id);
        if (allRounds || r.is_error || !use) continue;
        const what = String(use.input?.command ?? use.input?.file_path ?? '').slice(0, 200);
        const note = `[${use.name} completed with no output and no error${what ? `: ${what}` : ''}]`;
        parts.unshift(note);
        total += note.length;
        continue;
      }
      parts.unshift(text);
      total += text.length;
    }
  }
  // parts are unshifted while walking backwards, so the join is chronological
  // and the overflow must come off the HEAD. slice(0, maxChars) kept the oldest
  // rounds and cut the newest — the output a claim quotes from: both live
  // idcheck false positives were a hash quoted from the newest tool result and
  // truncated off the tail the moment the window overflowed.
  const joined = parts.join('\n---\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}
