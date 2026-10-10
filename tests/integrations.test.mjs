/**
 * The two out-of-repo runtimes' adapters, offline.
 *
 * What these guard is the defect family §18.2/§19.2 keeps producing: an
 * adapter that loads, fires, and can never change anything — because the model
 * map shipped empty, or the threshold sits above what the host delivers, or the
 * judge's answer is discarded. Each assertion below is "with nothing
 * configured, does the adapter still reach a usable decision".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pruneCommand } from '../agent-glue/src/prune.js';
import ocPlugin, { decideTurn, pluginConfigOf, DEFAULT_CHEAP, DEFAULT_MIN_CHARS } from '../integrations/openclaw/index.mjs';
import { makeProvider, toCompactShape, PROVIDER_ID } from '../integrations/openclaw/compact-provider.mjs';
import { TARGETS } from '../hooks/jev.js';

// Sized off the live threshold, not a literal: raising `thresholdChars` used to
// turn these fixtures into `below-threshold` passes that still went green.
const BIG = TARGETS.Bash.thresholdChars + 1000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('prune: below threshold passes through verbatim, without a judge', async () => {
  let judged = false;
  const r = await pruneCommand(
    { tool: 'Bash', request: 'why is it slow?', text: 'x'.repeat(100) },
    { key: 'k', judge: async (chunks) => { judged = true; return chunks.map(() => 'drop'); } },
  );
  assert.equal(r.text, 'x'.repeat(100));
  assert.equal(r.judged, false);
  assert.equal(r.reason, 'below-threshold');
  assert.equal(judged, false, 'a short result must not spend a Jev request');
});

test('prune: a drop verdict replaces the chunk with a visible marker', async () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
  assert.ok(text.length > TARGETS.Bash.thresholdChars, 'fixture must clear the Bash threshold');
  const r = await pruneCommand(
    { tool: 'Bash', request: 'why is it slow?', text },
    { key: 'k', judge: async (chunks) => chunks.map(() => 'drop') },
  );
  assert.equal(r.judged, true);
  assert.ok(r.dropped_lines > 0);
  assert.ok(r.chars_after < r.chars_before);
  assert.match(r.text, /\[jev-prune: dropped \d+ lines\]/);
});

test('prune: no request means no prune, not a prune against a stand-in', async () => {
  // §22.3: the Hermes middleware fed the tool's own shell command in as the
  // request, and a 40 KB file the task was entirely about came back 99.8%
  // dropped. Every criteria row is written relative to the user's task, so
  // without one there is nothing to judge against — refuse, never guess.
  let judged = false;
  const r = await pruneCommand(
    { tool: 'Bash', text: 'x'.repeat(BIG) },
    { key: 'k', judge: async (chunks) => { judged = true; return chunks.map(() => 'drop'); } },
  );
  assert.equal(r.reason, 'no-request');
  assert.equal(r.judged, false);
  assert.equal(r.text.length, BIG);
  assert.equal(judged, false, 'no request must not spend a Jev request either');
});

test('prune: a throwing judge keeps the output (fail-open)', async () => {
  const text = 'z'.repeat(BIG);
  const r = await pruneCommand(
    { tool: 'Bash', request: 'why is it slow?', text },
    { key: 'k', judge: async () => { throw new Error('boom'); } },
  );
  assert.equal(r.text, text);
  assert.equal(r.dropped_lines, 0);
});

test('prune: the CLI answers valid JSON and exits 0 with no credential', async () => {
  const r = await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['agent-glue/cli.mjs', 'prune'],
      { cwd: ROOT, env: { ...process.env, OPENROUTER_API_KEY: '' } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin.end(JSON.stringify({ tool: 'Bash', text: 'short' }));
  });
  assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  const v = JSON.parse(r.stdout);
  assert.equal(v.text, 'short');
  assert.equal(v.judged, false);
});

test('openclaw: the cheap rung ships, so the plugin can actually decide', () => {
  assert.ok(DEFAULT_CHEAP.model, 'an empty ladder would make the hook a no-op everywhere');
  assert.ok(DEFAULT_CHEAP.provider);
  assert.equal(typeof ocPlugin.register, 'function');
});

test('openclaw: a cheap tier becomes a provider+model override', async () => {
  const { override, entry } = await decideTurn(
    { prompt: 'rename this variable '.repeat(20) },
    {},
    { transport: fakeTransport('cheap'), now: 'T' },
  );
  assert.deepEqual(override, { providerOverride: DEFAULT_CHEAP.provider, modelOverride: DEFAULT_CHEAP.model });
  assert.equal(entry.outcome, 'cheap');
  assert.equal(entry.tier, 'cheap');
});

test('openclaw: nothing but the cheap rung is wired -> no upgrade is possible', async () => {
  const { override, entry } = await decideTurn(
    { prompt: 'design the migration '.repeat(20) },
    {},
    { transport: fakeTransport('hard'), now: 'T' },
  );
  assert.equal(override, null, 'a hard verdict must leave the turn on the status quo model');
  assert.equal(entry.outcome, 'no-model-map');
  assert.equal(entry.tier, 'hard');
});

test('openclaw: short turns and the escape hatch spend no request', async () => {
  let asked = false;
  const spy = { evaluate: async () => { asked = true; return {}; } };
  const short = await decideTurn({ prompt: 'x'.repeat(DEFAULT_MIN_CHARS - 1) }, {}, { transport: spy, now: 'T' });
  assert.equal(short.override, null);
  assert.equal(short.entry.outcome, 'too-short');
  const off = await decideTurn(
    { prompt: 'a real turn '.repeat(40) },
    {},
    { transport: spy, now: 'T', env: { JEV_OPENCLAW_TRIAGE: 'off' } },
  );
  assert.equal(off.override, null);
  assert.equal(off.entry.outcome, 'off');
  assert.equal(asked, false);
});

test('openclaw: a broken transport keeps the turn on its own model', async () => {
  const { override, entry } = await decideTurn(
    { prompt: 'a real turn '.repeat(40) },
    {},
    { transport: { evaluate: async () => { throw new Error('down'); } }, now: 'T' },
  );
  assert.equal(override, null);
  assert.equal(entry.outcome, 'status-quo');
});

test('openclaw: triage:false in plugin config spends no request', async () => {
  let asked = false;
  const spy = { evaluate: async () => { asked = true; return {}; } };
  const r = await decideTurn({ prompt: 'a real turn '.repeat(40) }, { triage: false }, { transport: spy, now: 'T' });
  assert.equal(r.override, null);
  assert.equal(r.entry.outcome, 'off');
  assert.equal(asked, false);
});

// api.config is the whole openclaw config; the plugin's own block is
// api.pluginConfig. Reading the former made every plugin setting a no-op.
test('openclaw: register reads api.pluginConfig and registers the compaction provider', async () => {
  let hook; const providers = [];
  ocPlugin.register({
    config: { triage: true },
    pluginConfig: { triage: false },
    on: (name, fn) => { if (name === 'before_model_resolve') hook = fn; },
    registerCompactionProvider: (p) => providers.push(p),
  });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, PROVIDER_ID);
  assert.equal(hook, undefined, 'triage:false must not register a hook that needs conversation access');
  ocPlugin.register({ pluginConfig: {}, on: (name, fn) => { if (name === 'before_model_resolve') hook = fn; }, registerCompactionProvider: () => {} });
  assert.equal(typeof hook, 'function');
  assert.deepEqual(pluginConfigOf({ config: { triage: true }, pluginConfig: { triage: false } }), { triage: false });
  assert.deepEqual(pluginConfigOf({ config: { cheapModel: 'x' } }), {}, 'the whole openclaw config is not plugin config');
});

/** One openclaw (pi-ai) span: a big dead tool pair, then the user's real ask. */
function ocSpan(resultChars) {
  return [
    { role: 'user', content: [{ type: 'text', text: 'list the repo, then fix the flaky test' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Listing.' }, { type: 'toolCall', id: 'c1', name: 'exec', arguments: { command: 'ls -R' } }] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'exec', content: [{ type: 'text', text: 'f'.repeat(resultChars) }], isError: false },
    { role: 'assistant', content: [{ type: 'text', text: 'The flaky test is test_sync_lock.' }] },
  ];
}

test('openclaw compaction: pi-ai toolCall/toolResult pair up for the judge', () => {
  const m = toCompactShape(ocSpan(10));
  assert.equal(m[1].tool_calls[0].id, 'c1');
  assert.equal(m[2].role, 'tool');
  assert.equal(m[2].tool_call_id, 'c1');
  assert.equal(m[0].content, 'list the repo, then fix the flaky test');
});

test('openclaw compaction: a dropped pair is elided, user/assistant text stays verbatim', async () => {
  const lines = [];
  const p = makeProvider({}, { key: 'k', judge: async () => 'drop', log: async (l) => lines.push(l) });
  const out = await p.summarize({ messages: ocSpan(20000) });
  assert.ok(out.length < 2000, `summary kept the dead payload (${out.length} chars)`);
  assert.match(out, /list the repo, then fix the flaky test/);
  assert.match(out, /The flaky test is test_sync_lock./);
  assert.match(lines[0], /tool sites elided/);
});

// openclaw falls back to its built-in summarizer only on a throw / empty result,
// so every "cannot vouch for it" path must throw rather than return the span.
test('openclaw compaction: keep, no key, or too little relief all hand back to built-in', async () => {
  const log = async () => {};
  await assert.rejects(makeProvider({}, { key: 'k', judge: async () => 'keep', log }).summarize({ messages: ocSpan(20000) }));
  await assert.rejects(makeProvider({}, { key: null, log }).summarize({ messages: ocSpan(20000) }));
  await assert.rejects(makeProvider({}, { key: 'k', judge: async () => { throw new Error('down'); }, log }).summarize({ messages: ocSpan(20000) }));
  await assert.rejects(makeProvider({ maxKeepRatio: 0.0001 }, { key: 'k', judge: async () => 'drop', log }).summarize({ messages: ocSpan(20000) }));
});

// #31: one 196-pair span sent 196 Zen requests, all 429, each swallowed as keep.
// Batched judging must keep a quota-exhausted span to a handful of requests,
// and the ledger must say it was the judge's HTTP status, not "below floor".
test('openclaw compaction: a 429 costs one request per batch, not one per pair', async () => {
  const span = [{ role: 'user', content: [{ type: 'text', text: 'fix the flaky test' }] }];
  for (let i = 0; i < 196; i++) {
    span.push({ role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'exec', arguments: { command: `ls ${i}` } }] });
    span.push({ role: 'toolResult', toolCallId: `c${i}`, toolName: 'exec', content: [{ type: 'text', text: 'f'.repeat(500) }] });
  }
  let calls = 0;
  const $ = { fs: { read: async () => '' }, http: { fetch: async () => { calls += 1; return { ok: false, status: 429, text: '' }; } } };
  const lines = [];
  await assert.rejects(makeProvider({}, { key: 'k', $, log: async (l) => lines.push(l) }).summarize({ messages: span }));
  assert.equal(calls, Math.ceil(196 / 40));
  assert.match(lines[0], /judge-http-429/);
});

/** A transport that answers whatever tier the test wants, in Jev's answer shape. */
function fakeTransport(tier) {
  // The real scale: difficulty is a 1..3 `score` (simple < 1.5, hard >= 2.0)
  // and costly_mistake is a `noul`, not a probability.
  const byTier = {
    cheap: { difficulty: { score: 1.0, confidence: 0.95 }, kind: { choice: 'mechanical', confidence: 0.95 }, costly_mistake: { noul: 0.02, confidence: 0.95 } },
    hard: { difficulty: { score: 3.0, confidence: 0.95 }, kind: { choice: 'architecture', confidence: 0.95 }, costly_mistake: { noul: 0.2, confidence: 0.95 } },
  };
  return { evaluate: async () => ({ answers: byTier[tier], latency_ms: 1 }) };
}

// A SKILL.md with no frontmatter loads nowhere: no `name`, no `description`, so
// nothing can match a situation and fire it. That failure is silent — the file
// is right there in the repo — which is the declaration≠effect family again
// (DEVLOG §18.2). `skills/jev-agent/SKILL.md` shipped that way until §21.
test('every skill declares frontmatter with a name and a description', () => {
  const root = new URL('../skills/', import.meta.url);
  const names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(names.length, 'no skills found');
  for (const name of names) {
    const text = readFileSync(new URL(`${name}/SKILL.md`, root), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `skills/${name}/SKILL.md has no frontmatter — it can never be invoked`);
    assert.match(fm[1], /^name:\s*\S/m, `skills/${name}: frontmatter has no name`);
    assert.match(fm[1], /^description:\s*\S/m, `skills/${name}: frontmatter has no description`);
  }
});
