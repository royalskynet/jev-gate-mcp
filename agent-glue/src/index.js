/**
 * agent-glue — the shared, testable Jev decision core for both Claude and Codex.
 *
 * One import, four capabilities, no host logic inside:
 *   - route:    pick from provided candidates / no_match / fail-open
 *   - compact:  verbatim context compaction (pairing, pinning, fail-open)
 *   - verify:   completion pass|fail|unknown + evidence, file:line
 *   - review:   staged diff review pipeline (risk → profile → evidence →
 *               mechanism → severity → reviewer route)
 *
 * `route` is the pre-existing, already-tested `plugin/lib/route.js`; importing
 * it here (rather than reimplementing) keeps the judgment logic in exactly one
 * place that Claude and Codex both call. The rest are new pure modules.
 */
export * from './compact.js';
export * from './verify.js';
export * from './review.js';
export * from './client.js';
export { route, makeScorer, EmptyCandidatesError } from '../../plugin/lib/route.js';
