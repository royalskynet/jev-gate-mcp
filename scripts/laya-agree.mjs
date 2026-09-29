#!/usr/bin/env node
/**
 * Laya consistency probe: does the quantized int8 checkpoint agree with the
 * fp16 reference on the same judgments?
 *
 * Two local bundles (config-identical: same laya_config.json, same vocab)
 * should answer choice/score/noul alike. This loads both through the shared
 * loader (`loadLaya`, the same path gateway + agent-glue use — tokenizer
 * shadow aliases + ORT memory options), runs 20+ mixed ZH/EN questions, and
 * compares each question's top decision: `choice` for choice, `score` for
 * score, `noul` for noul.
 *
 * Exit 0 = every question agrees on the top decision (probabilities may drift
 * slightly — quantization is a compression); exit 1 = at least one differs,
 * with the differing questions printed.
 *
 * Usage:
 *   node scripts/laya-agree.mjs <dirA> <dirB>
 */
import { loadLaya } from '../gateway/src/laya-loader.js';

// 20+ questions, mixed ZH/EN and choice/score/noul. `state` is the text the
// model judges; each question is typed with the criteria shape receptron's
// sequence.js renders. Avoid deliberately ambiguous items — the probe compares
// decisions, not ranking fuzz.
const CASES = [
  { state: '請把這個路由到 L1', q: { type: 'choice', instructions: '分類', criteria: { coding: 'coding', writing: 'writing' } }, name: 'kind-cn' },
  { state: 'Fix the null deref in the event loop and add a regression test.', q: { type: 'choice', instructions: 'classify', criteria: { coding: 'coding', writing: 'writing' } }, name: 'kind-en' },
  { state: '改這段的 commit message，讓它符合 conventional commits', q: { type: 'choice', instructions: '分類', criteria: { coding: 'coding', writing: 'writing' } }, name: 'kind-cn2' },
  { state: 'Write a three-paragraph explanation of why the merge failed.', q: { type: 'choice', instructions: 'classify', criteria: { coding: 'coding', writing: 'writing' } }, name: 'kind-en2' },
  { state: '這任務需要仔細讀程式碼才能改對', q: { type: 'choice', instructions: '難度分類', criteria: { low: 'low', medium: 'medium', high: 'high' } }, name: 'triage-cn' },
  { state: 'This one-line change touches the payment callback; review carefully.', q: { type: 'choice', instructions: 'difficulty', criteria: { low: 'low', medium: 'medium', high: 'high' } }, name: 'triage-en' },
  { state: '把以上討論重點整理成三點', q: { type: 'score', instructions: '給 0-2 分', criteria: ['摘要準確', '重點完整', '格式正確'] }, name: 'sum-cn' },
  { state: 'Summarize both sides and recommend one.', q: { type: 'score', instructions: 'score 0-2', criteria: ['acc', 'complete', 'fair'] }, name: 'sum-en' },
  { state: '重構這個 hot path，但要維持行為不變', q: { type: 'score', instructions: '評估 0-2', criteria: ['低風險', '中風險', '高風險'] }, name: 'risk-cn' },
  { state: 'The server has been down for an hour; ping on-call now.', q: { type: 'score', instructions: 'score 0-2', criteria: ['low', 'medium', 'high'] }, name: 'sev-en' },
  { state: 'The deadline is tomorrow and we have no progress yet.', q: { type: 'noul', instructions: '該催嗎', criteria: { false: '不用', true: '要' } }, name: 'push-cn' },
  { state: 'This dependency has 2 new commits that touch the API we use.', q: { type: 'noul', instructions: 'should we update now', criteria: { false: 'no', true: 'yes' } }, name: 'update-en' },
  { state: '這段 code review 意見合理，建議採納', q: { type: 'noul', instructions: '同意嗎', criteria: { false: '不同意', true: '同意' } }, name: 'agree-cn' },
  { state: 'The regression is flaky and only fails on CI.', q: { type: 'noul', instructions: 'is it release-blocking', criteria: { false: 'no', true: 'yes' } }, name: 'block-en' },
  { state: '請把這個 bug 的 root cause 寫清楚', q: { type: 'choice', instructions: '分類', criteria: { coding: 'coding', writing: 'writing' } }, name: 'kind-cn3' },
  { state: 'Cache the API response for a day; it changes rarely.', q: { type: 'choice', instructions: 'classify', criteria: { coding: 'coding', writing: 'writing' } }, name: 'kind-en3' },
  { state: '定位這個記憶體泄漏的來源', q: { type: 'choice', instructions: '難度分類', criteria: { low: 'low', medium: 'medium', high: 'high' } }, name: 'triage-cn2' },
  { state: 'Add docs for the new CLI flag and a changelog entry.', q: { type: 'choice', instructions: 'difficulty', criteria: { low: 'low', medium: 'medium', high: 'high' } }, name: 'triage-en2' },
  { state: '複述使用者的需求並確認理解', q: { type: 'score', instructions: '評估 0-2', criteria: ['文化', '一致', '效率'] }, name: 'sum-cn2' },
  { state: 'Draft a rollout message for the v3 migration.', q: { type: 'score', instructions: 'score 0-2', criteria: ['brief', 'clear', 'safe'] }, name: 'sum-en2' },
  { state: '熱修復應該現在就上嗎', q: { type: 'noul', instructions: '是/否', criteria: { false: '否', true: '是' } }, name: 'hotfix-cn' },
  { state: 'Should we merge without a second review?', q: { type: 'noul', instructions: 'yes/no', criteria: { false: 'no', true: 'yes' } }, name: 'merge-en' },
];

// "top decision" per type: the label chosen for choice, the top probability
// level for score, and the boolean read-off for noul (<0.5 → false). Quantized
// logits shift probabilities slightly; the top decision is the stable signal.
function decision(a) {
  if (a?.type === 'choice') return { kind: 'choice', value: a.choice };
  if (a?.type === 'score') {
    const probs = a.probabilities ?? {};
    const levels = Object.keys(probs);
    if (levels.length === 0) return { kind: 'score', value: Number(a.score) };
    const top = levels.reduce((bestBase, lv) => Number(probs[lv]) > Number(probs[bestBase]) ? lv : bestBase);
    return { kind: 'score', value: top };
  }
  if (a?.type === 'noul') return { kind: 'noul', value: Number(a.noul) >= 0.5 ? 1 : 0 };
  return { kind: 'unknown', value: String(a) };
}

const [_node, _script, dirA, dirB] = process.argv;
if (!dirA || !dirB) {
  console.error('usage: node scripts/laya-agree.mjs <dirA> <dirB>');
  process.exit(2);
}

const [modelA, modelB] = [
  await loadLaya({ modelDir: dirA }),
  await loadLaya({ modelDir: dirB }),
];

const diffs = [];
let n = 0;
for (const { state, q, name } of CASES) {
  n += 1;
  const questions = { q };
  // Sequential on purpose: two ORT sessions forwarding in parallel trips
  // onnxruntime's internal mutex on some builds. Order does not matter here.
  const ra = await modelA.systemOne(state, questions);
  const rb = await modelB.systemOne(state, questions);
  const a = decision(ra.answers.q);
  const b = decision(rb.answers.q);
  const same = a.value === b.value;
  const line = `${String(n).padStart(3)}. ${name.padEnd(12)} ${a.kind.padEnd(6)} A=${a.value} B=${b.value} ${same ? 'OK' : 'DIFF'}`;
  console.log(line);
  if (!same) diffs.push({ name, q, a, b });
}

if (diffs.length === 0) {
  console.log(`\nlaya-agree: ${n} questions, all top decisions agree (exit 0)`);
  process.exit(0);
}
console.log(`\nlaya-agree: ${diffs.length}/${n} questions disagree:`);
for (const d of diffs) {
  console.log(`  - ${d.name}: A=${JSON.stringify(d.a.value)} B=${JSON.stringify(d.b.value)}`);
}
process.exit(1);