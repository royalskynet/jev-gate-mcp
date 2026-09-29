import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactMessages,
  verifyCompletion,
  reviewDiff,
  deterministicSeverity,
  boundEvidence,
  riskFilter,
  parseGitDiff,
  route,
  EmptyCandidatesError,
} from '../../agent-glue/src/index.js';

const big = 'y'.repeat(5000);
const bigArgs = () => JSON.stringify({ command: 'x'.repeat(200) });
const pairMsg = () => [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: bigArgs() } }] },
  { role: 'tool', tool_call_id: 'c1', content: big },
  { role: 'assistant', content: 'done' },
];

test('compact: verbatim when judged keep, and when no candidate to drop', async () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const r = await compactMessages({ messages: msgs, judge: async () => 'keep' });
  assert.deepEqual(r.messages, msgs);
  assert.equal(r.compacted, false);
  assert.equal(r.reducedBy, 0);
});

test('compact: user/assistant prose never stripped; only call args + result', async () => {
  const r = await compactMessages({ messages: pairMsg(), judge: async () => 'drop', minReductionChars: 100, pinFirst: 1, pinLast: 1 });
  assert.equal(r.messages[0].content, 'hi');
  assert.equal(r.messages[1].content, 'ok'); // assistant prose verbatim
  assert.match(r.messages[1].tool_calls[0].function.arguments, /^\[jev-compact: dropped /);
  assert.match(r.messages[2].content, /^\[jev-compact: dropped /); // paired result dropped
  assert.equal(r.compacted, true);
  assert.ok(r.reducedBy >= 100);
});

test('compact: call/result pairing — drop never leaves a lone result', async () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'Grep', arguments: JSON.stringify({ pattern: 'z'.repeat(100) }) } }] },
    { role: 'tool', tool_call_id: 'c2', content: big },
    { role: 'assistant', content: 'done' },
  ];
  const r = await compactMessages({ messages: msgs, judge: async () => 'drop', minReductionChars: 100, pinFirst: 1, pinLast: 1 });
  const resultIdx = msgs.findIndex((m) => m.role === 'tool');
  assert.match(r.messages[resultIdx].content, /^\[jev-compact: dropped /, 'result must be paired-stripped');
  // A dropped site strips the call message AND its paired result together,
  // never leaving a lone result while the call survives.
  assert.match(r.messages[1].tool_calls[0].function.arguments, /^\[jev-compact: dropped /, 'call args must be paired-stripped too');
});

test('compact: pinning keeps first and last untouched even when judge drops', async () => {
  const seq = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'Bash', arguments: big } }] },
    { role: 'tool', tool_call_id: 'c', content: big },
    { role: 'user', content: 'last' },
  ];
  const r = await compactMessages({ messages: seq, judge: async () => 'drop', minReductionChars: 100, pinFirst: 1, pinLast: 1 });
  assert.equal(r.messages[0].content, 'first');
  assert.equal(r.messages[3].content, 'last');
  assert.match(r.messages[1].tool_calls[0].function.arguments, /^\[jev-compact: dropped /);
  assert.match(r.messages[2].content, /^\[jev-compact: dropped /);
});

test('compact: fail-open — judge throw aborts the WHOLE pass verbatim', async () => {
  const msgs = pairMsg();
  const r = await compactMessages({ messages: msgs, judge: async () => { throw new Error('down'); }, minReductionChars: 100 });
  assert.deepEqual(r.messages, msgs);
  assert.equal(r.compacted, false);
  assert.equal(r.reducedBy, 0);
});

test('compact: any judge throw globally fail-opens — earlier drops are not partially applied', async () => {
  // Two call sites: the first would drop, the second throws. A partial pass
  // would strip the first and keep the second; the contract is that any judge
  // failure aborts the entire pass, never a partial rewrite.
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'ok1', function: { name: 'Bash', arguments: bigArgs() } }] },
    { role: 'tool', tool_call_id: 'ok1', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 'bad2', function: { name: 'Grep', arguments: bigArgs() } }] },
    { role: 'tool', tool_call_id: 'bad2', content: big },
    { role: 'user', content: 'end' },
  ];
  let calls = 0;
  const r = await compactMessages({
    messages: msgs,
    minReductionChars: 100,
    pinFirst: 1,
    pinLast: 1,
    judge: async () => {
      calls++;
      if (calls === 1) return 'drop';
      throw new Error('provider down');
    },
  });
  assert.deepEqual(r.messages, msgs);
  assert.equal(r.compacted, false);
  assert.equal(r.messages[2].content, big, 'first site must not be partially stripped');
});

test('compact: below minReductionChars returns ORIGINAL messages, not a partial rewrite', async () => {
  const msgs = pairMsg();
  const r = await compactMessages({ messages: msgs, judge: async () => 'drop', minReductionChars: Number.MAX_SAFE_INTEGER });
  assert.equal(r.compacted, false);
  assert.deepEqual(r.messages, msgs, 'host falls back without a partial strip');
});

test('compact: multiple tool_calls on one assistant message share one call-site judgment', async () => {
  // One assistant message carries two calls; the judge sees BOTH summarized as
  // one call site (per-call-site aggregation), and a drop strips all of them
  // together rather than judging one and dropping the other.
  const msgs = [
    { role: 'user', content: 'a' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'm1', function: { name: 'Bash', arguments: bigArgs() } },
        { id: 'm2', function: { name: 'Grep', arguments: bigArgs() } },
      ],
    },
    { role: 'tool', tool_call_id: 'm1', content: big },
    { role: 'tool', tool_call_id: 'm2', content: big },
    { role: 'user', content: 'end' },
  ];
  let judgedSites = 0;
  const r = await compactMessages({
    messages: msgs,
    minReductionChars: 100,
    pinFirst: 1,
    pinLast: 1,
    judge: async (site) => {
      judgedSites++;
      assert.equal(site.calls.length, 2, 'judge sees both calls at the call site');
      return 'drop';
    },
  });
  assert.equal(judgedSites, 1, 'one assistant message == one judgment, not two');
  assert.match(r.messages[1].tool_calls[0].function.arguments, /^\[jev-compact: dropped /);
  assert.match(r.messages[1].tool_calls[1].function.arguments, /^\[jev-compact: dropped /);
  assert.match(r.messages[2].content, /^\[jev-compact: dropped /);
  assert.match(r.messages[3].content, /^\[jev-compact: dropped /);
});

test('compact: a short transcript with default pinLast stays fully verbatim (pinning covers it)', async () => {
  // Documenting the contract: a transcript shorter than the pin window pins
  // everything, so judge verdicts never apply. This is expected fail-safe
  // behaviour, not a bug — short contexts are already cheap.
  const msgs = pairMsg(); // 4 messages, default pinLast=8 pins all
  const r = await compactMessages({ messages: msgs, judge: async () => 'drop', minReductionChars: 100 });
  assert.deepEqual(r.messages, msgs);
  assert.equal(r.compacted, false);
  assert.equal(r.reducedBy, 0);
});

test('verify: no execution evidence -> unknown (model self-report is not evidence)', async () => {
  const r = await verifyCompletion({ claim: 'task is done, I fixed it', evidence: [] });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.note, 'no-execution-evidence');
});

test('verify: any failed execution record -> fail', async () => {
  const r = await verifyCompletion({ claim: 'done', evidence: [{ kind: 'test', text: '1 failing', ok: false }] });
  assert.equal(r.verdict, 'fail');
});

test('verify: passing executable evidence -> pass with locatable evidence', async () => {
  const r = await verifyCompletion({ claim: 'done', evidence: [{ kind: 'Bash', path: 'tests/a.test.js', text: 'pass', ok: true }] });
  assert.equal(r.verdict, 'pass');
  assert.ok(r.evidence[0].path === 'tests/a.test.js');
});

test('verify: pass always cites auditable command/log evidence, file:line only when present', async () => {
  const r = await verifyCompletion({
    claim: 'done',
    evidence: [
      { kind: 'Bash', text: '135 tests, 3 failing', ok: true },
      { kind: 'Bash', path: 'src/app.ts', line: 12, text: 'lint clean', ok: true },
    ],
  });
  assert.equal(r.verdict, 'pass');
  assert.ok(r.evidence.length >= 2, 'pass evidence is never empty');
  const noPath = r.evidence.find((e) => !e.path);
  const withFile = r.evidence.find((e) => e.path);
  assert.ok(noPath && typeof noPath.text === 'string', 'command/log evidence kept without a path');
  assert.ok(withFile && withFile.path === 'src/app.ts' && withFile.line === 12, 'file:line kept when present');
});

test('verify: incomplete evidence (no ok flag) -> unknown even with records', async () => {
  const r = await verifyCompletion({ claim: 'done', evidence: [{ kind: 'Bash', text: 'something ran' }] });
  assert.equal(r.verdict, 'unknown');
});

test('verify: a Jev judge failure never turns a deterministic pass into unknown', async () => {
  const r = await verifyCompletion({
    claim: 'done',
    evidence: [{ kind: 'Bash', text: 'ok', ok: true }],
    judge: async () => { throw new Error('jev down'); },
  });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.jev, null);
});

test('verify: laya noul is advisory, verdict untouched even on failure', async () => {
  const r = await verifyCompletion({
    claim: 'done',
    evidence: [{ kind: 'Bash', text: 'ok', ok: true }],
    layaNoul: true,
  });
  assert.equal(r.verdict, 'pass', 'laya noul must never change the verdict');
  assert.ok(r.laya === null || typeof r.laya.noul === 'number', 'advisory result is null or a numeric noul');
});

test('verify: layaNoulCheck returns a numeric noul from a working local judge', async () => {
  const { layaNoulCheck } = await import('../../agent-glue/src/verify.js');
  const stub = async () => ({ noul: { type: 'noul', noul: 0.9 } });
  const r = await layaNoulCheck({ claim: 'done', evidence: [] }, stub);
  assert.equal(r.noul, 0.9);
});

test('verify: layaNoulCheck returns null on judge failure', async () => {
  const { layaNoulCheck } = await import('../../agent-glue/src/verify.js');
  const bad = async () => { throw new Error('laya down'); };
  assert.equal(await layaNoulCheck({ claim: 'done', evidence: [] }, bad), null);
});

test('review: staged order — risk filter first, empty pass -> skip', async () => {
  const r = await reviewDiff({ files: [{ path: 'docs/note.txt', added: 3 }], riskThreshold: 100 });
  assert.equal(r.stage, 'risk-filter');
  assert.equal(r.route, 'skip');
  assert.equal(r.files.length, 0);
});

test('review: engine file profiles drive deterministic severity and reviewer route', async () => {
  const r = await reviewDiff({
    files: [
      { path: 'b.sh', added: 120 },
      { path: 'c.py', added: 120 },
      { path: 'd.js', added: 120 },
      { path: 'e.ts', added: 120 },
      { path: 'f.go', added: 120 },
    ],
    riskThreshold: 100,
  });
  assert.equal(r.stage, 'review');
  assert.equal(r.severity, 'high');
  assert.equal(r.route, 'senior');
  assert.equal(r.files.length, 5);
});

test('review: Jev severity opinion is advisory only — never moves deterministic severity or route', async () => {
  const files = [{ path: 'b.py', added: 120 }, { path: 'c.ts', added: 120 }, { path: 'd.go', added: 120 }]; // engine files -> medium
  const base = await reviewDiff({ files, riskThreshold: 100 });
  assert.equal(base.severity, 'medium');
  assert.equal(base.route, 'peer');
  const withJev = await reviewDiff({
    files,
    riskThreshold: 100,
    jev: async () => ({ severity: 'critical', confidence: 0.99 }),
  });
  // Jev's critical opinion is recorded as advisory but must not escalate the
  // deterministic severity/route while every policy is shadow/uncalibrated.
  assert.equal(withJev.severity, 'medium');
  assert.equal(withJev.route, 'peer');
  assert.equal(withJev.jev.severity, 'critical');
  assert.equal(withJev.jev.confidence, 0.99);
});

test('review: real git diff parses into files with additions, removals and hunks', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 123..456 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,5 +1,7 @@',
    ' unchanged',
    '+function run() {',
    '+  return 1;',
    '-let old = 2;',
    ' context',
  ].join('\n');
  const files = parseGitDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/app.ts');
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 1);
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].lines.filter((l) => l.kind === '+').length, 2);
});

test('review: sensitive path always passes the risk filter regardless of size', async () => {
  const r = await reviewDiff({
    files: [{ path: '.env', added: 2 }, { path: '.env.example', added: 2 }],
    riskThreshold: 100, // small diff that would normally skip
  });
  assert.equal(r.stage, 'review');
  assert.equal(r.severity, 'high'); // sensitive -> high deterministic severity
  assert.equal(r.route, 'senior');
});

test('review: a removals-heavy change still counts toward review risk', () => {
  const risky = riskFilter([{ path: 'x.ts', added: 10, removed: 200 }], 100);
  assert.equal(risky.length, 1);
});

test('review: evidence bounding is deterministic', () => {
  const hunks = Array.from({ length: 12 }, (_, h) => ({ hunk: h, lines: Array.from({ length: 60 }, (_, l) => `l${l}`) }));
  const b = boundEvidence(hunks, 8, 40);
  assert.equal(b.length, 8);
  assert.equal(b[0].lines.length, 40);
});

test('route: empty candidates throw; no_match wins fails open to no dispatch', async () => {
  await assert.rejects(route({ candidates: [] }), EmptyCandidatesError);
});

test('route: model unavailable -> fail-open no_match, never a forced pick', async () => {
  const r = await route({
    candidates: ['Bash', 'Read'],
    userRequest: 'x',
    scorer: async () => { throw new Error('no model'); },
  });
  assert.equal(r.no_match, true);
  assert.equal(r.reason, 'jev-unavailable');
});
