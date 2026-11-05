/**
 * Split a final reply into the completion claims worth checking.
 *
 * jevwire's verify asks for "single, self-contained statements — split
 * compound sentences". The Stop gate used to send the whole reply (≤4000
 * chars) as one claim, and 61% of 10-03..10-12 verdicts came back `escalate`:
 * a paragraph mixing what was done, what was not, and what comes next has no
 * single verdict. All claims go in one request, so splitting costs no extra
 * calls.
 *
 * Deterministic on purpose: a model deciding which sentences to check is a
 * second judge with no ledger. Only sentences that assert something already
 * happened are kept; plans, suggestions and honest "not yet" lines are not
 * completion claims, and checking them would punish Fail Loud.
 * ponytail: keyword heuristic; swap for a measured classifier if the replay
 *   shows it keeps hedges or drops real claims.
 */
const DONE = /(已|完成|通過|修好|改好|改完|生效|成功|驗證|全過|commit|推送|推上|寫進|寫入|新增了|刪掉|exit[ =]?0|\b\d+\s*\/\s*\d+\b|\bpass(?:ed|es)?\b|\bfixed\b|\bdone\b|\bcreated\b|\bupdated\b|\bverified\b|\bmerged\b|\bpushed\b|\bcommitted\b)/i;
const HEDGE = /(建議|下一步|接下來|還沒|尚未|沒做|未完成|要不要|可能|也許|預計|將會|之後|待辦|如果|若|\?|？|\bshould\b|\bwill\b|\bmaybe\b|\bmight\b|\btodo\b|\bnext\b|\bif\b)/i;

import { sentences, isFactClaim, decisive } from './factcheck/claims.js';

export { decisive };

export function atomicClaims(text, max = 8) {
  return selectClaims(text, { kinds: ['done'], max }).map((c) => c.claim);
}

/**
 * Claims worth checking, tagged with their kind. `done` = completion claims
 * (the Stop gate's original filter); `fact` = external-fact claims.
 * A sentence matching both is reported once, as `done`.
 * ponytail: keyword heuristic like DONE; replace with a measured classifier
 *   if the shadow ledger shows it keeps inferences or drops real claims.
 */
export function selectClaims(text, { kinds = ['done'], max = 8 } = {}) {
  const want = new Set(kinds);
  const seen = new Set();
  const out = [];
  for (const s of sentences(text)) {
    if (seen.has(s)) continue;
    let kind = null;
    if (want.has('done') && DONE.test(s) && !HEDGE.test(s)) kind = 'done';
    else if (want.has('fact') && isFactClaim(s)) kind = 'fact';
    if (!kind) continue;
    seen.add(s);
    out.push({ claim: s, kind });
    if (out.length >= max) break;
  }
  return out;
}

