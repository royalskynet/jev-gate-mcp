// Recompose recorded typed answers through the current deterministic policy.
// Replay artifacts contain no raw state or question text; they verify policy
// digest and Gate behavior without another provider call.
import { JevGateway } from '../src/gateway.js';

export async function runDecisionReplay({ registry, records }) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('replay records must be a non-empty array');
  const results = [];
  for (const [index, record] of records.entries()) {
    if (!record || typeof record.policy !== 'string' || !record.answers || typeof record.expected_outcome !== 'string') {
      throw new Error(`replay record ${index}: policy, answers, expected_outcome required`);
    }
    const adapter = async (_state, _questions, opts) => ({
      model: opts.model,
      answers: record.answers,
      usage: null,
      latency_ms: 0,
    });
    const gateway = new JevGateway({ evaluateAdapter: adapter, registry });
    const decision = await gateway.applyPolicy({
      policy: record.policy,
      version: record.version,
      // Deliberately opaque: replay recomposes recorded answers, it does not
      // claim to re-evaluate the original semantic state.
      state: 'decision replay; original state withheld',
      correlation: record.request_id ? { request_id: record.request_id, context: 'replay' } : { context: 'replay' },
    });
    const outcomeMatch = decision.outcome === record.expected_outcome;
    const digestMatch = !record.expected_policy_digest || decision.policy_digest === record.expected_policy_digest;
    results.push({
      id: record.id ?? String(index),
      policy: record.policy,
      expected_outcome: record.expected_outcome,
      actual_outcome: decision.outcome,
      policy_digest: decision.policy_digest,
      outcome_match: outcomeMatch,
      digest_match: digestMatch,
      pass: outcomeMatch && digestMatch,
    });
  }
  return { status: results.every((row) => row.pass) ? 'pass' : 'non-pass', total: results.length, results };
}
