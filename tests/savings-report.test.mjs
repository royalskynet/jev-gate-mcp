import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/savings-report-hermes-jev-prune.mjs', import.meta.url));

test('unified report keeps prune and routing savings separate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jev-savings-'));
  const hermes = path.join(root, 'hermes');
  const openclaw = path.join(root, 'openclaw');
  mkdirSync(path.join(hermes, 'profiles', 'coco', 'plugins', 'jev-prune'), { recursive: true });
  mkdirSync(path.join(hermes, 'profiles', 'coco', 'logs'), { recursive: true });
  mkdirSync(path.join(openclaw, 'logs'), { recursive: true });
  writeFileSync(
    path.join(hermes, 'profiles', 'coco', 'logs', 'jev-prune.jsonl'),
    `${JSON.stringify({ reason: 'judged', before: 1000, after: 200, dropped_lines: 8 })}\n`,
  );
  writeFileSync(
    path.join(openclaw, 'logs', 'jev-gate.jsonl'),
    [
      { at: '2026-01-01T00:00:00Z', outcome: 'too-short' },
      { at: '2026-01-01T00:01:00Z', outcome: 'cheap', model: 'cheap/model' },
      { at: '2026-01-01T00:02:00Z', outcome: 'status-quo' },
    ].map(JSON.stringify).join('\n') + '\n',
  );

  const stdout = execFileSync(process.execPath, [SCRIPT, '--json', 'coco'], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: hermes, OPENCLAW_HOME: openclaw },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.hermes.summary.chars_saved, 800);
  assert.equal(report.hermes.summary.estimated_tokens_saved, 200);
  assert.equal(report.openclaw.summary.decisions, 3);
  assert.equal(report.openclaw.summary.triage_calls, 2);
  assert.equal(report.openclaw.summary.downgrades, 1);
  assert.equal(report.openclaw.summary.downgrade_rate, 0.5);
  assert.equal(report.openclaw.summary.net_cost_savings, null);
  assert.equal('summary' in report, false, 'different mechanisms must not be merged into a synthetic total');
});
