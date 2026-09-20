import { appendFileSync } from 'node:fs';
import { promises as fsP } from 'node:fs';
import { dirname } from 'node:path';
import { runVerify, runNextStep } from 'jevwire';
import { getModel, DEFAULT_CONFIG } from './judge.js';

/**
 * jev-gate: Stop completion check + PreToolUse ghost-loop gate.
 *
 * Uses jevwire's `runVerify` (Stop) and `runNextStep` (PreToolUse) directly —
 * no policy engine rewritten. Every judgment is fail-open: if Jev is
 * unavailable or the schema is wrong, the result is neutral (no block).
 *
 * Shadow mode (`config.shadow === true`, the default): these functions only
 * RECORD what they would decide; they never emit a block or an override, so
 * the existing hooks (creds-egress-guard, guard, fi-reminder) are untouched.
 */

function logLine(cfg, event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try {
    appendFileSync(cfg.gateLog, line + '\n', 'utf8');
  } catch { /* logging never blocks */ }
}

/** Record-only shadow wrapper around a judgment that returns a decision value. */
export function shadow(decideFn, cfg) {
  return async function (payload) {
    let decided = null;
    let reason = null;
    try {
      decided = await decideFn(payload);
    } catch (e) {
      reason = e.message;
    }
    // Always write the observation; never act in shadow mode.
    if (cfg.shadow) {
      await logAsync(cfg, { event: 'gate_observe', decided, reason });
      return { shadow: true, decided };
    }
    return { shadow: false, decided, reason };
  };
}

async function logAsync(cfg, event) {
  try {
    await fsP.mkdir(dirname(cfg.gateLog), { recursive: true });
  } catch { /* ignore */ }
  logLine(cfg, event);
}

/**
 * Stop completion check. Evidence is the current round's diff / test output;
 * a completion claim with no supporting evidence is treated as unsupported.
 * Uses jevwire runVerify against one claim. Fail-open -> neutral.
 */
export function makeStopGate(cfg = DEFAULT_CONFIG) {
  const stopGate = shadow(async ({ claim, evidence }) => {
    const model = getModel(cfg);
    if (!model) throw new Error('no Jev model configured');
    const cfgOut = { thresholds: { auto: 0.85, review: 0.6 } };
    const out = await runVerify(model, { claims: [claim], evidence }, cfgOut);
    return out;
  }, cfg);
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
    const cfgOut = { thresholds: { auto: 0.85, review: 0.6 } };
    const out = await runNextStep(model, { goal, last_step, result, attempts }, cfgOut);
    return out;
  }, cfg);
  return nextGate;
}
