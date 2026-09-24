import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePreToolUse, handleStop } from '../plugin/hooks/gate.js';
import { readEvidence } from '../plugin/lib/transcript.js';

// The gate must coexist with creds-egress-guard: it may never override an
// existing deny. Our guarantee: the PreToolUse handler emits no
// permissionDecision, so a deny from creds-egress-guard / guard.js stands.
// That holds with shadow off too — only the Stop gate ever blocks.

const config = JSON.parse(readFileSync(new URL('../plugin/config.default.json', import.meta.url), 'utf8'));
assert.equal(config.shadow, false, 'shadow period is over: the Stop gate decides');

// A Bash payload that creds-egress-guard would deny (sensitive-path read):
const bashPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'cat /Users/51mini/.ssh/id_rsa' },
  prompt: 'read the key',
};

const preOut = await handlePreToolUse(bashPayload);
if (preOut !== undefined) {
  assert.ok(preOut.hookSpecificOutput?.additionalContext, 'PreToolUse may only add context');
  assert.equal(preOut.permissionDecision, undefined, 'PreToolUse must never emit a permissionDecision — a creds-egress-guard deny has to stand');
}

// The three fail-open paths. Each must end the turn without a judgment, and
// none of them may reach the network — on a headless box a Stop gate that
// blocks on a turn it cannot judge has no way out.
assert.equal(
  await handleStop({ hook_event_name: 'Stop', last_assistant_message: 'done', stop_hook_active: true }),
  undefined, 'a second pass must never block — that is the loop guard');
assert.equal(
  await handleStop({ hook_event_name: 'Stop', last_assistant_message: '', tool_response: { output: 'x' } }),
  undefined, 'an empty claim has nothing to verify');
assert.equal(
  await handleStop({ hook_event_name: 'Stop', last_assistant_message: 'done', tool_response: { output: '' } }),
  undefined, 'a turn that ran no tools has no evidence, so it ends');

// Evidence really does come out of the transcript: the live Stop payload has
// no tool_response at all, and judging every claim against '' returned
// not_addressed at 0.97 every time — which once the gate blocks is every turn.
const dir = mkdtempSync(join(tmpdir(), 'jev-gate-'));
const tp = join(dir, 't.jsonl');
writeFileSync(tp, [
  JSON.stringify({ type: 'user', message: { content: 'fix the build' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Ran 8 tests. 8 passed.' }] } }),
].join('\n') + '\n');
const evidence = readEvidence(tp);
assert.match(evidence, /8 passed/, 'this round’s tool output is the evidence');
assert.doesNotMatch(evidence, /fix the build/, 'the walk stops at the prompt that opened the round');
assert.equal(readEvidence('/no/such/transcript'), '', 'an unreadable transcript yields no evidence, never a throw');

console.log('coexist ok: gate adds no permission decision; Stop fails open on loop / no claim / no evidence; evidence comes from the transcript.');
