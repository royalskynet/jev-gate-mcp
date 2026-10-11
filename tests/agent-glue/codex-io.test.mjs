import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { appendLedger, runtimePath } from '../../agent-glue/codex/io.mjs';

const ROUTE_LOG = 'codex-route.log';
after(() => {
  try {
    rmSync(runtimePath(ROUTE_LOG), { force: true });
  } catch {
    /* leave it */
  }
});

test('codex ledger: the FIRST write creates the file (a decision must never be silently dropped)', async () => {
  // Regression: appendLedger used to read the (missing) file first and abort the
  // whole block on ENOENT, so the very first decision never landed in the ledger.
  appendLedger(ROUTE_LOG, 'one');
  appendLedger(ROUTE_LOG, 'two');
  const txt = await readFile(runtimePath(ROUTE_LOG), 'utf8');
  assert.match(txt, /^one\ntwo$/m, 'both lines, including the first, are written');
});
