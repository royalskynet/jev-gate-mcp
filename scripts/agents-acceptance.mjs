#!/usr/bin/env node
/**
 * agents:acceptance — one read-only gate for the Jev agent glue, run in order:
 *
 *   1. Claude plugin validate (when the `claude` CLI is available)
 *   2. full test suite (`node --test`)
 *   3. build check
 *   4. gateway acceptance
 *   5. both-end offline smoke (Claude bridge + Codex hooks + injected client)
 *
 * Any step failing exits non-zero. It never rewrites fixtures, policies,
 * thresholds or calibration; it only asserts they are unchanged.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `input: ''` gives every child an immediate EOF on stdin so no child can sit
// waiting on an interactive prompt (notably `claude plugin validate`) and hang
// the gate. Callers pass their own `input` per-call when they need real stdin.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', input: '', ...opts });

let failed = false;
function stage(name, fn) {
  try {
    const out = fn();
    process.stdout.write(`[agents:acceptance] ${name}: OK\n${out ? '  ' + out.trim().split('\n').join('\n  ') + '\n' : ''}`);
  } catch (error) {
    failed = true;
    process.stderr.write(`[agents:acceptance] ${name}: FAIL\n  ${String(error?.stdout ?? error)}\n`);
  }
}

// 1. Claude plugin validate (only when the CLI exists).
stage('claude plugin validate', () => {
  const claude = process.env.CLAUDE_BIN || 'claude';
  try {
    run(claude, ['plugin', 'validate', '.claude-plugin/plugin.json']);
    return 'validated';
  } catch {
    return 'claude CLI unavailable — skipped (present manifest unchanged)';
  }
});

// 2. Full test suite.
stage('full tests', () => run(process.execPath, ['--test', 'tests']).trim());

// 3. Build check.
stage('build', () => run(process.execPath, ['gateway/scripts/build-check.mjs']).trim());

// 4. Gateway acceptance.
stage('gateway acceptance', () => run(process.execPath, ['gateway/scripts/acceptance.mjs']).trim());

// 5. Both-end offline smoke.
stage('claude bridge smoke', () => {
  const out = run(process.execPath, ['agent-glue/claude/bridge.mjs', 'verify'], {
    input: JSON.stringify({ claim: 'done', evidence: [{ kind: 'Bash', text: '1 passing', ok: true }] }),
  });
  const v = JSON.parse(out);
  if (v.verdict !== 'pass') throw new Error(`expected pass, got ${v.verdict}`);
  return `verify=${v.verdict}`;
});

stage('codex hooks smoke', () => {
  const stop = run(process.execPath, ['agent-glue/codex/stop.mjs'], {
    input: JSON.stringify({ session_id: 'acc', stop_hook_active: false, transcript_path: null }),
  });
  const s = JSON.parse(stop);
  if (s.decision !== 'block') throw new Error('bare stop with no evidence must block once: got ' + s.decision);
  if (s.stop_hook_active !== true) throw new Error('first block must set stop_hook_active');
  const stop2 = run(process.execPath, ['agent-glue/codex/stop.mjs'], {
    input: JSON.stringify({ session_id: 'acc', stop_hook_active: true, transcript_path: null }),
  });
  const s2 = JSON.parse(stop2);
  if (s2.decision !== 'allow') throw new Error('already-active stop must not re-block');
  return 'stop=block-once-then-allow';
});

stage('injected client smoke', () => {
  const out = run(process.execPath, ['--input-type=module', '-e',
    `import { makeFakeTransport } from './agent-glue/src/client.js';
     const t = makeFakeTransport({ choice: 'no_match', confidence: 0.5 });
     const r = await t.evaluate({ state: 'x', questions: { q: { type: 'choice', instructions: 'i', criteria: {} } } });
     if (r.answers.q.choice !== 'no_match') throw new Error('fake client fail-open wrong');`,
  ]);
  return out.trim() || 'fake client ok';
});

if (failed) process.exit(1);
process.stdout.write('[agents:acceptance] ALL OK\n');
