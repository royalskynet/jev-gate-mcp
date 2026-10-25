import { readFileSync, statSync, existsSync, unlinkSync, mkdirSync, writeFileSync, promises as fsP } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { makeStopGate, makeNextGate, logAsync, RESULT_LEVEL } from '../lib/gate.js';
import { readEvidence } from '../lib/transcript.js';
import { stateEvidence } from '../lib/state.js';
import { atomicClaims, decisive } from '../lib/claims.js';
import { DEFAULT_CONFIG } from '../lib/judge.js';

const cfg = DEFAULT_CONFIG;

/**
 * Shadow-period capture for a later old-vs-new evidence replay. Git state is
 * live: read back days later it describes today's tree, not the round's (42% of
 * 517 rounds read "nothing changed" in the 10-11 dry run), so it can only be
 * recorded at Stop time. The transcript is append-only, so its byte length here
 * is enough to rebuild the claim and the tool evidence exactly. Kept out of
 * gateLog: that ledger stays stats-only; this file holds paths and status codes,
 * never file content. Local only, never committed (AGENTS.md).
 * ponytail: unbounded append, ~74 rounds/day x ~1KB; rotate when the replay is done.
 */
export async function captureState(c, payload, state) {
  if (!c.stateCaptureLog || !state?.text) return;
  try {
    const tp = payload?.transcript_path;
    let transcriptBytes = null;
    try {
      if (tp) transcriptBytes = statSync(tp).size;
    } catch { /* replay can still use the latest round */ }
    const rec = {
      ts: new Date().toISOString(),
      session_id: payload?.session_id ?? null,
      transcript_path: tp ?? null,
      transcript_bytes: transcriptBytes,
      stats: state.stats,
      state: state.text,
    };
    await fsP.mkdir(dirname(c.stateCaptureLog), { recursive: true });
    await fsP.appendFile(c.stateCaptureLog, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  } catch {
    // Fail open: observing must never cost a turn.
  }
}

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
  // Loop guard, scoped to this gate. A bare `stop_hook_active` skip also
  // skipped every round another hook (fi-reminder.sh) had blocked — usually
  // the real final answer. With a session id, only the Stop right after this
  // gate's own intervention is skipped; without one, the old blanket rule.
  const mark = interventionMark(c, payload?.session_id);
  if (mark) {
    if (existsSync(mark)) {
      try { unlinkSync(mark); } catch { /* fail open */ }
      return undefined;
    }
  } else if (payload?.stop_hook_active) return undefined;
  const out = await judgeStop(payload, c);
  // 10-22: a block or an additionalContext at Stop both add a round the user
  // sees. Park the note instead; ~/.claude/hooks/deferred-notes.sh hands it to
  // the model on the next UserPromptSubmit. `deferStop: false` restores blocking.
  if (out && c.deferStop !== false && deferStop(out, payload?.session_id)) return undefined;
  if (out && mark) {
    try {
      mkdirSync(dirname(mark), { recursive: true });
      writeFileSync(mark, '');
    } catch { /* fail open: worst case one more judged round */ }
  }
  return out;
}

/**
 * Write a Stop verdict as a sidecar for the next turn instead of answering the
 * hook. True when stored; false (caller answers the hook as before) without a
 * session id or when the write fails.
 */
let deferSeq = 0;
export function deferStop(out, sessionId, dir = process.env.CLAUDE_DEFERRED_DIR) {
  const text = out?.reason ?? out?.hookSpecificOutput?.additionalContext;
  const id = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!text || !id) return false;
  const d = join(dir || join(homedir(), '.cache', 'claude-deferred'), id);
  try {
    mkdirSync(d, { recursive: true });
    // Two verdicts in one millisecond would share a Date.now() name; the counter keeps both.
    writeFileSync(join(d, `jev-${Date.now()}-${process.pid}-${deferSeq++}.txt`), `[jev-gate] ${text}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Per-session flag: "this gate spoke on the last Stop". */
function interventionMark(c, sessionId) {
  const id = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id || !c?.gateLog) return null;
  return join(dirname(c.gateLog), 'stop-rounds', id);
}

async function judgeStop(payload, c) {
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
    if (c.stateShadow !== false) await captureState(c, payload, state);
  }
  const evidence = composeEvidence(toolOutput, state.text, c.stateShadow !== false);
  // A turn that ran no tools has nothing to verify against; let it end.
  if (!evidence.trim()) return undefined;
  // Invented commit/issue ids are Genie done_gate's job (invented_ids); the
  // copy that lived here was removed 10-25 so one Stop is not blocked twice.
  // Atomic claims, not the whole reply: see lib/claims.js. A reply with no
  // completion sentence is not judged: 10-21 replay of 3,406 turn endings over
  // 7 days found 801 (23.5%) with none, and the judge's answer on those is
  // almost always `not_addressed`, which only nags.
  // skipNoClaim=false restores the old whole-reply fallback.
  const claims = c.splitClaims === false ? [] : atomicClaims(claim);
  if (c.splitClaims !== false && c.skipNoClaim !== false && !claims.length) {
    await logAsync(c, { event: 'no_claim_skip', gate: 'stop' });
    return undefined;
  }
  const result = await makeStopGate(c)({ claim, claims, evidence });
  if (result.shadow) return undefined;
  const judged = decisive(result.decided?.claims);
  const withState = evidence !== String(toolOutput ?? '') && String(toolOutput ?? '').trim();
  if (!withState) return blockDecision(judged);
  return keepToolsOnlyBlock(judged, async () => {
    const plain = await makeStopGate(c)({ claim, claims, evidence: toolOutput });
    const out = blockDecision(decisive(plain.decided?.claims));
    if (out?.decision === 'block') await logAsync(c, { event: 'state_block_kept', gate: 'stop' });
    return out;
  });
}

/**
 * With state shown, the judge blocked less: in the 10-14 replay 3 of the 9
 * rounds the tools-only judge blocked came back as "unsure contradicted".
 * Blocking stays where it was by asking the tools-only judge again, but only
 * on that verdict (30 of 146 rounds), so every other round costs one call.
 */
export async function keepToolsOnlyBlock(judged, rejudgeToolsOnly) {
  const out = blockDecision(judged);
  if (judged?.verdict !== 'contradicted' || judged.gate === 'auto') return out;
  try {
    const plain = await rejudgeToolsOnly();
    if (plain?.decision === 'block') return plain;
  } catch {
    // Fail open: the state verdict already stands.
  }
  return out;
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
  if (!judged) return undefined;
  // Name the sentence: "a claim is off" without saying which one sends the
  // agent re-reading the whole reply and usually changing nothing.
  const which = judged.claim ? ` Claim: "${String(judged.claim).replace(RESULT_LEVEL, '').slice(0, 200)}"` : '';
  if (judged.verdict === 'contradicted') {
    if (judged.gate === 'auto') {
      return {
        decision: 'block',
        reason: `this round's tool output contradicts the claim (jev-gate: contradicted). Re-read the output and correct the claim.${which}`,
      };
    }
    // Below auto the judge is unsure, so this is a re-check request, not an
    // accusation. 10-03..10-12: 191 of 196 contradicted verdicts sat here and
    // said nothing at all — the gate saw the problem and nobody was told.
    return feedback(`(jev-gate) this round's tool output may contradict the completion claim (judge unsure). Re-check the claim against the output; correct it or state what is unverified.${which}`);
  }
  if (judged.gate === 'auto' && judged.verdict === 'not_addressed') {
    // Was `systemMessage`, which the Stop hook shows to the user only: 176
    // reminders in ten days that the agent never received (hooks docs, 10-13).
    return feedback(`(jev-gate) this round's tool output does not support the completion claim: 證據只證明動作，未證明結果，請補上結果層驗證或明說未驗證。${which}`);
  }
  return undefined;
}

/**
 * Non-error Stop feedback: Claude receives it and the turn continues so it can
 * act. `stop_hook_active` on that next Stop keeps this to one round.
 */
function feedback(text) {
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } };
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
