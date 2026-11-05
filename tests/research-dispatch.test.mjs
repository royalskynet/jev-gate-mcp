import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextJob, keyOf, parseRadar, radarPrompt, runJob, parseArgs } from '../integrations/openmausbot/research-dispatch.mjs';

const Q = [
  { msgId: 'm1', bot: '合規長', claim: 'VARA 要求每筆轉帳附 Travel Rule 資料。', context: 'ctx1' },
  { msgId: 'm1', bot: '合規長', claim: 'VARA 要求每筆轉帳附 Travel Rule 資料。', context: 'ctx1' },
  { msgId: 'm1', bot: '合規長', claim: '方案每月收費 500U。', context: 'ctx1' },
  { msgId: 'm2', bot: '合規長', claim: '方案每月收費  500U。', context: 'ctx2' },
  { msgId: 'm2', bot: '合規長', claim: 'MiCA 2026 年起適用。', context: 'ctx2' },
];
const NOW = Date.UTC(2026, 10, 5, 4);

test('nextJob groups by reply, dedupes claims (whitespace-insensitive) and skips researched ones', () => {
  const { job } = nextJob({ queue: Q, ledger: [], now: NOW, all: true, minGaps: 1 });
  assert.equal(job.msgId, 'm1');
  assert.equal(job.items.length, 2);
  const after = nextJob({ queue: Q, ledger: [{ ts: NOW, dispatched: true, keys: job.items.map((x) => x.key) }], now: NOW, all: true, minGaps: 1 });
  assert.equal(after.job.msgId, 'm2');
  assert.deepEqual(after.job.items.map((x) => x.claim), ['MiCA 2026 年起適用。']);
});

test('daily cap counts today only (Asia/Taipei)', () => {
  const ledger = [1, 2, 3].map((i) => ({ ts: NOW, dispatched: true, keys: [`k${i}`] }));
  assert.equal(nextJob({ queue: Q, ledger, now: NOW, dailyCap: 3 }).capped, true);
  assert.equal(nextJob({ queue: Q, ledger, now: NOW + 86400e3, dailyCap: 3, minGaps: 1 }).job.msgId, 'm1'); // m1 has a VARA claim
});

test('dispatch is off unless --dispatch', () => {
  assert.equal(parseArgs([]).dispatch, false);
  assert.equal(parseArgs(['--dispatch']).dispatch, true);
});

test('parseRadar reads the fixed CLAIMCHECK lines; prompt carries claims and report path', () => {
  const v = parseRadar('blah\nCLAIMCHECK 1 支持 https://vara.ae/x\nCLAIMCHECK 2 非公開 -\n');
  assert.deepEqual(v, { 1: { verdict: '支持', url: 'https://vara.ae/x' }, 2: { verdict: '非公開', url: undefined } });
  const p = radarPrompt({ bot: 'b', context: 'c', items: [{ claim: '甲' }, { claim: '乙' }] }, '/r/x.md');
  assert.match(p, /1\. 甲\n2\. 乙/);
  assert.match(p, /\/r\/x\.md/);
});

test('runJob: radar -> ingest only when something was supported/contradicted, then recheck', async () => {
  const d = mkdtempSync(join(tmpdir(), 'rd-'));
  const a = { ...parseArgs(['--radar-dir', d, '--wiki-dir', join(d, 'wiki')]), timeoutMin: 1 };
  const job = { msgId: 'm1', bot: '合規長', context: 'c', items: [{ key: keyOf('甲'), claim: '甲' }, { key: keyOf('乙'), claim: '乙' }] };
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args);
    if (args[1] === '法規雷達') {
      const path = readFileSync(args[3], 'utf8').match(/存到 (\S+\.md)/)[1];
      writeFileSync(path, '# report\n甲：官方原文 ...');
      return { code: 0, out: 'CLAIMCHECK 1 支持 https://vara.ae/a\nCLAIMCHECK 2 查無 -', err: '' };
    }
    return { code: 0, out: 'done', err: '' };
  };
  const e = await runJob(job, a, { exec, recheck: async () => 'supported', now: NOW });
  assert.deepEqual(calls.map((c) => c[1]), ['法規雷達', '文件起草']);
  assert.match(calls[1][2], /^ingest raw\/claimcheck\/2026-11-05_claimcheck_/);
  assert.ok(existsSync(join(d, 'wiki', e.ingest.raw)));
  assert.deepEqual(e.items.map((x) => [x.radar, x.recheck]), [['支持', 'supported'], ['查無', undefined]]);

  const calls2 = [];
  const nothing = await runJob(job, a, { exec: async (b, args) => { calls2.push(args); return { code: 0, out: 'CLAIMCHECK 1 查無 -', err: '' }; }, now: NOW });
  assert.equal(calls2.length, 1);
  assert.equal(nothing.ingest, undefined);
});

test('only regulatory claims go to the radar unless --all', () => {
  const q = [{ msgId: 'x', bot: 'b', claim: '跟之前那封回函的說法要一致。' }, { msgId: 'y', bot: 'b', claim: 'VARA 第 5 條要求保存紀錄。' }];
  assert.equal(nextJob({ queue: q, ledger: [], now: NOW, minGaps: 1 }).job.msgId, 'y');
  assert.equal(nextJob({ queue: q, ledger: [], now: NOW, all: true, minGaps: 1 }).job.msgId, 'x');
});

test('threshold: a reply with one gap waits until it has two, or the claim recurs elsewhere', () => {
  const one = [{ msgId: 'a', bot: 'b', claim: 'VARA 第 5 條要求保存紀錄。' }];
  assert.equal(nextJob({ queue: one, ledger: [], now: NOW }).job, null);
  const two = [...one, { msgId: 'a', bot: 'b', claim: 'FATF 建議 16 適用。' }];
  assert.equal(nextJob({ queue: two, ledger: [], now: NOW }).job.items.length, 2);
  const recurring = [...one, { msgId: 'c', bot: 'b', claim: 'VARA 第 5 條要求保存紀錄。' }];
  assert.equal(nextJob({ queue: recurring, ledger: [], now: NOW }).job.msgId, 'a');
  assert.equal(nextJob({ queue: one, ledger: [], now: NOW, minGaps: 1 }).job.msgId, 'a');
});
