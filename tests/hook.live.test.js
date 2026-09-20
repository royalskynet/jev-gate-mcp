import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG, judgeChunk, pruneText, register } from '../hooks/jev.js';

// The hook module carries its own wire code (it runs with no Node, so it cannot
// share plugin/lib/judge.js). That duplicate is exactly where a wrong model id
// or endpoint would hide behind fail-open, so it needs its own positive
// assertion: a real call, and output that measurably shrinks.
const hasKey = existsSync(CONFIG.apiKeyFile);

/** A stand-in for the engine's `$`, backed by Node. */
function makeHost() {
  const logs = [];
  return {
    logs,
    http: { fetch: async (url, init) => {
      const res = await fetch(url, init);
      return { status: res.status, ok: res.ok, headers: {}, text: await res.text() };
    } },
    fs: { read: async (p) => readFileSync(p, 'utf8') },
    ui: { log: (t) => logs.push(t) },
  };
}

const SIGNAL = 'ERROR: config.yaml not found at /etc/app/config.yaml';
function fixture() {
  const noise = Array.from({ length: 400 }, (_, i) => `debug heartbeat tick ${i} ok ok ok ok ok ok ok ok`);
  return [...noise.slice(0, 200), SIGNAL, ...noise.slice(200)].join('\n');
}

test('live: hook wire actually judges — a noise chunk comes back "drop"', { skip: !hasKey && 'no api key' }, async () => {
  const $ = makeHost();
  const key = readFileSync(CONFIG.apiKeyFile, 'utf8').trim();
  const noise = Array.from({ length: 200 }, (_, i) => `debug heartbeat tick ${i} ok ok ok`).join('\n');
  const verdict = await judgeChunk($, key, 'Find why the app cannot load its config file.', noise);
  // Positive assertion: a wrong model id / endpoint / body shape fails open to
  // 'keep', so only a real 'drop' proves the wire.
  assert.equal(verdict, 'drop', 'judge returned keep — wire likely failed open');
});

test('live: tool.call hook shrinks a long Bash stdout', { skip: !hasKey && 'no api key' }, async () => {
  const $ = makeHost();
  const out = fixture();
  assert.ok(out.length > CONFIG.thresholdChars);

  let hook;
  register((event, matcher, fn) => { if (event === 'tool.call') hook = fn; });
  assert.ok(hook, 'register did not add a tool.call hook');

  const core = { ref: 7, text: out, result: { stdout: out, stderr: '', interrupted: false } };
  const r = await hook($, { tool: 'Bash', command: 'run-app', description: 'Find why the app cannot load its config file.' }, async () => core);

  assert.ok(r.result.stdout.length < out.length, `expected pruning, got ${r.result.stdout.length}/${out.length}`);
  assert.equal(r.ref, undefined, 'kept core ref — the pruned record would be ignored');
  assert.ok($.logs.some((l) => l.startsWith('jev-prune:')), 'no prune log line');
});

test('pruneText never truncates chunks past the judged window', async () => {
  const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
  const { kept, droppedLines } = await pruneText(text, async () => 'drop', 0);
  assert.equal(kept, text);
  assert.equal(droppedLines, 0);
});

test('pruneText fails open when the judge throws', async () => {
  const text = 'a\nb\nc';
  const { kept, droppedLines } = await pruneText(text, async () => { throw new Error('boom'); });
  assert.equal(kept, text);
  assert.equal(droppedLines, 0);
});
