import assert from 'node:assert/strict';
import { touchedPathsFromLines } from '../plugin/lib/state.js';
import { evidenceFromLines } from '../plugin/lib/transcript.js';

// A compaction re-appends older messages after its boundary with their
// ORIGINAL timestamps. Live on 2026-10-11 a mid-turn compact made the Stop
// walk stop at a replayed old prompt: the round had edited four files and the
// gate saw zero edits, so state capture never wrote a line.

const line = (o) => `${JSON.stringify(o)}\n`;
const at = (m) => `2026-10-11T10:${String(m).padStart(2, '0')}:00.000Z`;
const prompt = (text, m) => line({ type: 'user', timestamp: at(m), message: { content: text } });
const edit = (p, m) => line({
  type: 'assistant', timestamp: at(m),
  message: { content: [{ type: 'tool_use', id: `e${m}`, name: 'Edit', input: { file_path: p } }] },
});
const result = (text, m) => line({
  type: 'user', timestamp: at(m), message: { content: [{ type: 'tool_result', tool_use_id: `e${m}`, content: text }] },
});
const boundary = (m) => line({ type: 'system', subtype: 'compact_boundary', timestamp: at(m) });

const lines = [
  prompt('older turn', 1),
  edit('/tmp/old.js', 2),
  result('OLD-RESULT', 2),
  prompt('this round', 10),
  edit('/tmp/a.js', 11),
  result('A-RESULT', 11),
  boundary(15),
  // replay: old prompts and results under their original timestamps
  prompt('older turn', 1),
  result('OLD-RESULT', 2),
  prompt('this round', 10),
  // real work after the compact
  edit('/tmp/b.js', 16),
  result('B-RESULT', 16),
].join('').split('\n');

assert.deepEqual(touchedPathsFromLines(lines), ['/tmp/a.js', '/tmp/b.js'],
  'edits on both sides of a mid-turn compact belong to the round');

{
  const ev = evidenceFromLines(lines);
  assert.ok(ev.includes('A-RESULT') && ev.includes('B-RESULT'), 'tool output on both sides of the compact');
  assert.ok(!ev.includes('OLD-RESULT'), 'a replayed old result is not this round');
}

{
  // Without any compaction the walk is unchanged.
  const plain = [prompt('p', 1), edit('/tmp/x.js', 2), prompt('q', 3), edit('/tmp/y.js', 4)].join('').split('\n');
  assert.deepEqual(touchedPathsFromLines(plain), ['/tmp/y.js']);
}
