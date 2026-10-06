// Why: the daily triage (difficulty / kind / costly_mistake) paid the cloud for
// every request because only the MCP set JEV_PROVIDER=laya. Triage now gets the
// laya router when the bundle is on disk — but only difficulty (score) and kind
// (task-kind-v1 profile) may be answered locally; costly_mistake is the one
// question whose wrong "safe" answer costs real damage, so it always stays on
// the cloud judge. A missing or broken bundle must never fail triage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGateway } from '../../gateway/src/config.js';
import { triageGatewayConfig, TRIAGE_LAYA_QTYPES } from '../../agent-glue/src/live.js';
import { makeGatewayTransport } from '../../agent-glue/src/client.js';
import { triage, triageQuestions } from '../../agent-glue/src/triage.js';

const BUNDLE = { exists: () => true, missing: () => false };

// A local model that is confident on every question, costly_mistake included:
// if costly_mistake is ever answered locally, this is what would let it through.
function confidentLocal(calls) {
  return async (s, qs) => {
    calls.push(['laya', Object.keys(qs).sort()]);
    const answers = {};
    for (const [id, q] of Object.entries(qs)) {
      if (q.type === 'score') {
        answers[id] = { type: 'score', score: 1, confidence: 0.97,
          probabilities: { 0: 0.01, 1: 0.97, 2: 0.01, 3: 0.01 } };
      } else if (q.type === 'noul') {
        answers[id] = { type: 'noul', noul: 0.02, confidence: 0.98 };
      } else {
        const keys = Object.keys(q.criteria);
        answers[id] = { type: 'choice', choice: keys[0], confidence: 0.99,
          probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])) };
      }
    }
    return { model: 'local', answers, usage: { input_tokens: 1, output_tokens: 0 } };
  };
}

function cloud(calls) {
  return async (s, qs) => {
    calls.push(['jev', Object.keys(qs).sort()]);
    const answers = {};
    for (const [id, q] of Object.entries(qs)) {
      answers[id] = q.type === 'noul'
        ? { type: 'noul', noul: 0.9, confidence: 0.9 }
        : q.type === 'score'
          ? { type: 'score', score: 3, confidence: 0.9, probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.9 } }
          : { type: 'choice', choice: Object.keys(q.criteria)[1], confidence: 0.9,
            probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 1 ? 1 : 0])) };
    }
    return { model: 'cloud', answers, usage: { input_tokens: 1, output_tokens: 0 } };
  };
}

function triageGateway(local, calls) {
  const cfg = triageGatewayConfig({ JEV_LAYA_MODEL_DIR: '/fake/bundle' }, BUNDLE.exists);
  const { gateway } = buildGateway({ ...cfg, telemetry: false, apiKeyFile: '/no/key',
    layaAdapter: local, jevAdapter: cloud(calls), teacherCorpus: false, recordRoutingSample: () => {} });
  return makeGatewayTransport(gateway);
}

const STATE = { user_request: '幫我改一行設定', char_bucket: 's' };

test('(a) triage defaults to the laya router when the bundle is on disk', () => {
  const cfg = triageGatewayConfig({}, BUNDLE.exists);
  assert.equal(cfg.provider, 'laya');
  assert.match(cfg.layaModelDir, /\.jevgate\/laya-trained-onnx$/);
  assert.deepEqual(cfg.layaQtypes, ['score']);
  assert.deepEqual([...TRIAGE_LAYA_QTYPES], ['score']);
  // settings.json pins JEV_PROVIDER=zen for every Claude Code child: that names
  // the cloud fallback, it must not switch the local lane off.
  const zen = triageGatewayConfig({ JEV_PROVIDER: 'zen' }, BUNDLE.exists);
  assert.equal(zen.provider, 'laya');
  assert.equal(zen.fallbackProvider, 'zen');
  assert.deepEqual(triageGatewayConfig({ JEV_PROVIDER: 'laya' }, BUNDLE.exists), { layaQtypes: ['score'] });
  assert.deepEqual(triageGatewayConfig({ JEV_PROVIDER: 'fake' }, BUNDLE.exists), {});
});

test('(a)+(b) difficulty and kind are answered locally, costly_mistake only by the cloud', async () => {
  const calls = [];
  const transport = triageGateway(confidentLocal(calls), calls);
  const res = await transport.evaluate({ state: STATE, questions: triageQuestions() });
  assert.deepEqual(calls, [['laya', ['difficulty', 'kind']], ['jev', ['costly_mistake']]]);
  assert.equal(res.answers.difficulty.score, 1);      // local
  assert.equal(res.answers.costly_mistake.noul, 0.9); // cloud, not the local 0.02
});

test('(c) no bundle -> plain gateway default (zen), never a laya provider', () => {
  assert.deepEqual(triageGatewayConfig({}, BUNDLE.missing), {});
  assert.deepEqual(triageGatewayConfig({ JEV_LAYA_MODEL_DIR: '/nope' }, BUNDLE.missing), {});
});

test('(c) a bundle that fails to load falls back to the cloud; triage does not fail open', async () => {
  const calls = [];
  const broken = async () => { calls.push(['laya-broken']); throw new Error('onnx load failed'); };
  const transport = triageGateway(broken, calls);
  const decision = await triage({ text: '幫我改一行設定', contextChars: 0 }, { transport });
  assert.equal(decision.failOpen, false);
  assert.ok(calls.some(c => c[0] === 'laya-broken'), 'the local lane was tried');
  assert.ok(calls.some(c => c[0] === 'jev' && c[1].includes('difficulty')), 'difficulty reached the cloud after local failure');
});
