#!/usr/bin/env node
/**
 * Batch-compact idle Claude Code sessions over a token floor, now.
 *
 * Each session is handed back to its own host (`claude -p --resume <id> /compact`),
 * so the installed jev `session.compact` hook does the pruning and Claude Code
 * writes its own transcript — no offline rewrite (issue #3; resume-chain risk, H8).
 * OpenMausBot's claude engine stores standard transcripts, either in ~/.claude
 * or per-team under ~/.openmausbot/engine-homes/<home>/.claude; both are scanned.
 *
 *   node scripts/compact-batch.mjs                       # list candidates (default)
 *   node scripts/compact-batch.mjs --execute             # compact them
 *   --min-tokens 200000  --idle-min 30  --root <dir/.claude>  --session <id>  (both repeatable)  --json
 *   --cwd <prefix>  only sessions whose cwd starts with it;  --backup <dir>  copy each transcript there first
 */
import { readdirSync, readFileSync, statSync, existsSync, realpathSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

/** Live context size of one transcript: last compact_boundary or last usage, whichever is later. */
export function sessionSize(lines) {
  let tokens = 0;
  let cwd = '';
  let id = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (typeof o.sessionId === 'string' && o.sessionId) id = o.sessionId;
    if (o.type === 'system' && o.subtype === 'compact_boundary' && o.compactMetadata) {
      tokens = Number(o.compactMetadata.postTokens) || 0;
    } else if (o.type === 'assistant' && o.message?.usage) {
      const u = o.message.usage;
      tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    }
  }
  return { id, cwd, tokens };
}

/** Claude config dirs to scan: the default plus every OpenMausBot engine home. */
export function defaultRoots(home = os.homedir(), env = process.env) {
  const roots = [env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')];
  const engineHomes = path.join(env.OMB_DATA_DIR || path.join(home, '.openmausbot'), 'engine-homes');
  if (existsSync(engineHomes)) {
    for (const d of readdirSync(engineHomes)) {
      const c = path.join(engineHomes, d, '.claude');
      if (existsSync(c)) roots.push(c);
    }
  }
  return [...new Set(roots)];
}

/** Sessions over `minTokens` whose transcript has been quiet for `idleMin` minutes. */
export function candidates(roots, { minTokens, idleMin, now = Date.now(), busy = () => false }) {
  const out = [];
  for (const root of roots) {
    const projects = path.join(root, 'projects');
    if (!existsSync(projects)) continue;
    for (const dir of readdirSync(projects)) {
      const pdir = path.join(projects, dir);
      let files;
      try { files = readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = path.join(pdir, f);
        const st = statSync(file);
        const idle = (now - st.mtimeMs) / 60000;
        if (idle < idleMin) continue;
        const s = sessionSize(readFileSync(file, 'utf8').split('\n'));
        if (!s.id || !s.cwd || s.tokens < minTokens) continue;
        if (busy(s.id)) continue;
        out.push({ ...s, root, file, idleMin: Math.round(idle) });
      }
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Pull the outcome out of `--output-format stream-json` stdout: the
 * compact_boundary on success, else the host's own refusal text
 * (e.g. "Not enough messages to compact.", which exits 0).
 */
export function parseCompactStream(stdout) {
  let reason = '';
  for (const line of String(stdout).split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const m = o.compact_metadata ?? o.compactMetadata ?? {};
      return { ok: true, pre: m.pre_tokens ?? m.preTokens ?? null, post: m.post_tokens ?? m.postTokens ?? null, trigger: m.trigger ?? null };
    }
    if (o.type === 'system' && o.compact_result === 'failed') reason ||= 'compact_result=failed';
    if (o.type === 'result' && typeof o.result === 'string' && o.result) reason = o.result;
  }
  return { ok: false, error: reason || 'no compact_boundary in output' };
}

/**
 * What the jev hook did, from the ledger lines this run appended. The host's
 * post_tokens is its own estimate and has read 30,944 where the resumed
 * context was 108,317, so the reduction we report is jev's char count.
 * `absent` = the hook never answered: jev-gate is not loaded for that root.
 */
export function jevOutcome(ledgerTail) {
  const lines = String(ledgerTail).split('\n').filter((l) => l.includes('jev-compact:') && !l.includes('registered'));
  const done = lines.find((l) => /backend=\w+, \d+ → \d+ chars/.test(l));
  if (done) {
    const [, before, after] = done.match(/(\d+) → (\d+) chars/);
    return { jev: 'pruned', charsBefore: Number(before), charsAfter: Number(after) };
  }
  const other = lines.find((l) => /fell back|not handling|no provider key|reset via built-in/.test(l));
  if (other) return { jev: 'built-in', note: other.split('jev-compact: ')[1] };
  return { jev: 'absent' };
}

const LEDGER = path.join(os.homedir(), '.openclaw', 'state', 'jev-compact.log');
const ledgerSize = () => { try { return statSync(LEDGER).size; } catch { return 0; } };
const ledgerFrom = (offset) => { try { return readFileSync(LEDGER).subarray(offset).toString('utf8'); } catch { return ''; } };

/** A live claude process holding this session id — never compact under it. */
function busyById(id) {
  return spawnSync('pgrep', ['-f', id], { encoding: 'utf8' }).status === 0;
}

function compactOne(s, claudeBin) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: s.root };
  if (!existsSync(s.cwd)) return { ok: false, error: `cwd gone: ${s.cwd}` };
  const offset = ledgerSize();
  const r = spawnSync(claudeBin, ['-p', '--resume', s.id, '/compact', '--output-format', 'stream-json', '--verbose'],
    { cwd: s.cwd, env, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const jev = jevOutcome(ledgerFrom(offset));
  if (r.status !== 0) return { ok: false, error: `rc=${r.status} ${String(r.stderr || '').slice(0, 200)}`, ...jev };
  return { ...parseCompactStream(r.stdout), ...jev };
}

function parseArgs(argv) {
  const a = { minTokens: 200000, idleMin: 30, roots: [], sessions: [], execute: false, json: false, claude: 'claude', cwd: '', backup: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--execute') a.execute = true;
    else if (k === '--json') a.json = true;
    else if (k === '--min-tokens') a.minTokens = Number(argv[++i]);
    else if (k === '--idle-min') a.idleMin = Number(argv[++i]);
    else if (k === '--root') a.roots.push(argv[++i]);
    else if (k === '--session') a.sessions.push(argv[++i]);
    else if (k === '--claude') a.claude = argv[++i];
    else if (k === '--cwd') a.cwd = argv[++i];
    else if (k === '--backup') a.backup = argv[++i];
    else throw new Error(`unknown option ${k}`);
  }
  if (!(a.minTokens >= 0) || !(a.idleMin >= 0)) throw new Error('--min-tokens/--idle-min must be numbers ≥ 0');
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const roots = a.roots.length ? a.roots : defaultRoots();
  const list = candidates(roots, { minTokens: a.minTokens, idleMin: a.idleMin, busy: busyById })
    .filter((s) => (!a.sessions.length || a.sessions.includes(s.id)) && s.cwd.startsWith(a.cwd));
  const results = [];
  if (a.execute && a.backup) mkdirSync(a.backup, { recursive: true });
  for (const s of list) {
    // Compaction only appends, but a copy makes "put it back" one cp.
    if (a.execute && a.backup) copyFileSync(s.file, path.join(a.backup, path.basename(s.file)));
    const r = a.execute ? compactOne(s, a.claude) : { ok: null };
    results.push({ id: s.id, root: s.root, cwd: s.cwd, tokens: s.tokens, idleMin: s.idleMin, ...r });
    if (!a.json) {
      const how = r.jev === 'pruned' ? `jev ${r.charsBefore} → ${r.charsAfter} chars`
        : r.jev === 'built-in' ? `built-in (${r.note})` : 'jev hook absent — built-in summary';
      const tail = r.ok === null ? 'dry-run'
        : r.ok ? `${how}; host estimate ${r.pre} → ${r.post} tokens` : `FAIL ${r.error}; ${how}`;
      console.log(`${s.id}\t${s.tokens}\t${s.cwd}\t${tail}`);
    }
  }
  if (a.json) console.log(JSON.stringify({ roots, minTokens: a.minTokens, idleMin: a.idleMin, results }, null, 1));
  else console.log(`${list.length} session(s) ≥ ${a.minTokens} tokens, idle ≥ ${a.idleMin} min${a.execute ? '' : ' — add --execute to compact'}`);
  process.exitCode = results.some((r) => r.ok === false) ? 1 : 0;
}

// realpath both sides: macOS /tmp is a symlink, and a plain URL compare skips main() silently.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e.message); process.exitCode = 2; });
}
