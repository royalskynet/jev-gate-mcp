// JEV_LAYA_SERVE_URL switches the local lane to upstream laya-serve over HTTP.
// The A/B against the int8 bundle is only honest if the switch really reaches
// the server and the action head stays quarantined like rl_agent does.
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { makeLayaAdapter } from '../src/adapters.js';

test('JEV_LAYA_SERVE_URL routes to laya-serve and strips the action head', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'laya-rl-agent',
        answers: { q: { type: 'noul', noul: 0.9, confidence: 0.8, x_jev_confidence: 0.8, action: { act_probability: 7.3 } } },
        usage: { input_tokens: 3, output_tokens: 0 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.JEV_LAYA_SERVE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const adapter = makeLayaAdapter({ modelDir: '/nonexistent-bundle' });
    const out = await adapter('state', { q: { type: 'noul', instructions: 'ok?' } });
    assert.equal(seen.length, 1, 'one HTTP call, the ONNX bundle path is never touched');
    assert.equal(seen[0].url, '/v1/systemone');
    assert.equal(out.answers.q.noul, 0.9);
    assert.equal(out.answers.q.x_jev_confidence, 0.8, 'Jev-scale confidence rides through for the gate');
    assert.equal(out.answers.q.action, undefined, 'raw act logits must not leak as certainty');
  } finally {
    delete process.env.JEV_LAYA_SERVE_URL;
    server.close();
  }
});

test('without JEV_LAYA_SERVE_URL the injected/ONNX path is unchanged', async () => {
  delete process.env.JEV_LAYA_SERVE_URL;
  let loaded = 0;
  const adapter = makeLayaAdapter({ load: () => { loaded++; return { systemOne: async () => ({ model: 'local/laya', answers: { q: { type: 'noul', noul: 1 } } }) }; } });
  const out = await adapter('state', { q: { type: 'noul', instructions: 'ok?' } });
  assert.equal(loaded, 1);
  assert.equal(out.model, 'local/laya');
});
