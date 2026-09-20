import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePreToolUse, handleStop } from '../plugin/hooks/gate.js';
import { DEFAULT_CONFIG } from '../plugin/lib/judge.js';

// The gate must coexist with creds-egress-guard: it may never override an
// existing deny. Our guarantee: the PreToolUse handler emits no
// permissionDecision, so a deny from creds-egress-guard / guard.js stands.
// Phase 3 lands in shadow mode, so it does not block or intervene at all.

const config = JSON.parse(readFileSync(new URL('../plugin/config.default.json', import.meta.url), 'utf8'));

// Phase 3 must remain shadow == true until the shadow period ends.
assert.equal(config.shadow, true, 'Phase 3 must land in shadow mode (shadow must be true)');

// A Bash payload that creds-egress-guard would deny (sensitive-path read):
const bashPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'cat /Users/51mini/.ssh/id_rsa' },
  prompt: 'read the key',
};

// Shadow mode: the gate emits nothing at all — no allow that could override.
const preOut = await handlePreToolUse(bashPayload);
assert.equal(preOut, undefined, 'shadow-mode PreToolUse must not emit any permission decision (can’t override creds-egress-guard deny)');

// Stop: shadow mode never blocks, so fi-reminder.sh’s one-shot block is untouched.
const stopOut = await handleStop({ hook_event_name: 'Stop', last_assistant_message: 'done', tool_response: {} });
assert.equal(stopOut, undefined, 'shadow-mode Stop must not emit a block');

console.log('coexist ok: gate emits no override; shadow stays true; creds-egress-guard deny cannot be overwritten.');
