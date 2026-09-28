/**
 * Codex hook I/O helpers — stdin JSON in, bounded JSON out, repo-relative
 * runtime state only. Every hook is a side channel: it never echoes state or
 * secrets, and failure is always fail-open (an empty/advisory response).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute repo root (this file lives in <root>/agent-glue/codex). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Runtime scratch, created on demand.
 *
 * Repo-relative was right when the hooks were wired project-level through
 * `.codex/hooks.json`. Installed as a plugin they are not: REPO_ROOT is then
 * `~/.codex/plugins/cache/<marketplace>/<plugin>/<ver>`, which `codex plugin
 * add` re-creates from scratch — every upgrade silently threw the ledger away,
 * and a ledger you cannot find after an upgrade cannot answer "did the hook
 * fire". So: inside a checkout keep the repo-relative path (gitignored, what
 * the tests assert), otherwise a stable per-user directory.
 */
const IN_CHECKOUT = existsSync(path.join(REPO_ROOT, '.git'));
export const RUNTIME_DIR = process.env.JEV_RUNTIME_DIR
  ?? (IN_CHECKOUT ? path.join(REPO_ROOT, '.jev-runtime')
                  : path.join(os.homedir(), '.codex', 'jev-runtime'));

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

/**
 * Say nothing. "Exit 0 with no output is treated as success and Codex
 * continues" (learn.chatgpt.com/docs/hooks), and that is the only correct
 * answer for an advisory hook with no advice: every `decision` value is an
 * *intervention*, and there is no `allow` for these events. The adapters used
 * to answer `{decision:'allow'}` on every event, which Codex rejected as an
 * invalid wire and reported as `hook: ... Failed` — the hook ran, reached Jev
 * and wrote its ledger, but its advisory was discarded before the model saw it.
 */
export function respondNothing() {}

/**
 * The documented advisory wire. `additionalContext` is a STRING, and it lives
 * under `hookSpecificOutput`, not at the top level. Only UserPromptSubmit,
 * SessionStart and SubagentStart carry it; PreCompact/PostCompact get the
 * common fields only, so a note there goes in `systemMessage`.
 */
export function respondContext(hookEventName, additionalContext) {
  respond({ hookSpecificOutput: { hookEventName, additionalContext: String(additionalContext) } });
}

/** Append one line to a repo-relative runtime ledger; never throws. */
export function appendLedger(name, line) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    // O_APPEND, one syscall. The old read-trim-rewrite was O(n^2) in ledger
    // length and, worse, a read-modify-write race: PreToolUse fires on every
    // tool call, so two hooks in flight would each rewrite the file from their
    // own stale read and one line would vanish. It also left no trailing
    // newline, so `cat`/`wc -l` ran the last line of one ledger into the next.
    appendFileSync(runtimePath(name), line + '\n');
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
