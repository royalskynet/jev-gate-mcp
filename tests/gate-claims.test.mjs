import assert from 'node:assert/strict';
import { atomicClaims, decisive } from '../plugin/lib/claims.js';

// Why: the whole reply went in as one claim and 61% of verdicts were
// `escalate`. jevwire verify wants single statements; only completion
// sentences are worth checking, and plans or honest "not yet" lines must not
// be held to tool output (that punishes Fail Loud).
const reply = [
  '## 改好了',
  '- 新寫的測試通過。',
  '- 全部 437 支測試有 423 支通過。',
  '- 已 commit 成 `5f288e5`。這個 repo 沒有設定遠端。',
  '建議下一步把長回覆拆句。',
  '還沒修 Laya 那 12 支測試。',
  '要不要接著做？',
  '```bash\nnpm test # passed\n```',
  '<options>\n<option>已完成的選項</option>\n</options>',
].join('\n');
assert.deepEqual(atomicClaims(reply), [
  '新寫的測試通過。',
  '全部 437 支測試有 423 支通過。',
  '已 commit 成 `5f288e5`。',
]);

// English completion sentences split on ". " too.
assert.deepEqual(atomicClaims('Fixed the parser. Tests passed 12/12. Next I will clean up.'),
  ['Fixed the parser.', 'Tests passed 12/12.']);

// No completion sentence: the caller falls back to the whole reply.
assert.deepEqual(atomicClaims('這是一個概念解釋，沒有動任何東西'), []);
assert.equal(atomicClaims(Array.from({ length: 20 }, (_, i) => `第 ${i} 項已完成`).join('\n')).length, 8, 'capped');

// The most severe verdict decides the round.
const c = (verdict, gate, claim = verdict) => ({ verdict, gate, claim });
assert.equal(decisive([c('supported', 'auto'), c('contradicted', 'review'), c('not_addressed', 'auto')]).verdict, 'contradicted');
assert.equal(decisive([c('contradicted', 'review', 'a'), c('contradicted', 'auto', 'b')]).claim, 'b');
assert.equal(decisive([c('not_addressed', 'escalate'), c('not_addressed', 'auto', 'x')]).claim, 'x');
assert.equal(decisive([c('supported', 'auto', 'first'), c('supported', 'review')]).claim, 'first');
assert.equal(decisive(undefined), undefined);

console.log('ok: completion sentences only, most severe verdict decides');
