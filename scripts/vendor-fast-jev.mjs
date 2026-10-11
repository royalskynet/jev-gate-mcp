#!/usr/bin/env node
// Re-vendor agent-glue/vendor/fast-jev from a fast-jev-compaction checkout.
// ponytail: shells out to the upstream's own `tsc`; no build config here to drift.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2] ?? join(process.env.HOME, 'dev', 'fast-jev-compaction-openrouter');
const dest = join(dirname(dirname(fileURLToPath(import.meta.url))), 'agent-glue', 'vendor', 'fast-jev');
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;

execFileSync(join(src, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: src, stdio: 'inherit' });
mkdirSync(dest, { recursive: true });
const files = readdirSync(join(src, 'dist')).filter((f) => f.endsWith('.js'));
for (const f of files) copyFileSync(join(src, 'dist', f), join(dest, f));
console.log(`vendored fast-jev-compaction ${version}: ${files.length} files -> ${dest}`);
console.log('update the version/date table in VENDORED.md by hand.');
