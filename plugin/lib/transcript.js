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
  const parts = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0 && total < maxChars; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
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
      if (!text) continue;
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
