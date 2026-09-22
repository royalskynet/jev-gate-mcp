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
import ocPlugin, { decideTurn, DEFAULT_CHEAP, DEFAULT_MIN_CHARS } from '../integrations/openclaw/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('prune: below threshold passes through verbatim, without a judge', async () => {
  let judged = false;
  const r = await pruneCommand(
    { tool: 'Bash', text: 'x'.repeat(100) },
    { key: 'k', judge: async (chunks) => { judged = true; return chunks.map(() => 'drop'); } },
  );
  assert.equal(r.text, 'x'.repeat(100));
  assert.equal(r.judged, false);
  assert.equal(r.reason, 'below-threshold');
  assert.equal(judged, false, 'a short result must not spend a Jev request');
});

test('prune: a drop verdict replaces the chunk with a visible marker', async () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
  assert.ok(text.length > 4000, 'fixture must clear the Bash threshold');
  const r = await pruneCommand({ tool: 'Bash', text }, { key: 'k', judge: async (chunks) => chunks.map(() => 'drop') });
  assert.equal(r.judged, true);
  assert.ok(r.dropped_lines > 0);
  assert.ok(r.chars_after < r.chars_before);
  assert.match(r.text, /\[jev-prune: dropped \d+ lines\]/);
});

test('prune: a throwing judge keeps the output (fail-open)', async () => {
  const text = 'z'.repeat(9000);
  const r = await pruneCommand({ tool: 'Bash', text }, { key: 'k', judge: async () => { throw new Error('boom'); } });
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
