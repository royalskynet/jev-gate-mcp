import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../src/redact.js';
import { buildGateway } from '../src/config.js';

// Built at runtime so no literal key shape lives in the repo.
const OR_KEY = ['sk', 'or', 'v1', 'a1b2c3'.repeat(11)].join('-');
const GH_KEY = 'ghp' + '_' + 'Z'.repeat(36);

test('redact masks known key shapes at any depth and leaves prose alone', () => {
  const out = redact({ user_request: `用這把 ${OR_KEY} 測`, nested: [{ t: `token ${GH_KEY}` }], n: 3, phase: 'acting' });
  assert.equal(out.user_request, '用這把 [REDACTED:openrouter] 測');
  assert.equal(out.nested[0].t, 'token [REDACTED:github]');
  assert.equal(out.n, 3);
  assert.equal(out.phase, 'acting');
  // Near-miss shapes are ordinary text, not secrets.
  assert.equal(redact('sk-or-v1-short and task-ant-farm'), 'sk-or-v1-short and task-ant-farm');
});

test('redact masks groq and telegram bot tokens, not their near-misses', () => {
  const groq = 'gsk' + '_' + 'Q'.repeat(52);
  const tg = '1234567890' + ':' + 'AA' + 'b'.repeat(33);
  assert.equal(redact(`g ${groq} t ${tg}`), 'g [REDACTED:groq] t [REDACTED:telegram]');
  assert.equal(redact('gsk_x 12345:AAshort'), 'gsk_x 12345:AAshort');
});

// 10-07: an unprefixed key pasted as "ci key:  <token>" passed every shape above
// and reached the cloud teacher; gitleaks generic-api-key caught it at rest.
test('redact masks a labelled bare key, keeps the label and plain identifiers', () => {
  const bare = 'Ab3' + 'x9Kq'.repeat(13);
  assert.equal(redact(`另存creds ci key:  ${bare} 謝`), '另存creds ci key:  [REDACTED:labelled] 謝');
  assert.equal(redact(`API_KEY="${bare}"`), 'API_KEY="[REDACTED:labelled]"');
  assert.equal(redact(`密鑰：${bare}`), '密鑰：[REDACTED:labelled]');
  // No digit, too short, or no assignment: ordinary text.
  assert.equal(redact('key: kv_cache_key_names_for_layer'), 'key: kv_cache_key_names_for_layer');
  assert.equal(redact('token=abc123'), 'token=abc123');
  assert.equal(redact(`the key ${bare}`), `the key ${bare}`);
});

// The incident: a pasted key in a hook prompt reached the cloud teacher and the
// teacher corpus. Both sinks sit behind the adapter boundary and must see only
// the masked state.
test('gateway masks state before the cloud provider and the teacher corpus', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-redact-'));
  const keyFile = path.join(dir, 'TYPESAFE_API_KEY.txt');
  fs.writeFileSync(keyFile, 'x');
  const seen = [];
  const recorded = [];
  const { gateway } = buildGateway({
    provider: 'laya', apiKeyFile: keyFile,
    layaAdapter: async () => { throw new Error('laya off'); },
    jevAdapter: async (state) => { seen.push(state); return { model: 'jev-test', answers: { q: { type: 'noul', noul: 1 } } }; },
    recordTeacherSample: (s) => { recorded.push(s.state); },
  });
  await gateway.evaluate({
    state: { user_request: `key=${OR_KEY}`, phase: 'acting' },
    questions: { q: { type: 'noul', instructions: 'ok?', criteria: { true: 'yes', false: 'no' } } },
  });
  assert.ok(seen.length >= 1, 'cloud adapter was called');
  for (const s of [...seen, ...recorded]) {
    assert.doesNotMatch(JSON.stringify(s), /a1b2c3a1b2c3/);
    assert.match(JSON.stringify(s), /REDACTED:openrouter/);
  }
  assert.ok(recorded.length >= 1, 'teacher corpus was written');
});
