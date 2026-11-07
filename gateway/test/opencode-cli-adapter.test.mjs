import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { makeOpencodeCliAdapter } from '../src/adapters.js';

function fakeSpawn({ code = 0, stdout = '', stderr = '', capture } = {}) {
  return (bin, args, opts) => {
    capture.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
}

const QUESTIONS = {
  q: { type: 'noul', instructions: 'true?' },
};

test('opencode CLI adapter returns valid answers and calls opencode run --pure -m beam-free', async () => {
  const capture = [];
  const adapter = makeOpencodeCliAdapter({
    spawn: fakeSpawn({ stdout: '{"answers":{"q":{"type":"noul","noul":0.9}}}', capture }),
  });
  const r = await adapter('state', QUESTIONS);
  assert.equal(r.model, 'opencode-go/beam-free');
  assert.equal(r.answers.q.noul, 0.9);
  assert.deepEqual(r.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(capture.length, 1);
  assert.deepEqual(capture[0].args.slice(0, 4), ['run', '--pure', '-m', 'opencode-go/beam-free']);
});

test('opencode CLI adapter throws when probabilities/answer invalid (noul out of range)', async () => {
  const capture = [];
  const adapter = makeOpencodeCliAdapter({
    spawn: fakeSpawn({ stdout: '{"answers":{"q":{"type":"noul","noul":2}}}', capture }),
  });
  await assert.rejects(() => adapter('s', QUESTIONS), (e) => e.code === 'upstream');
});

test('opencode CLI adapter throws on non-zero exit', async () => {
  const capture = [];
  const adapter = makeOpencodeCliAdapter({
    spawn: fakeSpawn({ code: 1, stderr: 'boom', stdout: '', capture }),
  });
  await assert.rejects(() => adapter('s', QUESTIONS), (e) => e.code === 'upstream' && /exited 1/.test(e.message));
});

test('opencode CLI adapter throws when score probabilities sum != 1', async () => {
  const capture = [];
  const adapter = makeOpencodeCliAdapter({
    spawn: fakeSpawn({ stdout: '{"answers":{"q":{"type":"score","score":0,"legend":{"0":"a","1":"b"},"probabilities":{"0":0.2,"1":0.2},"confidence":0.8}}}', capture }),
  });
  const questions = { q: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] } };
  await assert.rejects(() => adapter('s', questions), (e) => e.code === 'upstream');
});
