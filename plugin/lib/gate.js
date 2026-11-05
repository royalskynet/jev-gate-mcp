import { appendFileSync } from 'node:fs';
import { promises as fsP } from 'node:fs';
import { dirname } from 'node:path';
import { runNextStep } from 'jevwire';
import { getModel, DEFAULT_CONFIG } from './judge.js';
import { judgeClaims, runConfig } from './claimcheck.js';

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

// Claim judging lives in the host-neutral component (./claimcheck.js); the
// Stop gate keeps only its Claude Code wiring (shadow ledger, block decision).
export { runConfig, RESULT_LEVEL, withResultLevel } from './claimcheck.js';

export function makeStopGate(cfg = DEFAULT_CONFIG) {
  const stopGate = shadow(async ({ claim, claims, evidence }) =>
    judgeClaims(claims?.length ? claims : [claim], evidence, cfg), cfg, 'stop');
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
