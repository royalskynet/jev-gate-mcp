#!/usr/bin/env node
/**
 * Codex Stop hook — completion verification + evidence collector + one retry.
 *
 * Deterministic evidence gate over the session transcript: any execution
 * record with `isError` true -> fail; any executable record that ran clean ->
 * pass with cited evidence (file:line where present); nothing executable ->
 * unknown. The model's self-reported "done" is never evidence on its own.
 *
 * Retry contract (mandatory read of `stop_hook_active`): if the Stop event is
 * already a continuation of our own block, we must NOT block again — at most
 * one rerun, or an infinite loop would follow. Only a `fail`/`unknown` result
 * and an inactive flag produce one `decision: block` asking for evidence; a
 * `pass` always lets the stop through.
 */
import { readFileSync } from 'node:fs';
import { readEvent, respond, appendLedger, boundedSummary } from './io.mjs';
import { verifyCompletion } from '../src/verify.js';

const event = await readEvent();
const session = event?.session_id ?? 'anon';
const alreadyActive = event?.stop_hook_active === true;

// Collect deterministic execution evidence from the transcript (best-effort).
const evidence = [];
try {
  if (event?.transcript_path && typeof event.transcript_path === 'string') {
    for (const line of readFileSync(event.transcript_path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.type === 'function_call_result' || /tool|call|result|command/i.test(rec?.type ?? '')) {
          const text = typeof rec?.text === 'string' ? rec.text : null;
          if (text && text.trim()) {
            evidence.push({
              kind: rec?.tool_use?.name ?? rec?.name ?? 'command',
              text: text.slice(0, 2000),
              ok: rec?.isError === true ? false : true,
            });
          }
        }
      } catch {
        /* skip malformed line */
      }
    }
  }
} catch {
  /* no transcript: evidence is empty -> unknown below */
}

const verdict = await verifyCompletion({
  claim: event?.last_user_message ?? 'completion claim',
  evidence,
  note: 'codex-stop',
});

const needsRerun = (verdict.verdict === 'fail' || verdict.verdict === 'unknown') && !alreadyActive;

appendLedger(
  'codex-verify.log',
  `stop\t${boundedSummary(verdict)}\tevidence=${evidence.length}\tactive=${alreadyActive}`,
);

if (!needsRerun) {
  respond({ decision: 'allow', stop_hook_active: false });
} else {
  respond({
    decision: 'block',
    stop_hook_active: true,
    additionalContext: [
      `Completion verification returned ${verdict.verdict} (${verdict.note}). ` +
        'Do not claim the task is done on self-report alone. Run one verifiable check ' +
        '(a command whose output confirms the outcome) and show its raw output before continuing.',
    ],
  });
}
