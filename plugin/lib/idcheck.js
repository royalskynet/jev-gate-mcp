/**
 * Deterministic half of the Stop gate: an identifier in a completion claim
 * either appears in the transcript's tool output or it was invented.
 *
 * Why this sits in front of the Jev judgment rather than inside it:
 *
 * - A fabricated issue URL is `not_addressed`, not `contradicted` — nothing in
 *   the output disagrees with it, there is simply nothing there. That verdict
 *   is deliberately advisory (see gate.js), so the strongest evidence of a made
 *   up result was the one thing the gate let through.
 * - Verifier leniency drifts with context: a judge that has spent the session
 *   watching repairs grades later claims softer. String comparison does not.
 * - The literature's own test is this exact one: a claimed ID either appears in
 *   the tool output or it doesn't.
 *
 * Scope is narrow on purpose, and the narrowing is measured (1423 transcripts,
 * 4447 quotable ids):
 *
 * - Numbers are excluded. Sums, diffs and percentages are computed, so a
 *   legitimate one is absent from every tool output by construction; they were
 *   ~65% of the raw hits and all of the inspected ones were false.
 * - Markdown emphasis is stripped first. `540,524,**682**` otherwise reads as
 *   the number 540,524, i.e. the formatting manufactures its own false hit.
 * - Only commit-shaped hex and issue/PR URLs remain. Both can only be quoted,
 *   never derived, which is what makes absence conclusive.
 */

const EMPH = /\*\*|__|\*|`/g;
const GH_ISSUE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/gi;
const HASH = /\b[0-9a-f]{7,40}\b/g;
// Docs and templates cite these; they are examples, not results.
const PLACEHOLDER = /^(org|owner|user|username|you|your-?\w*|example|repo|myorg|foo|bar|OWNER|REPO)$/i;

const demark = (s) => String(s ?? '').replace(EMPH, '');
// A hash has at least one a-f; 1234567 is a number that happens to be hex.
const hexish = (t) => /[a-f]/.test(t);

/**
 * Does `evidence` contain a hash that is the same object as `claimed`?
 * A 7-char short hash quoted from a 40-char output is the same commit, so the
 * comparison is prefix-wise in both directions.
 */
function hashSupported(claimed, evidence) {
  for (const t of evidence.match(HASH) ?? []) {
    if (!hexish(t)) continue;
    if (t.startsWith(claimed) || claimed.startsWith(t)) return true;
  }
  return false;
}

/**
 * `gh issue view` / the REST API print the repo and the number in separate
 * fields and never a full URL, so a URL assembled from them is quoted, not
 * invented. Requiring the number in an issue-shaped position keeps this from
 * matching any stray digit in the output.
 */
function issueSupported(full, repo, num, evidence) {
  if (evidence.includes(full)) return true;
  if (!evidence.includes(repo)) return false;
  return new RegExp(`(?:"?number"?\\s*[:=]\\s*|#|issues/|pull/)${num}\\b`).test(evidence);
}

/**
 * Identifiers asserted in `claim` that nothing in `evidence` supports.
 * Returns [] when either side is empty — no evidence means nothing to check,
 * and the caller must fail open.
 */
export function unsupportedIds(claim, evidence) {
  const c = demark(claim);
  const e = demark(evidence);
  if (!c.trim() || !e.trim()) return [];
  const out = [];
  for (const [full, owner, repo, num] of c.matchAll(GH_ISSUE)) {
    if (PLACEHOLDER.test(owner) || PLACEHOLDER.test(repo)) continue;
    if (!issueSupported(full, repo, num, e)) out.push(full);
  }
  for (const t of new Set(c.match(HASH) ?? [])) {
    if (!hexish(t)) continue;
    if (!hashSupported(t, e)) out.push(t);
  }
  return [...new Set(out)];
}

/**
 * The block. Phrased so the fix is to cite or drop the identifier, never to
 * delete the caveat around it: an openly-unproven statement is what the house
 * rules ask for, and a gate that punishes it teaches the opposite.
 */
export function idBlock(ids) {
  if (!ids?.length) return undefined;
  return {
    decision: 'block',
    reason:
      `(jev-gate) ${ids.length === 1 ? 'this identifier appears' : 'these identifiers appear'} in the claim but in no tool output this session: ` +
      `${ids.slice(0, 5).join(', ')}. An id can only be quoted, not derived, so this is an invented result. ` +
      'Run the command and quote what it returned, or remove the id. Saying plainly that something is unverified is fine — inventing its id is not.',
  };
}
