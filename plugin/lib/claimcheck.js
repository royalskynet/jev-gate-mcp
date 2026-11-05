import { runVerify } from 'jevwire';
import { getStopModel, DEFAULT_CONFIG } from './judge.js';
import { selectClaims, decisive } from './claims.js';

/**
 * claimcheck — host-neutral claim verification component.
 *
 * reply text + evidence text -> atomic claims -> Jev (jevwire runVerify)
 * -> per-claim verdict (supported | contradicted | not_addressed) + the one
 * decisive verdict. Hosts only supply the reply and the evidence: the Claude
 * Code Stop hook (plugin/hooks/gate.js) and the OpenMausBot watcher
 * (integrations/openmausbot) both go through here.
 *
 * Deterministic before Jev: fact claims with no evidence at all are
 * `not_addressed` without a call (an unsourced fact is the case this exists
 * to catch, and it costs nothing to say so). Fail-open: a Jev error returns
 * `error`, never a verdict.
 */

const OUTCOME = /修好|修復|修正了|生效|通過|可用|恢復|正常了|成功|搞定|\b(?:fixed|works|working|passes|passing|resolved|succeeded)\b/i;
export const RESULT_LEVEL = ' [result-level claim: supported only if the evidence shows the result itself (command output, a passing test line, a health-check response, an exit code). Evidence that a file was edited or a request was sent is not_addressed.]';
export { SOURCE_LEVEL } from './factcheck/index.js';
import { SOURCE_LEVEL } from './factcheck/index.js';

export function withResultLevel(claims) {
  return claims.map((c) => (OUTCOME.test(c) && !c.includes(RESULT_LEVEL) ? c + RESULT_LEVEL : c));
}

/**
 * The config handed to jevwire's runners. `maxConcurrency` must be finite:
 * jevwire's mapWithConcurrency opens ZERO workers on NaN and every claim comes
 * back not_addressed with usage 0 — reads like a judgment, is not one.
 */
export function runConfig(cfg = DEFAULT_CONFIG) {
  return { thresholds: { auto: 0.85, review: 0.6 }, maxConcurrency: cfg.maxConcurrency ?? 2 };
}

/** Raw Jev call: claim strings + evidence -> jevwire verify output. */
export async function judgeClaims(claims, evidence, cfg = DEFAULT_CONFIG, verify = runVerify) {
  const model = verify === runVerify ? getStopModel(cfg) : null;
  if (!model && verify === runVerify) throw new Error('no Jev model configured');
  return verify(model, { claims: withResultLevel(claims), evidence }, runConfig(cfg));
}

/**
 * @param {object} o
 * @param {string} o.text        the reply to check
 * @param {string} o.evidence    what the agent actually saw (tool output)
 * @param {string[]} [o.kinds]   claim kinds: 'done', 'fact'
 * @param {object} [o.cfg]
 * @param {function} [o.verify]  injectable jevwire-shaped verify (tests)
 * @returns {Promise<{claims, judged, decisive, skipped?, error?}>}
 */
export async function checkClaims({ text, evidence = '', kinds = ['done', 'fact'], cfg = DEFAULT_CONFIG, verify, max = 8 } = {}) {
  const picked = selectClaims(text, { kinds, max });
  if (!picked.length) return { claims: [], judged: [], decisive: null, skipped: 'no_claim' };
  const ev = String(evidence ?? '');
  const tagged = picked.map((c) => (c.kind === 'fact' ? c.claim + SOURCE_LEVEL : c.claim));
  if (!ev.trim()) {
    const judged = picked
      .filter((c) => c.kind === 'fact')
      .map((c) => ({ claim: c.claim, kind: c.kind, verdict: 'not_addressed', gate: 'auto', note: 'no-evidence' }));
    return { claims: picked, judged, decisive: decisive(judged) ?? null, skipped: judged.length ? undefined : 'no_evidence' };
  }
  try {
    const out = await judgeClaims(tagged, ev, cfg, verify);
    const judged = (out?.claims ?? []).map((j, i) => ({ ...j, claim: picked[i]?.claim ?? j.claim, kind: picked[i]?.kind }));
    return { claims: picked, judged, decisive: decisive(judged) ?? null, usage: out?.usage };
  } catch (e) {
    return { claims: picked, judged: [], decisive: null, error: String(e?.message ?? e) };
  }
}
