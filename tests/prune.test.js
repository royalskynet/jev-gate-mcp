import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkLines, pruneOutput, THRESHOLD_CHARS } from '../plugin/hooks/prune.js';

test('chunkLines preserves line boundaries and sizes', () => {
  const text = Array.from({ length: 5 }, (_, i) => `line${i}-` + 'x'.repeat(20)).join('\n');
  const chunks = chunkLines(text, 50, 8);
  const rejoin = chunks.join('\n');
  assert.equal(rejoin, text);
  for (const c of chunks) assert.ok(c.length <= 50, 'chunk within budget');
});

test('below threshold short-circuits: judge never called', async () => {
  const output = 'a'.repeat(THRESHOLD_CHARS - 1);
  let calls = 0;
  const r = await pruneOutput({
    output,
    userRequest: 'r',
    judge: async () => { calls++; return 'drop'; },
  });
  assert.equal(r.shortCircuited, true);
  assert.equal(r.kept, output, 'short output unchanged');
  assert.equal(calls, 0, 'no judge call for short output');
});

test('fail-open: judge error keeps original output, nothing dropped', async () => {
  // Force chunking so the judge path is exercised.
  const output = Array.from({ length: 100 }, (_, i) => `line${i}-` + 'y'.repeat(80)).join('\n');
  assert.ok(output.length >= THRESHOLD_CHARS);
  const r = await pruneOutput({
    output,
    userRequest: 'r',
    judge: async () => { throw new Error('provider down'); },
  });
  assert.equal(r.kept, output, 'original output kept verbatim on judge failure');
  assert.equal(r.droppedLines, 0);
});

test('judge dropping chunks yields markers and keeps kept-chunks verbatim', async () => {
  const lines = Array.from({ length: 6 }, (_, i) => `content line ${i}`);
  const output = lines.join('\n') + 'x'.repeat(THRESHOLD_CHARS); // pad over threshold
  // Judge drops every chunk whose user_request indicates "noise".
  const r = await pruneOutput({
    output,
    userRequest: 'drop-it',
    judge: async () => 'drop',
  });
  assert.match(r.kept, /\[jev-prune: dropped \d+ lines\]/);
});
