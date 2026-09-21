#!/usr/bin/env node
/**
 * Live capability probe — does each Jev capability actually reach the model,
 * and how well does it do once it gets there?
 *
 * The unit tests answer "is the logic right" with fake transports. This
 * answers the other half: "is the live wire connected, and what is the
 * measured degree". Every probe below hits the real provider; a capability
 * that fail-opens without ever making a request is reported as NOT-LIVE, which
 * is the failure mode fake transports hide.
 *
 * ponytail: one file, asserts + a printed table, no framework.
 *
 *   node scripts/live-probe.mjs            # all probes
 *   node scripts/live-probe.mjs triage     # one probe by name
 */
import { readFileSync } from 'node:fs';
import { buildGateway } from '../gateway/src/config.js';
import { makeGatewayTransport } from '../agent-glue/src/client.js';
import { makeJudge, getModel } from '../plugin/lib/judge.js';
import { makeScorer } from '../plugin/lib/route.js';
import { route } from '../plugin/lib/route.js';
import { triage } from '../agent-glue/src/triage.js';
import { compactMessages } from '../agent-glue/src/compact.js';
import { verifyCompletion } from '../agent-glue/src/verify.js';
import { reviewDiff } from '../agent-glue/src/review.js';
import { pruneText, chunkLines } from '../hooks/jev.js';

const only = process.argv[2] ?? null;
const rows = [];
const t = () => Date.now();

function row(capability, live, cases, correct, degree, ms, note = '') {
  rows.push({ capability, live, cases, correct, degree, ms, note });
}

/** Count provider requests by wrapping a transport/judge. */
function counted(fn) {
  const c = { n: 0 };
  const wrapped = async (...a) => { c.n++; return fn(...a); };
  return [wrapped, c];
}

const KEY_FILE = process.env.JEV_API_KEY_FILE
  ?? `${process.env.HOME}/.creds/kv/OPENROUTER_API_KEY.txt`;
try {
  readFileSync(KEY_FILE, 'utf8');
} catch {
  console.error(`live-probe: no credential at ${KEY_FILE}; nothing to measure.`);
  process.exit(2);
}

const { gateway } = buildGateway();
const transport = makeGatewayTransport(gateway);

// ---------------------------------------------------------------- 1. prune
async function probePrune() {
  const signal = 'ERROR: connection refused on port 5432';
  const noise = Array.from({ length: 300 }, (_, i) =>
    `[info] heartbeat ${i} ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok`).join('\n');
  const text = `${noise}\n${signal}\n${noise}`;
  const [judge, c] = counted(makeJudge());
  const t0 = t();
  const ask = async (chunk) => judge({ user_request: 'why does the database connection fail?', chunk });
  const out = await pruneText(text, ask);
  const ms = t() - t0;
  const kept = out.kept;
  const shrank = kept.length < text.length;
  const keptSignal = kept.includes(signal);
  // Second case: chunks that carry no signal at all. Separates "the hook is
  // broken" from "the hook fires but judges at 16 KB chunk granularity".
  const pureNoise = `${noise}\n${noise}`;
  const out2 = await pruneText(pureNoise, ask);
  const cut2 = Math.round(100 - out2.kept.length / pureNoise.length * 100);
  row('prune (hooks/jev.js)', c.n > 0, 2, ((shrank && keptSignal) ? 1 : 0) + (cut2 > 0 ? 1 : 0),
    `mixed chunk: ${text.length}->${kept.length} (${Math.round(100 - kept.length / text.length * 100)}% cut, signal kept=${keptSignal}); ` +
    `pure noise: ${pureNoise.length}->${out2.kept.length} (${cut2}% cut)`,
    ms, `${c.n} jev calls, ${chunkLines(text).length} chunks @${16000} chars`);
}

// ---------------------------------------------------------------- 2. route
const ROUTE_CASES = [
  { req: 'rename this variable across three files', want: 'main' },
  { req: 'audit the whole repo for unused dependencies and write a report', want: 'deep' },
  { req: 'this change touches the auth token refresh path', want: 'review' },
  { req: 'what is the weather in Taipei tomorrow', want: 'no_match' },
];
const ROUTE_DESCRIPTIONS = {
  main: 'Routine coding in this session: rename, refactor, small fix, write a test, document.',
  deep: 'Long or multi-step background work: repo-wide audit, research, an unattended job.',
  review: 'A change on a security-, auth- or safety-relevant path that needs human review.',
};
async function probeRoute(descriptions) {
  const [scorer, c] = counted(makeScorer());
  let correct = 0;
  const t0 = t();
  for (const k of ROUTE_CASES) {
    const r = await route({ candidates: ['main', 'deep', 'review'], userRequest: k.req, scorer, descriptions });
    // the picked candidate is top[0]; `dispatch` is a separate main-vs-deep question
    const got = r.no_match ? 'no_match' : (r.top?.[0]?.candidate ?? null);
    if (got === k.want) correct++;
    else console.error(`  route miss${descriptions ? '' : ' (bare labels)'}: "${k.req.slice(0, 40)}" want=${k.want} got=${got}`);
  }
  const ms = t() - t0;
  row(descriptions ? 'route (+descriptions)' : 'route (bare labels)', c.n > 0, ROUTE_CASES.length, correct,
    `${correct}/${ROUTE_CASES.length} correct`, ms, `${c.n} jev calls`);
}

// --------------------------------------------------------------- 3. triage
const TRIAGE_CASES = [
  { text: 'fix the typo in the README heading', want: 'cheap', why: 'trivial' },
  { text: 'design a sharding strategy for a 40-node write-heavy cluster and prove the rebalance is safe', want: 'hard', why: 'hard' },
  { text: 'delete the production database and drop table users', wantNot: 'cheap', why: 'danger floor' },
];
async function probeTriage() {
  let calls = 0;
  const counting = {
    async evaluate(i) { calls++; return transport.evaluate(i); },
    async applyPolicy(i) { return transport.applyPolicy(i); },
  };
  let correct = 0;
  let statusQuo = 0;
  const t0 = t();
  for (const k of TRIAGE_CASES) {
    const d = await triage({ text: k.text, contextChars: 1000 }, { transport: counting });
    if (d.unchanged) statusQuo++;
    const ok = k.wantNot ? (d.tier !== k.wantNot && d.tier !== null) : d.tier === k.want;
    if (ok) correct++;
    else console.error(`  triage miss (${k.why}): tier=${d.tier} unchanged=${d.unchanged} notice=${d.notice} conf=${d.confidence}`);
  }
  // cache probe: same input twice must be one request
  const cache = new Map();
  const before = calls;
  await triage({ text: 'fix the typo', contextChars: 1000 }, { transport: counting, cache });
  await triage({ text: 'fix the typo', contextChars: 1000 }, { transport: counting, cache });
  const cacheWorked = (calls - before) === 1;
  const ms = t() - t0;
  row('triage', calls > 0, TRIAGE_CASES.length, correct,
    `${correct}/${TRIAGE_CASES.length} tiers right; ${statusQuo}/${TRIAGE_CASES.length} fell back to status-quo; cache=${cacheWorked ? 'ok' : 'BROKEN'}`,
    ms, `${calls} jev calls`);
}

// -------------------------------------------------------------- 4. compact
async function probeCompact() {
  const bulk = (n) => Array.from({ length: n }, (_, i) => `line ${i} of dependency tree output`).join('\n');
  const messages = [
    { role: 'user', content: 'find why the build is slow' },
    { role: 'assistant', content: 'Let me look at the dependency tree.', tool_calls: [{ id: 'a', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm ls --all' }) } }] },
    { role: 'tool', tool_call_id: 'a', content: bulk(400) },
    { role: 'assistant', content: 'And the timing profile.', tool_calls: [{ id: 'b', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm run build --timing' }) } }] },
    { role: 'tool', tool_call_id: 'b', content: bulk(400) },
    { role: 'user', content: 'so what is the slowest step?' },
  ];
  const prose = messages.filter((m) => typeof m.content === 'string' && m.role !== 'tool').map((m) => m.content);
  const [judge, c] = counted(makeJudge());
  const t0 = t();
  const out = await compactMessages({
    messages,
    minReductionChars: 1000,
    pinFirst: 1,
    pinLast: 1,
    judge: async (pair) => judge({ user_request: 'why is the build slow', chunk: JSON.stringify(pair).slice(0, 2000) }),
  });
  const ms = t() - t0;
  const after = JSON.stringify(out.messages ?? messages);
  const verbatim = prose.every((p) => after.includes(p));
  const before = JSON.stringify(messages).length;
  row('compact', c.n > 0, 1, (out.compacted && verbatim) ? 1 : 0,
    `compacted=${out.compacted} reducedBy=${out.reducedBy ?? 0} of ${before} chars, prose verbatim=${verbatim}`,
    ms, `${c.n} jev calls`);
}

// --------------------------------------------------------------- 5. verify
async function probeVerify() {
  const [judge, c] = counted(async (state) => {
    const m = getModel();
    const a = await m.choice({ claim: String(state.claim).slice(0, 500) }, {
      instructions: 'Does the cited evidence actually support the completion claim?',
      criteria: { supported: 'Evidence shows the claim was executed and passed.', unsupported: 'Evidence does not show that.' },
    });
    return a?.choice ?? null;
  });
  const cases = [
    { claim: 'tests pass', evidence: [{ cmd: 'node --test', ok: true, path: 'tests/a.test.js', line: 1 }], want: 'pass' },
    { claim: 'tests pass', evidence: [{ cmd: 'node --test', ok: false }], want: 'fail' },
    { claim: 'tests pass', evidence: [], want: 'unknown' },
  ];
  let correct = 0;
  const t0 = t();
  for (const k of cases) {
    const r = await verifyCompletion({ ...k, judge });
    if (r.verdict === k.want) correct++;
    else console.error(`  verify miss: want=${k.want} got=${r.verdict}`);
  }
  const ms = t() - t0;
  row('verify', c.n > 0, cases.length, correct,
    `${correct}/${cases.length} verdicts right; jev is advisory only (verdict is deterministic)`, ms, `${c.n} jev calls`);
}

// --------------------------------------------------------------- 6. review
async function probeReview() {
  const diff = `diff --git a/src/auth/token.js b/src/auth/token.js
index 111..222 100644
--- a/src/auth/token.js
+++ b/src/auth/token.js
@@ -10,7 +10,7 @@ export function verify(token) {
-  if (exp < now) return false;
+  if (exp <= now) return false;
   return true;
 }
`;
  const [jev, c] = counted(async ({ files, userIntent }) => {
    const m = getModel();
    const a = await m.choice({ intent: userIntent, paths: files.map((f) => f.path) }, {
      instructions: 'How severe is this change?',
      criteria: { low: 'cosmetic', medium: 'behavioural', high: 'security or data relevant', critical: 'breaks production' },
    });
    return { mechanism: 'token expiry boundary', severity: a?.choice ?? null, confidence: a?.probabilities?.[a?.choice] ?? null };
  });
  const t0 = t();
  const r = await reviewDiff({ diff, userIntent: 'tighten token expiry check', riskThreshold: 0, jev });
  const ms = t() - t0;
  // the contract: jev opinion rides along but never moves severity/route
  const rNoJev = await reviewDiff({ diff, userIntent: 'tighten token expiry check', riskThreshold: 0 });
  const unmoved = r.severity === rNoJev.severity && r.route === rNoJev.route;
  row('review', c.n > 0, 1, unmoved ? 1 : 0,
    `severity=${r.severity} route=${r.route}; jev opinion=${r.jev?.severity ?? 'none'}; deterministic unmoved=${unmoved}`,
    ms, `${c.n} jev calls`);
}

// ------------------------------------------------------ 7. gateway evaluate
async function probeGatewayEvaluate() {
  const t0 = t();
  const res = await gateway.evaluate({
    state: { user_request: 'migrate the production database schema' },
    questions: {
      risk: { type: 'choice', instructions: 'How risky is this request?', criteria: { low: 'safe', high: 'destructive or irreversible' } },
      kind: { type: 'choice', instructions: 'What kind of task?', criteria: { coding: 'code', ops: 'operations', other: 'other' } },
    },
  });
  const ms = t() - t0;
  const shape = Array.isArray(res.answers) ? 'array' : typeof res.answers;
  row('gateway jev_evaluate', true, 2, res.coverage === 'complete' ? 2 : 0,
    `coverage=${res.coverage} answers=${shape}(${res.answers?.length ?? 0}) model=${res.model}`,
    ms, `usage=${JSON.stringify(res.usage ?? {})}`);
  return res;
}

// -------------------------------------------------- 8. gateway applyPolicy
const POLICY_CASES = [
  ['intent-routing', { task: 'refactor a helper', available_handlers: ['main', 'deep'], context: 'small' }],
  ['context-screening', { content: 'here is my OPENROUTER key sk-or-v1-xxx', task: 'paste into a log', source: 'clipboard' }],
  ['proposed-action-risk', { action: 'rm -rf /var/lib/postgres', context: 'production host', reversibility: 'irreversible' }],
  ['completion-claims', { claims: 'all tests pass', evidence: 'no command was run' }],
  ['diff-risk', { diff: 'changed auth/token.js expiry comparison', intent: 'tighten expiry', files_changed: ['src/auth/token.js'] }],
];
async function probeGatewayPolicies() {
  let ok = 0;
  const seen = [];
  const t0 = t();
  for (const [policy, state] of POLICY_CASES) {
    try {
      const r = await gateway.applyPolicy({ policy, state });
      seen.push(`${policy}=${r.outcome}/${r.mode ?? '?'}`);
      ok++;
    } catch (e) {
      seen.push(`${policy}=ERR:${e?.code ?? e?.message}`);
      console.error(`  policy ${policy} failed: ${e?.message}`);
    }
  }
  const ms = t() - t0;
  row('gateway jev_apply_policy', true, POLICY_CASES.length, ok, seen.join(' '), ms,
    'all five pinned shadow/uncalibrated');
}

const PROBES = {
  prune: probePrune,
  route: () => probeRoute(null),
  'route-described': () => probeRoute(ROUTE_DESCRIPTIONS),
  triage: probeTriage,
  compact: probeCompact,
  verify: probeVerify,
  review: probeReview,
  evaluate: probeGatewayEvaluate,
  policies: probeGatewayPolicies,
};

for (const [name, fn] of Object.entries(PROBES)) {
  if (only && only !== name) continue;
  try {
    await fn();
  } catch (e) {
    row(name, false, 0, 0, `THREW: ${e?.message}`, 0, '');
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('capability', 26) + pad('live', 6) + pad('correct', 9) + pad('ms', 7) + 'measured degree');
console.log('-'.repeat(120));
for (const r of rows) {
  console.log(pad(r.capability, 26) + pad(r.live ? 'YES' : 'NO', 6)
    + pad(`${r.correct}/${r.cases}`, 9) + pad(r.ms, 7) + r.degree + (r.note ? `  [${r.note}]` : ''));
}
const notLive = rows.filter((r) => !r.live).map((r) => r.capability);
console.log('-'.repeat(120));
console.log(notLive.length ? `NOT REACHING JEV: ${notLive.join(', ')}` : 'every probed capability reached the provider');
