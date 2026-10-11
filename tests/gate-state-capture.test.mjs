// The capture is the only record of git state at Stop time; a replay built on
// it is worthless if a line is missing a pointer or carries the wrong round.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureState } from '../plugin/hooks/gate.js';

const dir = mkdtempSync(join(tmpdir(), 'cap-'));
const transcript = join(dir, 't.jsonl');
const body = '{"type":"user"}\n{"type":"assistant"}\n';
writeFileSync(transcript, body);
const log = join(dir, 'sub', 'cap.jsonl');
const state = { text: '=== state ===\n  a.js: uncommitted change', stats: { repos: 1, paths: 1, changed: 1, unchanged: 0, missing: 0 } };

await captureState({ stateCaptureLog: log }, { transcript_path: transcript, session_id: 's1' }, state);
const rec = JSON.parse(readFileSync(log, 'utf8').trim());
assert.equal(rec.transcript_path, transcript);
assert.equal(rec.transcript_bytes, Buffer.byteLength(body), 'byte length pins the round for replay');
assert.equal(rec.session_id, 's1');
assert.equal(rec.state, state.text);
assert.deepEqual(rec.stats, state.stats);

// Appends, never rewrites: the earlier round must survive the next one.
await captureState({ stateCaptureLog: log }, { transcript_path: transcript }, state);
assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);

// No log configured or no state: nothing written, nothing thrown.
const none = join(dir, 'none.jsonl');
await captureState({}, { transcript_path: transcript }, state);
await captureState({ stateCaptureLog: none }, { transcript_path: transcript }, { text: '', stats: null });
assert.equal(existsSync(none), false);

// Unwritable path and missing transcript fail open.
await captureState({ stateCaptureLog: '/dev/null/x/cap.jsonl' }, { transcript_path: join(dir, 'gone') }, state);
console.log('gate-state-capture: ok');
