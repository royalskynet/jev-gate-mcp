import { appendFileSync } from 'node:fs';
import { promises as fsP } from 'node:fs';
import { dirname } from 'node:path';
import { runVerify, runNextStep } from 'jevwire';
import { getModel, getStopModel, DEFAULT_CONFIG } from './judge.js';

/**
 * jev-gate: Stop completion check + PreToolUse ghost-loop gate.
 *
 * Uses jevwire's `runVerify` (Stop) and `runNextStep` (PreToolUse) directly —
 * no policy engine rewritten. Every judgment is fail-open: if Jev is
 * unavailable or the schema is wrong, the result is neutral (no block).
 *
 * Shadow mode (`config.shadow === true`): these functions only RECORD what
 * they would decide; they never emit a block or an override. With shadow off
 * the Stop gate may block; the PreToolUse gate still only adds context, so a
 * creds-egress-guard / guard deny can never be overridden either way.
 */

function logLine(cfg, event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try {
    // 600: claims are logged verbatim (secret-shaped text, emails seen 10-13).
    appendFileSync(cfg.gateLog, line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch { /* logging never blocks */ }
}

/**
 * Record-only shadow wrapper around a judgment that returns a decision value.
 * `label` says which gate wrote the line; the two verdict shapes are otherwise
 * told apart only by guessing at their fields.
 */
export function shadow(decideFn, cfg, label = 'gate') {
  return async function (payload) {
    let decided = null;
    let reason = null;
    try {
      decided = await decideFn(payload);
    } catch (e) {
      reason = e.message;
    }
    // The ledger is written either way: once the gate can act, what it acted
    // on is the only record of why.
    await logAsync(cfg, { event: cfg.shadow ? 'gate_observe' : 'gate_decide', gate: label, decided, reason });
    return { shadow: !!cfg.shadow, decided, reason };
  };
}

/**
 * Exported because the deterministic identifier check decides without calling
 * `shadow()`, so it would otherwise act without leaving a ledger line — the one
 * record of what the gate stopped and whether it was right to.
 */
export async function logAsync(cfg, event) {
  try {
    await fsP.mkdir(dirname(cfg.gateLog), { recursive: true });
  } catch { /* ignore */ }
  logLine(cfg, event);
}

/**
 * The config handed to jevwire's runners.
 *
 * `maxConcurrency` is NOT optional. jevwire's `mapWithConcurrency` computes
 * `Math.max(1, Math.min(Math.floor(limit), n))`, and `Math.floor(undefined)`
 * is NaN, so `Array.from({ length: NaN })` opens ZERO workers: every claim
 * comes back `not_addressed` with `usage: 0` and no request ever sent. That
 * reads like a judgment and is not one. Keep it a finite number.
 */
export function runConfig(cfg = DEFAULT_CONFIG) {
  return { thresholds: { auto: 0.85, review: 0.6 }, maxConcurrency: cfg.maxConcurrency ?? 2 };
}

/**
 * Stop completion check. Evidence is the current round's diff / test output;
 * a completion claim with no supporting evidence is treated as unsupported.
 * Uses jevwire runVerify against one claim. Fail-open -> neutral.
 */
/**
 * Outcome claims ("fixed", "works", "passes") are only as good as evidence of
 * the outcome. The jevwire rubric is literal, so "edited the file" can read as
 * entailing "fixed it". The qualifier rides on the claim itself: an outcome
 * claim backed only by an action comes back not_addressed, not supported.
 */
const OUTCOME = /修好|修復|修正了|生效|通過|可用|恢復|正常了|成功|搞定|\b(?:fixed|works|working|passes|passing|resolved|succeeded)\b/i;
export const RESULT_LEVEL = ' [result-level claim: supported only if the evidence shows the result itself (command output, a passing test line, a health-check response, an exit code). Evidence that a file was edited or a request was sent is not_addressed.]';
export function withResultLevel(claims) {
  return claims.map((c) => (OUTCOME.test(c) && !c.includes(RESULT_LEVEL) ? c + RESULT_LEVEL : c));
}

export function makeStopGate(cfg = DEFAULT_CONFIG) {
  const stopGate = shadow(async ({ claim, claims, evidence }) => {
    const model = getStopModel(cfg);
    if (!model) throw new Error('no Jev model configured');
    const cfgOut = runConfig(cfg);
    const out = await runVerify(model, { claims: withResultLevel(claims?.length ? claims : [claim]), evidence }, cfgOut);
    return out;
  }, cfg, 'stop');
  return stopGate;
}

/**
 * PreToolUse ghost-loop gate. Recurring same-fingerprint failures bubble to a
 * next_step suggestion via jevwire runNextStep. Fail-open -> neutral.
 */
export function makeNextGate(cfg = DEFAULT_CONFIG) {
  const nextGate = shadow(async ({ goal, last_step, result, attempts }) => {
    const model = getModel(cfg);
    if (!model) throw new Error('no Jev model configured');
    const cfgOut = runConfig(cfg);
    const out = await runNextStep(model, { goal, last_step, result, attempts }, cfgOut);
    return out;
  }, cfg, 'next');
  return nextGate;
}
