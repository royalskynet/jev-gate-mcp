import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTeacherCorpus, recordTeacherSample } from '../src/teacher-corpus.js';

// The local lane's whitelist is keyed on (caller, question family), so a teacher
// row that does not say who asked can never count toward certifying anyone.
test('teacher rows carry the caller the router was given', async () => {
  const rows = [];
  const adapter = async () => ({ model: 'jev-1.13-free', answers: { a: { type: 'noul', noul: 0.9 } } });
  await withTeacherCorpus(adapter, r => rows.push(r))('s', { a: { type: 'noul' } }, { caller: 'cascade:compact' });
  await withTeacherCorpus(adapter, r => rows.push(r))('s', { a: { type: 'noul' } });
  assert.deepEqual(rows.map(r => r.caller), ['cascade:compact', null]);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-')), 'c.jsonl');
  assert.equal(recordTeacherSample({ state: 's', questions: {}, result: { model: 'jev', answers: {} }, caller: 'cascade:stop-gate' }, file), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).caller, 'cascade:stop-gate');
});
