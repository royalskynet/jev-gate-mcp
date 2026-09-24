import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { makeStopGate, makeNextGate } from '../lib/gate.js';
import { readEvidence } from '../lib/transcript.js';
import { DEFAULT_CONFIG } from '../lib/judge.js';

const cfg = DEFAULT_CONFIG;

/**
 * Stop hook. Judges the completion claim against the tool output of this
 * round. Blocks only when Jev is confident enough for its own `auto` gate;
 * anything softer is recorded and allowed through.
 *
 * Fail-open in three places, all of them load-bearing on a headless machine:
 * a second pass (`stop_hook_active`) never blocks, an empty claim or empty
 * evidence never blocks, and an error inside the judgment never blocks.
 */
export async function handleStop(payload) {
  // fi-reminder.sh's guard: one block per turn-chain, never a loop.
  if (payload?.stop_hook_active) return undefined;
  const claim = String(payload?.last_assistant_message ?? '').slice(0, 4000);
  const evidence = payload?.tool_response?.output ?? readEvidence(payload?.transcript_path);
  // A turn that ran no tools has nothing to verify against; let it end.
  if (!claim.trim() || !evidence.trim()) return undefined;
  const result = await makeStopGate(cfg)({ claim, evidence });
  if (result.shadow) return undefined;
  return blockDecision(result.decided?.claims?.[0]);
}

/**
 * The decision itself, kept separate so it is testable without the network.
 * Its predecessor read `String(result.decided).includes('not_addressed')` on
 * an object — `'[object Object]'` never matches, so the gate could not have
 * blocked anything even with shadow off.
 *
 * `gate: 'auto'` is jevwire's own word for "confidence cleared the auto
 * threshold"; below that the verdict is recorded and the turn ends.
 *
 * Only `contradicted` blocks. `not_addressed` speaks up and lets the turn end,
 * because the first time this gate blocked for real it blocked a report whose
 * own words were "here is the part I have not proven" — the honesty the house
 * rules demand reads to a verifier as an unsupported claim. Blocking that
 * punishes Fail Loud and teaches the opposite. A turn whose evidence actively
 * contradicts it is a different animal and still stops.
 */
export function blockDecision(judged) {
  if (judged?.gate !== 'auto') return undefined;
  if (judged.verdict === 'contradicted') {
    return {
      decision: 'block',
      reason: "this round's tool output contradicts the claim (jev-gate: contradicted). Re-read the output and correct the claim.",
    };
  }
  if (judged.verdict === 'not_addressed') {
    return {
      continue: true,
      systemMessage: "(jev-gate) this round's tool output does not support the completion claim. If something is still unproven, say so plainly.",
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
