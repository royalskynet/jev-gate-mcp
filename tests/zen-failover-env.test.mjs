import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Why (#28): M2 exports JEV_ENDPOINT/JEV_MODEL/JEV_API_KEY_FILE set to the Zen
// defaults. followsZen() read "set" as "pinned elsewhere", so during a Zen
// cooldown nothing switched to OpenRouter and every prune failed open to keep.
// Env is set before the imports: zen-status.js and hooks/jev.js read it at load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-zen-env-'));
const kv = path.join(home, '.creds', 'kv');
fs.mkdirSync(kv, { recursive: true });
fs.writeFileSync(path.join(kv, 'OPENCODE_ZEN_API_KEY.txt'), 'zen-test-key');
fs.writeFileSync(path.join(kv, 'OPENROUTER_SECOND_API_KEY.txt'), 'or-test-key');
const statusFile = path.join(home, 'zen-free-status.json');
Object.assign(process.env, {
  HOME: home,
  JEV_ENDPOINT: 'https://opencode.ai/zen/v1/systemone',
  JEV_MODEL: 'jev-1.13-free',
  JEV_API_KEY_FILE: path.join(kv, 'OPENCODE_ZEN_API_KEY.txt'),
  JEV_ZEN_STATUS_FILE: statusFile,
  JEV_USAGE_LOG: 'off',
  JEV_CLI_LEDGER: '/dev/null',
  JEV_LEDGER: '/dev/null',
});

const { followsZen, ZEN_BACKUP } = await import('../agent-glue/claude/env.mjs');
const { refreshConfig, CONFIG } = await import('../hooks/jev.js');
const { pruneCommand } = await import('../agent-glue/src/prune.js');

test('env set to the Zen defaults still follows Zen and takes the backup', () => {
  assert.equal(followsZen(), true);
  refreshConfig(true);
  assert.equal(CONFIG.endpoint, ZEN_BACKUP.endpoint);
  assert.equal(CONFIG.model, ZEN_BACKUP.model);
  assert.match(CONFIG.apiKeyFile, /OPENROUTER_SECOND_API_KEY\.txt$/);
  refreshConfig();
  assert.equal(CONFIG.endpoint, 'https://opencode.ai/zen/v1/systemone');
});

test('a host pinned elsewhere never takes the backup', () => {
  const saved = process.env.JEV_ENDPOINT;
  process.env.JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
  try {
    assert.equal(followsZen(), false);
    refreshConfig(true);
    assert.equal(CONFIG.endpoint, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(CONFIG.model, 'jev-1.13-free');
  } finally {
    process.env.JEV_ENDPOINT = saved;
    refreshConfig();
  }
});

// The probe had not written a cooldown yet: the first 429 must switch this very
// call to OpenRouter, not keep everything for up to an hour.
test('prune: a Zen 429 retries the same request on OpenRouter and starts the cooldown', async () => {
  const hits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    hits.push({ host: new URL(url).host, model: body.model, auth: init.headers.Authorization });
    if (url.includes('opencode.ai')) return new Response('{"error":"FreeUsageLimitError"}', { status: 429 });
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { choice: 'drop' }]));
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  try {
    const noise = Array.from({ length: 3000 }, (_, i) => `heartbeat ok tick ${i}`).join('\n');
    const r = await pruneCommand({ tool: 'Bash', request: 'qqqq', text: noise });
    assert.equal(r.judged, true);
    assert.ok(r.chars_after < r.chars_before, `expected pruning, got ${r.chars_after}/${r.chars_before}`);
    assert.equal(hits[0].host, 'opencode.ai');
    assert.equal(hits[1].host, 'openrouter.ai');
    assert.equal(hits[1].model, ZEN_BACKUP.model);
    assert.equal(hits[1].auth, 'Bearer or-test-key');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.ok(status.cooldown_until > Date.now(), 'the next call must skip Zen');
  } finally {
    globalThis.fetch = realFetch;
    refreshConfig();
  }
});
