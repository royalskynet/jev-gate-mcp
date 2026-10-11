import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../scripts/laya-handoff-report.mjs';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const h = (caller, q_total, q_local, ts = '2026-10-10T05:00:00Z') => ({
  ts, caller, q_total, q_local, q_cloud: q_total - q_local,
  by_state_filter: q_total - q_local, by_low_conf: 0, by_invalid: 0, by_no_match: 0 });
const u = (caller, model, ts = '2026-10-10T05:00:00Z', status = 200) => ({ ts, caller, model, status });
const total = (rows) => new Map(rows).get('2026-10-10\t*');

// 分母＝原本會發給 Jev 的全部：router 請求＋快取命中＋沒經 router 的 Jev 呼叫。
// 省錢按請求算，laya 只數整次沒碰雲端的。
test('denominator counts every would-be Jev request once across all three sources', () => {
  const g = total(summarize({
    handoff: [h('cascade:stop-gate', 1, 0), h('cascade:stop-gate', 1, 1), h('gateway:x', 3, 1)],
    usage: [
      u('cascade:stop-gate', 'typesafe/jev'),      // 同一請求在 handoff 已計，不得重算
      u('gateway:cascade-server', 'typesafe/jev'), // cascade 往上游那一跳，重複
      u('cascade:stop-gate', 'cache'),             // 快取命中：沒進 router
      u('cli:hermes-compact', 'typesafe/jev'),     // 沒經 router 的 caller
      u('hook-triage', 'jev-1.13-free'),
      u('cascade:stop-gate', null),                // /health
      u('claude-compact', 'jev-1.13-free', '2026-10-10T05:00:00Z', 429), // 沒成功
    ],
  }, { days: 3, now: NOW }));
  assert.deepEqual([g.denom, g.laya, g.part, g.cache, g.jev], [6, 1, 1, 1, 3]);
});

test('before a caller is first routed, its usage rows are classified by model', () => {
  const g = total(summarize({
    handoff: [h('cascade:compact', 1, 1, '2026-10-10T06:00:00Z')],
    usage: [u('cascade:compact', 'laya', '2026-10-10T01:00:00Z'),
      u('cascade:compact', 'hybrid:laya+jev', '2026-10-10T02:00:00Z'),
      u('cascade:compact', 'typesafe/jev', '2026-10-10T07:00:00Z')],
  }, { days: 3, now: NOW }));
  assert.deepEqual([g.denom, g.laya, g.part, g.jev], [3, 2, 1, 0]);
});

test('offline callers are excluded unless --all', () => {
  const data = { handoff: [h('gateway:backtest:teacher', 1, 1)], usage: [u('gateway:replay-split', 'jev')] };
  assert.equal(total(summarize(data, { days: 3, now: NOW })), undefined);
  assert.equal(total(summarize(data, { days: 3, all: true, now: NOW })).denom, 2);
});
