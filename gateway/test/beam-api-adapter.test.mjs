import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBeamApiAdapter } from '../src/adapters.js';
import { readZenStatus, recordZenStatus } from '../src/zen-status.js';

const QUESTIONS = { q: { type: 'noul', instructions: 'true?' } };
const NOW = 1_000_000;

test('beam API adapter 200 + valid JSON returns answer, calls /chat/completions with model=beam-free', async () => {
  const calls = [];
  const adapter = makeBeamApiAdapter({
    apiKey: 'k',
    statusFile: join(mkdtempSync(join(tmpdir(), 'beam-api-')), 's.json'),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answers":{"q":{"type":"noul","noul":0.7}}}' } }] }), { status: 200 });
    },
    now: () => NOW,
  });
  const r = await adapter('state', QUESTIONS);
  assert.equal(r.answers.q.noul, 0.7);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/chat/completions'));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'beam-free');
});

test('beam API adapter 500 calls backup', async () => {
  let backed = 0;
  const backup = async () => { backed += 1; return { model: 'cli', answers: { q: { type: 'noul', noul: 1 } } }; };
  const adapter = makeBeamApiAdapter({
    apiKey: 'k',
    statusFile: join(mkdtempSync(join(tmpdir(), 'beam-api-')), 's.json'),
    fetch: async () => new Response('err', { status: 500 }),
    backup,
  });
  const r = await adapter('s', QUESTIONS);
  assert.equal(backed, 1);
  assert.equal(r.model, 'cli');
});

test('beam API adapter 403 FreeTierError calls backup, writes cooldown, second call skips fetch', async () => {
  const statusFile = join(mkdtempSync(join(tmpdir(), 'beam-api-')), 's.json');
  let fetches = 0;
  let backed = 0;
  const backup = async () => { backed += 1; return { model: 'cli', answers: { q: { type: 'noul', noul: 1 } } }; };
  const adapter = makeBeamApiAdapter({
    apiKey: 'k',
    statusFile,
    now: () => NOW,
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: { type: 'FreeTierError', message: 'abuse' } }), { status: 403 });
    },
    backup,
  });
  await adapter('s', QUESTIONS);
  assert.equal(backed, 1);
  assert.equal(fetches, 1);
  const st = readZenStatus(statusFile);
  assert.ok(Number.isFinite(st?.cooldown_until) && st.cooldown_until > NOW);

  await adapter('s', QUESTIONS);
  assert.equal(backed, 2);
  assert.equal(fetches, 1, 'second call must not fetch during cooldown');
});

test('beam API adapter invalid probability/answer calls backup', async () => {
  let backed = 0;
  const backup = async () => { backed += 1; return { model: 'cli', answers: { q: { type: 'noul', noul: 0 } } }; };
  const adapter = makeBeamApiAdapter({
    apiKey: 'k',
    statusFile: join(mkdtempSync(join(tmpdir(), 'beam-api-')), 's.json'),
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"answers":{"q":{"type":"noul","noul":2}}}' } }] }), { status: 200 }),
    backup,
  });
  const r = await adapter('s', QUESTIONS);
  assert.equal(backed, 1);
  assert.equal(r.answers.q.noul, 0);
});
