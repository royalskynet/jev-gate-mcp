import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevLaya, MIN_CHARS } from '../integrations/opencode/jev-laya.js';

test('prunes long output with repeated lines', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const repeated = 'npm WARN x\n'.repeat(50);
  const filler = 'a'.repeat(MIN_CHARS);
  const out = { output: filler + '\n' + repeated };
  await fn({ tool: 'bash' }, out);
  assert.ok(out.output.includes('[l0: repeated'));
  assert.ok(out.output.length < filler.length + repeated.length);
});

test('leaves short output untouched', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const out = { output: 'short output' };
  await fn({ tool: 'bash' }, out);
  assert.equal(out.output, 'short output');
});

test('does not throw when output field missing', async () => {
  const hook = await JevLaya();
  const fn = hook['tool.execute.after'];
  const out = {};
  await fn({ tool: 'bash' }, out);
  assert.deepEqual(out, {});
});
