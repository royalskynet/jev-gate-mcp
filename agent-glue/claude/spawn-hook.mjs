#!/usr/bin/env node
/**
 * Claude `agent.spawn` hook — pick the subagent model from a Jev triage.
 *
 * Opt-in and fail-open by default. `enabled:false` (env `JEV_TRIAGE_ENABLED=1`
 * opts in); a disabled or broken hook never changes the subagent's model.
 * Risky, low-confidence and large-context cases never downgrade (those floors
 * live in `src/triage.js`). With no injected transport the triage fail-opens
 * to "retain status quo", so the default wiring here is a no-op — the value a
 * host realizes only when it enables the hook AND injects a live transport.
 *
 * The hook also runs a skill-select pass: it can answer "no skill needed", so
 * most turns load zero skills (see `pickSkills`). The returned skill list is
 * advisory only.
 */
import { triage, DEFAULT_TRIAGE } from '../src/triage.js';

export const ENABLED = process.env.JEV_TRIAGE_ENABLED === '1';

// Optional per-tier model override, e.g. JEV_TRIAGE_MODEL_HARD=opus. Undefined
// tiers keep the engine default (the parent's own model via `inherit`).
export const TIER_MODELS = {
  cheap: process.env.JEV_TRIAGE_MODEL_CHEAP || undefined,
  medium: process.env.JEV_TRIAGE_MODEL_MEDIUM || undefined,
  hard: process.env.JEV_TRIAGE_MODEL_HARD || undefined,
};

/** Map a triage tier onto a model alias; undefined tiers stay inherit/default. */
export function tierToModel(tier) {
  return tier && TIER_MODELS[tier] ? TIER_MODELS[tier] : undefined;
}

/**
 * Skill-select: rank a catalog for one prompt. Deterministic first pass keeps
 * cheap (never calls Jev when nothing needs a skill); returns `[]` for "no
 * skill needed", which is the common case.
 *
 * ponytail: the deterministic pass is a keyword heuristic — the upgrade path
 * is a real Jev Choice over the catalog when the deterministic pass flags a
 * candidate conflict.
 */
export function pickSkills(prompt = '', catalog = []) {
  if (!prompt || !catalog || catalog.length === 0) return [];
  return catalog.filter((s) => {
    const name = String(s?.name ?? s ?? '').toLowerCase();
    return /skill|agent|debug|review|research|search|route|verify/i.test(name) && prompt.toLowerCase().includes(name.replace(/[^a-z]/g, '') || '');
  }).slice(0, 3);
}

/**
 * Decide what the spawn hook should do. Pure-ish (reads module env) and
 * transport-injected for tests. `forceEnabled` lets tests exercise the enabled
 * path without a global env.
 */
export async function spawnDecision(input = {}, deps = {}) {
  const enabled = deps.forceEnabled === true || ENABLED;
  if (!enabled) {
    return { change: false, model: undefined, skills: [], decision: null, reason: 'disabled' };
  }
  // fork inherits the parent's context/model by definition — nothing to decide.
  if (input.fork) {
    return { change: false, model: undefined, skills: [], decision: null, reason: 'fork' };
  }
  const decision = await triage(
    {
      text: input.prompt ?? '',
      contextChars: input.contextChars ?? 0,
      pinned: input.fork, // fork -> pinned (inherits) -> pre-gated in triage too
      has_images: input.has_images ?? false,
    },
    deps,
  );
  if (decision.unchanged || decision.failOpen) {
    return { change: false, model: undefined, skills: pickSkills(input.prompt), decision, reason: 'status-quo' };
  }
  const map = deps.modelMap ?? TIER_MODELS;
  const model = map[decision.tier];
  if (!model) {
    return { change: false, model: undefined, skills: pickSkills(input.prompt), decision, reason: 'no-model-map' };
  }
  return { change: true, model, skills: pickSkills(input.prompt), decision, reason: 'triage' };
}

export const register = (on) => {
  on('agent.spawn', async ($, input, next) => {
    const d = await spawnDecision(input || {}, {});
    if (!d.change) return next(input); // default: leave the subagent's model to the engine
    $.ui?.log?.(`jev-triage: subagent on ${d.model} (tier=${d.decision?.tier})`);
    return next({ ...(input || {}), model: d.model });
  });
};
