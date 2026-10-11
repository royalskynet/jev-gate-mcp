// Real-call tests (codex-adapters, spawn-hook) answer with a real model, so the
// fake/mock filter misses them. By 10-05 their probe prompts were 96% of the
// score/noul teacher rows, which made Laya's online accuracy meaningless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { recordTeacherSample } from '../gateway/src/teacher-corpus.js';
import { recordRoutingSample } from '../gateway/src/routing-corpus.js';

const realTeacher = join(homedir(), '.jevgate', 'teacher-corpus.jsonl');
const realRouting = join(homedir(), '.jevgate', 'routing-samples.jsonl');
const sample = { state: { user_request: 'something' }, questions: [{ id: 'difficulty' }],
  result: { model: 'jev-1.13-free', answers: {} } };

test('node --test never writes a real-model answer into the real teacher corpus', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'runs under node --test');
  assert.equal(recordTeacherSample(sample, realTeacher), false);
});

test('node --test never writes into the real routing log', () => {
  assert.equal(recordRoutingSample({ question: [], local_model: 'laya', teacher_model: 'jev' }, realRouting), false);
});

test('an explicit temp corpus still records, so corpus tests keep working', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-guard-'));
  const file = join(dir, 't.jsonl');
  assert.equal(recordTeacherSample(sample, file), true);
  assert.ok(existsSync(file));
});
