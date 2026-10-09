import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevLaya } from '../integrations/opencode/jev-laya.js';
import * as plugin from '../integrations/opencode/jev-laya.js';
import { MIN_CHARS, shrink, lastUserText, defaultJevEnv, compactParts } from '../integrations/opencode/prune-core.js';
import { judgeSegments } from '../agent-glue/src/prune.js';

test('plugin module exports nothing but the plugin (opencode calls every export)', () => {
  assert.deepEqual(Object.keys(plugin), ['JevLaya']);
});

test('prunes long output with repeated lines', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const repeated = 'npm WARN x\n'.repeat(50);
  const filler = 'a'.repeat(MIN_CHARS);
  const out = { output: filler + '\n' + repeated };
  await fn({ tool: 'bash' }, out);
  assert.ok(out.output.includes('[l0: repeated'));
  assert.ok(out.output.length < filler.length + repeated.length);
});

test('leaves short output untouched', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const out = { output: 'short output' };
  await fn({ tool: 'bash' }, out);
  assert.equal(out.output, 'short output');
});

test('does not throw when output field missing', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const out = {};
  await fn({ tool: 'bash' }, out);
  assert.deepEqual(out, {});
});

const big = Array.from({ length: 2000 }, (_, i) => `line ${i} payload`).join('\n');

test('big output goes to the Jev judge with the mapped tool and the user request', async () => {
  const calls = [];
  const prune = async (p) => { calls.push(p); return { judged: true, text: 'kept' }; };
  const text = await shrink({ tool: 'bash', text: big }, { prune, getRequest: async () => 'fix the build' });
  assert.equal(text, 'kept');
  assert.equal(calls[0].tool, 'Bash');
  assert.equal(calls[0].request, 'fix the build');
});

test('the judge is only asked past its own threshold, so short outputs never fetch the request', async () => {
  let asked = false;
  const text = await shrink({ tool: 'bash', text: 'x'.repeat(5000) }, {
    prune: async () => { throw new Error('must not run'); },
    getRequest: async () => { asked = true; return 'r'; },
  });
  assert.equal(text.length, 5000);
  assert.equal(asked, false);
});

test('edit/write output is the model\'s own work and is never judged', async () => {
  const text = await shrink({ tool: 'edit', text: big }, {
    prune: async () => { throw new Error('must not run'); },
    getRequest: async () => 'r',
  });
  assert.equal(text, big);
});

test('no request means no judge (a request-free prune drops the needle, DEVLOG §22.3)', async () => {
  let called = false;
  const text = await shrink({ tool: 'bash', text: big }, { prune: async () => { called = true; }, getRequest: async () => '' });
  assert.equal(called, false);
  assert.equal(text, big);
});

test('a throwing or unjudged prune falls back to the L0 text', async () => {
  const thrown = await shrink({ tool: 'read', text: big }, { prune: async () => { throw new Error('net'); }, getRequest: async () => 'r' });
  assert.equal(thrown, big);
  const unjudged = await shrink({ tool: 'read', text: big }, { prune: async () => ({ judged: false, text: '' }), getRequest: async () => 'r' });
  assert.equal(unjudged, big);
});

test('lastUserText picks the newest real user text, skipping synthetic parts', () => {
  const msgs = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'old ask' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'reply' }] },
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'injected', synthetic: true }, { type: 'text', text: 'new ask' }] },
  ];
  assert.equal(lastUserText(msgs), 'new ask');
  assert.equal(lastUserText(undefined), '');
});

test('defaultJevEnv sets endpoint, model and key file together, and only when unset', () => {
  const env = { HOME: '/h' };
  assert.equal(defaultJevEnv(env, () => true), true);
  assert.equal(env.JEV_MODEL, 'jev-latest');
  assert.equal(env.JEV_API_KEY_FILE, '/h/.creds/kv/TYPESAFE_API_KEY.txt');
  const preset = { HOME: '/h', JEV_ENDPOINT: 'x' };
  assert.equal(defaultJevEnv(preset, () => true), false);
  assert.equal(preset.JEV_MODEL, undefined);
  assert.equal(defaultJevEnv({ HOME: '/h' }, () => false), false);
});

// --- compaction (experimental.chat.messages.transform) ---

const toolPart = (id, out, tool = 'bash') => ({ type: 'tool', tool, callID: id, state: { status: 'completed', input: { command: id }, output: out } });
const history = () => [
  { info: { role: 'user' }, parts: [{ type: 'text', text: 'fix the login bug' }] },
  { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'looking' }, toolPart('ls', 'x'.repeat(50000))] },
  { info: { role: 'assistant' }, parts: [toolPart('err', 'E'.repeat(40000))] },
  { info: { role: 'assistant' }, parts: [toolPart('tiny', 'small')] },
  // the newest pinLast (4) messages are never touched, whatever their size
  { info: { role: 'user' }, parts: [{ type: 'text', text: 'go on' }] },
  { info: { role: 'assistant' }, parts: [toolPart('recent', 'r'.repeat(90000))] },
  { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'a' }] },
  { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'b' }] },
];

test('compaction drops only judged tool outputs, keeps text and pinned tail verbatim', async () => {
  const msgs = history();
  const asked = [];
  const judge = async ({ request, segments }) => { asked.push({ request, n: segments.length }); return segments.map((s) => (s.includes('tool: bash\nargs: {"command":"ls"}') ? 'drop' : 'keep')); };
  const r = await compactParts(msgs, { judge, decisions: new Map() });
  assert.equal(r.dropped, 50000);
  assert.deepEqual(asked, [{ request: 'go on', n: 2 }]); // 'tiny' under minPartChars, 'recent' pinned
  assert.match(msgs[1].parts[1].state.output, /^\[jev-compact: dropped 50000 chars/);
  assert.equal(msgs[1].parts[0].text, 'looking');
  assert.equal(msgs[2].parts[0].state.output.length, 40000);
  assert.equal(msgs[5].parts[0].state.output.length, 90000);
});

test('each output is judged once; a drop is replayed on later turns without asking again', async () => {
  const decisions = new Map();
  let calls = 0;
  const judge = async ({ segments }) => { calls++; return segments.map(() => 'drop'); };
  await compactParts(history(), { judge, decisions });
  const next = history();
  const r = await compactParts(next, { judge, decisions });
  assert.equal(calls, 1);
  assert.equal(r.dropped, 90000);
  assert.match(next[2].parts[0].state.output, /^\[jev-compact/);
});

test('below the history threshold nothing is judged or dropped', async () => {
  const msgs = history();
  const r = await compactParts(msgs, { judge: async () => { throw new Error('must not run'); }, decisions: new Map(), opts: { atChars: 10 ** 6 } });
  assert.deepEqual(r, { dropped: 0, judged: 0 });
});

test('a failed or malformed judgment keeps everything and is retried next turn', async () => {
  const decisions = new Map();
  const msgs = history();
  await compactParts(msgs, { judge: async () => { throw new Error('net'); }, decisions });
  await compactParts(msgs, { judge: async () => ['drop'], decisions }); // wrong length
  assert.equal(decisions.size, 0);
  assert.equal(msgs[1].parts[1].state.output.length, 50000);
});

test('judgeSegments batches, fails open per batch, and refuses without a request', async () => {
  const seen = [];
  const judge = async (b) => { seen.push(b.length); if (b[0] === 's8') throw new Error('x'); return b.map(() => 'drop'); };
  const segs = Array.from({ length: 10 }, (_, i) => `s${i}`);
  const v = await judgeSegments({ request: 'r', segments: segs }, { key: 'k', judge, host: {} });
  assert.deepEqual(seen.sort(), [2, 8]);
  assert.deepEqual(v, [...Array(8).fill('drop'), 'keep', 'keep']);
  assert.deepEqual(await judgeSegments({ request: ' ', segments: segs }, { key: 'k', judge }), Array(10).fill('keep'));
});

test('the transform hook is registered and JEV_COMPACT_ENABLED=0 switches it off', async () => {
  const hook = await JevLaya();
  assert.equal(typeof hook['experimental.chat.messages.transform'], 'function');
  const prev = process.env.JEV_COMPACT_ENABLED;
  process.env.JEV_COMPACT_ENABLED = '0';
  try {
    const msgs = history();
    await hook['experimental.chat.messages.transform']({}, { messages: msgs });
    assert.equal(msgs[1].parts[1].state.output.length, 50000);
  } finally {
    if (prev === undefined) delete process.env.JEV_COMPACT_ENABLED; else process.env.JEV_COMPACT_ENABLED = prev;
  }
});
