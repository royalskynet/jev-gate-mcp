import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Every file the hooks module pulls in at load time. `hooks/index.js` is a
 * single aggregator, so one of these touching a Node global takes all seven
 * hooks down — and `claude plugin validate` passes anyway, because it checks
 * the shape of the `$` calls and not what else the source names.
 *
 * ponytail: a hand-written list, not a parsed import graph. It is five files;
 * a new import here is a line in this list, and a stale list fails loud the
 * first time someone adds one without reading this comment.
 */
const LOADED_BY_THE_HOOK = [
  'hooks/index.js',
  'hooks/jev.js',
  'agent-glue/claude/env.mjs',
  'agent-glue/claude/spawn-hook.mjs',
  'agent-glue/claude/compact-hook.mjs',
  'agent-glue/src/compact.js',
  'agent-glue/src/triage.js',
  'agent-glue/src/live.js',
];

/** Strip block and line comments so a `process` in prose does not fail the test. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// The regression this file exists for: on 2026-09-23 `hooks/jev.js` read
// `process.env` at module scope, so the module threw
// `ReferenceError: process is not defined` at load and the prune ledger stayed
// empty for two days while every "is it installed" check answered yes. The one
// place that said so was the debug log. `agent-glue/claude/env.mjs` is the
// exception by design: it is the single `typeof process === 'undefined'` guard
// the rest of the plugin reads its environment through.
test('the hooks module chain names no Node global', () => {
  for (const relative of LOADED_BY_THE_HOOK) {
    const source = code(readFileSync(join(ROOT, relative), 'utf8'));
    const offenders = [...source.matchAll(/\b(process|require|__dirname|__filename|Buffer)\b/g)]
      .map((m) => m[1])
      .filter((name) => !(relative.endsWith('claude/env.mjs') && name === 'process'));
    assert.deepEqual(
      offenders,
      [],
      `${relative} names ${[...new Set(offenders)].join(', ')}; a hooks module has no Node. `
      + 'Read it through agent-glue/claude/env.mjs (ENV + the module\'s own hydrate($)) instead.',
    );
  }
});

test('env.mjs guards the one process reference it keeps', () => {
  const source = readFileSync(join(ROOT, 'agent-glue/claude/env.mjs'), 'utf8');
  assert.match(source, /typeof process === 'undefined'/);
});
