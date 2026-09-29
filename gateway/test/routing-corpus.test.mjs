import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordRoutingSample } from '../src/routing-corpus.js';

test('private corpus keeps teacher separate from gold and never auto-enables training', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jev-corpus-')), 'samples.jsonl');
  assert.equal(recordRoutingSample({ profile: 'task-kind-v1', question: { type: 'choice' },
    state: '合成測試', local_model: 'laya', teacher_model: 'jev', teacher_answer: { choice: 'a' },
    label: 'a', training_eligible: true }, file), true);
  const row = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(row.label, null);
  assert.equal(row.training_eligible, false);
  assert.equal(row.split, 'unassigned');
  assert.equal(row.teacher_answer.choice, 'a');
  assert.equal(row.question_digest.length, 64);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('disabled, fake and broken sinks cannot pollute live data or fail decisions', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jev-corpus-')), 'samples.jsonl');
  assert.equal(recordRoutingSample({ local_model: 'fake/local' }, file), false);
  assert.equal(existsSync(file), false);
  assert.equal(recordRoutingSample({}, 'off'), false);
  assert.equal(recordRoutingSample({}, '/dev/null/no-file'), false);
});
