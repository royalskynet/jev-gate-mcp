import assert from 'node:assert/strict';
import { unsupportedIds, idBlock } from '../plugin/lib/idcheck.js';

// The case that motivated this: an issue URL reported as created, with no
// `gh issue create` anywhere in the round. The judge calls that `not_addressed`
// and lets it through, so the deterministic check has to be the one that stops.
const fab = unsupportedIds(
  'Issue 已開：https://github.com/royalskynet/fixindex/issues/10',
  'total 4\n-rw-r--r-- 1 me staff 120 Sep 29 17:00 README.md',
);
assert.deepEqual(fab, ['https://github.com/royalskynet/fixindex/issues/10']);
assert.equal(idBlock(fab).decision, 'block');
assert.match(idBlock(fab).reason, /only be quoted/);

// Quoted from the tool output -> silent.
assert.deepEqual(
  unsupportedIds(
    'Issue 已開：https://github.com/royalskynet/fixindex/issues/10',
    'https://github.com/royalskynet/fixindex/issues/10\n',
  ),
  [],
);

// `gh issue view --json` prints repo and number in separate fields and never a
// URL. A URL assembled from those is quoted, not invented.
assert.deepEqual(
  unsupportedIds(
    'See https://github.com/NandhaKishorM/laya/issues/156',
    '{"repository":{"name":"laya"},"number":156,"title":"noul labels"}',
  ),
  [],
);
// ...but a stray digit elsewhere in the output must not launder a made-up number.
assert.deepEqual(
  unsupportedIds(
    'See https://github.com/NandhaKishorM/laya/issues/156',
    'cloned laya, 156 files changed',
  ),
  ['https://github.com/NandhaKishorM/laya/issues/156'],
);

// A short hash quoted from a full one in the output is the same commit.
assert.deepEqual(
  unsupportedIds('pushed 2e0abb5', '[main 2e0abb5f1c9d4e7a8b3c2d1e0f9a8b7c6d5e4f3a] report'),
  [],
);
assert.deepEqual(unsupportedIds('pushed 2e0abb5', 'nothing to commit'), ['2e0abb5']);

// Measured false-positive classes, all of which must stay silent.

// Markdown emphasis inside a number: `540,524,**682**` otherwise reads as a
// separate short token and the formatting manufactures its own hit.
assert.deepEqual(unsupportedIds('540,524,**682** bytes', 'size 540524682'), []);
// Computed numbers are absent from every output by construction.
assert.deepEqual(unsupportedIds('省下約 26,500 token，約 4.25%', 'x'), []);
// Hex-shaped but not a hash.
assert.deepEqual(unsupportedIds('port 1234567', 'nothing'), []);
// Documentation placeholders are examples, not results.
assert.deepEqual(unsupportedIds('e.g. https://github.com/org/repo/issues/1234', 'nothing'), []);

// Fail open: no evidence means nothing to judge, never a block.
assert.deepEqual(unsupportedIds('https://github.com/a/b/issues/1', ''), []);
assert.deepEqual(unsupportedIds('', 'anything'), []);
assert.equal(idBlock([]), undefined);

console.log('ok: invented ids block, quoted ids pass, measured false-positive classes stay silent');
