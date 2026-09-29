import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLayaRouter, TASK_KIND, MESSAGE_TOPIC } from '../src/laya-routing.js';
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
