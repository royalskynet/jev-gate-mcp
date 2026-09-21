// Gateway Core unit tests: adapter failure space, strict validation, immutable
// registry, fail-safe gate, kill switch, and limits. Determines fail/deny
// behavior without needing a provider or a transport.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry } from '../src/registry.js';
import { makeFakeAdapter, FakeMode, makeOpenrouterAdapter } from '../src/adapters.js';
import { JevGateway, composeGate } from '../src/gateway.js';
import { ERR, LIMITS, killSwitchGlobal, killSwitchPolicy, resetRuntime } from '../src/core.js';

const registry = loadRegistry();
const QUESTIONS = {
  target: {
    type: 'choice',
    instructions: 'pick the best tier',
    criteria: { main: 'routine', deep: 'long', review: 'risky', no_match: 'none' },
  },
};

function gw(adapter) {
  return new JevGateway({ evaluateAdapter: adapter, registry });
}

test('evaluate: success is advisory with complete coverage and validated answers', async () => {
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  const r = await g.evaluate({ state: 'x', questions: QUESTIONS });
  assert.equal(r.outcome, 'advisory');
  assert.equal(r.coverage, 'complete');
  assert.equal(r.errors.length, 0);
  assert.equal(r.answers[0].answer.choice, 'main');
});

test('evaluate: malformed answer surfaces as typed error, not acceptance', async () => {
  const g = gw(makeFakeAdapter(FakeMode.MALFORMED, { failQuestionId: 'target' }));
  const r = await g.evaluate({ state: 'x', questions: QUESTIONS });
  assert.equal(r.coverage, 'incomplete');
  assert.ok(r.errors.some((e) => e.code === 'ERR_FOREIGN_CHOICE'));
});

test('evaluate: partial (missing) answer is typed error, never negative evidence', async () => {
  const g = gw(makeFakeAdapter(FakeMode.MISSING, { failQuestionId: 'target' }));
  const r = await g.evaluate({ state: 'x', questions: QUESTIONS });
  assert.equal(r.coverage, 'incomplete');
  assert.equal(r.errors[0].code, 'ERR_MISSING_ANSWER');
});

test('applyPolicy: incomplete coverage can never accept', async () => {
  const g = gw(makeFakeAdapter(FakeMode.MISSING, { failQuestionId: 'target' }));
  const r = await g.applyPolicy({ policy: 'intent-routing', state: 'x' });
  assert.equal(r.outcome, 'deny');
  assert.equal(r.coverage, 'incomplete');
  assert.equal(r.unavailable.code, 'ERR_MISSING_ANSWER');
});

test('applyPolicy: provider failure returns unavailable/deny, never fabricated accept', async () => {
  const g = gw(makeFakeAdapter(FakeMode.PROVIDER_FAILURE));
  const r = await g.applyPolicy({ policy: 'intent-routing', state: 'x' });
  assert.equal(r.outcome, 'deny');
  assert.equal(r.coverage, 'incomplete');
  assert.ok(r.unavailable.message.includes('upstream'));
});

test('applyPolicy: consequential policy can never auto-accept on low certainty', async () => {
  // score answer lands on a mid level -> not accept
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  const r = await g.applyPolicy({ policy: 'proposed-action-risk', state: { action: 'rm -rf /tmp/x' } });
  assert.notEqual(r.outcome, 'accept');
  assert.ok(['deny', 'escalate', 'review'].includes(r.outcome));
});

test('applyPolicy: shadow/uncalibrated policy is capped at review, raw gate exposed as shadow_outcome', async () => {
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  const r = await g.applyPolicy({ policy: 'completion-claims', state: 'evidence present' });
  assert.equal(r.outcome, 'review', 'shadow/uncalibrated outcome must never be accept');
  assert.equal(r.shadow_outcome, 'accept', 'raw composed gate observable via shadow_outcome');
  assert.equal(r.policy.id, 'completion-claims');
  assert.equal(r.policy.version, 1);
});

test('kill switch: global switch fails closed for evaluate and applyPolicy', async () => {
  resetRuntime();
  killSwitchGlobal();
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(() => g.evaluate({ state: 'x', questions: QUESTIONS }), (e) => e.code === 'ERR_KILL_SWITCH');
  await assert.rejects(() => g.applyPolicy({ policy: 'completion-claims', state: 'x' }), (e) => e.code === 'ERR_KILL_SWITCH');
  resetRuntime();
});

test('limits: too many questions are rejected, never truncated', async () => {
  const questions = {};
  for (let i = 0; i < LIMITS.maxQuestions + 1; i++) {
    questions['q' + i] = {
      type: 'noul',
      instructions: 'yes?',
      criteria: { true: 'y', false: 'n' },
    };
  }
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(() => g.evaluate({ state: 'x', questions }), (e) => e.code === 'ERR_BAD_REQUEST');
});

test('strict schema: caller cannot override policy thresholds/model/composition', async () => {
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(
    () => g.applyPolicy({ policy: 'completion-claims', state: 'x', thresholds: { auto: 0.1, review: 0.05 } }),
    (e) => e.code === 'ERR_BAD_REQUEST',
  );
});

test('registry: released policy specs are deep-frozen (immutable)', async () => {
  const spec = registry.resolve('completion-claims', 1);
  assert.throws(() => { spec.thresholds = { auto: 0.1 }; });
  assert.throws(() => { spec.questions.supported = null; });
});

test('registry: unknown version selection fails loudly', async () => {
  assert.throws(() => registry.resolve('completion-claims', 99), (e) => e.code === 'ERR_BAD_REQUEST');
});

test('registry: incomplete semantic mappings fail at startup instead of falling back to confidence-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-policy-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({
      broken: { versions: [{
        version: 1,
        mode: 'active',
        model: 'typesafe/jev-1.13-20260917',
        evaluation_dataset_version: 'synthetic-v1',
        calibration_status: 'calibrated',
        consequence: 'advisory',
        state_projection: ['state'],
        state_schema: { oneOf: [{ type: 'string' }, { type: 'object', properties: { state: {} }, additionalProperties: false }] },
        activation: { allow_outcomes: ['accept', 'review', 'escalate', 'deny'], rollout_percent: 100, salt: 'test' },
        thresholds: { auto: 0.85, review: 0.6 },
        questions: { q: { type: 'choice', instructions: 'pick', criteria: { safe: 'safe', risky: 'risky' } } },
        mapping: { q: { safe: 'accept' } },
      }] },
    }));
    assert.throws(() => loadRegistry(dir), /must cover exactly its answer space/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('composeGate: most conservative signal wins', () => {
  const policy = { consequence: 'advisory', thresholds: { auto: 0.9, review: 0.6 } };
  assert.equal(composeGate([{ confidence: 0.95 }], policy), 'accept');
  assert.equal(composeGate([{ confidence: 0.7 }], policy), 'review');
  assert.equal(composeGate([{ confidence: 0.4 }], policy), 'escalate');
  // consequential policy starts at escalate; a confident signal can still only reach review
  const conc = { consequence: 'irreversible', thresholds: { auto: 0.9, review: 0.6 } };
  assert.equal(composeGate([{ confidence: 0.95 }], conc), 'review');
  const qualityPolicy = { ...policy, quality_thresholds: { min_margin: 0.4, max_entropy: 0.7 } };
  assert.equal(composeGate([{ confidence: 0.95, quality: { margin: 0.1, entropy: 0.9, variance: null } }], qualityPolicy), 'review');
});

// --- Helpers for deterministic answer injection (item 6/7: Gate must look at
// answer semantics AND confidence, never confidence alone). ---

const NO_MATCH = { type: 'choice', choice: 'no_match', probabilities: { main: 0, deep: 0, review: 0, no_match: 1 }, confidence: 1 };
const LOW_CONF_CHOICE = { type: 'choice', choice: 'main', probabilities: { main: 0.6, deep: 0.1, review: 0.1, no_match: 0.2 }, confidence: 0.3 };

/** Build an adapter returning an exact answer map (shape already validated). */
function answers(map) {
  return async (state, questions, opts) => ({ model: opts.model ?? 'test', answers: map, usage: {}, latency_ms: 1 });
}

// --- Item 4: kill switch regression ---

test('kill switch: per-policy kills only that policy, never a global exemption', async () => {
  resetRuntime();
  killSwitchPolicy('completion-claims');
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  // the targeted policy is down
  await assert.rejects(() => g.applyPolicy({ policy: 'completion-claims', state: 'x' }), (e) => e.code === 'ERR_KILL_SWITCH');
  // other policies are unaffected (resolvable; shadow/uncalibrated caps at review)
  const other = await g.applyPolicy({ policy: 'intent-routing', state: 'x' });
  assert.notEqual(other.outcome, 'accept');
  assert.equal(other.shadow_outcome, 'accept');
  // a per-policy kill never touches the advisory evaluate path
  const ev = await g.evaluate({ state: 'x', questions: QUESTIONS });
  assert.equal(ev.outcome, 'advisory');
  resetRuntime();
});

test('kill switch: global switch shuts down every policy AND evaluate, even with a per-policy kill set', async () => {
  resetRuntime();
  killSwitchPolicy('completion-claims');
  killSwitchGlobal();
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(() => g.applyPolicy({ policy: 'completion-claims', state: 'x' }), (e) => e.code === 'ERR_KILL_SWITCH');
  // a per-policy kill used to *exempt* a policy from the global switch; it must not
  await assert.rejects(() => g.applyPolicy({ policy: 'intent-routing', state: 'x' }), (e) => e.code === 'ERR_KILL_SWITCH');
  await assert.rejects(() => g.evaluate({ state: 'x', questions: QUESTIONS }), (e) => e.code === 'ERR_KILL_SWITCH');
  resetRuntime();
});

// --- Item 5: jev_apply_policy pins and forwards the immutable spec.model ---

test('applyPolicy: immutable spec.model is forwarded to the adapter and recorded as resolved model', async () => {
  const seen = [];
  const spy = async (state, questions, opts) => {
    seen.push(opts.model);
    return { model: opts.model ?? 'unset', answers: { supported: { type: 'noul', noul: 1 } }, usage: {}, latency_ms: 1 };
  };
  const g = new JevGateway({ evaluateAdapter: spy, registry });
  const r = await g.applyPolicy({ policy: 'completion-claims', state: 'x' });
  assert.equal(r.model, 'typesafe/jev-1.13-20260917', 'response records the pinned resolved model');
  assert.deepEqual(seen, ['typesafe/jev-1.13-20260917'], 'adapter receives exactly the server-owned pinned model');
  // the caller can never override the model (strict input schema rejects it)
  await assert.rejects(() => g.applyPolicy({ policy: 'completion-claims', state: 'x', model: 'caller/forge' }), (e) => e.code === 'ERR_BAD_REQUEST');
});

test('applyPolicy: undeclared state is removed before provider egress', async () => {
  let seen;
  const spy = async (state, questions, opts) => {
    seen = state;
    return { model: opts.model, answers: { supported: { type: 'noul', noul: 1 } }, latency_ms: 1 };
  };
  const g = new JevGateway({ evaluateAdapter: spy, registry });
  const r = await g.applyPolicy({
    policy: 'completion-claims',
    state: { claims: ['done'], evidence: 'tests pass', secret: 'must-not-egress' },
  });
  assert.deepEqual(seen, { claims: ['done'], evidence: 'tests pass' });
  assert.equal(r.gate_reasons[0].decision_quality.margin, 1);
  assert.match(r.policy_digest, /^sha256:[0-9a-f]{64}$/);
});

test('applyPolicy: state projection that leaves no policy evidence is rejected', async () => {
  const g = gw(makeFakeAdapter(FakeMode.SUCCESS));
  await assert.rejects(
    () => g.applyPolicy({ policy: 'completion-claims', state: { secret_only: 'x' } }),
    (error) => error.code === 'ERR_BAD_REQUEST' && /state/.test(error.message),
  );
});

// --- Item 6/7: declarative Gate composition (answer semantics + confidence) ---

test('gate semantics: completion supported=false denies even at full confidence', async () => {
  const g = gw(answers({ supported: { type: 'noul', noul: 0 } })); // noul 0 => supported=false
  const r = await g.applyPolicy({ policy: 'completion-claims', state: 'unsupported claim' });
  assert.equal(r.outcome, 'deny');
});

test('gate semantics: intent no_match escalates even at full confidence', async () => {
  const g = gw(answers({ target: NO_MATCH }));
  const r = await g.applyPolicy({ policy: 'intent-routing', state: 'task matches nothing' });
  assert.equal(r.outcome, 'escalate');
});

test('gate semantics: destructive blast radius or credential exposure deny (consequential)', async () => {
  const g = gw(answers({
    blast_radius: { type: 'score', score: 2, legend: { 0: 'l0', 1: 'l1', 2: 'l2' }, probabilities: { 0: 0, 1: 0, 2: 1 } },
    credential_exposure: { type: 'noul', noul: 1 },
  }));
  const r = await g.applyPolicy({ policy: 'proposed-action-risk', state: { action: 'send secret to external' } });
  assert.equal(r.outcome, 'deny');
});

test('gate semantics: low confidence escalates even when the answer is semantically acceptable', async () => {
  const g = gw(answers({ target: LOW_CONF_CHOICE })); // main, but confidence 0.3
  const r = await g.applyPolicy({ policy: 'intent-routing', state: 'x' });
  assert.equal(r.outcome, 'escalate');
});

test('gate semantics: medium-low confidence on a noul yields review, never accept', async () => {
  const g = gw(answers({ supported: { type: 'noul', noul: 0.55 } })); // true-ish but low confidence
  const r = await g.applyPolicy({ policy: 'completion-claims', state: 'x' });
  assert.ok(['review', 'escalate'].includes(r.outcome));
  assert.notEqual(r.outcome, 'accept');
});

test('gate semantics: consequential policy caps at review even when every signal is accept', async () => {
  // full-confidence accept signals on both questions, yet an irreversible/
  // consequential policy can never auto-accept: it stops at review.
  const g = gw(answers({
    blast_radius: { type: 'score', score: 0, legend: { 0: 'l0', 1: 'l1', 2: 'l2' }, probabilities: { 0: 1, 1: 0, 2: 0 }, confidence: 1 },
    credential_exposure: { type: 'noul', noul: 0 },
  }));
  const r = await g.applyPolicy({ policy: 'proposed-action-risk', state: 'low risk read' });
  assert.equal(r.outcome, 'review');
});

test('gate semantics: fractional scores use the more conservative adjacent mapping', () => {
  const policy = {
    consequence: 'advisory',
    thresholds: { auto: 0.85, review: 0.6 },
  };
  const risk = { type: 'score', score: 1.4 };
  assert.equal(composeGate([{ answer: risk, confidence: 1, map: { 0: 'accept', 1: 'review', 2: 'deny' } }], policy), 'deny');
  const relevance = { type: 'score', score: 1.4 };
  assert.equal(composeGate([{ answer: relevance, confidence: 1, map: { 0: 'escalate', 1: 'review', 2: 'accept' } }], policy), 'review');
});

test('OpenRouter adapter targets the canonical System One URL exactly once', async () => {
  let seenUrl = null;
  const fetch = async (url) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({
      model: 'typesafe/jev-1.13-20260917',
      answers: { supported: { type: 'noul', noul: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const adapter = makeOpenrouterAdapter({ apiKey: 'test-only', fetch, sleep: async () => {} });
  await adapter('evidence', {
    supported: { type: 'noul', instructions: 'supported?', criteria: { true: 'yes', false: 'no' } },
  });
  assert.equal(seenUrl, 'https://openrouter.ai/api/v1/systemone');
});
