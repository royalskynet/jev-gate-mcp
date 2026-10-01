// The nightly job's only output a human sees is the hpush, so test that: a
// question type crossing the ready threshold is pushed exactly once, and one
// below it never is. No pending rows -> the Laya graph is never loaded.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('laya-nightly pushes a ready question type once and skips the rest', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-nightly-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.jevgate'));
  const pushes = path.join(home, 'pushes.txt');
  fs.writeFileSync(path.join(bin, 'hpush'), `#!/bin/sh\necho "$*" >> ${pushes}\n`, { mode: 0o755 });
  const row = (digest, local, teacher) => JSON.stringify({
    question_digest: digest, local_answer: { q: { type: 'choice', choice: local } }, teacher_answer: { q: { type: 'choice', choice: teacher } },
  });
  const corpus = path.join(home, 'corpus.jsonl');
  fs.writeFileSync(corpus, [row('a'.repeat(64), 'x', 'x'), row('a'.repeat(64), 'y', 'y'), row('b'.repeat(64), 'x', 'y'), row('b'.repeat(64), 'x', 'x')].join('\n') + '\n');
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, JEV_TEACHER_CORPUS: corpus,
    JEV_LAYA_REPORT: path.join(home, 'report.json'), LAYA_READY_MIN: '2', LAYA_READY_RATE: '0.95' };
  const run = () => execFileSync('bash', [path.join(ROOT, 'scripts/laya-nightly.sh')], { env, encoding: 'utf8' });

  run();
  const first = fs.readFileSync(pushes, 'utf8').trim().split('\n');
  assert.equal(first.length, 1, `expected one push, got ${first}`);
  assert.match(first[0], /aaaaaaaaaaaa\/q/);
  assert.match(first[0], /100%/);

  run();
  assert.equal(fs.readFileSync(pushes, 'utf8').trim().split('\n').length, 1, 'ready key re-pushed on the next night');
});
