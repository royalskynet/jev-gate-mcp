import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectClaims, atomicClaims } from '../plugin/lib/claims.js';
import { checkClaims, SOURCE_LEVEL } from '../plugin/lib/claimcheck.js';
import { runOnce, threadEvidence } from '../integrations/openmausbot/claimcheck-watch.mjs';

const VENDOR = '五種協議各自要另外繳月費。我推論 CODE 卡片可能要另外開通。供應商文件第 27 行寫系統自動選協議。下一步要問供應商嗎？';

test('fact claims: unsourced pricing/obligation sentences are picked, labelled inferences are not', () => {
  const got = selectClaims(VENDOR, { kinds: ['fact'] }).map((c) => c.claim);
  assert.ok(got.includes('五種協議各自要另外繳月費。'));
  assert.ok(got.includes('供應商文件第 27 行寫系統自動選協議。'));
  assert.ok(!got.some((s) => s.includes('推論')));
  assert.ok(!got.some((s) => s.endsWith('？')));
});

test('done-only selection is unchanged for the Stop gate', () => {
  assert.deepEqual(atomicClaims('五種協議各自要另外繳月費。'), []);
  assert.deepEqual(atomicClaims('測試已通過 12/12。'), ['測試已通過 12/12。']);
});

test('fact claim with no evidence is not_addressed without calling Jev', async () => {
  let called = 0;
  const r = await checkClaims({ text: '方案每月收費 500U。', evidence: '', verify: async () => { called++; } });
  assert.equal(called, 0);
  assert.equal(r.decisive.verdict, 'not_addressed');
  assert.equal(r.judged[0].kind, 'fact');
});

test('claims go to Jev with the source-level qualifier; verdicts map back to the plain claim', async () => {
  let sent;
  const verify = async (_m, { claims }) => { sent = claims; return { claims: claims.map(() => ({ verdict: 'contradicted', gate: 'auto' })) }; };
  const r = await checkClaims({ text: '五種協議各自要另外繳月費。', evidence: 'docs: 系統自動為每個對手方選用合適的協議', verify });
  assert.ok(sent[0].endsWith(SOURCE_LEVEL));
  assert.equal(r.judged[0].claim, '五種協議各自要另外繳月費。');
  assert.equal(r.decisive.verdict, 'contradicted');
});

test('Jev failure fails open: error, no verdict', async () => {
  const r = await checkClaims({ text: '方案包含五種協議。', evidence: 'x', verify: async () => { throw new Error('boom'); } });
  assert.ok(r.error);
  assert.equal(r.decisive, null);
});

function fixtureDb(dir) {
  const path = join(dir, 'messages.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));`);
  const ins = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)');
  ins.run('T', 'u1', 1000, 'user', 'text', '帳單：Solution monthly commitment 500U', '{}');
  ins.run('T', 'a1', 1100, 'bot', 'activity', null, JSON.stringify({ tool: { name: 'read', input: 'docs_travel-rule-overview.md', ok: true, output: '27: The system automatically selects the protocol for each counterparty.' } }));
  ins.run('T', 'a2', 1150, 'bot', 'activity', null, JSON.stringify({ tool: { name: 'read', input: 'secret.md', ok: false, output: 'ENOENT' } }));
  ins.run('T', 'b1', 1200, 'bot', 'text', '五種協議各自要另外繳月費。', '{}');
  db.close();
  return path;
}

test('watcher: evidence spans tool output and user messages, skips failed tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const db = new DatabaseSync(fixtureDb(dir), { readOnly: true });
  const ev = threadEvidence(db, 'T', 1200, 60000);
  db.close();
  assert.match(ev, /automatically selects the protocol/);
  assert.match(ev, /500U/);
  assert.doesNotMatch(ev, /ENOENT/);
});

test('watcher: flags an unsupported fact once, writes ledger + alert, does not re-check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const dbPath = fixtureDb(dir);
  const files = { stateFile: join(dir, 's.json'), logFile: join(dir, 'l.jsonl'), alertsFile: join(dir, 'a.txt') };
  let calls = 0;
  const check = async (o) => { calls++; return checkClaims({ ...o, verify: async (_m, { claims }) => ({ claims: claims.map(() => ({ verdict: 'not_addressed', gate: 'auto' })) }), cfg: {} }); };
  const bots = [{ name: '合規長', threads: ['T'] }];
  const first = await runOnce({ dbPath, bots, ...files, check, now: 0 });
  assert.equal(calls, 1);
  assert.equal(first.length, 1);
  const entry = JSON.parse(readFileSync(files.logFile, 'utf8').trim());
  assert.equal(entry.bot, '合規長');
  assert.equal(entry.flagged, 1);
  assert.equal(entry.claims[0].verdict, 'not_addressed');
  assert.ok(existsSync(files.alertsFile));
  const second = await runOnce({ dbPath, bots, ...files, check, now: 0 });
  assert.equal(second.length, 0);
  assert.equal(calls, 1);
});

test('watcher: first run without backfill starts at now and checks nothing old', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const dbPath = fixtureDb(dir);
  let calls = 0;
  const out = await runOnce({ dbPath, bots: [{ name: 'x', threads: ['T'] }], stateFile: join(dir, 's.json'), logFile: join(dir, 'l.jsonl'), check: async () => { calls++; return {}; }, now: 5000 });
  assert.equal(out.length, 0);
  assert.equal(calls, 0);
});

test('watcher: bot soul is part of the evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const dbPath = fixtureDb(dir);
  let seen = '';
  await runOnce({ dbPath, bots: [{ name: '合規長', threads: ['T'], soul: '回覆超過 800 字必須附網址' }], stateFile: join(dir, 's.json'), logFile: join(dir, 'l.jsonl'),
    check: async (o) => { seen = o.evidence; return {}; }, now: 0 });
  assert.match(seen, /^\[bot instructions\]\n回覆超過 800 字必須附網址/);
});
