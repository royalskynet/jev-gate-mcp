import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Strip block and line comments so a `process` in prose does not fail the test. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every file the hooks module pulls in at load time, found by following the
 * static `import … from './x'` declarations out of `hooks/index.js`. It is a
 * single aggregator, so one of these failing takes every hook down — and
 * `claude plugin validate` passed the 2026-09-23 break, because it checks the
 * shape of the `$` calls and not what else the source names.
 *
 * This used to be a hand-written list. It went stale twice without failing:
 * compact-anthropic.mjs and the vendored fast-jev core were never on it.
 */
function loadedByTheHook(entry = 'hooks/index.js') {
  const seen = new Set();
  const walk = (relative) => {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = code(readFileSync(join(ROOT, relative), 'utf8'));
    for (const m of source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      walk(join(dirname(relative), m[1]));
    }
  };
  walk(entry);
  return [...seen];
}

const LOADED_BY_THE_HOOK = loadedByTheHook();

/**
 * Node names a file may keep, each with why it never runs in the hook worker.
 * env.mjs: the one guarded `typeof process` reader. vendor client.js:
 * `options.apiKey ?? process.env…` — compact-hook returns before `askerFor`
 * when the key is empty, so the `??` always short-circuits. Vendored, not
 * edited here (see vendor/fast-jev/VENDORED.md).
 */
const ALLOWED = {
  'agent-glue/claude/env.mjs': ['process'],
  'agent-glue/vendor/fast-jev/client.js': ['process'],
};

test('the import walk reaches the files the 2026-09 list missed', () => {
  for (const relative of [
    'agent-glue/claude/compact-anthropic.mjs',
    'agent-glue/vendor/fast-jev/client.js',
    'gateway/src/classification-profiles.js',
  ]) {
    assert.ok(LOADED_BY_THE_HOOK.includes(relative), `${relative} not reached from hooks/index.js`);
  }
});

// 2026-10-05: Claude Code 2.1.289 refuses a dynamic import() anywhere in the
// module's closure ("a hooks module imports its own files with an import
// declaration"), and the aggregator took every hook down with it. The one
// offender was spawn-hook -> src/live.js, which lazily imported the Node-only
// gateway; it is out of the closure now and must stay out.
test('the hooks module chain has no dynamic import()', () => {
  for (const relative of LOADED_BY_THE_HOOK) {
    const source = code(readFileSync(join(ROOT, relative), 'utf8'));
    assert.doesNotMatch(
      source,
      /\bimport\s*\(/,
      `${relative} calls import(); the engine refuses the whole hooks module for it. Use a static import declaration, or keep the file out of hooks/index.js's closure.`,
    );
  }
  assert.ok(!LOADED_BY_THE_HOOK.includes('agent-glue/src/live.js'), 'src/live.js is back in the hooks closure');
});

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
      .filter((name) => !(ALLOWED[relative] ?? []).includes(name));
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
