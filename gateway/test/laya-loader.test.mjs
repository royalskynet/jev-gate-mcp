// Shadow tokenizer: one shared dir per tokenizer version, graph symlinked, not
// copied — a per-process full copy leaked ~540MB per hook call into tmpdir.
import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shadowDirFor } from '../src/laya-loader.js';

test('shadow is shared across concurrent loaders and symlinks the graph', async () => {
  const src = await mkdtemp(path.join(os.tmpdir(), 'laya-src-'));
  await mkdir(path.join(src, 'tokenizer'));
  await writeFile(path.join(src, 'laya.onnx'), 'graph');
  await writeFile(path.join(src, 'laya_config.json'), '{}');
  await writeFile(path.join(src, 'tokenizer', 'tokenizer_config.json'), '{}');
  await writeFile(path.join(src, 'tokenizer', 'tokenizer.json'), JSON.stringify({ added_tokens: [
    { content: '<pad>', id: 0 }, { content: '<eos>', id: 1 }, { content: '<bos>', id: 2 }, { content: '<mask>', id: 4 },
  ] }));

  const dirs = await Promise.all([1, 2, 3, 4].map(() => shadowDirFor(src)));
  assert.equal(new Set(dirs).size, 1);
  const dir = dirs[0];
  assert.ok((await lstat(path.join(dir, 'laya.onnx'))).isSymbolicLink());
  const tok = JSON.parse(await readFile(path.join(dir, 'tokenizer', 'tokenizer.json'), 'utf8'));
  const ids = Object.fromEntries(tok.added_tokens.map((t) => [t.content, t.id]));
  assert.deepEqual([ids['[CLS]'], ids['[SEP]'], ids['[MASK]'], ids['[PAD]']], [2, 1, 4, 0]);
  // No stray temp dirs left behind by the losers of the rename race.
  const left = (await readdir(path.dirname(dir))).filter((f) => f.startsWith('.tmp-'));
  assert.deepEqual(left, []);
  assert.equal(await shadowDirFor(src), dir);
});
