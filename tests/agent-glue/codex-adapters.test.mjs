/**
 * Every Codex hook adapter, actually executed.
 *
 * These six scripts are only ever run as subprocesses by Codex, so nothing
 * imported them and nothing type-checked them: a stale identifier or a wire
 * shape Codex rejects both looked exactly like a passing build. Three real
 * defects shipped that way — a `decision: "allow"` that is not a value any of
 * these events accept, an `additionalContext` sent as an array of blocks
 * instead of a string, and a helper used but not imported. Codex reports all
 * three the same way, as `hook: ... Failed`, after the hook has already run and
 * billed a Jev call, so the only honest check is to run each adapter the way
 * Codex does and read its stdout.
 *
 * One Jev call is real: `user_prompt_submit.mjs` in the advisory test below.
 * The five remaining adapters (and the loop's own user_prompt_submit) run with
 * `JEV_PROVIDER=fake`, the gateway's existing offline provider — so firing all
 * six adapters here costs a single live triage, not six.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODEX_DIR = resolve(fileURLToPath(new URL('../../agent-glue/codex', import.meta.url)));
const ADAPTER_TIMEOUT_MS = Number(process.env.JEV_ADAPTER_TIMEOUT_MS ?? 30_000);

/** Collect a subprocess's stdout/stderr; rejects if it exceeds the timeout. */
function collect(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // one bad adapter must not hang the whole suite
      reject(new Error(`adapter timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code, signal });
    });
  });
}

/**
 * Run one adapter exactly as Codex does: JSON on stdin, JSON or nothing on
 * stdout. `env` is merged on top of the process env (an import seam so a caller
 * can stub a live transport with the existing offline provider).
 */
async function fire(script, event, env = {}) {
  const runtime = await mkdtemp(join(tmpdir(), 'jev-adapter-'));
  try {
    const child = spawn('node', [join(CODEX_DIR, script)], {
      env: { ...process.env, JEV_RUNTIME_DIR: runtime, ...env },
    });
    assert.ok(child instanceof ChildProcess, 'spawn returned a process handle');
    child.stdin.end(JSON.stringify(event));
    const { stdout, stderr } = await collect(child, ADAPTER_TIMEOUT_MS);
    return { stdout: stdout.trim(), stderr };
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
}

// Only these events accept additionalContext, and only as a string under
// hookSpecificOutput. PreCompact/PostCompact get the common fields only.
const CARRIES_CONTEXT = new Set(['UserPromptSubmit', 'SessionStart', 'SubagentStart']);
const COMMON = new Set(['continue', 'stopReason', 'systemMessage', 'suppressOutput']);

const CASES = [
  ['user_prompt_submit.mjs', { hook_event_name: 'UserPromptSubmit', prompt: 'refactor the auth middleware', cwd: '/tmp' }],
  ['pre_tool_use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' }],
  ['post_tool_use.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' }, cwd: '/tmp' }],
  ['pre_compact.mjs', { hook_event_name: 'PreCompact', trigger: 'auto', cwd: '/tmp' }],
  ['post_compact.mjs', { hook_event_name: 'PostCompact', trigger: 'auto', cwd: '/tmp' }],
  ['stop.mjs', { hook_event_name: 'Stop', cwd: '/tmp' }],
];

// Offline in the loop: the existing gateway fake provider (`JEV_PROVIDER=fake`)
// never touches the network, so these six runs bill exactly zero Jev calls. The
// single real triage lives in the advisory test below.
const OFFLINE = { JEV_PROVIDER: 'fake' };

for (const [script, event] of CASES) {
  test(`codex adapter ${script} exits clean and emits a wire Codex accepts`, async () => {
    const { stdout, stderr } = await fire(script, event, OFFLINE);

    // A ReferenceError here still exits 0 — the adapters fail open — so the
    // stack only ever shows up on stderr. That is the regression that hid the
    // missing `boundedSummary` import.
    assert.doesNotMatch(stderr, /ReferenceError|TypeError|is not defined/, `${script} threw: ${stderr}`);

    // Saying nothing is a valid answer: "exit 0 with no output is treated as
    // success and Codex continues".
    if (stdout === '') return;

    const out = JSON.parse(stdout); // must be parseable, not bare prose
    assert.equal(typeof out, 'object');
    assert.ok(!Array.isArray(out));

    // `allow` is not a decision any of these events define; the allow path is
    // silence. This is the assertion that fails if the old shape comes back.
    assert.notEqual(out.decision, 'allow', `${script} sent the invalid decision "allow"`);

    if ('additionalContext' in out) {
      assert.fail(`${script} put additionalContext at top level; it belongs under hookSpecificOutput`);
    }

    if (out.hookSpecificOutput) {
      const hso = out.hookSpecificOutput;
      assert.equal(hso.hookEventName, event.hook_event_name, 'hookEventName must echo the event');
      if ('additionalContext' in hso) {
        assert.ok(CARRIES_CONTEXT.has(hso.hookEventName), `${hso.hookEventName} does not carry additionalContext`);
        assert.equal(typeof hso.additionalContext, 'string', 'additionalContext is a string, not blocks');
      }
    }

    // PreCompact/PostCompact are limited to the common fields.
    if (event.hook_event_name.endsWith('Compact')) {
      for (const key of Object.keys(out)) {
        assert.ok(COMMON.has(key), `${script} sent "${key}", not a common output field`);
      }
    }
  });
}

test('codex adapters: the advisory actually carries a Jev answer, not a fail-open stub', async () => {
  // No offline env: this is the one real Jev call in the file.
  const { stdout } = await fire('user_prompt_submit.mjs', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'refactor the auth middleware',
    cwd: '/tmp',
  });
  const note = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(note, /^jev-triage: /);
  // With a provider configured this must be a real tier, not the no-transport
  // path — that fail-open string is what a broken JEV_PROVIDER looked like.
  assert.doesNotMatch(note, /no live transport/, 'no live transport: the provider is misconfigured');
  assert.match(note, /conf \d\.\d\d/, 'a real triage reports a confidence');
});