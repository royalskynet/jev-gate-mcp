import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * State evidence for the Stop gate: what the working tree says, not what the
 * transcript says.
 *
 * `readEvidence` gives the gate this round's tool output — the agent's own
 * account of what it did. That is the last and least reliable witness: a turn
 * can print "committed" and have committed nothing, and the transcript reads
 * identically either way. The store is the witness that cannot be talked into
 * agreeing, so this module asks git about exactly the paths this round claimed
 * to edit.
 *
 * Deliberately no diff content, only paths and status codes. The evidence is
 * sent to an external judge, so including file bodies would push whatever the
 * edited files hold — keys, PII — off the machine. Which files changed, and
 * whether they reached HEAD, is enough to catch a claim the store contradicts.
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The paths this round said it edited, oldest first, newest kept when capped.
 *
 * Walks the JSONL backwards and stops at the user turn that opened the round,
 * using the same boundary rule as `evidenceFromLines`: a plain-string user
 * message, or a structured one carrying no tool_result, is a prompt.
 */
export function touchedPathsFromLines(lines, max = 25) {
  const recs = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      // A truncated or half-written line says nothing about what was edited.
    }
  }
  // Find the round boundary walking backwards, then read forwards from it, so
  // several edits inside one assistant turn stay in the order they happened.
  let start = 0;
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    if (rec.type !== 'user') continue;
    const content = rec.message?.content;
    const isPrompt = typeof content === 'string'
      || !Array.isArray(content)
      || !content.some((p) => p?.type === 'tool_result');
    if (isPrompt) {
      start = i + 1;
      break;
    }
  }

  const paths = [];
  const seen = new Set();
  for (let i = start; i < recs.length; i++) {
    const content = recs[i].type === 'assistant' ? recs[i].message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== 'tool_use' || !EDIT_TOOLS.has(part.name)) continue;
      const p = part.input?.file_path ?? part.input?.notebook_path;
      // A relative path has no answerable location from here: the hook's cwd is
      // not the turn's cwd, so resolving it would invent a different file.
      if (typeof p !== 'string' || !p.startsWith('/') || seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
  }
  // Newest edits are the ones a completion claim is about, so an overflow comes
  // off the head — the same reason evidenceFromLines trims its oldest rounds.
  return paths.length > max ? paths.slice(paths.length - max) : paths;
}

/**
 * Raw stdout, deliberately untrimmed: porcelain status puts the worktree code
 * in the second column, so " M path" means an unstaged edit to a tracked file —
 * the most common case there is. Trimming eats that leading space, shifts the
 * path by one character, and every such file reads as unchanged.
 */
function git(args, cwd, timeoutMs) {
  return execFileSync('git', args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 1 << 20,
  });
}

/** `XY path`, or `XY old -> new` for a rename, keyed by the path git now has. */
function parseStatus(status) {
  const codes = new Map();
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    // ponytail: quoted paths only get their quotes stripped, so a path with an
    // escaped byte still misses its lookup. Set core.quotePath=false here if
    // that ever shows up in a real repo.
    codes.set(path.trim().replace(/^"|"$/g, ''), code);
  }
  return codes;
}

/**
 * Ask git about these paths. Returns `{ text, stats }`: the text goes to the
 * judge, the stats to the ledger, so observing this source costs no content.
 *
 * Every git call fails open on its own. A missing binary, a detached repo, a
 * slow lock — none of it may decide whether a turn ends, so an unreachable
 * store degrades to "nothing to add" and the gate falls back to tool output.
 */
export function gitState(paths, { timeoutMs = 2500, maxChars = 2000 } = {}) {
  const stats = { repos: 0, paths: paths.length, changed: 0, unchanged: 0, missing: 0 };
  if (!paths.length) return { text: '', stats };

  const byRepo = new Map();
  const orphans = [];
  for (const p of paths) {
    // `--show-toplevel` hands back a realpath, so a path under a symlinked
    // prefix (every /var/... on macOS, which is /private/var) would not share
    // the root's prefix and every file would read as UNCHANGED — a false
    // contradiction, the one direction this evidence must never invent.
    const dir = dirname(p);
    let realDir = dir;
    try {
      realDir = realpathSync(dir);
    } catch {
      // A missing parent directory is itself the answer; keep the literal path.
    }
    let root = null;
    try {
      root = git(['rev-parse', '--show-toplevel'], realDir, timeoutMs).trim() || null;
    } catch {
      root = null;
    }
    const entry = { abs: p, canonical: join(realDir, basename(p)) };
    if (!root) {
      orphans.push(entry);
      continue;
    }
    if (!byRepo.has(root)) byRepo.set(root, []);
    byRepo.get(root).push(entry);
  }

  const out = [];
  for (const [root, ps] of byRepo) {
    stats.repos += 1;
    let head = '?';
    let status = '';
    const inHead = new Set();
    try {
      head = git(['rev-parse', '--short', 'HEAD'], root, timeoutMs).trim();
    } catch { /* an empty repo has no HEAD; the per-path lines still say enough */ }
    try {
      status = git(['status', '--porcelain=v1', '-uall', '--', ...ps.map((e) => e.canonical)], root, timeoutMs);
    } catch { /* fail open */ }
    try {
      const names = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], root, timeoutMs);
      for (const n of names.split('\n')) if (n.trim()) inHead.add(n.trim());
    } catch { /* fail open */ }

    const codes = parseStatus(status);

    out.push(`repo ${root} @ ${head}`);
    for (const { abs, canonical } of ps) {
      const rel = canonical.startsWith(`${root}/`) ? canonical.slice(root.length + 1) : canonical;
      const code = codes.get(rel);
      const gone = !existsSync(abs);
      const bits = [];
      if (gone) bits.push('MISSING on disk');
      if (code) bits.push(`uncommitted change, git status "${code}"`);
      if (inHead.has(rel)) bits.push('present in HEAD commit');
      // One bucket each, so the three counters sum to `paths` and a ledger line
      // reads without wondering which paths got counted twice.
      if (gone) stats.missing += 1;
      else if (bits.length) stats.changed += 1;
      else {
        bits.push('UNCHANGED: identical to HEAD and not in the HEAD commit');
        stats.unchanged += 1;
      }
      out.push(`  ${rel}: ${bits.join('; ')}`);
    }
  }
  for (const { abs } of orphans) {
    const here = existsSync(abs);
    if (here) stats.changed += 1;
    else stats.missing += 1;
    out.push(`  ${abs}: ${here ? 'exists, not inside a git repo' : 'MISSING on disk'}`);
  }

  if (!out.length) return { text: '', stats };
  const body = out.join('\n');
  const header = "=== state (git), the paths this round's edits named ===";
  return {
    text: `${header}\n${body.length > maxChars ? `${body.slice(0, maxChars)}\n(truncated)` : body}`,
    stats,
  };
}

/** Read the transcript and ask git about whatever this round claimed to edit. */
export function stateEvidence(transcriptPath, opts = {}) {
  const empty = { text: '', stats: { repos: 0, paths: 0, changed: 0, unchanged: 0, missing: 0 } };
  if (!transcriptPath) return empty;
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return empty;
  }
  return gitState(touchedPathsFromLines(lines), opts);
}
