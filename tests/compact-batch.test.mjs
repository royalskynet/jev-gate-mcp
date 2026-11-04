import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { sessionSize, defaultRoots, candidates, parseCompactStream, jevOutcome } from '../scripts/compact-batch.mjs';

const usage = (n) => JSON.stringify({ type: 'assistant', sessionId: 's1', cwd: '/w', message: { usage: { input_tokens: 1, cache_creation_input_tokens: n, cache_read_input_tokens: 0, output_tokens: 1 } } });
const boundary = (post) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: 's1', cwd: '/w', compactMetadata: { preTokens: 9, postTokens: post } });

test('sessionSize: last usage counts all input buckets', () => {
  assert.deepEqual(sessionSize([usage(100), usage(5000)]), { id: 's1', cwd: '/w', tokens: 5002 });
});

test('sessionSize: a later compact_boundary wins over earlier usage', () => {
  assert.equal(sessionSize([usage(300000), boundary(9000)]).tokens, 9000);
  assert.equal(sessionSize([boundary(9000), usage(250000)]).tokens, 250002);
});

test('sessionSize: skips malformed lines', () => {
  assert.equal(sessionSize(['{bad', '', usage(10)]).tokens, 12);
});

function fakeClaude(root, name, lines, ageMin) {
  const dir = path.join(root, 'projects', '-w');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.jsonl`);
  writeFileSync(f, lines.join('\n'));
  const t = (Date.now() - ageMin * 60000) / 1000;
  utimesSync(f, t, t);
  return f;
}

test('defaultRoots: includes OpenMausBot engine homes', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  mkdirSync(path.join(home, '.openmausbot', 'engine-homes', 'team', '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.openmausbot', 'engine-homes', 'room-ab'), { recursive: true });
  const roots = defaultRoots(home, {});
  assert.deepEqual(roots, [path.join(home, '.claude'), path.join(home, '.openmausbot', 'engine-homes', 'team', '.claude')]);
});

test('candidates: floor, idle and busy filters; biggest first', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  const mk = (id, n, age) => fakeClaude(root, id, [usage(n).replace('"s1"', `"${id}"`)], age);
  mk('big', 400000, 60);
  mk('mid', 250000, 60);
  mk('small', 1000, 60);
  mk('fresh', 500000, 1);
  mk('busy', 500000, 60);
  const got = candidates([root], { minTokens: 200000, idleMin: 30, busy: (id) => id === 'busy' });
  assert.deepEqual(got.map((s) => s.id), ['big', 'mid']);
  assert.equal(got[0].root, root);
});

test('parseCompactStream: reads snake_case boundary from stream-json', () => {
  const out = [
    '{"type":"system","subtype":"init"}',
    'not json',
    '{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":28368,"post_tokens":9589}}',
  ].join('\n');
  assert.deepEqual(parseCompactStream(out), { ok: true, pre: 28368, post: 9589, trigger: 'manual' });
});

test('parseCompactStream: surfaces the host refusal that exits 0', () => {
  const out = [
    '{"type":"system","subtype":"status","status":null,"compact_result":"failed"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Not enough messages to compact."}',
  ].join('\n');
  assert.deepEqual(parseCompactStream(out), { ok: false, error: 'Not enough messages to compact.' });
  assert.deepEqual(parseCompactStream(''), { ok: false, error: 'no compact_boundary in output' });
});

test('jevOutcome: pruned, built-in fallback, or hook absent', () => {
  const reg = '2026-11-04T04:39:23Z\tjev-compact: registered (at 60% or 200000 tokens)\n';
  assert.deepEqual(jevOutcome(`${reg}2026-11-04T04:45:23Z\tjev-compact: backend=anthropic, 449479 → 412044 chars, 37435 dropped, 9/11 messages, verbatim, trigger=manual\n`),
    { jev: 'pruned', charsBefore: 449479, charsAfter: 412044 });
  assert.equal(jevOutcome(`${reg}x\tjev-compact: fell back to built-in (backend=anthropic, reducedBy 0 of 206 chars, floor 4000)\n`).jev, 'built-in');
  assert.deepEqual(jevOutcome(reg), { jev: 'absent' });
  assert.deepEqual(jevOutcome(''), { jev: 'absent' });
});

test('cli: runs main when invoked through a symlinked path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  const link = path.join(dir, 'cb.mjs');
  symlinkSync(fileURLToPath(new URL('../scripts/compact-batch.mjs', import.meta.url)), link);
  const r = spawnSync(process.execPath, [link, '--root', path.join(dir, 'none')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 session\(s\)/);
});

test('cli: --cwd filters and --backup copies before compacting', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  const line = (id, cwd) => usage(300000).replace('"s1"', `"${id}"`).replace('"/w"', `"${cwd}"`);
  // Random ids: `pgrep -f keep` matches any process whose command line says "keep" and skips it as running.
  const keep = `k${randomUUID()}`, skip = `s${randomUUID()}`;
  fakeClaude(root, keep, [line(keep, '/bots/a')], 60);
  fakeClaude(root, skip, [line(skip, '/home/me')], 60);
  const bak = path.join(root, 'bak');
  // `false` as the claude binary: compaction fails, but the backup must already exist.
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/compact-batch.mjs', import.meta.url)),
    '--root', root, '--cwd', '/bots/', '--backup', bak, '--execute', '--claude', 'false'], { encoding: 'utf8' });
  assert.match(r.stdout, new RegExp(`^${keep}\\t`, 'm'));
  assert.doesNotMatch(r.stdout, new RegExp(`^${skip}\\t`, 'm'));
  assert.deepEqual(readdirSync(bak), [`${keep}.jsonl`]);
});
