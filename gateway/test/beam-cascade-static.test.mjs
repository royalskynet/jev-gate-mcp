import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('cascade-server main wiring uses beam-free CLI adapter, not OpenRouter', () => {
  const src = readFileSync(join(root, 'gateway/src/cascade-server.js'), 'utf8');
  assert.equal(src.includes('makeOpenrouterAdapter('), false);
  assert.match(src, /makeOpencodeCliAdapter/);
});

test('makeOpencodeCliAdapter does not use fetch', () => {
  const src = readFileSync(join(root, 'gateway/src/adapters.js'), 'utf8');
  const start = src.indexOf('export function makeOpencodeCliAdapter');
  assert.ok(start >= 0, 'adapter missing');
  const next = src.indexOf('\n// --- Beam', start);
  const body = src.slice(start, next > start ? next : undefined);
  assert.equal(body.includes('fetch'), false, 'opencode CLI adapter must not fetch');
});

// Main-block identifiers only fail at daemon start (tests never run main): every called factory must be imported.
test('cascade-server main block only calls imported factories', () => {
  const src = readFileSync(join(root, 'gateway/src/cascade-server.js'), 'utf8');
  const imported = new Set([...src.matchAll(/^import\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())));
  const main = src.slice(src.indexOf('if (process.argv[1]'));
  const defined = new Set([...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]));
  for (const name of new Set([...main.matchAll(/\b((?:make|with)[A-Z]\w*)\(/g)].map((m) => m[1]))) {
    assert.ok(imported.has(name) || defined.has(name), `${name} is called in main but not imported`);
  }
});
