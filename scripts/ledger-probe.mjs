#!/usr/bin/env node
/**
 * Is the prune hook alive in *this* session?
 *
 * Nothing in this repo can answer that from the outside. Every instrument the
 * plugin has lives inside a hook that core may never have loaded — and a hook
 * that was never loaded is silent in exactly the same way as one that looked
 * at a result and decided not to prune it. The only signal that separates them
 * is a new line in the ledger, and only a real tool call through a real
 * session can produce one.
 *
 * So this script does the two halves a script can do, and hands the middle
 * back to the agent driving the session:
 *
 *   node scripts/ledger-probe.mjs        # write a fixture, remember the ledger
 *   <read the fixture with the Read tool>
 *   node scripts/ledger-probe.mjs check  # did a line appear?
 *
 * Read, not Bash: core persists any Bash or Grep result over ~8 KB to
 * `tool-results/<id>.txt` and hands the hook a ~2 KB preview, so a Bash probe
 * measures core's spill threshold instead of ours. Read is delivered whole.
 *
 * ponytail: state is one file next to the fixture, not a database.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG, LEDGER } from '../hooks/jev.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const FIXTURE = join(tmpdir(), 'jev-ledger-probe.txt');
const STATE = `${FIXTURE}.baseline`;

const ledgerLines = () => {
  try {
    return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The whole probe without a human: `claude -p --plugin-dir` always loads the
 * plugin fresh from disk, so a fix is measurable in the session that made it
 * rather than in the next one someone remembers to open. `--debug` is what
 * turns a silent hook into a named reason: the engine writes
 * `hooks module <plugin> failed to load: <error>` to the debug log, which is
 * the one signal `claude plugin validate` cannot give (it reads the source
 * statically, so a `process` reference passes it and dies at load).
 */
/** `2.1.278 (Claude Code)` -> [2, 1, 278]; null when the binary will not say. */
function versionOf(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  const m = r.status === 0 && /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const MIN_VERSION = [2, 1, 274];
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The newest claude on this machine, not merely the one that spawned us.
 * `$CLAUDE_CODE_EXECPATH` is whatever wrapper is hosting this session — inside
 * Happy that is its own bundled copy, two releases behind the `claude` on PATH
 * — and an older binary refuses the module on the first event name it does not
 * know (`"session.compact" is not an event`), which reads in the debug log
 * exactly like the load failure this probe exists to catch. So pick by version
 * and say which, rather than blaming the hooks module for the host.
 */
function newestClaude() {
  const seen = [];
  let best = null;
  for (const bin of [process.env.JEV_CLAUDE_BIN, process.env.CLAUDE_CODE_EXECPATH, 'claude']) {
    if (!bin) continue;
    const v = versionOf(bin);
    if (!v) continue;
    seen.push(`${bin} ${v.join('.')}`);
    if (!best || cmp(v, best.v) > 0) best = { bin, v };
  }
  if (!best) {
    console.error('ledger-probe: no runnable claude binary found (tried $JEV_CLAUDE_BIN, $CLAUDE_CODE_EXECPATH, claude).');
    process.exit(2);
  }
  if (cmp(best.v, MIN_VERSION) < 0) {
    console.error(`ledger-probe: function hooks need >= ${MIN_VERSION.join('.')}; newest available is ${best.bin} ${best.v.join('.')}.`);
    console.error(`  candidates: ${seen.join(', ')}`);
    console.error('  This is a host problem, not a hook problem — nothing about the module is proven either way.');
    process.exit(2);
  }
  return best.bin;
}

function e2e() {
  const before = ledgerLines().length;
  const claude = newestClaude();
  console.log(`binary   ${claude}`);
  const r = spawnSync(claude, [
    '-p', '--debug',
    '--plugin-dir', PLUGIN_DIR,
    '--settings', '{"sandbox":{"enabled":false}}',
    `Use the Read tool to read ${FIXTURE} in full (no limit, no offset). Then reply with only the number of lines you received.`,
  ], {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
  });
  if (r.error) {
    console.error(`ledger-probe: could not run ${claude}: ${r.error.message}`);
    process.exit(2);
  }
  const added = ledgerLines().slice(before);
  if (added.length) {
    console.log(`PASS  ${added.length} new ledger line(s) in ${LEDGER}:`);
    for (const l of added) console.log(`  ${l}`);
    process.exit(0);
  }
  console.log(`FAIL  no new line in ${LEDGER} after a headless session.`);
  console.log('The fifth cause, the one the README\'s four cannot tell apart: the');
  console.log('hooks module failed to load. Read the newest file in ~/.claude/debug');
  console.log('for a line beginning `hooks module` — it names the error.');
  process.exit(1);
}

if (process.argv[2] === 'e2e') {
  writeFixture();
  e2e();
}

if (process.argv[2] === 'check') {
  if (!existsSync(STATE)) {
    console.error('ledger-probe: no baseline; run without arguments first.');
    process.exit(2);
  }
  // The baseline is only meaningful for the ledger it was taken against: a run
  // with JEV_LEDGER pointed elsewhere leaves a count from a different file, and
  // slicing the real ledger by it reports every existing line as new.
  const [ledgerAtBaseline, count] = readFileSync(STATE, 'utf8').split('\n');
  if (ledgerAtBaseline !== LEDGER) {
    console.error(`ledger-probe: baseline was taken against ${ledgerAtBaseline}, not ${LEDGER}.`);
    console.error('Run without arguments again to re-baseline.');
    process.exit(2);
  }
  const before = Number(count);
  if (!Number.isInteger(before)) {
    console.error(`ledger-probe: unreadable baseline in ${STATE}; run without arguments first.`);
    process.exit(2);
  }
  const lines = ledgerLines();
  const added = lines.slice(before);
  if (added.length) {
    console.log(`PASS  ${added.length} new ledger line(s) in ${LEDGER}:`);
    for (const l of added) console.log(`  ${l}`);
    process.exit(0);
  }
  console.log(`FAIL  no new line in ${LEDGER} (still ${lines.length}).`);
  console.log('Work down the five causes in README "An empty ledger", in order:');
  console.log('  1. "$CLAUDE_CODE_EXECPATH" --version  >= 2.1.274, and it is not');
  console.log('     necessarily the `claude` on PATH — a wrapper ships its own copy.');
  console.log('  2. npm run validate:hooks  — plain `plugin validate` takes the');
  console.log('     marketplace branch and never opens the module. Also check which');
  console.log('     copy runs: ~/.claude/plugins/cache/<name>/<name>/<version>/ is a');
  console.log('     version-keyed snapshot, so editing this repo changes nothing.');
  console.log('  3. CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in the session env.');
  console.log(`  4. Was the fixture read with the Read tool? ${FIXTURE}`);
  console.log(`  5. A jev-nokey line would mean ${CONFIG.apiKeyFile} is unreadable.`);
  process.exit(1);
}

// A fixture the judge should mostly drop: repeated noise around one real line.
// Just over the threshold, not comfortably over — the reader pays for every
// byte of it in context, and nothing here is measuring size.
function writeFixture() {
  const noise = 'GET /health 200 0.4ms upstream=api-7 pool=idle\n';
  const signal = 'ERROR: connection refused on port 5432\n';
  const half = noise.repeat(Math.ceil((CONFIG.chunkChars * 0.6) / noise.length));
  writeFileSync(FIXTURE, half + signal + half);
  return half.length * 2 + signal.length;
}

const chars = writeFixture();

const before = ledgerLines().length;
writeFileSync(STATE, `${LEDGER}\n${before}`);

console.log(`fixture  ${FIXTURE}  ${chars.toLocaleString()} chars`);
console.log(`ledger   ${LEDGER}  ${before} line(s) now`);
console.log('');
console.log('Now read that fixture with the Read tool — the whole file, no limit —');
console.log('then run:  node scripts/ledger-probe.mjs check');
