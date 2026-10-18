/**
 * usage.jsonl exists to say who spent the Zen quota — and must never become a
 * second copy of what was judged. These pin both halves: the line carries the
 * allowlisted counters and nothing else, and a ledger that cannot be written
 * never reaches the caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logUsage, meteredFetch, usageFile, handoffFile } from '../agent-glue/src/usage-ledger.js';
import { hookUsageFile } from '../agent-glue/claude/usage-line.mjs';

const SECRET = 'PROMPT-CONTENT-must-not-leak';

test('a usage line carries the counters and none of the content passed with them', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jev-usage-')), 'usage.jsonl');
  assert.equal(logUsage({
    caller: 'cli:test', model: 'jev-1.13-free', status: 429, input_tokens: 12, output_tokens: 3, latency_ms: 40,
    prompt: SECRET, state: { user_request: SECRET }, response: SECRET, apiKey: SECRET,
  }, file), true);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(SECRET), 'content leaked into usage.jsonl');
  const line = JSON.parse(raw);
  assert.deepEqual(Object.keys(line).sort(),
    ['caller', 'input_tokens', 'latency_ms', 'model', 'output_tokens', 'status', 'ts']);
  assert.equal(line.status, 429);
});

// fix 10668: a bare `node --test` used to append laya-routing fixtures to the
// live laya-handoff.jsonl as caller cascade:compact — 16 of the 210 "invalid"
// rows on 10-18 were test runs. Under the test runner the default is off.
test('under node --test the ledgers default to off; an explicit path still wins; hosts get the live file', () => {
  const t = { NODE_TEST_CONTEXT: 'child-v8' };
  assert.equal(usageFile(t), 'off');
  assert.equal(handoffFile(t), 'off');
  assert.equal(handoffFile({ ...t, JEV_HANDOFF_LOG: '/tmp/h.jsonl' }), '/tmp/h.jsonl');
  assert.match(usageFile({}), /\.jevgate\/usage\.jsonl$/);
  assert.match(handoffFile({}), /\.jevgate\/laya-handoff\.jsonl$/);
});

test('an unwritable ledger answers false instead of throwing', () => {
  assert.doesNotThrow(() => logUsage({ caller: 'x' }, '/nonexistent-root-dir/\0bad/usage.jsonl'));
  assert.equal(logUsage({ caller: 'x' }, '/nonexistent-root-dir/\0bad/usage.jsonl'), false);
  assert.equal(logUsage({ caller: 'x' }, 'off'), false);
});

test('meteredFetch records a 429 with its tokens, never the request, URL query or body', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jev-usage-')), 'usage.jsonl');
  const prev = process.env.JEV_USAGE_LOG;
  process.env.JEV_USAGE_LOG = file;
  try {
    const fake = async () => new Response(JSON.stringify({ error: SECRET, usage: { input_tokens: 7, output_tokens: 1 } }), { status: 429 });
    const res = await meteredFetch('gateway:test', fake)(`https://example.invalid/v1/systemone?token=${SECRET}`, {
      method: 'POST', headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ model: 'jev-1.13-free', state: { user_request: SECRET } }),
    });
    assert.equal(res.status, 429);
    assert.match(await res.text(), /usage/, 'the caller still reads the full body');
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(SECRET));
    assert.deepEqual(
      (({ ts, latency_ms, ...rest }) => rest)(JSON.parse(raw)),
      { caller: 'gateway:test', model: 'jev-1.13-free', status: 429, input_tokens: 7, output_tokens: 1 },
    );
    // A thrown fetch is a call too, and still rethrows to the caller.
    await assert.rejects(meteredFetch('gateway:test', async () => { throw new Error('net'); })('https://example.invalid', {}), /net/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[1]).status, 'error');
  } finally {
    if (prev === undefined) delete process.env.JEV_USAGE_LOG; else process.env.JEV_USAGE_LOG = prev;
  }
});

test('hooks write a per-day file beside the shared one, and honour off', () => {
  assert.equal(hookUsageFile({ JEV_USAGE_LOG: 'off' }, '2026-10-05T00:00:00Z'), null);
  assert.equal(hookUsageFile({ HOME: '/h' }, '2026-10-05T01:02:03Z'), '/h/.jevgate/usage-hook-2026-10-05.jsonl');
});

test('the prune hook leaves one hook-triage line per Jev call, 429 included, content-free', async () => {
  const { register, CONFIG } = await import('../hooks/jev.js');
  const dir = mkdtempSync(join(tmpdir(), 'jev-usage-hook-'));
  const prev = process.env.JEV_USAGE_LOG;
  process.env.JEV_USAGE_LOG = join(dir, 'usage.jsonl');
  const files = { [CONFIG.apiKeyFile]: 'sk-test\n' };
  const $ = {
    clock: { now: async () => Date.parse('2026-10-05T00:00:00.000Z'), sleep: () => new Promise(() => {}) },
    fs: {
      read: async (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); },
      exists: async (p) => p in files,
      write: async (p, t) => { files[p] = t; },
    },
    http: { fetch: async () => ({ ok: false, status: 429, text: JSON.stringify({ error: SECRET }) }) },
    ui: { log: () => {} },
    session: { messages: async () => [{ role: 'user', text: SECRET }] },
  };
  try {
    const hooks = [];
    register((event, filter, fn) => hooks.push({ filter, fn }));
    const bash = hooks.find((h) => h.filter?.tool === 'Bash');
    await bash.fn($, {}, async () => ({ result: { stdout: `${SECRET}\n`.repeat(2000) } }));
    const raw = files[join(dir, 'usage-hook-2026-10-05.jsonl')];
    assert.ok(raw, 'no hook usage file written');
    assert.ok(!raw.includes(SECRET));
    const line = JSON.parse(raw);
    assert.equal(line.caller, 'hook-triage');
    assert.equal(line.status, 429);
  } finally {
    if (prev === undefined) delete process.env.JEV_USAGE_LOG; else process.env.JEV_USAGE_LOG = prev;
  }
});
