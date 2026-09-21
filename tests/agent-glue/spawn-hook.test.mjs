import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnDecision, pickSkills, tierToModel } from '../../agent-glue/claude/spawn-hook.mjs';

// A fake triage-shaped transport that returns an easy, safe, confident verdict.
function easyTransport() {
  return {
    async evaluate() {
      return {
        answers: {
          difficulty: { type: 'score', score: 0.5, probabilities: { 0: 0.3, 1: 0.55, 2: 0.15, 3: 0 }, confidence: 0.92 },
          kind: { type: 'choice', choice: 'coding', probabilities: { coding: 0.9 }, confidence: 0.9 },
          costly_mistake: { type: 'noul', noul: 0.1 },
        },
        model: 'fake',
        latency_ms: 5,
      };
    },
  };
}

test('spawn hook: DISABLED by default — never changes the subagent model', async () => {
  const d = await spawnDecision({ prompt: 'do a big risky redesign' });
  assert.equal(d.change, false);
  assert.equal(d.model, undefined);
  assert.equal(d.reason, 'disabled');
});

test('spawn hook: risky/large-context/low-confidence never downgrades the model', async () => {
  // risky (danger word) with an easy verdict must still land on a non-cheap tier,
  // so even a wired cheap model must not be applied.
  const d = await spawnDecision(
    { prompt: 'deploy the migration to production and delete the old table' },
    { forceEnabled: true, transport: easyTransport(), modelMap: { cheap: 'haiku', medium: 'sonnet', hard: 'opus' } },
  );
  assert.equal(d.change, true, 'dangerous + non-cheap tier may still pick a model');
  assert.notEqual(d.model, 'haiku', 'risky task must never land on the cheapest model');
});

test('spawn hook: enabled but with no live transport fail-opens to unchanged', async () => {
  const d = await spawnDecision({ prompt: 'something', contextChars: 100 }, { forceEnabled: true });
  assert.equal(d.change, false);
  assert.equal(d.model, undefined);
  assert.equal(d.reason, 'status-quo');
});

test('spawn hook: fork is never touched (inherits model)', async () => {
  const d = await spawnDecision(
    { prompt: 'x', fork: true },
    { forceEnabled: true, transport: easyTransport(), modelMap: { cheap: 'haiku', medium: 'sonnet', hard: 'opus' } },
  );
  assert.equal(d.change, false);
  assert.equal(d.reason, 'fork');
});

test('spawn hook: tier with no model mapping keeps engine default', async () => {
  const d = await spawnDecision(
    { prompt: 'quick tweak', contextChars: 1000 },
    { forceEnabled: true, transport: easyTransport(), modelMap: {} },
  );
  assert.equal(d.change, false);
  assert.equal(d.reason, 'no-model-map');
});

test('spawn hook: wired cheap model on a safe easy task changes the model', async () => {
  const d = await spawnDecision(
    { prompt: 'rename a local variable', contextChars: 1000 },
    { forceEnabled: true, transport: easyTransport(), modelMap: { cheap: 'haiku', medium: 'sonnet', hard: 'opus' } },
  );
  assert.equal(d.change, true);
  assert.equal(d.model, 'haiku');
});

test('skill select: most prompts load zero skills; only a matching catalog entry is kept', () => {
  assert.deepEqual(pickSkills('just fix the typo'), []);
  assert.deepEqual(pickSkills('debug the failing test', ['debug', 'review']), ['debug']);
  assert.deepEqual(pickSkills('x', []), []);
});
