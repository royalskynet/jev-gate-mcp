import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnDecision, tierToModel, triageEnabled, tierModels, TIER_MODELS, DEFAULT_TIER_MODELS,
} from '../../agent-glue/claude/spawn-hook.mjs';

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

// The hook now ships a tier ladder and is on by situation, so the thing worth
// pinning is the escape hatch — and that it still never changes a model when it
// is off. (No transport is injected here on purpose: `=0` must short-circuit
// before any provider call.)
test('spawn hook: JEV_TRIAGE_ENABLED=0 disables it — never changes the subagent model', async () => {
  const prev = process.env.JEV_TRIAGE_ENABLED;
  process.env.JEV_TRIAGE_ENABLED = '0';
  try {
    const d = await spawnDecision({ prompt: 'do a big risky redesign' });
    assert.equal(d.change, false);
    assert.equal(d.model, undefined);
    assert.equal(d.reason, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.JEV_TRIAGE_ENABLED;
    else process.env.JEV_TRIAGE_ENABLED = prev;
  }
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

test('skill select: a catalog pick is advisory and never changes the model', async () => {
  // With a catalog answered as a skill, skills surfaces but the model (tier)
  // decision is unaffected.
  const d = await spawnDecision(
    { prompt: 'debug the failing test', contextChars: 1000, skills: ['debug', 'review'] },
    {
      forceEnabled: true,
      transport: {
        async evaluate() {
          return {
            answers: {
              difficulty: { type: 'score', score: 0.5, probabilities: { 0: 0.3, 1: 0.55, 2: 0.15, 3: 0 }, confidence: 0.92 },
              kind: { type: 'choice', choice: 'coding', confidence: 0.9 },
              costly_mistake: { type: 'noul', noul: 0.1 },
              skill: { type: 'choice', choice: 'debug', confidence: 0.9 },
            },
            latency_ms: 5,
          };
        },
      },
      modelMap: { cheap: 'haiku', medium: 'sonnet', hard: 'opus' },
    },
  );
  assert.equal(d.change, true, 'model choice still driven by triage tier');
  assert.equal(d.model, 'haiku');
  assert.deepEqual(d.skills, ['debug'], 'advisory skill surfaces on the decision');
});

test('skill select: no catalog -> zero skills, triage stays three questions', async () => {
  const calls = [];
  const d = await spawnDecision(
    { prompt: 'quick tweak', contextChars: 1000 },
    {
      forceEnabled: true,
      transport: {
        calls,
        async evaluate(input) {
          calls.push(input);
          return {
            answers: {
              difficulty: { type: 'score', score: 0.5, probabilities: { 0: 0.3, 1: 0.55, 2: 0.15, 3: 0 }, confidence: 0.92 },
              kind: { type: 'choice', choice: 'coding', confidence: 0.9 },
              costly_mistake: { type: 'noul', noul: 0.1 },
            },
            latency_ms: 5,
          };
        },
      },
      modelMap: { cheap: 'haiku' },
    },
  );
  assert.equal(d.change, true);
  assert.deepEqual(d.skills, []);
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].questions).length, 3, 'no catalog -> exactly three questions');
});

// Activation by situation, not by a flag nobody remembers: with no tier model
// configured the hook could not change anything whatever Jev answered, so it
// stays off; configure one and it turns itself on. `=0` always wins.
test('spawn-hook: auto-enables only when a tier model is configured', () => {
  assert.equal(triageEnabled({}, { cheap: undefined, medium: undefined, hard: undefined }), false);
  assert.equal(triageEnabled({}, { cheap: undefined, medium: undefined, hard: 'opus' }), true);
  assert.equal(triageEnabled({ JEV_TRIAGE_ENABLED: '0' }, { hard: 'opus' }), false, 'explicit off wins');
  assert.equal(triageEnabled({ JEV_TRIAGE_ENABLED: '1' }, {}), true, 'explicit on needs no model map');
});

// The layer used to ship with an empty map, so the auto rule above resolved to
// "off" on every machine and nothing was ever decided. A ladder ships now.
test('spawn-hook: the tier ladder ships, so the hook is on out of the box', () => {
  assert.deepEqual(tierModels({}), { cheap: 'haiku', medium: 'sonnet', hard: 'opus' });
  assert.deepEqual(TIER_MODELS, DEFAULT_TIER_MODELS, 'no env set -> the shipped ladder');
  assert.equal(triageEnabled({}, tierModels({})), true);
  assert.equal(
    tierModels({ JEV_TRIAGE_MODEL_HARD: 'opus-4-1' }).hard, 'opus-4-1', 'one tier overridden',
  );
  const allOff = tierModels({
    JEV_TRIAGE_MODEL_CHEAP: 'off', JEV_TRIAGE_MODEL_MEDIUM: 'off', JEV_TRIAGE_MODEL_HARD: 'off',
  });
  assert.deepEqual(allOff, { cheap: undefined, medium: undefined, hard: undefined });
  assert.equal(triageEnabled({}, allOff), false, 'all tiers off turns the hook back off');
});

// Regression: the hook used to call triage with deps={}, so the core fell back
// to `defaultNoTransport` and fail-opened on every live turn — an enabled hook
// was indistinguishable from a disabled one. An injected transport must still
// win over the live one, and the hook must pass *something*.
test('spawn-hook: an injected transport is the one triage uses', async () => {
  let asked = 0;
  const transport = {
    async evaluate() {
      asked++;
      return {
        answers: {
          difficulty: { type: 'score', score: 0.1, probabilities: { 0: 0.95, 1: 0.05, 2: 0, 3: 0 }, confidence: 0.95 },
          kind: { choice: 'coding', probabilities: { coding: 0.9 } },
          costly_mistake: { type: 'noul', noul: 0.02 },
        },
        coverage: 'complete',
      };
    },
  };
  const d = await spawnDecision(
    { prompt: 'rename a local variable' },
    { forceEnabled: true, transport, modelMap: { cheap: 'haiku' } },
  );
  assert.equal(asked, 1, 'the injected transport was actually called');
  assert.equal(d.change, true);
  assert.equal(d.model, 'haiku');
});
