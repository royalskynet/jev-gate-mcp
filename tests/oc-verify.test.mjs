import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdicts, grade, ocVerifier, buildPrompt } from '../integrations/openmausbot/oc-verify.mjs';
import { checkClaims } from '../plugin/lib/claimcheck.js';
import { parseArgs } from '../integrations/openmausbot/claimcheck-watch.mjs';

const EV = '系統自動為每個對手方選用合適的協議。帳單：Solution monthly commitment 500U';

test('parseVerdicts takes the last JSON array, ignoring chatter and brackets in prose', () => {
  const out = 'thinking [not json]\n```json\n[{"i":1,"verdict":"supported","quote":"x"}]\n```\n';
  assert.deepEqual(parseVerdicts(out), [{ i: 1, verdict: 'supported', quote: 'x' }]);
  assert.equal(parseVerdicts('no array here'), null);
});

test('grade keeps a verdict only when its quote is verbatim in the evidence', () => {
  const g = grade(['A', 'B', 'C', 'D'], [
    { i: 1, verdict: 'supported', quote: '自動為每個對手方選用合適的協議' },
    { i: 2, verdict: 'supported', quote: '五種協議各自另外收費' },
    { i: 3, verdict: 'not_addressed', quote: '' },
    { i: 4, verdict: 'banana' },
  ], EV);
  assert.deepEqual(g.map((j) => [j.verdict, j.gate]), [
    ['supported', 'auto'], ['not_addressed', 'review'], ['not_addressed', 'auto'], ['not_addressed', 'auto'],
  ]);
  assert.equal(g[1].note, 'quote-not-in-evidence');
  assert.equal(g[3].note, 'no-answer');
});

test('ocVerifier runs the CLI once with the free model and plugs into checkClaims', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push({ bin, args });
    return '[{"i":1,"verdict":"contradicted","quote":"系統自動為每個對手方選用合適的協議"}]';
  };
  const r = await checkClaims({
    text: '五種協議各自要另外繳月費。', evidence: EV, kinds: ['fact'],
    verify: ocVerifier({ bin: '/x/opencode', run }),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), ['run', '--pure', '-m', 'opencode-go/beam-free']);
  assert.equal(r.decisive.verdict, 'contradicted');
  assert.equal(r.judged[0].claim, '五種協議各自要另外繳月費。');
});

test('CLI failure or unparseable output is an error, not a verdict', async () => {
  const bad = await checkClaims({ text: '方案每月收費 500U。', evidence: EV, kinds: ['fact'],
    verify: ocVerifier({ run: async () => 'sorry, I cannot help' }) });
  assert.match(bad.error, /no JSON verdicts/);
  assert.equal(bad.decisive, null);
});

test('prompt carries every claim and the evidence', () => {
  const p = buildPrompt(['甲', '乙'], 'EVID');
  assert.match(p, /1\. 甲\n2\. 乙/);
  assert.match(p, /EVIDENCE:\nEVID$/);
});

test('watcher defaults to the oc judge and rejects unknown judges', () => {
  assert.equal(parseArgs(['--bots', 'x']).judge, 'oc');
  assert.throws(() => parseArgs(['--bots', 'x', '--judge', 'gpt']), /oc or jev/);
});

test('older opencode without --pure gets plain run flags', async () => {
  const calls = [];
  const v = ocVerifier({ run: async (b, args) => { calls.push(args); return '[]'; }, flags: { pure: false, standalone: false }, proxy: '' });
  await v(null, { claims: ['x'], evidence: 'e' });
  assert.deepEqual(calls[0].slice(0, 3), ['run', '-m', 'opencode-go/beam-free']);
});

test('proxy goes to the child env and forces --standalone when supported', async () => {
  const calls = [];
  const run = async (b, args, opts) => { calls.push({ args, env: opts.env }); return '[]'; };
  await ocVerifier({ run, flags: { pure: true, standalone: true }, proxy: 'http://127.0.0.1:18443' })(null, { claims: ['x'], evidence: 'e' });
  assert.deepEqual(calls[0].args.slice(0, 5), ['run', '--pure', '--standalone', '-m', 'opencode-go/beam-free']);
  assert.equal(calls[0].env.HTTPS_PROXY, 'http://127.0.0.1:18443');
  assert.match(calls[0].env.NO_PROXY, /127\.0\.0\.1/);
  await ocVerifier({ run, flags: { pure: true, standalone: true }, proxy: '' })(null, { claims: ['x'], evidence: 'e' });
  assert.ok(!calls[1].args.includes('--standalone'));
  assert.equal(calls[1].env.HTTPS_PROXY, process.env.HTTPS_PROXY);
});

test('basis passes through; prompt asks for user/inference/evidence', () => {
  const g = grade(['A', 'B'], [
    { i: 1, verdict: 'supported', quote: '自動為每個對手方選用合適的協議', basis: 'user' },
    { i: 2, verdict: 'not_addressed', quote: '', basis: 'inference' },
  ], EV);
  assert.deepEqual(g.map((j) => j.basis), ['user', 'inference']);
  assert.equal(grade(['A'], [{ i: 1, verdict: 'supported', quote: '自動為每個對手方選用合適的協議', basis: 'banana' }], EV)[0].basis, undefined);
  assert.match(buildPrompt(['甲'], 'E'), /"basis"/);
});
