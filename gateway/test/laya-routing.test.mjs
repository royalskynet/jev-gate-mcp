import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLayaRouter, maxSoftmax, TASK_KIND, MESSAGE_TOPIC, LOCAL_BUDGET_MS } from '../src/laya-routing.js';
import { buildGateway } from '../src/config.js';
import { makeLayaAdapter } from '../src/adapters.js';
import { ERR, LIMITS } from '../src/core.js';

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
  }, cloud: async () => { calls++; return {}; }, record: () => {}, cloudReserveMs: 0 });
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

test('each question type is held to its own calibrated floor', async () => {
  // Same confidence, opposite outcomes: 0.66 clears score's 0.65 but not noul's
  // 0.70. A single shared floor cannot produce this split, so it proves the
  // per-type floors are applied and not collapsed to one number.
  const { run, calls, samples } = setupTyped({
    hard: { type: 'score', score: 2, probabilities: { 0: 0.17, 1: 0.17, 2: 0.66 } },
    rev: { type: 'noul', noul: 0.66 },
  });
  await run({ user_request: '幫我改一行設定', char_bucket: 's' }, { hard: SCORE_Q, rev: NOUL_Q });
  assert.deepEqual(calls, [['laya', ['hard', 'rev']], ['jev', ['rev']]]);
  assert.deepEqual(samples.map(s => s.fallback_reason), [null, 'low-confidence']);
});

test('a question type with no calibrated floor is never served locally', async () => {
  const { parseConfMin } = await import('../src/laya-routing.js');
  const floor = parseConfMin('score=0.65');
  assert.equal(floor('score'), 0.65);
  assert.equal(floor('noul'), Infinity, 'an unlisted type must not inherit a floor');
  assert.equal(parseConfMin('0.7')('anything'), 0.7, 'a bare number still applies to every type');
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

// laya-handoff.jsonl 是「Laya 接手多少 Jev 工作」的唯一來源：gateway 路徑上全本地請求
// 在 usage.jsonl 不留痕跡。這裡釘住每次請求記一行、計數正確、原因拆對、不帶內容。
test('every routed request leaves one handoff line with counts and reasons, no content', async () => {
  const lines = [];
  const local = async (s, q) => reply('local', q);
  const cloud = async (s, q) => reply('cloud', q);
  const run = makeLayaRouter({ local, cloud, record: () => {}, handoff: r => lines.push(r) });
  const risk = { type: 'choice', instructions: 'Is this safe?', criteria: { safe: 'safe', risky: 'risky' } };
  await run({ user_request: '請翻譯這句英文', char_bucket: 's' }, { kind: TASK_KIND }, { caller: 'cascade:t' });
  await run({ claims: ['x'], evidence: 'SECRET-EVIDENCE' }, { kind: TASK_KIND, risk }, { caller: 'cascade:t' });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { caller: 'cascade:t', q_total: 1, q_local: 1, q_cloud: 0,
    by_state_filter: 0, by_low_conf: 0, by_invalid: 0, by_no_match: 0 });
  // 長 state 被 state 過濾器整筆送雲端：兩題都記在 by_state_filter，不是低信心
  assert.equal(lines[1].q_cloud, 2);
  assert.equal(lines[1].by_state_filter, 2);
  assert.ok(!JSON.stringify(lines).includes('SECRET'), 'handoff line must not carry content');
});

// --- Shadow runs and the calibrated (caller, family) whitelist lane ---

const COMPACT_STATE = { phase: 'compact', transcript: 'long', dirty_paths: ['a'] };

test('shadow runs cloud-bound questions locally without changing or delaying the answer', async () => {
  const calls = [], samples = [];
  let releaseLocal;
  const local = (s, q) => { calls.push(['laya', Object.keys(q)]);
    return new Promise(res => { releaseLocal = () => res({ model: 'local', answers: { result_t3: { type: 'noul', noul: 0.9 } } }); }); };
  const cloud = async (s, q) => { calls.push(['jev', Object.keys(q)]);
    return { model: 'cloud', answers: Object.fromEntries(Object.keys(q).map(id => [id, { type: 'noul', noul: 0.8 }])) }; };
  const run = makeLayaRouter({ local, cloud, record: s => samples.push(s), shadow: true });
  // The local run never settles before the response: if the router awaited it, this would hang.
  const r = await run(COMPACT_STATE, { result_t3: NOUL_Q }, { caller: 'cascade:compact' });
  assert.deepEqual(r.answers, { result_t3: { type: 'noul', noul: 0.8 } }, 'the caller gets the teacher answer');
  assert.equal(r.model, 'cloud');
  assert.equal(samples.length, 0, 'shadow row waits for the local answer');

  // A second request while the first shadow run is in flight waits in the queue.
  await run(COMPACT_STATE, { result_t4: NOUL_Q }, { caller: 'cascade:compact' });
  assert.equal(calls.filter(c => c[0] === 'laya').length, 1);

  releaseLocal();
  await new Promise(res => setImmediate(res));
  assert.equal(samples.length, 1);
  assert.match(samples[0].request_id, /^[0-9a-f-]{36}$/, 'calibration counts requests, not units');
  assert.deepEqual({ ...samples[0], question: undefined, request_id: undefined }, { shadow: true, request_id: undefined, question_id: 'result_t3', caller: 'cascade:compact',
    family: 'result_t#', profile: null, question: undefined, local_model: 'local', local_answer: { type: 'noul', noul: 0.9 },
    local_confidence: 0.9, fallback_reason: null, teacher_model: 'cloud', teacher_answer: { type: 'noul', noul: 0.8 } });
  assert.ok(!('state' in samples[0]), 'the teacher corpus keeps state; the shadow row does not');
});

test('shadow digests a large request in small sampled batches after the teacher answers', async () => {
  const order = [], sizes = [], samples = [];
  const local = async (s, q) => { order.push('laya'); sizes.push(Object.keys(q).length);
    return { model: 'local', answers: Object.fromEntries(Object.keys(q).map(id => [id, { type: 'noul', noul: 0.9 }])) }; };
  const cloud = async (s, q) => { order.push('jev');
    return { model: 'cloud', answers: Object.fromEntries(Object.keys(q).map(id => [id, { type: 'noul', noul: 0.8 }])) }; };
  const run = makeLayaRouter({ local, cloud, record: s => samples.push(s), shadow: true,
    shadowLimits: { maxQ: 10, queueMax: 15, gapMs: 1, batch: 4 } });
  const many = (p, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${p}${i}`, NOUL_Q]));
  await run(COMPACT_STATE, many('result_t', 190), { caller: 'cascade:compact' });
  // Queue holds 10; a second 10-question sample would overflow 15 and is dropped.
  await run(COMPACT_STATE, many('claim_', 50), { caller: 'cascade:compact' });
  await new Promise(res => setTimeout(res, 50));
  assert.equal(order[0], 'jev', 'shadow never competes with the live request');
  assert.deepEqual(sizes, [4, 4, 2], '190 questions → 10 sampled, digested 4 at a time');
  assert.equal(samples.length, 10);
  assert.ok(samples.every(s => s.family === 'result_t#'));
  // Drained queue accepts work again.
  await run(COMPACT_STATE, many('claim_', 3), { caller: 'cascade:compact' });
  await new Promise(res => setTimeout(res, 20));
  assert.equal(samples.length, 13);
});

test('whitelist lane serves only the certified (caller, family) pair, behind its own floor', async () => {
  const wl = new Map([['cascade:compact\tresult_t#', 0.9]]);
  const mk = (noul) => {
    const calls = [], samples = [];
    const local = async (s, q) => { calls.push(['laya', Object.keys(q)]);
      return { model: 'local', answers: Object.fromEntries(Object.keys(q).map(id => [id, { type: 'noul', noul }])) }; };
    const cloud = async (s, q) => { calls.push(['jev', Object.keys(q)]);
      return { model: 'cloud', answers: Object.fromEntries(Object.keys(q).map(id => [id, { teacher: true }])) }; };
    return { calls, samples, run: makeLayaRouter({ local, cloud, record: s => samples.push(s), whitelist: () => wl }) };
  };
  // The state filter would reject this state outright; the whitelist replaces it for this pair.
  let t = mk(0.95);
  let r = await t.run(COMPACT_STATE, { result_t1: NOUL_Q, call_t1: NOUL_Q }, { caller: 'cascade:compact' });
  assert.deepEqual(t.calls, [['laya', ['result_t1']], ['jev', ['call_t1']]], 'call_t# is not certified');
  assert.deepEqual(r.answers.result_t1, { type: 'noul', noul: 0.95 });

  // Under the family's floor (0.9), even though it clears the type floor noul=0.70.
  t = mk(0.8);
  await t.run(COMPACT_STATE, { result_t1: NOUL_Q }, { caller: 'cascade:compact' });
  assert.deepEqual(t.calls, [['laya', ['result_t1']], ['jev', ['result_t1']]]);
  assert.equal(t.samples[0].fallback_reason, 'low-confidence');

  // Same family from another caller was never measured: cloud.
  t = mk(0.99);
  await t.run(COMPACT_STATE, { result_t1: NOUL_Q }, { caller: 'cascade:stop-gate' });
  assert.deepEqual(t.calls, [['jev', ['result_t1']]]);

  // A pinned model bypasses every local lane.
  t = mk(0.99);
  await t.run(COMPACT_STATE, { result_t1: NOUL_Q }, { caller: 'cascade:compact', model: 'pinned' });
  assert.deepEqual(t.calls, [['jev', ['result_t1']]]);
});

// fix 10628: live 白名單讓 62 題 compact 進本地，Laya 吃掉整個 15s deadline，
// 請求在 Jev 還沒被呼叫前就死掉——本地沒接到手，變成整條 compact 判斷全掛。
// 釘住：本地慢不能拖垮請求，Jev 一定還有預算答完。
test('a slow local lane loses only its own slice; the cloud still answers', async () => {
  const wl = new Map([['cascade:compact\tresult_t#', 0.5]]);
  const calls = [], samples = [];
  let localBudget = null;
  const local = async (s, q, opts) => {
    calls.push(['laya', Object.keys(q)]);
    localBudget = opts.deadlineAtMs - Date.now();
    await new Promise(r => setTimeout(r, 40));
    throw ERR.timeout('laya systemOne exceeded');
  };
  const cloud = async (s, q) => { calls.push(['jev', Object.keys(q)]);
    return { model: 'cloud', answers: Object.fromEntries(Object.keys(q).map(id => [id, { type: 'noul', noul: 0.1 }])) }; };
  const run = makeLayaRouter({ local, cloud, record: s => samples.push(s), whitelist: () => wl });
  const r = await run(COMPACT_STATE, { result_t1: NOUL_Q, call_t1: NOUL_Q }, { caller: 'cascade:compact' });
  assert.deepEqual(calls, [['laya', ['result_t1']], ['jev', ['call_t1', 'result_t1']]]);
  assert.equal(r.model, 'cloud');
  assert.deepEqual(Object.keys(r.answers).sort(), ['call_t1', 'result_t1']);
  assert.equal(samples[0].fallback_reason, 'local-error-or-invalid');
  // 本地只拿到自己那一片，剩下的留給 Jev
  assert.ok(localBudget <= LOCAL_BUDGET_MS, `local budget ${localBudget} must not exceed its slice`);
  assert.ok(localBudget < LIMITS.deadlineMs, 'local budget must not be the whole request deadline');
});

test('a stale, broken or missing whitelist file is an empty whitelist', async () => {
  const { loadWhitelist } = await import('../src/laya-routing.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wl-'));
  const f = join(dir, 'wl.json');
  const now = Date.parse('2026-10-13T00:00:00Z');
  const entries = [{ caller: 'c', family: 'f#', threshold: 0.8 }, { caller: 'c', family: 'g#', threshold: null }];
  writeFileSync(f, JSON.stringify({ generated: '2026-10-12T00:00:00Z', entries }));
  assert.deepEqual([...loadWhitelist(f, now)], [['c\tf#', 0.8]], 'an entry without a threshold is not certified');
  writeFileSync(f, JSON.stringify({ generated: '2026-10-09T00:00:00Z', entries }));
  assert.equal(loadWhitelist(f, now).size, 0, 'older than 3 days');
  writeFileSync(f, '{not json');
  assert.equal(loadWhitelist(f, now).size, 0);
  assert.equal(loadWhitelist(join(dir, 'missing.json'), now).size, 0);
});
