import assert from 'node:assert/strict';
import { evidenceFromLines } from '../plugin/lib/transcript.js';

// A write-type command that succeeds prints nothing. The Stop gate then had no
// evidence for "card registered" and deferred a false "not supported" note.

const line = (o) => `${JSON.stringify(o)}\n`;
const prompt = line({ type: 'user', message: { content: 'register it' } });
const use = (id, name, input) => line({
  type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
});
const res = (id, content, extra = {}) => line({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
});
const ev = (...parts) => evidenceFromLines(parts.join('').split('\n'));

const quiet = ev(prompt, use('a', 'Bash', { command: 'wheel_registry.py add card1' }), res('a', ''));
assert.match(quiet, /Bash completed with no output and no error: wheel_registry\.py add card1/);

const failed = ev(prompt, use('a', 'Bash', { command: 'false' }), res('a', '', { is_error: true }));
assert.equal(failed, '', 'an errored empty result is not evidence of success');

const loud = ev(prompt, use('a', 'Bash', { command: 'ls' }), res('a', 'file.txt'));
assert.equal(loud, 'file.txt', 'non-empty output is unchanged');

const wide = evidenceFromLines((prompt + use('a', 'Bash', { command: 'x' }) + res('a', '')).split('\n'), 8000, { allRounds: true });
assert.equal(wide, 'register it', 'the identifier window is untouched');
