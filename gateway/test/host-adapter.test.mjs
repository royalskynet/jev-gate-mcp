import test from 'node:test';
import assert from 'node:assert';
import { createHostAdapter } from '../src/host-adapter.js';

test('host adapter: non-accept decision stops the real execution boundary', async () => {
  let executed = false;
  const adapter = createHostAdapter({
    applyPolicy: async () => ({ outcome: 'review', policy: { id: 'proposed-action-risk', version: 1 } }),
  });
  const result = await adapter.enforce({
    boundary: 'before_action',
    state: { action: 'publish' },
    execute: async () => { executed = true; },
  });
  assert.equal(result.executed, false);
  assert.equal(executed, false, 'red-line: review must not execute');
});

test('host adapter: literal accept is the only branch that executes', async () => {
  const adapter = createHostAdapter({
    applyPolicy: async (args) => ({ outcome: 'accept', policy: { id: args.policy, version: 1 } }),
  });
  const result = await adapter.enforce({
    boundary: 'before_finish',
    state: { claims: ['done'], evidence: 'tests pass' },
    execute: async () => 'finished',
  });
  assert.equal(result.executed, true);
  assert.equal(result.value, 'finished');
});

test('host adapter: missing/unknown boundary fails before policy or execution', async () => {
  const adapter = createHostAdapter({ applyPolicy: async () => ({ outcome: 'accept' }) });
  await assert.rejects(
    () => adapter.enforce({ boundary: 'unknown', state: {}, execute: async () => {} }),
    /unknown lifecycle boundary/,
  );
});
