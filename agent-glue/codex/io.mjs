/**
 * Codex hook I/O helpers — stdin JSON in, bounded JSON out, repo-relative
 * runtime state only. Every hook is a side channel: it never echoes state or
 * secrets, and failure is always fail-open (an empty/advisory response).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute repo root (this file lives in <root>/agent-glue/codex). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repo-relative runtime scratch (never committed); create on demand. */
export const RUNTIME_DIR = path.join(REPO_ROOT, '.jev-runtime');

export function runtimePath(name) {
  return path.join(RUNTIME_DIR, name);
}

/** Read stdin as JSON; returns null on any parse failure (fail-open input). */
export async function readEvent() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

export function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Append one line to a repo-relative runtime ledger; never throws. */
export function appendLedger(name, line) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const file = runtimePath(name);
    const prefix = readFileSync(file, 'utf8').trim();
    writeFileSync(file, `${prefix ? prefix + '\n' : ''}${line}`);
  } catch {
    /* observation only */
  }
}

/** Bounded text of a decision: never the raw payload. */
export function boundedSummary(obj) {
  const parts = ['jev-agent'];
  for (const k of ['route', 'no_match', 'verdict', 'outcome', 'reason']) {
    if (obj && obj[k] !== undefined && obj[k] !== null) parts.push(`${k}=${obj[k]}`);
  }
  return parts.join(' ');
}
