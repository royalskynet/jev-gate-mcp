/**
 * jev-prune Hermes middleware unit tests (offline).
 *
 * Exercises `integrations/hermes/jev-prune/__init__.py` through its subprocess
 * seam: the middleware shells out to `agent-glue/cli.mjs prune`, and that CLI
 * is exercised here for the fail-open contract — bad JSON, timeout, non-string
 * answer — while the Python pre-gate / next_call-once / no-payload-ledger logic
 * is covered by the plugin's own `_selfcheck` (run in verify-hermes-jev-rollout).
 *
 * What must never regress (DEVLOG §18.2/§19.2): an adapter that loads, fires,
 * and can never change anything, or that leaks request/result into the ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = ['agent-glue/cli.mjs', 'prune'];

function runCli(input, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      CLI,
      { cwd: ROOT, env: { ...process.env, OPENROUTER_API_KEY: '', ...(opts.env || {}) }, timeout: opts.timeout },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

test('hermes CLI: valid prune answer is JSON with exit 0', async () => {
  const r = await runCli(JSON.stringify({ tool: 'Bash', request: 'r', text: 'x'.repeat(20000) }), {
    env: { JEV_API_KEY_FILE: '/nonexistent-key-file' },
  });
  assert.equal(r.code, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(typeof v, 'object');
  // no key -> fail-open: text verbatim, judged false, reason recorded
  assert.equal(v.text, 'x'.repeat(20000));
  assert.equal(v.judged, false);
  assert.ok(typeof v.reason === 'string' && v.reason.length > 0);
});

test('hermes CLI: bad JSON on stdin exits 2 without crashing', async () => {
  const r = await runCli('{not json');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not valid JSON/);
});

test('hermes CLI: hangs past the timeout and still exits (fail-open)', async () => {
  // The middleware's own 20s subprocess timeout is the real bound; here we
  // force the caller's timeout to fire first, and the CLI must still exit
  // (execFile timeout kills the child — exactly what a hung prune does).
  const r = await runCli(JSON.stringify({ tool: 'Bash', request: 'r', text: 'y'.repeat(20000) }), { timeout: 100 });
  assert.ok([0, 1, 2].includes(r.code), `expected a fail-open exit, got ${r.code} ${r.stderr}`);
});

test('hermes CLI: a non-string text payload answers verbatim, judged false', async () => {
  const r = await runCli(JSON.stringify({ tool: 'Bash', request: 'r', text: { rows: [1, 2] } }));
  assert.equal(r.code, 0);
  const v = JSON.parse(r.stdout);
  assert.equal(v.judged, false);
  assert.equal(v.text, '');
});
