import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferStop, blockDecision } from '../plugin/hooks/gate.js';

// 10-22: a Stop verdict is parked for the next turn, never answered at Stop.
// Both shapes blockDecision produces must land in the sidecar verbatim.
const dir = mkdtempSync(join(tmpdir(), 'jev-defer-'));
try {
  assert.equal(deferStop(blockDecision({ verdict: 'contradicted', gate: 'auto' }), 'sess 1!', dir), true);
  assert.equal(deferStop(blockDecision({ verdict: 'not_addressed', gate: 'auto' }), 'sess 1!', dir), true);
  const files = readdirSync(join(dir, 'sess1')).sort();
  assert.equal(files.length, 2, 'one file per verdict, session id sanitised');
  const text = files.map((f) => readFileSync(join(dir, 'sess1', f), 'utf8')).join('');
  assert.match(text, /\[jev-gate\] this round's tool output contradicts/);
  assert.match(text, /\[jev-gate\] \(jev-gate\) this round's tool output does not support/);

  // Without a session id the caller must keep answering the hook itself.
  assert.equal(deferStop(blockDecision({ verdict: 'contradicted', gate: 'auto' }), '', dir), false);
  assert.equal(deferStop(undefined, 'x', dir), false, 'nothing to say, nothing written');
  assert.equal(readdirSync(dir).length, 1, 'no stray session directories');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok: Stop verdicts defer to a per-session sidecar; no session id keeps the old answer');
