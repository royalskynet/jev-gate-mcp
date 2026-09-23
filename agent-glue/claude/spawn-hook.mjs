#!/usr/bin/env node
/**
 * Claude `agent.spawn` hook — pick the subagent model from a Jev triage.
 *
 * On by situation, fail-open always. It activates because a tier ladder ships
 * (`DEFAULT_TIER_MODELS`); `JEV_TRIAGE_ENABLED=0` is the escape hatch. A
 * disabled or broken hook never changes the subagent's model.
 * Risky, low-confidence and large-context cases never downgrade (those floors
 * live in `src/triage.js`). With no injected transport the triage fail-opens
 * to "retain status quo", so the default wiring here is a no-op — the value a
 * host realizes only when it enables the hook AND injects a live transport.
 *
 * The hook also folds skill selection into the same single triage request as a
 * 4th `skill` Choice question when a catalog is supplied (see `triage`): it can
 * answer "no skill needed", so most turns load zero skills. The returned skill
 * list is advisory only and never affects model choice.
 */
import { triage, DEFAULT_TRIAGE } from '../src/triage.js';
import { liveTransport } from '../src/live.js';
import { ENV, fillEnv } from './env.mjs';

// The shipped tier ladder, cheapest first. Same mapping the community
// model-routing hooks converged on — haiku for mechanical work, sonnet for
// ordinary implementation, opus for architecture and deep multi-file analysis —
// and the same one this repo's tests have always used.
//
// These are defaults, not policy: any tier can be overridden, and the floors in
// `src/triage.js` still forbid a downgrade on a risky, low-confidence or
// large-context spawn. Shipping them is what makes the hook decide by default;
// with an empty map it could not change the model whatever Jev answered, so it
// stayed off and the whole layer was dead weight.
export const DEFAULT_TIER_MODELS = { cheap: 'haiku', medium: 'sonnet', hard: 'opus' };

/**
 * Per-tier model override, e.g. `JEV_TRIAGE_MODEL_HARD=opus`. The literal
 * `off` drops that tier back to the engine default (the parent's own model via
 * `inherit`); all three `off` turns the hook off, by the rule below.
 */
export function tierModels(env = ENV, defaults = DEFAULT_TIER_MODELS) {
  const pick = (v, d) => (v === 'off' ? undefined : (v || d));
  return {
    cheap: pick(env.JEV_TRIAGE_MODEL_CHEAP, defaults.cheap),
    medium: pick(env.JEV_TRIAGE_MODEL_MEDIUM, defaults.medium),
    hard: pick(env.JEV_TRIAGE_MODEL_HARD, defaults.hard),
  };
}

export let TIER_MODELS = tierModels();

/**
 * Activation by situation, not by a flag the user has to remember.
 *
 *   JEV_TRIAGE_ENABLED=0  -> off, always (the escape hatch)
 *   JEV_TRIAGE_ENABLED=1  -> on, always (even with no model map: the decision
 *                            is then observable in the ledger but changes nothing)
 *   unset                 -> ON exactly when a tier model is configured, which
 *                            the shipped `DEFAULT_TIER_MODELS` makes true out
 *                            of the box.
 *
 * The auto rule is the whole point: a hook with nowhere to move the model could
 * not change anything whatever Jev answered, so spending a request would buy
 * nothing. Set every tier to `off` and it turns itself back off — no second
 * switch to find.
 */
export function triageEnabled(env = ENV, models = TIER_MODELS) {
  const flag = env.JEV_TRIAGE_ENABLED;
  if (flag === '0') return false;
  if (flag === '1') return true;
  return Object.values(models).some(Boolean);
}

export let ENABLED = triageEnabled();

/**
 * Recompute the tier map and the switch from `ENV`. Called once at load (for
 * Node) and again after `hydrate($)` in the hook, where `ENV` starts empty
 * because a hooks module has no `process`.
 */
export function refreshConfig() {
  TIER_MODELS = tierModels();
  ENABLED = triageEnabled();
}

let hydrated;

/** See jev.js: the names are literals so validate lists what this module reads. */
function hydrate($) {
  hydrated ??= (async () => {
    // `$` is the engine's here and a stub in the unit tests, which have no
    // `env` noun — and a guard cannot ask, since reading `$.env` as a value is
    // exactly what the validator refuses. Under Node, ENV already holds
    // process.env, so there is nothing to fall back to.
    try {
      fillEnv({
        JEV_TELEMETRY: await $.env.get('JEV_TELEMETRY'),
        JEV_TRIAGE_ENABLED: await $.env.get('JEV_TRIAGE_ENABLED'),
        JEV_TRIAGE_MODEL_CHEAP: await $.env.get('JEV_TRIAGE_MODEL_CHEAP'),
        JEV_TRIAGE_MODEL_MEDIUM: await $.env.get('JEV_TRIAGE_MODEL_MEDIUM'),
        JEV_TRIAGE_MODEL_HARD: await $.env.get('JEV_TRIAGE_MODEL_HARD'),
      });
    } catch {
      /* no `$.env` (Node): ENV already came from process.env */
    }
    refreshConfig();
  })();
  return hydrated;
}

/** Map a triage tier onto a model alias; undefined tiers stay inherit/default. */
export function tierToModel(tier) {
  return tier && TIER_MODELS[tier] ? TIER_MODELS[tier] : undefined;
}

/**
 * Decide what the spawn hook should do. Pure-ish (reads module env) and
 * transport-injected for tests. `forceEnabled` lets tests exercise the enabled
 * path without a global env. Skill selection rides on the same single triage
 * request (no second Jev call); a catalog comes from `input.skills ?? deps.skillCatalog`.
 */
export async function spawnDecision(input = {}, deps = {}) {
  const enabled = deps.forceEnabled === true || triageEnabled();
  if (!enabled) {
    return { change: false, model: undefined, skills: [], decision: null, reason: 'disabled' };
  }
  // fork inherits the parent's context/model by definition — nothing to decide.
  if (input.fork) {
    return { change: false, model: undefined, skills: [], decision: null, reason: 'fork' };
  }
  const catalog = input.skills ?? deps.skillCatalog ?? [];
  // A missing transport is the silent failure this hook shipped with: triage
  // fail-opens to status quo and an enabled hook looks identical to a disabled
  // one. Tests inject their own; production gets the in-process gateway (null
  // when there is no credential, which still fail-opens — but on purpose).
  const transport = deps.transport ?? (await liveTransport()) ?? undefined;
  const decision = await triage(
    {
      text: input.prompt ?? '',
      contextChars: input.contextChars ?? 0,
      pinned: input.fork, // fork -> pinned (inherits) -> pre-gated in triage too
      has_images: input.has_images ?? false,
      skills: catalog,
    },
    { ...deps, transport },
  );
  if (decision.unchanged || decision.failOpen) {
    return { change: false, model: undefined, skills: decision.skills, decision, reason: 'status-quo' };
  }
  const map = deps.modelMap ?? TIER_MODELS;
  const model = map[decision.tier];
  if (!model) {
    return { change: false, model: undefined, skills: decision.skills, decision, reason: 'no-model-map' };
  }
  return { change: true, model, skills: decision.skills, decision, reason: 'triage' };
}

export const register = (on) => {
  on('agent.spawn', async ($, input, next) => {
    await hydrate($);
    const d = await spawnDecision(input || {}, {});
    if (!d.change) return next(input); // default: leave the subagent's model to the engine
    $.ui.log(`jev-triage: subagent on ${d.model} (tier=${d.decision?.tier})`);
    return next({ ...(input || {}), model: d.model });
  });
};
