import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('gate-event-counts 只印計數、不外洩內容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gec-'));
  const p = join(dir, 'fake.log');
  const now = new Date().toISOString(), old = '2020-01-01T00:00:00.000Z';
  const L = [
    { ts: now, event: 'no_claim_skip', gate: 'stop' },
    { ts: now, event: 'no_claim_skip', gate: 'stop' },
    { ts: now, event: 'gate_decide', decided: { claims: [{ verdict: 'contradicted', claim: 'SECRET-TOKEN-xyz' }] } },
    { ts: old, event: 'gate_observe', decided: { claims: [{ verdict: 'SECRET-TOKEN-xyz' }] } },
    { ts: old, event: 'SECRET-TOKEN-xyz' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\nnot json\n';
  writeFileSync(p, L);
  const out = execFileSync('node', ['scripts/gate-event-counts.mjs', '--log', p, '--days', '7'], { encoding: 'utf8' });
  assert.match(out, /event no_claim_skip 2/);
  assert.match(out, /verdict contradicted 1/);
  assert.match(out, /== 全部: 5 行/);
  assert.match(out, /== 近 7 天: 3 行/);
  assert.match(out, /event other 1/);
  assert.doesNotMatch(out, /SECRET/);
});
