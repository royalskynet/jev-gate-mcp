// errorStatus: caller-fault 4xx pass through; key problems and the rest stay 502.
import { test } from 'node:test';
import assert from 'node:assert';
import { errorStatus } from '../src/cascade-server.js';

test('caller-fault 4xx pass through, from status or cause.status', () => {
  assert.equal(errorStatus({ status: 400 }), 400);
  assert.equal(errorStatus({ status: 422 }), 422);
  assert.equal(errorStatus({ cause: { status: 400 } }), 400);
});

test('own key problems stay 502', () => {
  assert.equal(errorStatus({ status: 401 }), 502);
  assert.equal(errorStatus({ status: 403 }), 502);
});

test('existing mappings unchanged', () => {
  assert.equal(errorStatus({ code: 'LAYA_ABSTAIN' }), 503);
  assert.equal(errorStatus({ code: 'JEV_BUDGET_EXCEEDED' }), 402);
  assert.equal(errorStatus({ code: 'JEV_PAYMENT_REQUIRED', status: 400 }), 402);
  assert.equal(errorStatus({ status: 429 }), 429);
  assert.equal(errorStatus({ cause: { status: 429 } }), 429);
  assert.equal(errorStatus({ status: 500 }), 502);
  assert.equal(errorStatus({}), 502);
});
