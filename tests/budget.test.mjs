import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withDailyBudget, withPaymentStop } from '../gateway/src/budget.js';

const NOON = (d) => Date.UTC(2026, 9, d, 12);

function tmpFile(name) {
  return join(mkdtempSync(join(tmpdir(), 'jev-budget-')), name);
}

test('withDailyBudget: max=2 時第 3 次 throw JEV_BUDGET_EXCEEDED，notify 每天只叫 1 次', async () => {
  const file = tmpFile('or-budget.json');
  const notes = [];
  let calls = 0;
  const adapter = async () => { calls += 1; return 'ok'; };
  const wrapped = withDailyBudget(adapter, {
    max: 2, file, notify: (m) => notes.push(m), now: () => NOON(8),
  });

  assert.equal(await wrapped({}, []), 'ok');
  assert.equal(await wrapped({}, []), 'ok');
  assert.equal(calls, 2);

  await assert.rejects(wrapped({}, []), (err) => {
    assert.equal(err.code, 'JEV_BUDGET_EXCEEDED');
    return true;
  });
  assert.equal(notes.length, 1);

  await assert.rejects(wrapped({}, []), (err) => {
    assert.equal(err.code, 'JEV_BUDGET_EXCEEDED');
    return true;
  });
  assert.equal(notes.length, 1, '已通知過就不再通知');
  assert.equal(calls, 2, '超過上限後不呼叫 adapter');
});

test('withDailyBudget: 換日歸零', async () => {
  const file = tmpFile('or-budget.json');
  let calls = 0;
  const adapter = async () => { calls += 1; return 'ok'; };
  let day = 8;
  const wrapped = withDailyBudget(adapter, {
    max: 2, file, notify: () => {}, now: () => NOON(day),
  });

  await wrapped({}, []);
  await wrapped({}, []);
  await assert.rejects(wrapped({}, []), (err) => err.code === 'JEV_BUDGET_EXCEEDED');

  day = 9;
  assert.equal(await wrapped({}, []), 'ok');
  assert.equal(calls, 3);
});

test('withDailyBudget: 保留額度只給 compact，其他 caller 提早被擋', async () => {
  const file = tmpFile('or-budget.json');
  const notes = [];
  let calls = 0;
  const adapter = async () => { calls += 1; return 'ok'; };
  const wrapped = withDailyBudget(adapter, {
    max: 3, reserve: 2, file, notify: (m) => notes.push(m), now: () => NOON(8),
  });
  const gate = { caller: 'cascade:stop-gate' };
  const compact = { caller: 'cascade:compact' };

  assert.equal(await wrapped({}, [], gate), 'ok');
  await assert.rejects(wrapped({}, [], gate), (err) => err.code === 'JEV_BUDGET_EXCEEDED');
  await assert.rejects(wrapped({}, []), (err) => err.code === 'JEV_BUDGET_EXCEEDED');
  assert.equal(notes.length, 0, '一般額度用完不算日上限，不通知');

  assert.equal(await wrapped({}, [], compact), 'ok');
  assert.equal(await wrapped({}, [], compact), 'ok');
  await assert.rejects(wrapped({}, [], compact), (err) => err.code === 'JEV_BUDGET_EXCEEDED');
  assert.equal(calls, 3);
  assert.equal(notes.length, 1);
});

test('withPaymentStop: 402 後停用，第二次不碰 adapter', async () => {
  const file = tmpFile('or-status.json');
  const notes = [];
  let calls = 0;
  const adapter = async () => {
    calls += 1;
    const err = new Error('insufficient credits');
    err.status = 402;
    throw err;
  };
  const wrapped = withPaymentStop(adapter, {
    file, notify: (m) => notes.push(m), now: () => NOON(8),
  });

  await assert.rejects(wrapped({}, []), (err) => {
    assert.equal(err.status, 402);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(notes.length, 1);

  await assert.rejects(wrapped({}, []), (err) => {
    assert.equal(err.code, 'JEV_PAYMENT_REQUIRED');
    return true;
  });
  assert.equal(calls, 1, '停用期間不呼叫 adapter');
});

test('withPaymentStop: e.cause.status === 402 也算付款問題', async () => {
  const file = tmpFile('or-status.json');
  let calls = 0;
  const adapter = async () => {
    calls += 1;
    const err = new Error('wrapped');
    err.cause = { status: 402 };
    throw err;
  };
  const wrapped = withPaymentStop(adapter, {
    file, notify: () => {}, now: () => NOON(8),
  });

  await assert.rejects(wrapped({}, []));
  assert.equal(calls, 1);
  await assert.rejects(wrapped({}, []), (err) => err.code === 'JEV_PAYMENT_REQUIRED');
  assert.equal(calls, 1);
});

test('withPaymentStop: 非 402 錯誤不寫 or-status 檔', async () => {
  const file = tmpFile('or-status.json');
  const boom = new Error('boom');
  const adapter = async () => { throw boom; };
  const wrapped = withPaymentStop(adapter, {
    file, notify: () => {}, now: () => NOON(8),
  });

  await assert.rejects(wrapped({}, []), (err) => {
    assert.equal(err, boom);
    return true;
  });
  assert.equal(existsSync(file), false, '非 402 不寫 or-status');
});
