import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pruneOutput, THRESHOLD_CHARS } from '../plugin/hooks/prune.js';
import { makeJudge, DEFAULT_CONFIG } from '../plugin/lib/judge.js';

// ponytail: one live test, skipped without a key. The stubbed tests prove the
// wiring; only this one proves the provider id and request shape are real.
// It is the check that would have caught model "typesafe/jev-1.13.0" (404).
const hasKey = existsSync(DEFAULT_CONFIG.apiKeyFile);

test('live: real Jev call actually prunes, keeps the signal line verbatim', { skip: !hasKey && 'no api key' }, async () => {
  const SIGNAL = 'ERROR: config.yaml not found at /etc/app/config.yaml';
  const noise = Array.from({ length: 400 }, (_, i) => `debug heartbeat tick ${i} ok ok ok ok ok ok ok ok`);
  const output = [...noise.slice(0, 200), SIGNAL, ...noise.slice(200)].join('\n');
  assert.ok(output.length > THRESHOLD_CHARS);

  const r = await pruneOutput({
    output,
    userRequest: 'Find why the app cannot load its config file.',
    judge: makeJudge(DEFAULT_CONFIG),
  });

  // The whole point of the component: it must actually shrink something.
  assert.ok(r.kept.length < output.length, `expected pruning, got ${r.kept.length}/${output.length}`);
  // And it must not have silently failed open on a bad model id or shape.
  assert.ok(r.droppedLines > 0, 'no lines dropped — provider likely failed open');
  // Kept text stays verbatim, never rewritten.
  for (const line of r.kept.split('\n')) {
    assert.ok(
      line.startsWith('[jev-prune:') || output.includes(line),
      `kept line not verbatim: ${line.slice(0, 60)}`,
    );
  }
});
