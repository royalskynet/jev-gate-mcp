// route-judge 重放：校準只信 champion 沒看過的列，且同一列在同一 champion 下只算一次。
// 兩條任何一條壞掉，白名單的 lb 都會被高估（洩漏）或 MIN_REQUESTS／CP 被灌水（重複）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CALLER, MARK, doneIds, pickRows, replay } from '../scripts/laya-replay-routejudge.mjs';
import { recordRoutingSample } from '../gateway/src/routing-corpus.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CHAMP = '2026-10-14T02:02:15Z';

const corpusRow = (id, ts, extra = {}) => JSON.stringify({
  id, ts, state: { user_request: `req ${id}`, dirty_paths: [], phase: 'x' }, teacher_model: 'jev',
  questions: {
    tier: { type: 'choice', instructions: `${MARK}: tier`, criteria: { a: 'A', b: 'B' } },
    ambiguous: { type: 'noul', instructions: 'ambiguous?' },
    note: { type: 'text', instructions: 'skip me' },
  },
  teacher_answer: { tier: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } }, ambiguous: { type: 'noul', noul: 0.1 } },
  ...extra,
});

// 本機答案：tier 選 a（信心 0.8），ambiguous 0.05。
const fakeLaya = async (_state, qs) => ({ model: 'laya', answers: Object.fromEntries(Object.keys(qs).map((id) =>
  [id, id === 'tier' ? { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 } } : { type: 'noul', noul: 0.05 }])) });

test('leak gate: rows at or before champion promoted_at are never replayed', () => {
  const text = [
    corpusRow('old', '2026-10-13T00:00:00.000Z'),
    corpusRow('edge', CHAMP),
    corpusRow('new', '2026-10-15T00:00:00.000Z'),
    // 走 cascade 的列已有即時 shadow，重放會重複計數。
    corpusRow('live', '2026-10-15T00:00:00.000Z', { caller: 'cascade:route-judge' }),
    corpusRow('other', '2026-10-15T00:00:00.000Z', { questions: { tier: { type: 'choice', instructions: 'compact' } } }),
  ].join('\n');
  assert.deepEqual(pickRows(text, CHAMP, new Set()).map((r) => r.id), ['new']);
  // 沒有 champion 時間＝沒有洩漏邊界，一列都不放。
  assert.deepEqual(pickRows(text, undefined, new Set()), []);
  // 只送有老師答案的 choice/noul 題。
  assert.deepEqual(Object.keys(pickRows(text, CHAMP, new Set())[0].questions).sort(), ['ambiguous', 'tier']);
});

test('dedup: running twice under the same champion appends nothing the second time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  const samples = path.join(dir, 'routing-samples.jsonl');
  const corpus = [corpusRow('a', '2026-10-15T00:00:00Z'), corpusRow('b', '2026-10-16T00:00:00Z')].join('\n');
  const once = async () => {
    const done = fs.existsSync(samples) ? doneIds(fs.readFileSync(samples, 'utf8'), CHAMP) : new Set();
    return replay(pickRows(corpus, CHAMP, done), fakeLaya, (x) => recordRoutingSample(x, samples), CHAMP);
  };
  assert.equal((await once()).written, 4);
  const n1 = fs.readFileSync(samples, 'utf8').trim().split('\n').length;
  assert.equal((await once()).rows, 0);
  assert.equal(fs.readFileSync(samples, 'utf8').trim().split('\n').length, n1);
  // 換 champion 後同一列可以再重放（新權重的信心不同）。
  assert.equal(doneIds(fs.readFileSync(samples, 'utf8'), '2026-10-21T02:00:00Z').size, 0);
  // 10-20 前的重放列是舊名 gateway:route-judge，改名後不能被當成沒重放過再灌一次。
  const old = JSON.stringify({ replay: true, shadow: true, caller: 'gateway:route-judge', champion_at: CHAMP, request_id: 'x' });
  assert.deepEqual([...doneIds(old, CHAMP)], ['x']);
  const row = JSON.parse(fs.readFileSync(samples, 'utf8').split('\n')[0]);
  assert.equal(row.caller, CALLER);
  assert.equal(row.shadow, true);
  assert.equal(row.replay, true);
  assert.equal(row.request_id, 'a');
});

test('calibrate picks up replay rows as gateway:route-judge families', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cal-'));
  const samples = path.join(dir, 'routing-samples.jsonl');
  const corpus = Array.from({ length: 25 }, (_, i) => corpusRow(`r${i}`, '2026-10-15T00:00:00Z')).join('\n');
  await replay(pickRows(corpus, CHAMP, new Set()), fakeLaya, (x) => recordRoutingSample(x, samples), CHAMP);
  fs.writeFileSync(path.join(dir, 'champ.json'), JSON.stringify({ promoted_at: CHAMP }));
  const out = path.join(dir, 'wl.json');
  execFileSync('python3', [path.join(ROOT, 'scripts/laya-calibrate.py'), '--samples', samples, '--out', out], {
    env: { ...process.env, JEV_LAYA_CHAMPION: path.join(dir, 'champ.json'), JEV_LAYA_LB_HISTORY: path.join(dir, 'h.jsonl'),
      JEV_USAGE_LOG: path.join(dir, 'none.jsonl') }, encoding: 'utf8' });
  const wl = JSON.parse(fs.readFileSync(out, 'utf8'));
  const got = [...wl.entries, ...wl.rejected].filter((e) => e.caller === CALLER).map((e) => [e.family, e.requests]).sort();
  assert.deepEqual(got, [['ambiguous', 25], ['tier', 25]]);
});
