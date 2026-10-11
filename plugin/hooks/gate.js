import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { makeStopGate, makeNextGate, logAsync } from '../lib/gate.js';
import { readEvidence } from '../lib/transcript.js';
import { stateEvidence } from '../lib/state.js';
import { unsupportedIds, idBlock } from '../lib/idcheck.js';
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
 *
 * `c` lets another host reuse the gate with its own log, caller and shadow
 * switch (~/bots/mythos/bin/stop-gate.mjs) without forking this logic.
 */
export async function handleStop(payload, c = cfg) {
  // fi-reminder.sh's guard: one block per turn-chain, never a loop.
  if (payload?.stop_hook_active) return undefined;
  const claim = String(payload?.last_assistant_message ?? '').slice(0, 4000);
  // Nothing claimed, nothing to check — and no reason to ask git about it.
  if (!claim.trim()) return undefined;
  const toolOutput = payload?.tool_response?.output ?? readEvidence(payload?.transcript_path);
  // The store, not the agent's account of it. Shadow by default: computed and
  // counted, withheld from the judge, because the last time this gate changed
  // where evidence comes from the new source turned out to be empty, and the
  // shadow period was the only reason that was a dull ledger instead of a
  // headless machine blocking every turn (fixindex 0325 §12).
  let state = { text: '', stats: null };
  try {
    state = stateEvidence(payload?.transcript_path);
  } catch {
    // Fail open, like every other guard in this hook.
  }
  if (state.stats?.paths) {
    // Stats only, never the paths themselves: observing a source must not turn
    // the ledger into a second copy of the content (AGENTS.md).
    await logAsync(c, {
      event: c.stateShadow === false ? 'state_evidence' : 'state_observe',
      gate: 'stop',
      ...state.stats,
    });
  }
  const evidence = composeEvidence(toolOutput, state.text, c.stateShadow !== false);
  // A turn that ran no tools has nothing to verify against; let it end.
  if (!evidence.trim()) return undefined;
  // Deterministic first: an invented id reads as `not_addressed` to the judge,
  // which is advisory, so the clearest case would otherwise pass. Widened to
  // the whole transcript because quoting a hash from an earlier round is honest.
  try {
    const ids = unsupportedIds(claim, readEvidence(payload?.transcript_path, 400000, { allRounds: true }) || evidence);
    if (ids.length) {
      // Every hit is recorded whether or not it acts. Staged rollouts stop
      // checking the moment the rollout ends; a permanent ledger is what makes
      // the false-positive rate knowable next month instead of during a window.
      // The denominator is already there: the judge below logs every Stop.
      // idcheckShadow (issue #12) kept this observe-only while the rate was
      // measured: 4/5 shadow hits were evidence-side misses, now fixed; replay of
      // 666 Stops (278 with ids) flags only the one real fabrication. Default
      // off; set true to go back to observe-only. c.shadow still gates both.
      await logAsync(c, {
        event: c.shadow || c.idcheckShadow ? 'idcheck_observe' : 'idcheck_block',
        gate: 'stop',
        ids,
      });
      if (!c.shadow && !c.idcheckShadow) return idBlock(ids);
    }
  } catch {
    // Fail open, like every other guard in this hook.
  }
  const result = await makeStopGate(c)({ claim, evidence });
  if (result.shadow) return undefined;
  return blockDecision(result.decided?.claims?.[0]);
}

/**
 * What the judge is shown, kept separate so the composition is testable without
 * git or the network.
 *
 * State goes first: it is the shorter and harder witness, and a window that
 * overflows should keep it. While `shadow` is on the state block is dropped
 * here, so turning the source on is one config flag and no code path change.
 */
export function composeEvidence(toolOutput, stateText, shadow = true) {
  const tools = String(toolOutput ?? '');
  if (shadow || !stateText) return tools;
  return tools.trim() ? `${stateText}\n\n=== this round's tool output ===\n${tools}` : stateText;
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
