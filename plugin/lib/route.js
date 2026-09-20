import { JevDecisionModel } from 'jevwire';
import { getModel, DEFAULT_CONFIG } from './judge.js';

/**
 * jev-route: deterministic pre-filter + one Jev Choice, open-world.
 * Pure function; not mounted as a hook. Call explicitly from the main session.
 *
 * `candidates` are the still-enabled MCP tools + skills. Route asks Jev a
 * single Choice over (candidates + `no_match`) and returns top-3 with
 * probabilities; if `no_match` wins, it returns `no_match` and does not
 * force a pick. A second Jev question picks the dispatch target.
 *
 * Fail-open: if the Jev call cannot be made, route returns
 * `{ no_match: true, dispatch: null, reason }` rather than guessing.
 */

export class EmptyCandidatesError extends Error {
  constructor() {
    super('route: candidate list is empty after prefilter');
    this.name = 'EmptyCandidatesError';
  }
}

const noMatchLabel = 'no_match';

/**
 * @param {object} opts
 * @param {string[]} opts.candidates  candidate tool/skill ids
 * @param {string} opts.userRequest   the user's current request (state context)
 * @param {function} [opts.prefilter] (candidate[]) => candidate[]  deterministic filter;
 *     defaults to identity (caller pre-gates unavailability/permission/risk upstream).
 * @param {function} [opts.scorer]    (state, choices) => {choice, probabilities}
 *     injectable for tests; defaults to a Jev Choice (fail-open).
 * @param {number} [opts.topN=3]
 */
export async function route(opts) {
  const { candidates, userRequest, prefilter = (c) => c, scorer, topN = 3 } = opts ?? {};
  if (!Array.isArray(candidates)) {
    throw new EmptyCandidatesError();
  }
  // Deterministic first pass: availability / permission / risk.
  const filtered = prefilter(candidates);
  if (!Array.isArray(filtered) || filtered.length === 0) {
    throw new EmptyCandidatesError();
  }

  // Guard against a candidate that duplicates no_match.
  if (filtered.includes(noMatchLabel)) {
    throw new EmptyCandidatesError();
  }

  const choices = [...filtered, noMatchLabel];
  const score = scorer || makeScorer();

  let result;
  try {
    result = await score(
      { user_request: userRequest ?? '' },
      choices,
    );
  } catch {
    return { no_match: true, top: [], dispatch: null, reason: 'jev-unavailable' };
  }

  const { choice, probabilities } = result;
  if (!probabilities || typeof probabilities !== 'object') {
    return { no_match: true, top: [], dispatch: null, reason: 'jev-bad-schema' };
  }

  const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN).map(([id, p]) => ({ candidate: id, probability: p }));

  if (choice === noMatchLabel) {
    return { no_match: true, top, dispatch: null };
  }

  // Dispatch target: main vs deep — a second judgment.
  let dispatch = null;
  try {
    const d = await score({ user_request: userRequest ?? '' }, ['main', 'deep']);
    dispatch = d.choice === 'deep' ? 'deep' : 'main';
  } catch {
    dispatch = null; // fail-open: no dispatch opinion
  }

  return { no_match: false, top, dispatch };
}

/**
 * Default Jev scorer: ask one Choice with the options as criteria.
 * Returns `{choice, probabilities}`; throws on any provider error (caller's
 * `route` catches and fail-opens).
 */
export function makeScorer(cfg = DEFAULT_CONFIG) {
  const model = getModel(cfg);
  if (!model) {
    return async () => { throw new Error('no Jev model configured'); };
  }
  return async function scorer(state, choices) {
    const criteria = {};
    for (const c of choices) criteria[c] = null;
    const answer = await model.choice(state, {
      instructions: 'Which option best matches the user request? Choose the single best fit, or no_match if none is a good fit.',
      criteria,
    });
    if (!answer || typeof answer.choice !== 'string' || !answer.probabilities) {
      throw new Error('jev route returned a bad schema');
    }
    return { choice: answer.choice, probabilities: answer.probabilities };
  };
}
