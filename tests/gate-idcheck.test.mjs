import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// handleStop resolves ${HOME} at import time (DEFAULT_CONFIG) and appends every
// idcheck hit to cfg.gateLog — point both at a scratch dir before importing,
// like coexist.test.mjs does.
const SCRATCH = mkdtempSync(join(tmpdir(), 'jev-gate-idcheck-'));
process.env.HOME = SCRATCH;

const { unsupportedIds, idBlock } = await import('../plugin/lib/idcheck.js');
const { readEvidence } = await import('../plugin/lib/transcript.js');
const { handleStop } = await import('../plugin/hooks/gate.js');
const { DEFAULT_CONFIG } = await import('../plugin/lib/judge.js');

// The case that motivated this: an issue URL reported as created, with no
// `gh issue create` anywhere in the round. The judge calls that `not_addressed`
// and lets it through, so the deterministic check has to be the one that stops.
const fab = unsupportedIds(
  'Issue 已開：https://github.com/royalskynet/fixindex/issues/10',
  'total 4\n-rw-r--r-- 1 me staff 120 Sep 29 17:00 README.md',
);
assert.deepEqual(fab, ['https://github.com/royalskynet/fixindex/issues/10']);
assert.equal(idBlock(fab).decision, 'block');
assert.match(idBlock(fab).reason, /only be quoted/);

// Quoted from the tool output -> silent.
assert.deepEqual(
  unsupportedIds(
    'Issue 已開：https://github.com/royalskynet/fixindex/issues/10',
    'https://github.com/royalskynet/fixindex/issues/10\n',
  ),
  [],
);

// `gh issue view --json` prints repo and number in separate fields and never a
// URL. A URL assembled from those is quoted, not invented.
assert.deepEqual(
  unsupportedIds(
    'See https://github.com/NandhaKishorM/laya/issues/156',
    '{"repository":{"name":"laya"},"number":156,"title":"noul labels"}',
  ),
  [],
);
// ...but a stray digit elsewhere in the output must not launder a made-up number.
assert.deepEqual(
  unsupportedIds(
    'See https://github.com/NandhaKishorM/laya/issues/156',
    'cloned laya, 156 files changed',
  ),
  ['https://github.com/NandhaKishorM/laya/issues/156'],
);

// A short hash quoted from a full one in the output is the same commit.
assert.deepEqual(
  unsupportedIds('pushed 2e0abb5', '[main 2e0abb5f1c9d4e7a8b3c2d1e0f9a8b7c6d5e4f3a] report'),
  [],
);
assert.deepEqual(unsupportedIds('pushed 2e0abb5', 'nothing to commit'), ['2e0abb5']);

// Measured false-positive classes, all of which must stay silent.

// Markdown emphasis inside a number: `540,524,**682**` otherwise reads as a
// separate short token and the formatting manufactures its own hit.
assert.deepEqual(unsupportedIds('540,524,**682** bytes', 'size 540524682'), []);
// Computed numbers are absent from every output by construction.
assert.deepEqual(unsupportedIds('省下約 26,500 token，約 4.25%', 'x'), []);
// Hex-shaped but not a hash.
assert.deepEqual(unsupportedIds('port 1234567', 'nothing'), []);
// Documentation placeholders are examples, not results.
assert.deepEqual(unsupportedIds('e.g. https://github.com/org/repo/issues/1234', 'nothing'), []);

// Fail open: no evidence means nothing to judge, never a block.
assert.deepEqual(unsupportedIds('https://github.com/a/b/issues/1', ''), []);
assert.deepEqual(unsupportedIds('', 'anything'), []);
assert.equal(idBlock([]), undefined);

// Issue #12 regression: the two live false positives. readEvidence walks the
// transcript backwards and unshifts each tool result, so the join is
// chronological — and slice(0, maxChars) then cut the NEWEST rounds, the ones
// a claim quotes from. Both blocked hashes (a push output, two `fixindex fi`
// commit outputs) were the newest tool results at block time and got truncated
// off the tail the moment the collected text exceeded the window. The window
// must overflow off the oldest end.
const prompt = (text) => JSON.stringify({ type: 'user', message: { content: text } });
const round = (text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
const mkTranscript = (name, lines) => {
  const p = join(SCRATCH, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

// The mechanism, minimal: an old round fills a small window, the newest tool
// result carries the hash being quoted.
const tpSmall = mkTranscript('fp-small.jsonl', [
  prompt('do the work'),
  round('x'.repeat(400)),
  round('ce215ca..9d1a190  main -> main'),
]);
const evSmall = readEvidence(tpSmall, 300, { allRounds: true });
assert.match(evSmall, /9d1a190/, 'the newest tool result stays inside the window');
assert.deepEqual(
  unsupportedIds('落地完成，`9d1a190` 已推。', evSmall),
  [],
  'a hash quoted from the newest tool result is not a fabrication',
);

// End-to-end at the real 400000-char window: old rounds hold more tool output
// than the window can keep, and the commit hash appears only in the newest
// result. With idcheckShadow off, the pre-fix slice blocked this honest quote.
const tpLive = mkTranscript('fp-live.jsonl', [
  prompt('earlier work'),
  round('q'.repeat(410000)),
  prompt('push it'),
  round('To https://github.com/royalskynet/oc-agent.git\n   ce215ca..9d1a190  main -> main'),
]);
const savedShadow = DEFAULT_CONFIG.shadow;
const savedIdcheckShadow = DEFAULT_CONFIG.idcheckShadow;
DEFAULT_CONFIG.shadow = false;
DEFAULT_CONFIG.idcheckShadow = false;
try {
  const honest = await handleStop({
    hook_event_name: 'Stop',
    last_assistant_message: '落地完成，`9d1a190` 已推。',
    transcript_path: tpLive,
  });
  assert.equal(honest, undefined, 'an honestly quoted hash must not block');

  // The control: a hash that appears in no tool output still blocks.
  const invented = await handleStop({
    hook_event_name: 'Stop',
    last_assistant_message: '落地完成，`deadbee` 已推。',
    transcript_path: tpLive,
  });
  assert.equal(invented?.decision, 'block', 'a hash absent from every tool output is still an invented result');
} finally {
  DEFAULT_CONFIG.shadow = savedShadow;
  DEFAULT_CONFIG.idcheckShadow = savedIdcheckShadow;
}

// Issue #12 shadow log, 2026-09-30..10-02: 5 hits, 4 false. Each shape below
// was quoted verbatim from a tool output the old \b{7,40} scan could not see.
const sha256 = '8432a99c0513c484554cbd2b2adb09d4c2a6f05fd70ecd982007cecb78ec0a11';
assert.deepEqual(unsupportedIds('回 `match 8432a99c…`', `mismatch actual=${sha256}`), [], '64-hex sha256');
assert.deepEqual(unsupportedIds('sha256 前 8 碼 `8a9f4c27`', '--- 前8碼 ---\ntoken_8a9f4c27'), [], 'word char before the hex');
// ...and the one true hit (4fb3ac9: "已推" with no commit or push in the round) still flags.
assert.deepEqual(unsupportedIds('已推（`4fb3ac9`）', `rc=0\nguard verdict: soft\n${sha256}`), ['4fb3ac9']);

// A session id prefix the model read from SessionStart hook context is quoted.
const tpHook = join(SCRATCH, 'hook-context.jsonl');
writeFileSync(tpHook, [
  { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['recent-sessions:\n  2026-09-30 09:13:29  83ed4d3d  /Users/me'] } },
  { type: 'user', message: { content: 'resume that session' } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
].map((r) => JSON.stringify(r)).join('\n'));
assert.deepEqual(unsupportedIds('session `83ed4d3d` 已接回', readEvidence(tpHook, 400000, { allRounds: true })), []);
// Per-round evidence (the Jev judge) stays tool output only.
assert.doesNotMatch(readEvidence(tpHook), /83ed4d3d/);

console.log('ok: invented ids block, quoted ids pass, measured false-positive classes stay silent');
