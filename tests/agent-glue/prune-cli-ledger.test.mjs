// Guard for "CLI prune silence is unobservable" (#4/#6 option 2): a bare CLI
// prune run must leave a `jev-prune-cli.log` line even with NO API key, a
// short input and no request — every early-return exit path writes before it
// returns (fix 0522 §7: `!key → return` before appendLedger left the ledger
// silent for two days). The CLI ledger is separate from the hook ledger on
// purpose: a CLI run proves the judge loaded, never that the hook did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('cli prune without any key still writes a non-empty CLI ledger', async () => {
  const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cli-ledger-')), 'jev-prune-cli.log');
  const result = await new Promise((resolve) => {
    // No key anywhere: force the key-file branch to miss and strip OPENROUTER_API_KEY.
    const child = execFile(
      process.execPath,
      ['agent-glue/cli.mjs', 'prune'],
      // No key anywhere: point the rotated-file fallback at a nonexistent path
      // and strip the env fallback, so a short input answers below-threshold
      // and never touches the network (deterministic, offline).
      { cwd: ROOT, env: { ...process.env, JEV_CLI_LEDGER: ledger, JEV_API_KEY_FILE: '/nonexistent/jev-key.txt', OPENROUTER_API_KEY: '' } },
      (err) => resolve({ code: err ? err.code ?? 1 : 0 }),
    );
    child.stdin.write(JSON.stringify({ tool: 'Bash', request: 'x', text: 'short' }) + '\n');
    child.stdin.end();
  });
  assert.equal(result.code, 0, 'bare CLI prune must exit 0 (fail-open)');
  assert.ok(fs.existsSync(ledger), `CLI ledger must be created at ${ledger}`);
  const content = fs.readFileSync(ledger, 'utf8');
  assert.ok(content.length > 0, 'CLI ledger must not be empty');
  assert.match(content, /jev-cli\(/, `line must be tagged jev-cli(...), got ${content.replace(/\n/g, ' | ')}`);
});

test('cli prune reaches the judge through its default host (clock included)', async (t) => {
  // d835990 made judgeChunks meter its deadline on `$.clock`; the CLI's host
  // had no clock, so every Hermes prune threw before the fetch and kept all.
  const { pruneCommand } = await import('../../agent-glue/src/prune.js');
  const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cli-ledger-')), 'l.log');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    calls += 1;
    const answers = Object.fromEntries(Object.keys(JSON.parse(opts.body).questions).map((k) => [k, { choice: 'drop' }]));
    return new Response(JSON.stringify({ answers }));
  });
  const text = Array.from({ length: 3000 }, (_, i) => `noise line ${i}`).join('\n');
  const r = await pruneCommand({ tool: 'terminal', request: 'fix the readme', text }, { key: 'k', ledger });
  assert.ok(calls > 0, 'the judge must actually be called');
  assert.ok(r.dropped_lines > 0, `expected drops, got ${JSON.stringify({ ...r, text: undefined })}`);
  // #31: the judged line carries before → after, so savings come from the ledger alone.
  assert.match(fs.readFileSync(ledger, 'utf8'), new RegExp(`judged ${text.length} → ${r.text.length} chars`));
});
