import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { terms, gather, sourceOf, botFiles, citedNames, qmdFiles, listDocs, makeRetriever } from '../integrations/openmausbot/evidence.mjs';
import { runOnce } from '../integrations/openmausbot/claimcheck-watch.mjs';
import { checkClaims } from '../plugin/lib/claimcheck.js';

const CLAIM = 'Travel Rule 方案每月收費 500U。';

function tree() {
  const d = mkdtempSync(join(tmpdir(), 'ev-'));
  const mk = (p, body) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), body); };
  mk('work/chief/docs_pricing.md', 'intro\nunrelated\nTravel Rule monthly commitment 500U\nmore\nend');
  mk('work/chief/other.md', 'nothing relevant here');
  mk('gap/report.md', 'gap: 每月收費 未定\n');
  mk('gap/.venv/lib/x.md', 'Travel Rule 500U decoy inside venv');
  mk('jur/VARA.md', 'VARA requires Travel Rule compliance\n');
  mk('wiki/摘要-Pricing.md', 'Travel Rule 方案 每月收費 500U 起\n');
  mk('outside/secret.md', 'Travel Rule 500U token=abc');
  return d;
}

test('terms: ASCII words and numbers, CJK bigrams, stopwords dropped', () => {
  const t = terms([CLAIM]);
  assert.deepEqual(t.ascii, ['travel', 'rule', '500u']);
  assert.ok(t.cjk.includes('收費'));
});

test('listDocs skips dot dirs and venvs', () => {
  const d = tree();
  const got = listDocs(join(d, 'gap'));
  assert.deepEqual(got.map((p) => p.slice(d.length)), ['/gap/report.md']);
});

test('gather keeps the best verbatim windows under budget, labelled by tier', () => {
  const d = tree();
  const r = gather({ claims: [CLAIM], budget: 4000, sources: [
    { tier: 'work', files: [join(d, 'work/chief/docs_pricing.md'), join(d, 'work/chief/other.md')] },
  ] });
  assert.match(r.text, /^\[source: work .*docs_pricing\.md\]\n/);
  assert.match(r.text, /Travel Rule monthly commitment 500U/);
  assert.doesNotMatch(r.text, /nothing relevant/);
  const tiny = gather({ claims: [CLAIM], budget: 10, sources: [{ tier: 'work', files: [join(d, 'work/chief/docs_pricing.md')] }] });
  assert.equal(tiny.text, '');
});

test('sourceOf maps a quote to the block that holds it, else the thread', () => {
  const blocks = [{ tier: 'wiki', path: 'p', text: 'Travel Rule 方案\n每月收費 500U 起' }];
  assert.equal(sourceOf('方案 每月收費 500U', blocks), 'wiki');
  assert.equal(sourceOf('said in the thread', blocks), 'thread');
  assert.equal(sourceOf('', blocks), undefined);
});

test('botFiles reads Read/Write file_path across threads; citedNames finds file names', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages (thread_id TEXT, kind TEXT, json TEXT)');
  const ins = db.prepare('INSERT INTO messages VALUES (?,?,?)');
  ins.run('A', 'activity', JSON.stringify({ tool: { name: 'Read', input: JSON.stringify({ file_path: '/w/a.md' }) } }));
  ins.run('B', 'activity', JSON.stringify({ tool: { name: 'Write', input: { file_path: '/w/b.md' } } }));
  ins.run('B', 'activity', JSON.stringify({ tool: { name: 'Bash', input: { command: 'cat /w/c.md' } } }));
  ins.run('Z', 'activity', JSON.stringify({ tool: { name: 'Read', input: { file_path: '/w/z.md' } } }));
  assert.deepEqual([...botFiles(db, ['A', 'B'])].sort(), ['/w/a.md', '/w/b.md']);
  assert.deepEqual([...citedNames('見 docs_travel-rule-overview.md 第 27 行與 work/gap/報告.md')].sort(), ['docs_travel-rule-overview.md', '報告.md']);
});

test('qmdFiles runs qmd search --json once and maps hits under wikiRoot', () => {
  const d = tree();
  const calls = [];
  const run = (bin, args) => { calls.push([bin, args]); return { stdout: JSON.stringify([{ file: 'qmd://wiki-llm/摘要-Pricing.md' }, { file: 'qmd://wiki-llm/gone.md' }, { file: 'qmd://raw/x.md' }]) }; };
  const got = qmdFiles('travel rule', { bin: '/q', wikiRoot: join(d, 'wiki'), run });
  assert.deepEqual(got, [join(d, 'wiki/摘要-Pricing.md')]);
  assert.deepEqual(calls[0], ['/q', ['search', '--json', 'travel rule', '-c', 'wiki-llm', '-n', '3']]);
  assert.deepEqual(qmdFiles('x', { wikiRoot: d, run: () => ({ stdout: 'not json' }) }), []);
});

test('retriever: own files, gap, jurisdictions, wiki; read history outside roots is dropped', () => {
  const d = tree();
  const { retrieve } = makeRetriever({ workDirs: [join(d, 'work/chief')], gapDir: join(d, 'gap'), jurDir: join(d, 'jur'),
    wikiRoot: join(d, 'wiki'), run: () => ({ stdout: JSON.stringify([{ file: 'qmd://wiki-llm/摘要-Pricing.md' }]) }) });
  const r = retrieve({ text: `${CLAIM} 見 docs_pricing.md`, claims: [CLAIM], budget: 8000,
    readFiles: new Set([join(d, 'outside/secret.md'), join(d, 'jur/VARA.md')]) });
  const tiers = new Set(r.blocks.map((b) => b.tier));
  assert.ok(tiers.has('own-file') && tiers.has('wiki') && tiers.has('gap'));
  assert.equal(r.blocks.find((b) => b.path.endsWith('docs_pricing.md')).tier, 'own-file');
  assert.equal(r.blocks.find((b) => b.path.endsWith('VARA.md')).tier, 'own-file');
  assert.doesNotMatch(r.text, /token=abc/);
  assert.doesNotMatch(r.text, /decoy/);
});

test('watcher: extra evidence reaches the judge and a wiki-only support is logged weak', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const dbPath = join(dir, 'messages.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));`);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run('T', 'b1', 1200, 'bot', 'text', CLAIM, '{}');
  db.close();
  const blocks = [{ tier: 'wiki', path: '/w/p.md', text: 'Travel Rule 方案 每月收費 500U 起' }];
  const retriever = { refresh() {}, retrieve: () => ({ text: '[source: wiki /w/p.md]\nTravel Rule 方案 每月收費 500U 起', blocks }) };
  let seen = '';
  const check = (o) => { seen = o.evidence; return checkClaims({ ...o, cfg: {},
    verify: async (_m, { claims }) => ({ claims: claims.map(() => ({ verdict: 'supported', gate: 'auto', quote: '每月收費 500U' })) }) }); };
  const logFile = join(dir, 'l.jsonl');
  await runOnce({ dbPath, bots: [{ name: 'x', threads: ['T'] }], stateFile: join(dir, 's.json'), logFile, check, now: 0, retriever });
  assert.match(seen, /\[source: wiki \/w\/p\.md\]/);
  const c = JSON.parse(readFileSync(logFile, 'utf8').trim()).claims[0];
  assert.equal(c.source, 'wiki');
  assert.equal(c.weak, true);
});

test('watcher: not_addressed fact claims go to the research queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const dbPath = join(dir, 'messages.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));`);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run('T', 'b1', 1200, 'bot', 'text', CLAIM, '{}');
  db.close();
  const researchQueue = join(dir, 'q.jsonl');
  const check = (o) => checkClaims({ ...o, cfg: {}, verify: async (_m, { claims }) => ({ claims: claims.map(() => ({ verdict: 'not_addressed', gate: 'auto' })) }) });
  await runOnce({ dbPath, bots: [{ name: '合規長', threads: ['T'] }], stateFile: join(dir, 's.json'), logFile: join(dir, 'l.jsonl'),
    check: async (o) => check({ ...o, evidence: 'x' }), now: 0, researchQueue });
  const q = readFileSync(researchQueue, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(q.map((x) => [x.msgId, x.claim]), [['b1', CLAIM]]);
});

test('user premise: restating the user\'s own invoice is not a model claim', async () => {
  const { userPremise } = await import('../integrations/openmausbot/claimcheck-watch.mjs');
  const said = 'Travel Rule Solution monthly commitment US$500.00 US$500.00 Travel Rule Message Processing 0 US$0.10\n我們用 Vendor';
  assert.equal(userPremise('Vendor Travel Rule：每月 US$500 的固定月租承諾額，計費以訊息筆數為基礎；', said), true);
  assert.equal(userPremise('Vendor Travel Rule 每月 900U。', said), false);
  assert.equal(userPremise('五種協議各自要另外繳月費。', said), false);
});

test('watcher: user statements lead the evidence; a premise is neither flagged nor queued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const dbPath = join(dir, 'messages.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));`);
  const ins = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)');
  ins.run('T', 'u1', 100, 'user', 'text', 'Travel Rule monthly commitment US$500.00', '{}');
  ins.run('T', 'a1', 150, 'bot', 'activity', null, JSON.stringify({ tool: { name: 'Bash', input: 'x', ok: true, output: 'y'.repeat(5000) } }));
  ins.run('T', 'b1', 200, 'bot', 'text', 'Travel Rule 方案每月收費 500U。', '{}');
  db.close();
  let seen = '';
  const researchQueue = join(dir, 'q.jsonl');
  const logFile = join(dir, 'l.jsonl');
  await runOnce({ dbPath, bots: [{ name: 'x', threads: ['T'] }], stateFile: join(dir, 's.json'), logFile, researchQueue, now: 0, evidenceChars: 2000,
    check: (o) => { seen = o.evidence; return checkClaims({ ...o, cfg: {}, verify: async (_m, { claims }) => ({ claims: claims.map(() => ({ verdict: 'not_addressed', gate: 'auto' })) }) }); } });
  assert.match(seen, /^\[user messages\]\nTravel Rule monthly commitment US\$500\.00/);
  const e = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.equal(e.claims[0].premise, true);
  assert.equal(e.flagged, 0);
  assert.equal(existsSync(researchQueue), false);
});

test('user premise needs a number; shared words alone do not make the model\'s inference a premise', async () => {
  const { userPremise } = await import('../integrations/openmausbot/claimcheck-watch.mjs');
  const said = 'Travel Rule Solution monthly commitment US$500.00\nOTHERVASP 月2k服务费 Vendor';
  assert.equal(userPremise('Travel Rule 沒有輕量版，只要開通功能就按月計費。', said), false);
  assert.equal(userPremise('Vendor 的 500U 照樣要付。', said), true);
  assert.equal(userPremise('舊通道每月 2k。', said), true);
  assert.equal(userPremise('舊通道每月 3k。', 'monthly 3'), false);
});

test('watcher: judge basis decides premise; an inference on the user\'s numbers stays a claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const dbPath = join(dir, 'messages.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));`);
  const ins = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)');
  ins.run('T', 'u1', 100, 'user', 'text', 'Travel Rule monthly commitment US$500.00', '{}');
  ins.run('T', 'b1', 200, 'bot', 'text', 'Travel Rule 方案每月收費 500U。停掉舊通道 後只付 500U 就能維持合規。', '{}');
  db.close();
  const logFile = join(dir, 'l.jsonl');
  const researchQueue = join(dir, 'q.jsonl');
  const answers = [
    { verdict: 'supported', gate: 'auto', quote: 'monthly commitment US$500.00', basis: 'user' },
    { verdict: 'not_addressed', gate: 'auto', basis: 'inference' },
  ];
  await runOnce({ dbPath, bots: [{ name: 'x', threads: ['T'] }], stateFile: join(dir, 's.json'), logFile, researchQueue, now: 0,
    check: (o) => checkClaims({ ...o, cfg: {}, verify: async (_m, { claims }) => ({ claims: claims.map((_, i) => answers[i]) }) }) });
  const e = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.deepEqual(e.claims.map((c) => [c.basis, c.premise]), [['user', true], ['inference', undefined]]);
  assert.equal(e.flagged, 1);
  assert.equal(readFileSync(researchQueue, 'utf8').trim().split('\n').length, 1);
});
