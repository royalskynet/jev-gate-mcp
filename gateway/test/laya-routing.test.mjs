import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLayaRouter, maxSoftmax, TASK_KIND, MESSAGE_TOPIC } from '../src/laya-routing.js';
import { buildGateway } from '../src/config.js';
import { makeLayaAdapter } from '../src/adapters.js';
import { ERR } from '../src/core.js';

function reply(model, questions, choice) {
  return { model, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    const pick = choice ?? Object.keys(q.criteria)[0];
    return [id, { type: 'choice', choice: pick, confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === pick ? 1 : 0])) }];
  })), usage: { input_tokens: 2, output_tokens: 0 } };
}

function setup(localChoice) {
  const calls = [], samples = [];
  const local = async (s, q) => { calls.push(['laya', Object.keys(q)]); return reply('local', q, localChoice); };
  const cloud = async (s, q) => { calls.push(['jev', Object.keys(q)]); return reply('cloud', q); };
  return { calls, samples, run: makeLayaRouter({ local, cloud, record: s => samples.push(s) }) };
}

test('short fixed classification is local; cloud is not called for success', async () => {
  const { run, calls, samples } = setup();
  const r = await run({ user_request: '請翻譯這句英文', char_bucket: 's' }, { kind: TASK_KIND });
  assert.deepEqual(calls, [['laya', ['kind']]]);
  assert.equal(r.model, 'local');
  assert.equal(samples[0].teacher_answer, null);
  assert.equal(samples[0].label, null);
});

test('mixed batch sends only classification to Laya and difficulty/risk to Jev', async () => {
  const { run, calls } = setup();
  const risk = { type: 'choice', instructions: 'Is this safe?', criteria: { safe: 'safe', risky: 'risky' } };
  const r = await run('寫一封通知', { kind: TASK_KIND, risk });
  assert.deepEqual(calls, [['laya', ['kind']], ['jev', ['risk']]]);
  assert.deepEqual(Object.keys(r.answers).sort(), ['kind', 'risk']);
  assert.equal(r.usage.input_tokens, 4);
});

test('unknown schemas, complex states, explicit models and long/negated requests go directly to Jev', async () => {
  for (const [state, q, opts] of [
    ['x', { q: { ...TASK_KIND, instructions: 'Decide if deleting evidence is safe' } }, {}],
    [{ claim: 'done', evidence: [] }, { kind: TASK_KIND }, {}],
    ['請翻譯', { kind: TASK_KIND }, { model: 'pinned' }],
    ['x'.repeat(321), { kind: TASK_KIND }, {}],
    ['不要退款，先查重複扣款', { kind: TASK_KIND }, {}],
    [{ user_request: '請翻譯', char_bucket: 'l' }, { kind: TASK_KIND }, {}],
  ]) {
    const { run, calls } = setup();
    await run(state, q, opts);
    assert.deepEqual(calls, [['jev', Object.keys(q)]]);
  }
});

test('no-match is combined with other cloud work in one request; Jev is a teacher, not gold', async () => {
  const { run, calls, samples } = setup('general');
  const q = { kind: TASK_KIND, arbitrary: { ...MESSAGE_TOPIC, instructions: 'different task' } };
  await run('隨便聊聊', q);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1].sort(), ['arbitrary', 'kind']);
  assert.equal(samples[0].local_answer.choice, 'general');
  assert.ok(samples[0].teacher_answer);
  assert.equal(samples[0].label, null);
});

test('local errors and malformed answers fall back once; missing cloud cannot run risky work locally', async () => {
  for (const local of [async () => { throw Error('failed'); }, async () => ({ answers: {} }),
    async (s, q) => ({ ...reply('local', q), answers: { kind: { choice: 'coding', probabilities: { coding: 2 } } } })]) {
    let calls = 0;
    const run = makeLayaRouter({ local, cloud: async (s, q) => { calls++; return reply('cloud', q); }, record: () => {} });
    assert.equal((await run('請翻譯', { kind: TASK_KIND })).model, 'cloud');
    assert.equal(calls, 1);
  }
  const run = makeLayaRouter({ local: () => { throw Error('must not run'); }, cloud: null, record: () => {} });
  await assert.rejects(run('x', { q: { type: 'noul', instructions: 'safe?' } }), /credential|configured/);
});

test('real gateway wiring keeps every policy on Jev and still caps shadow outcomes', async () => {
  const calls = [];
  const { gateway, registry } = buildGateway({ provider: 'laya', telemetry: false,
    apiKeyFile: '/no/key', layaAdapter: async (s, q) => { calls.push('laya'); return reply('fake/local', q); },
    jevAdapter: async (s, q) => { calls.push('jev'); return reply('fake/cloud', q); },
    recordRoutingSample: () => {},
  });
  await gateway.evaluate({ state: '請翻譯這句话', questions: { kind: TASK_KIND } });
  assert.deepEqual(calls, ['laya']);
  for (const policy of registry.ids()) {
    const r = await gateway.applyPolicy({ policy, state: 'test policy state' });
    assert.notEqual(r.outcome, 'accept');
  }
  assert.deepEqual(calls.slice(1), registry.ids().map(() => 'jev'));
});

test('local action logits never escape as a probability', async () => {
  const adapter = makeLayaAdapter({ load: async () => ({ systemOne: async (s, q) => {
    const r = reply('local', q);
    r.answers.kind.rl_agent = { act_probability: 1455 };
    return r;
  } }) });
  const r = await adapter('請翻譯', { kind: TASK_KIND });
  assert.equal(r.answers.kind.rl_agent, undefined);
  assert.equal(r.answers.kind.choice, 'coding');
});

test('expired request cannot start a cloud call after slow local work', async () => {
  let calls = 0;
  const run = makeLayaRouter({ local: async (s, q) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return reply('local', q, 'general');
  }, cloud: async () => { calls++; return {}; }, record: () => {} });
  await assert.rejects(run('請翻譯', { kind: TASK_KIND }, { deadlineAtMs: Date.now() + 10 }), /deadline/);
  assert.equal(calls, 0);
});

test('policy breaker failure is visible in readiness and policy telemetry', async () => {
  const built = buildGateway({ provider: 'laya', telemetry: false, apiKeyFile: '/no/key',
    breaker: { volumeThreshold: 1, errorThresholdPercentage: 1 },
    layaAdapter: async (s, q) => reply('fake/local', q),
    jevAdapter: async () => { throw ERR.provider('offline'); }, recordRoutingSample: () => {},
  });
  const events = [];
  built.gateway._tel = { record: e => events.push(e) };
  await built.gateway.applyPolicy({ policy: 'completion-claims', state: 'test' });
  assert.equal(built.readiness().ready, false);
  assert.equal(built.readiness().policy_breaker_state, 'open');
  assert.equal(events.at(-1).breaker_state, 'open');
});

// --- Calibrated question-type lane (score/noul behind max-softmax) ---

const SCORE_Q = { type: 'score', instructions: 'How hard?', criteria: ['low', 'mid', 'high'] };
const NOUL_Q = { type: 'noul', instructions: 'Is it reversible?' };

function setupTyped(answers) {
  const calls = [], samples = [];
  const local = async (s, q) => { calls.push(['laya', Object.keys(q)]);
    return { model: 'local', answers, usage: { input_tokens: 1, output_tokens: 0 } }; };
  const cloud = async (s, q) => { calls.push(['jev', Object.keys(q)]);
    return { model: 'cloud', answers: Object.fromEntries(Object.keys(q).map(id => [id, { teacher: true }])),
      usage: { input_tokens: 1, output_tokens: 0 } }; };
  return { calls, samples, run: makeLayaRouter({ local, cloud, record: s => samples.push(s) }) };
}

test('confident score and noul are answered locally; the state filter still applies', async () => {
  const { run, calls, samples } = setupTyped({
    hard: { type: 'score', score: 2, probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 } },
    rev: { type: 'noul', noul: 0.95 },
  });
  const r = await run({ user_request: '幫我改一行設定', char_bucket: 's' }, { hard: SCORE_Q, rev: NOUL_Q });
  assert.deepEqual(calls, [['laya', ['hard', 'rev']]]);
  assert.equal(r.model, 'local');
  assert.deepEqual(samples.map(s => s.fallback_reason), [null, null]);
  assert.deepEqual(samples.map(s => s.local_confidence), [0.85, 0.95]);

  // A state the conservative filter rejects never reaches the local model at all.
  const far = setupTyped({});
  await far.run({ user_request: '先改設定再部署', char_bucket: 's' }, { hard: SCORE_Q });
  assert.deepEqual(far.calls, [['jev', ['hard']]]);
});

test('under-threshold confidence falls back to Jev and is recorded as such', async () => {
  const { run, calls, samples } = setupTyped({
    hard: { type: 'score', score: 0, probabilities: { 0: 0.34, 1: 0.33, 2: 0.33 } },
    rev: { type: 'noul', noul: 0.55 },
  });
  const r = await run({ user_request: '調一下參數', char_bucket: 's' }, { hard: SCORE_Q, rev: NOUL_Q });
  assert.deepEqual(calls, [['laya', ['hard', 'rev']], ['jev', ['hard', 'rev']]]);
  assert.deepEqual(samples.map(s => s.fallback_reason), ['low-confidence', 'low-confidence']);
  // The teacher's answer is what the caller gets, and it is kept as the label source.
  assert.deepEqual(r.answers, { hard: { teacher: true }, rev: { teacher: true } });
  assert.deepEqual(samples.map(s => s.teacher_model), ['cloud', 'cloud']);
  assert.equal(r.model, 'cloud');
});

test('the lane does not widen to choice: an unknown choice schema stays on Jev', async () => {
  const { run, calls } = setupTyped({});
  const q = { type: 'choice', instructions: 'Which?', criteria: { a: 'a', b: 'b' } };
  await run({ user_request: '挑一個', char_bucket: 's' }, { pick: q });
  assert.deepEqual(calls, [['jev', ['pick']]]);
});

test('maxSoftmax reads choice/score distributions and binary noul, and nothing else', () => {
  assert.equal(maxSoftmax({ probabilities: { a: 0.2, b: 0.8 } }), 0.8);
  assert.equal(maxSoftmax({ noul: 0.2 }), 0.8);
  assert.equal(maxSoftmax({ noul: 0.9 }), 0.9);
  for (const a of [null, undefined, {}, { probabilities: {} }, { probabilities: null }, { noul: 'x' }]) {
    assert.equal(maxSoftmax(a), null, `expected null for ${JSON.stringify(a)}`);
  }
});

test('the profile lane keeps its own fallback and is not put behind the threshold', async () => {
  // Gating the fixed schemas too would send most of that pilot's traffic to the
  // cloud, so a low-confidence task-kind answer must still be served locally.
  const { run, calls, samples } = setupTyped({
    kind: { type: 'choice', choice: 'coding', probabilities: { ...Object.fromEntries(
      Object.keys(TASK_KIND.criteria).map(k => [k, 0])), coding: 0.34, general: 0.33, writing: 0.33 } },
  });
  const r = await run({ user_request: '幫我接一個函式', char_bucket: 's' }, { kind: TASK_KIND });
  assert.deepEqual(calls, [['laya', ['kind']]]);
  assert.equal(r.model, 'local');
  assert.equal(samples[0].fallback_reason, null);
  assert.ok(samples[0].local_confidence < 0.7, 'fixture must be below the threshold to prove the point');
});
