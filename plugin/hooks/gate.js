import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { makeStopGate, makeNextGate } from '../lib/gate.js';
import { DEFAULT_CONFIG } from '../lib/judge.js';

const cfg = DEFAULT_CONFIG;

/**
 * Stop hook. In shadow mode it only records whether the completion claim has
 * evidence; it never emits a block, so it coexists with fi-reminder.sh's
 * one-shot block (a later block would replace the reminder, which we must not
 * do until shadow mode is lifted).
 */
export async function handleStop(payload) {
  const claim = payload?.last_assistant_message ?? '';
  const result = await makeStopGate(cfg)({
    claim,
    evidence: payload?.tool_response?.output ?? '',
  });
  // Shadow: never block. Non-shadow would emit {decision:'block'} here.
  if (!result.shadow && result.decided && String(result.decided).includes('not_addressed')) {
    return {
      decision: 'block',
      reason: 'completion claimed without matching evidence; re-verify before declaring done. (jev-gate, to Claude)',
    };
  }
  return undefined;
}

/**
 * PreToolUse ghost-loop gate. Shadow mode: record only; never emit a
 * permission decision, so a creds-egress-guard / guard deny is never
 * overridden.
 */
export async function handlePreToolUse(payload) {
  const result = await makeNextGate(cfg)({
    goal: payload?.prompt ?? '',
    last_step: payload?.tool_name ?? '',
    result: payload?.error ?? '',
    attempts: (payload?.tool_input?.attempts ?? 1),
  });
  if (!result.shadow && result.decided && result.decided.next === 'ask_user') {
    // Would surface a need to involve the user; emit only as an advisory,
    // never as allow/allowWithLog, so an existing deny stands.
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: '(jev-gate) repeated same-step failure — consider asking the user.',
      },
    };
  }
  return undefined;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  let out;
  if (payload.hook_event_name === 'Stop') {
    out = await handleStop(payload);
  } else if (payload.hook_event_name === 'PreToolUse') {
    out = await handlePreToolUse(payload);
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) main().catch(() => process.exit(1));
