import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (script, args, payload) =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { cwd: ROOT }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr });
    });
    child.stdin.write(JSON.stringify(payload) + '\n');
    child.stdin.end();
  });

for (const [name, script] of [['cli', 'agent-glue/cli.mjs'], ['bridge', 'agent-glue/claude/bridge.mjs']]) {
  test(`route (${name}): candidates given -> bounded fail-open JSON, exit 0, no stack trace`, async () => {
    // With a live Jev model route returns a real no_match/top; without one
    // it fails open to jev-unavailable. Either way the CLI must surface a
    // bounded result and exit 0, never a stack trace.
    const r = await run(script, ['route'], { candidates: ['Bash', 'Read'], userRequest: 'do something' });
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.equal(v.no_match, true, 'bare CLI route always settles on no_match (fail-open)');
    assert.ok(Array.isArray(v.top));
    assert.equal(r.stderr.includes('Error'), false, 'must not leak an error/stack trace');
  });

  test(`route (${name}): no candidates -> bounded no-candidates, exit 0, no stack trace`, async () => {
    const r = await run(script, ['route'], { userRequest: 'do something' });
    assert.equal(r.code, 0);
    const v = JSON.parse(r.stdout);
    assert.equal(v.no_match, true);
    assert.equal(v.reason, 'no-candidates');
    assert.deepEqual(v.top, []);
    assert.equal(r.stderr.includes('EmptyCandidatesError'), false, 'must not leak a stack trace');
  });
}

// route's own jev-unavailable fail-open wiring (deterministic, injected scorer).
test('route: scorer failure -> jev-unavailable (deterministic, injected)', async () => {
  const { route } = await import('../../plugin/lib/route.js');
  const r = await route({
    candidates: ['Bash', 'Read'],
    userRequest: 'x',
    scorer: async () => { throw new Error('no model'); },
  });
  assert.equal(r.no_match, true);
  assert.equal(r.reason, 'jev-unavailable');
  assert.deepEqual(r.top, []);
});
