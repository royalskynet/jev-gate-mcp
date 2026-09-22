import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG, LEDGER, TARGETS, TARGET_NAMES, appendLedger, judgeChunk, pruneText, register, userRequestOf } from '../hooks/jev.js';

// The hook module carries its own wire code (it runs with no Node, so it cannot
// share plugin/lib/judge.js). That duplicate is exactly where a wrong model id
// or endpoint would hide behind fail-open, so it needs its own positive
// assertion: a real call, and output that measurably shrinks.
const hasKey = existsSync(CONFIG.apiKeyFile);

/** A stand-in for the engine's `$`, backed by Node. */
function makeHost(userText = 'Find why the app cannot load its config file.') {
  const logs = [];
  return {
    logs,
    http: { fetch: async (url, init) => {
      const res = await fetch(url, init);
      return { status: res.status, ok: res.ok, headers: {}, text: await res.text() };
    } },
    fs: { read: async (p) => readFileSync(p, 'utf8') },
    ui: { log: (t) => logs.push(t) },
    session: { messages: async () => [{ role: 'user', text: userText, toolUses: [] }] },
  };
}

/** The hooks the module registers, keyed by the tool its matcher names. */
function hooksByTool() {
  const found = {};
  register((event, matcher, fn) => { if (event === 'tool.call') found[matcher.tool] = fn; });
  return found;
}

const SIGNAL = 'ERROR: config.yaml not found at /etc/app/config.yaml';
// 800 lines, not 400: at 400 the noise tail is a single 3.5 KB chunk and the
// judge scores it 0.63-0.74 — straddling `minDropProbability`, so the test
// failed on live variance rather than on a broken wire (DEVLOG §22.2). At 800
// the tail chunks are full 16 KB dumps and come back 0.91-0.96 every run.
function noisyLog() {
  const noise = Array.from({ length: 800 }, (_, i) => `debug heartbeat tick ${i} ok ok ok ok ok ok ok ok`);
  return [...noise.slice(0, 200), SIGNAL, ...noise.slice(200)].join('\n');
}

test('every target tool gets its own tool.call hook', () => {
  const hooks = hooksByTool();
  assert.deepEqual(Object.keys(hooks).sort(), TARGET_NAMES.slice().sort(), 'a TARGETS entry has no hook (or vice versa)');
});

test('live: hook wire actually judges — a noise chunk comes back "drop"', { skip: !hasKey && 'no api key' }, async () => {
  const $ = makeHost();
  const key = readFileSync(CONFIG.apiKeyFile, 'utf8').trim();
  const noise = Array.from({ length: 200 }, (_, i) => `debug heartbeat tick ${i} ok ok ok`).join('\n');
  // ponytail: live judge is nondeterministic — a transient keep (or a >2s host
  // call failing open) must not fail the suite. Retry and require one real drop.
  let verdict = 'keep';
  for (let attempt = 0; attempt < 6 && verdict !== 'drop'; attempt++) {
    verdict = await judgeChunk($, key, 'Find why the app cannot load its config file.', noise);
  }
  // Positive assertion: a wrong model id / endpoint / body shape fails open to
  // 'keep', so only a real 'drop' proves the wire.
  assert.equal(verdict, 'drop', 'judge returned keep — wire likely failed open');
});

test('live: Bash hook shrinks a long stdout', { skip: !hasKey && 'no api key' }, async () => {
  const out = noisyLog();
  assert.ok(out.length > TARGETS.Bash.thresholdChars);

  // ponytail: live judge is nondeterministic — retry the drop a bounded number
  // of times; the assertions below run against the attempt that shrank.
  let $, r;
  for (let attempt = 0; attempt < 6; attempt++) {
    $ = makeHost();
    const core = { ref: 7, text: out, result: { stdout: out, stderr: '', interrupted: false } };
    r = await hooksByTool().Bash($, { tool: 'Bash', command: 'run-app' }, async () => core);
    if (r.result.stdout.length < out.length) break;
  }

  assert.ok(r.result.stdout.length < out.length, `expected pruning, got ${r.result.stdout.length}/${out.length}`);
  assert.equal(r.result.stderr, '', 'sibling fields must survive');
  assert.equal(r.ref, undefined, 'kept core ref — the pruned record would be ignored');
  assert.ok($.logs.some((l) => l.startsWith('jev-prune(Bash):')), 'no prune log line');
});

test('live: Grep hook shrinks content-mode matches and fixes numLines', { skip: !hasKey && 'no api key' }, async () => {
  const out = noisyLog();
  // ponytail: live judge is nondeterministic — retry the drop a bounded number
  // of times; the assertions below run against the attempt that shrank.
  let $, r;
  for (let attempt = 0; attempt < 6; attempt++) {
    $ = makeHost('Which file defines the config loader?');
    const core = {
      ref: 3,
      text: out,
      result: { mode: 'content', numFiles: 1, filenames: [], content: out, numLines: out.split('\n').length, totalLines: 401 },
    };
    r = await hooksByTool().Grep($, { tool: 'Grep', pattern: 'config' }, async () => core);
    if (r.result.content.length < out.length) break;
  }

  assert.ok(r.result.content.length < out.length, `expected pruning, got ${r.result.content.length}/${out.length}`);
  assert.equal(r.result.numLines, r.result.content.split('\n').length, 'numLines must match the pruned content');
  assert.equal(r.result.mode, 'content', 'sibling fields must survive');
  assert.equal(r.ref, undefined);
});

test('Read is left alone below the threshold', async () => {
  const $ = makeHost();
  const out = noisyLog().slice(0, TARGETS.Read.thresholdChars - 1);
  assert.ok(out.length < TARGETS.Read.thresholdChars);
  const core = { ref: 1, text: out, result: { type: 'text', file: { filePath: '/a.js', content: out, numLines: 401, startLine: 1, totalLines: 401 } } };
  const r = await hooksByTool().Read($, { tool: 'Read', file_path: '/a.js' }, async () => core);
  assert.equal(r, core, 'Read under its threshold must pass through untouched');
});

test('Read rewrites file.content in place and recomputes numLines', async () => {
  const $ = makeHost();
  const bulk = Array.from({ length: 900 }, (_, i) => `AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH ${i}`).join('\n');
  assert.ok(bulk.length > TARGETS.Read.thresholdChars);
  const core = { ref: 1, text: bulk, result: { type: 'text', file: { filePath: '/a.min.js', content: bulk, numLines: 900, startLine: 1, totalLines: 900 } } };
  // Stub the judge path by pruning directly: this test is about the record surgery.
  const pruned = TARGETS.Read.set(core.result, '[jev-prune: dropped 900 lines]');
  assert.equal(pruned.file.content, '[jev-prune: dropped 900 lines]');
  assert.equal(pruned.file.numLines, 1);
  assert.equal(pruned.file.filePath, '/a.min.js', 'sibling fields must survive');
  assert.equal(pruned.type, 'text');
  assert.equal(core.result.file.content, bulk, 'the original record must not be mutated');
  assert.ok($.logs.length === 0);
});

test('non-text Read branches (image, notebook) are not touched', () => {
  assert.equal(TARGETS.Read.get({ type: 'image', file: { content: 'x'.repeat(99999) } }), undefined);
  assert.equal(TARGETS.Grep.get({ mode: 'files_with_matches', filenames: ['a', 'b'] }), undefined);
});

test('userRequestOf prefers the newest real user turn over the call', async () => {
  const $ = makeHost('why is the build slow?');
  assert.equal(await userRequestOf($, { file_path: '/a.js' }), 'why is the build slow?');
  const broken = { session: { messages: async () => { throw new Error('no transcript'); } } };
  assert.equal(await userRequestOf(broken, { file_path: '/a.js' }), '/a.js');
});

// Read lives in a thin band, squeezed from both sides by measurement. Below one
// chunk the judge can only answer all-or-nothing and does not drop: all three
// real Read prunes in this machine's ledger were 12-13 KB and dropped 0 lines.
// Above core's token cap the hook can never fire at all — core caps a Read
// before the hook sees it, and measured delivery was 8,000 chars for a 207 KB
// log and 16,571 for a 114 KB base64 blob, which fail-open would hide.
test('Read threshold sits between one chunk and the core token cap', () => {
  assert.ok(TARGETS.Read.thresholdChars >= CONFIG.chunkChars, 'sub-chunk Read prunes measured 0 yield');
  assert.ok(TARGETS.Read.thresholdChars <= 16571, 'Read would never be reached');
});

test('pruneText never truncates chunks past the judged window', async () => {
  const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
  const { kept, droppedLines } = await pruneText(text, async (chunks) => chunks.map(() => 'drop'), 0);
  assert.equal(kept, text);
  assert.equal(droppedLines, 0);
});

test('pruneText fails open when the judge throws', async () => {
  const text = 'a\nb\nc';
  const { kept, droppedLines } = await pruneText(text, async () => { throw new Error('boom'); });
  assert.equal(kept, text);
  assert.equal(droppedLines, 0);
});

// --- ledger observability regression (the path that stayed silent in §5.3) ---

/** A `$` with a working clock.now and an in-memory ledger, so appendLedger is
 * deterministic without touching the real file or the live provider. */
function ledgerHost(seed = '') {
  const writes = [];
  const $ = {
    clock: { now: async () => Date.parse('2026-09-21T00:00:00.000Z') },
    fs: {
      read: async () => seed,
      write: async (path, text) => { assert.equal(path, LEDGER); writes.push(text); },
    },
  };
  return { $, writes };
}

test('appendLedger records an ISO-timestamped line for every judged outcome', async () => {
  const { $, writes } = ledgerHost('2026-09-21T00:00:00.000Z\tOLD line\n');
  await appendLedger($, 'jev-prune(Bash): 100 → 40 chars, 60 lines dropped');
  assert.equal(writes.length, 1);
  // previous content is preserved, then an ISO `\t` line is appended
  assert.ok(writes[0].startsWith('2026-09-21T00:00:00.000Z\tOLD line\n'),
    'ledger must append, not replace');
  assert.ok(/^2026-09-21T00:00:00\.000Z\tjev-prune\(Bash\): /.test(writes[0].split('\n')[1]),
    'new line must be ISO-timestamped with a jev-prune(Bash) token');
});

test('appendLedger never throws: a broken ledger cannot break its caller', async () => {
  const $ = {
    clock: { now: async () => { throw new Error('clock dead'); } },
    fs: { read: async () => { throw new Error('ENOENT'); }, write: async () => { throw new Error('EACCES'); } },
  };
  await assert.doesNotReject(appendLedger($, 'jev-prune(Grep): 100 → 100 chars, 0 lines dropped'));
});

test('live: a real drop writes a ledger-style line', { skip: !hasKey && 'no api key' }, async () => {
  // Same live Bash prune as above, but with a full host (clock + fs.write) so
  // the ledger path is exercised end to end, not just the prune logic. The
  // judge is a live, nondeterministic model, so retry the drop a bounded number
  // of times; each attempt writes a ledger line (keep or drop), and we require
  // at least one to drop AND record a non-zero drop to the ledger.
  const host = makeHost();
  host.__writes = [];
  host.clock = { now: async () => Date.now() };
  host.fs.write = async (path, text) => { if (path === LEDGER) host.__writes.push(text); };
  const out = noisyLog();
  const core = { ref: 7, text: out, result: { stdout: out, stderr: '', interrupted: false } };
  let shrank = false;
  for (let attempt = 0; attempt < 6 && !shrank; attempt++) {
    const r = await hooksByTool().Bash(host, { tool: 'Bash', command: 'run-app' }, async () => core);
    shrank = r.result.stdout.length < out.length;
  }
  assert.ok(shrank, `expected at least one drop, got ${out.length}/${out.length} every time`);
  assert.ok(host.__writes.length >= 1, 'a judged-prunable call must write a ledger line');
  assert.ok(
    host.__writes.some((w) => /jev-prune\(Bash\): .+ → .+ chars, [1-9][0-9]* lines dropped/.test(w)),
    'at least one ledger line must record a real non-zero drop',
  );
});

test('a near-miss under the threshold is recorded; a small output leaves no trace', async () => {
  // Observation window (DEVLOG §23.6): the ledger cannot show what pruning gave
  // up when the threshold rose, because those calls stopped happening. Half a
  // chunk up is the give-up band; below it the line count would swamp the file.
  const writes = [];
  const $ = {
    ...makeHost(),
    clock: { now: async () => Date.parse('2026-09-22T00:00:00.000Z') },
    fs: { read: async () => '', write: async (p, t) => { assert.equal(p, LEDGER); writes.push(t); } },
  };
  const hook = hooksByTool().Bash;
  const run = (out) => hook($, { tool: 'Bash', command: 'x' },
    async () => ({ ref: 1, text: out, result: { stdout: out, stderr: '', interrupted: false } }));

  await run('y'.repeat(CONFIG.chunkChars / 2 - 1));
  assert.equal(writes.length, 0, 'below half a chunk must stay out of the ledger');
  await run('y'.repeat(CONFIG.chunkChars - 1));
  assert.equal(writes.length, 1, 'the give-up band must be recorded');
  assert.match(writes[0], /jev-skip\(Bash\): 15999 chars, under threshold 16000/);
});
