import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../scripts/laya-handoff-report.mjs';

const row = (caller, q_total, q_local, ts = '2026-10-10T01:00:00Z') => JSON.stringify({
  ts, caller, q_total, q_local, q_cloud: q_total - q_local,
  by_state_filter: q_total - q_local, by_low_conf: 0, by_invalid: 0, by_no_match: 0 });

// 省錢按請求算：一題送雲端整次就付費，所以 full 只數 q_cloud==0 的請求
test('full-local counts only requests with no cloud question; backtest is excluded by default', () => {
  const lines = [row('cascade:stop-gate', 1, 0), row('gateway:x', 2, 2), row('gateway:x', 3, 1),
    row('gateway:backtest:teacher', 5, 5)];
  const all = new Map(summarize(lines, { days: 3, now: Date.parse('2026-10-10T12:00:00Z') })).get('2026-10-10\t*');
  assert.deepEqual([all.req, all.full, all.part, all.ql, all.qt], [3, 1, 1, 3, 6]);
  const withBt = new Map(summarize(lines, { days: 3, all: true, now: Date.parse('2026-10-10T12:00:00Z') })).get('2026-10-10\t*');
  assert.equal(withBt.req, 4);
});
