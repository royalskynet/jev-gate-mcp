import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { samplesFromLines, routeGrey, sampleKey, makeSecretCheck } from '../scripts/backtest-teacher.mjs';

// 10-10 首跑把遮罩前的 state 寫進語料、遮罩漏網的憑證形狀也送了出去。這道閘必須真的會擋。
const HOOK = join(homedir(), '.claude', 'hooks', 'canary-allowlist.mjs');
test('secret check drops a token-shaped value and keeps plain text', { skip: !existsSync(HOOK) && 'no canary hook on this host' }, () => {
  const check = makeSecretCheck(HOOK);
  try {
    const fake = `${'1'.repeat(10)}:AA${'x9'.repeat(16)}Z`;
    assert.equal(check({ user_request: `bot token ${fake}` }), true);
    assert.equal(check({ user_request: '把 shadow 開關改掉然後跑測試' }), false);
  } finally { check.close(); }
});

const L = (o) => JSON.stringify(o);
const prompt = (t, ts = '2026-10-09T00:00:00Z') => L({ type: 'user', timestamp: ts, message: { content: t } });
const tool = (name, input = {}) => L({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const result = (text, is_error = false) => L({ type: 'user', message: { content: [{ type: 'tool_result', content: text, is_error }] } });
const say = (t) => L({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });

// 灰帶閘照 route-judge：短問句與短指令不送，危險詞不論長短都送。
test('routeGrey mirrors route-judge gate', () => {
  assert.equal(routeGrey('這是什麼？'), false);
  assert.equal(routeGrey('好'), false);
  assert.equal(routeGrey('刪除'), true);
  assert.equal(routeGrey('把這三個檔的 shadow 開關全部關掉然後重跑測試確認'), true);
});

test('route phase comes from the previous turn, claim needs tools and a done word', () => {
  const lines = [
    prompt('先把 gate 的 shadow 開關改掉，然後跑一次測試看結果'),
    tool('Edit', { file_path: '/x/gate.js' }),
    result('ok'),
    tool('Bash'),
    result('tests 12 passed 0 failed'),
    say('改好了，測試全部通過，完成。'),
    prompt('接著把同樣的改法套到 mythos 那支 stop-gate 腳本上面'),
    say('我先讀一下檔案。'),
  ];
  const s = samplesFromLines(lines);
  assert.equal(s.route.length, 2);
  assert.equal(s.route[0].phase, 'unknown');
  // 第二則 prompt 的前一輪動過檔 → acting，線上會因此把同一句判成多檔變更。
  assert.equal(s.route[1].phase, 'acting');
  assert.equal(s.claim.length, 1, 'second turn ran no tools, so no claim');
  assert.deepEqual(s.claim[0].claims, ['改好了，測試全部通過，完成。']);
  // 證據只取那一輪的工具輸出，不能漏掉最後那句測試結果。
  assert.match(s.claim[0].evidence, /0 failed/);
});

test('since drops old prompts; tagged text is not a human prompt', () => {
  const lines = [
    prompt('很久以前的一則很長的任務描述，應該被時間窗濾掉才對', '2026-01-01T00:00:00Z'),
    prompt('<local-command-stdout>some long output that is not typed by a human</local-command-stdout>'),
  ];
  assert.equal(samplesFromLines(lines, { since: Date.parse('2026-09-01') }).route.length, 0);
});

// 去重鍵要跟題組綁在一起：同一句話換一組題就是新樣本。
test('sampleKey depends on both questions and state', () => {
  const st = { user_request: 'x' };
  assert.notEqual(sampleKey({ a: 1 }, st), sampleKey({ b: 1 }, st));
  assert.equal(sampleKey({ a: 1 }, st), sampleKey({ a: 1 }, { user_request: 'x' }));
});
