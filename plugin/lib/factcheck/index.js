import { selectFacts, decisive } from './claims.js';

export { selectFacts, decisive, sentences, isFactClaim, FACT, INFER } from './claims.js';

export const SOURCE_LEVEL = ' [source-level claim: supported only if the evidence contains a passage that states this; an inference from nearby passages is not_addressed.]';

/**
 * reply text + evidence text -> fact claims -> verifier -> per-claim verdict.
 *
 * `verify({ claims, evidence })` must resolve to `{ claims: [{ verdict, gate, ... }] }`
 * in the same order, verdict ∈ supported | contradicted | not_addressed.
 * A fact claim with no evidence at all is `not_addressed` without calling the
 * verifier. A verifier error comes back as `error`, never as a verdict.
 */
export async function checkFacts({ text, evidence = '', verify, max = 8 } = {}) {
  const claims = selectFacts(text, { max });
  if (!claims.length) return { claims, judged: [], decisive: null, skipped: 'no_claim' };
  const ev = String(evidence ?? '');
  if (!ev.trim()) {
    const judged = claims.map((claim) => ({ claim, verdict: 'not_addressed', gate: 'auto', note: 'no-evidence' }));
    return { claims, judged, decisive: decisive(judged) };
  }
  if (typeof verify !== 'function') throw new TypeError('checkFacts: verify function required when evidence is given');
  try {
    const out = await verify({ claims: claims.map((c) => c + SOURCE_LEVEL), evidence: ev });
    const judged = (out?.claims ?? []).map((j, i) => ({ ...j, claim: claims[i] ?? j.claim }));
    return { claims, judged, decisive: decisive(judged) ?? null, usage: out?.usage };
  } catch (e) {
    return { claims, judged: [], decisive: null, error: String(e?.message ?? e) };
  }
}

/**
 * Verifier backed by jevwire's `runVerify` (optional peer dependency).
 * `model` is a jevwire `JevDecisionModel`. `maxConcurrency` must be finite:
 * jevwire opens zero workers on NaN and every claim reads not_addressed.
 */
export function jevVerifier(model, { maxConcurrency = 2, thresholds = { auto: 0.85, review: 0.6 } } = {}) {
  return async (input) => {
    const { runVerify } = await import('jevwire');
    return runVerify(model, input, { thresholds, maxConcurrency });
  };
}
