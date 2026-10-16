import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { touchedPathsFromLines, gitState, stateEvidence } from '../plugin/lib/state.js';
import { composeEvidence } from '../plugin/hooks/gate.js';

// The point of this evidence source: a turn can print "committed" and have
// committed nothing, and the transcript reads the same either way. These tests
// check the store answers, and that an unanswerable store never decides.

const line = (o) => `${JSON.stringify(o)}\n`;
const assistantEdit = (...paths) => line({
  type: 'assistant',
  message: { content: paths.map((p, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: p } })) },
});
const toolResult = (text) => line({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
const prompt = (text) => line({ type: 'user', message: { content: text } });

// --- touchedPathsFromLines -------------------------------------------------

{
  const lines = [
    prompt('older turn'),
    assistantEdit('/tmp/old.js'),
    prompt('this round'),
    assistantEdit('/tmp/a.js', '/tmp/b.js'),
    toolResult('ok'),
    assistantEdit('/tmp/a.js'),
  ].join('').split('\n');
  const got = touchedPathsFromLines(lines);
  assert.deepEqual(got, ['/tmp/a.js', '/tmp/b.js'], 'this round only, deduped');
  assert.ok(!got.includes('/tmp/old.js'), 'the previous round is not this round');
}

{
  // Reads and Bash calls are not edits; a round that claimed nothing has no
  // paths, and then this source must stay silent rather than guess.
  const lines = [
    prompt('go'),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('').split('\n');
  assert.deepEqual(touchedPathsFromLines(lines), []);
}

{
  // Overflow keeps the newest edits, like evidenceFromLines keeps the newest
  // rounds: a completion claim is about what just happened.
  const many = Array.from({ length: 30 }, (_, i) => `/tmp/f${i}.js`);
  const lines = [prompt('go'), assistantEdit(...many)].join('').split('\n');
  const got = touchedPathsFromLines(lines, 5);
  assert.deepEqual(got, ['/tmp/f25.js', '/tmp/f26.js', '/tmp/f27.js', '/tmp/f28.js', '/tmp/f29.js']);
}

{
  // Garbage lines and a relative path must not throw or leak through.
  const lines = ['not json', '', line({ type: 'assistant', message: { content: 'plain' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'rel.js' } }] } })].join('\n').split('\n');
  assert.deepEqual(touchedPathsFromLines(lines), [], 'only absolute paths are answerable');
}

// --- gitState --------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'jev-state-'));
try {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const g = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');

  const committed = join(repo, 'committed.txt');
  const untouched = join(repo, 'untouched.txt');
  // A tracked file edited but not staged. Porcelain writes it " M path": the
  // worktree code sits in the second column, so trimming the output shifts the
  // path by one character and the file reads as unchanged — which, once this
  // source reaches the judge, is evidence against a claim that was true. The
  // "aa-" prefix keeps it on the first line, where only trimming can hurt it.
  const modified = join(repo, 'aa-modified.txt');
  writeFileSync(committed, 'one\n');
  writeFileSync(untouched, 'same\n');
  writeFileSync(modified, 'before\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  // A second commit so `untouched.txt` is neither dirty nor in HEAD — the exact
  // shape of a file a claim says it edited and the store says it did not.
  writeFileSync(committed, 'two\n');
  writeFileSync(modified, 'mid\n');
  g('add', '-A');
  g('commit', '-qm', 'second');

  // Left dirty after the last commit: one tracked, one never added.
  writeFileSync(modified, 'after\n');
  const dirty = join(repo, 'dirty.txt');
  writeFileSync(dirty, 'new\n');
  const gone = join(repo, 'never-written.txt');

  const { text, stats } = gitState([committed, untouched, dirty, gone, modified]);

  assert.match(text, /aa-modified\.txt: uncommitted change, git status " M"/,
    'an unstaged edit to a tracked file is a change, whatever column the code sits in');
  assert.ok(!/aa-modified\.txt: UNCHANGED/.test(text), 'never invent a contradiction');
  assert.match(text, /committed\.txt: present in HEAD commit/);
  assert.match(text, /untouched\.txt: UNCHANGED: identical to HEAD and not in the HEAD commit/);
  assert.match(text, /dirty\.txt: uncommitted change, git status "\?\?"/);
  assert.match(text, /never-written\.txt: MISSING on disk/);
  assert.match(text, /^=== state \(git\)/);
  assert.ok(!text.includes('one') && !text.includes('two'), 'file contents never reach the judge');

  assert.equal(stats.repos, 1);
  assert.equal(stats.paths, 5);
  assert.equal(stats.unchanged, 1);
  assert.equal(stats.missing, 1);
  assert.equal(stats.changed, 3, 'committed, dirty and modified all count as answered');
  assert.equal(stats.changed + stats.unchanged + stats.missing, stats.paths,
    'one bucket per path, or the ledger counts cannot be read');

  // Nothing claimed, nothing said.
  assert.equal(gitState([]).text, '');
  // A path with no repo above it is counted, not thrown on, and says nothing
  // to the judge; one that vanished still does.
  const outside = join(root, 'loose.txt');
  writeFileSync(outside, 'x\n');
  const loose = gitState([outside]);
  assert.equal(loose.text, '', 'no repo, no line for the judge');
  assert.equal(loose.stats.changed, 1, 'still counted in the ledger');
  assert.match(gitState([join(root, 'gone.txt')]).text, /MISSING on disk/);

  // An unreadable transcript degrades to silence, never an exception.
  assert.equal(stateEvidence('/nonexistent/transcript.jsonl').text, '');
  assert.equal(stateEvidence(undefined).text, '');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- composeEvidence -------------------------------------------------------

assert.equal(composeEvidence('tools', 'STATE', true), 'tools', 'shadow withholds state from the judge');
{
  const out = composeEvidence('tools', 'STATE', false);
  assert.ok(out.startsWith('STATE'), 'state leads: it is the harder witness');
  assert.match(out, /this round's tool output/);
  assert.match(out, /tools$/);
}
assert.equal(composeEvidence('tools', '', false), 'tools', 'no state, no scaffolding');
assert.equal(composeEvidence('  ', 'STATE', false), 'STATE', 'state alone is still evidence');
assert.equal(composeEvidence(undefined, '', false), '', 'nothing to judge stays nothing, so the gate fails open');

console.log('ok: state evidence reads the store, withholds content, and fails open');
