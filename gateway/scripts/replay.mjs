#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../src/registry.js';
import { runDecisionReplay } from '../lib/replay.mjs';

export function parseReplay(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.records;
  } catch {
    return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node gateway/scripts/replay.mjs <records.json|jsonl>');
  const report = await runDecisionReplay({ registry: loadRegistry(), records: parseReplay(fs.readFileSync(file, 'utf8')) });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`replay: ${error.message}\n`);
    process.exitCode = 2;
  });
}
