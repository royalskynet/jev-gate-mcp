import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, collapseProgress, collapseRepeats, l0Prune } from '../agent-glue/src/l0-prune.js';

test('stripAnsi removes CSI and OSC sequences', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(stripAnsi('\x1b]0;title\x07plain'), 'plain');
});

test('collapseProgress keeps only the last carriage-return segment per line', () => {
  assert.equal(collapseProgress('10%\r50%\r100%\ndone'), '100%\ndone');
  assert.equal(collapseProgress('a\r\nb'), 'a\nb');
});

test('collapseRepeats collapses runs of at least min identical lines', () => {
  assert.equal(collapseRepeats('x\nx\nx\nx\nx\ny'), 'x\n[l0: repeated 4 more times]\ny');
  assert.equal(collapseRepeats('x\nx\ny'), 'x\nx\ny');
  assert.equal(collapseRepeats('x\nx\nx\nx', { min: 2 }), 'x\n[l0: repeated 3 more times]');
});

test('l0Prune leaves clean text unchanged and reports savedChars', () => {
  const plain = l0Prune('hello\nworld');
  assert.equal(plain.text, 'hello\nworld');
  assert.equal(plain.savedChars, 0);
});

test('l0Prune passes non-string input through untouched', () => {
  assert.deepEqual(l0Prune(null), { text: null, savedChars: 0 });
});

test('l0Prune applies all three stages in order', () => {
  const out = l0Prune('a\n'.repeat(4) + 'b');
  assert.equal(out.text, 'a\n[l0: repeated 3 more times]\nb');
  assert.equal(out.savedChars, 'a\na\na\na\nb'.length - 'a\n[l0: repeated 3 more times]\nb'.length);
});
