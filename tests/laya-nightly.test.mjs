// The nightly job trains; the only output a human sees is the hpush, so test
// that. Three things can silently rot here: labelling could drift onto the
// trained weights (which turns the "vs int8" baseline into self-comparison),
// a promotion could land without the ONNX export that makes it reachable, and
// the summary line is jq string-building that has been wrong before. The gate
// itself is relative only (10-11): same-paper McNemar against the serving
// model plus the unmeasured-question check. Absolute accuracy belongs to the
// takeover gate (per-question confMin + CP error budget), not to shipping.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const QIDS = ['costly_mistake', 'difficulty', 'kind'];

const REPORT = (promoted, live = { n: 170, accuracy: 0.994 }, extra = {}) => JSON.stringify({
  units: 533, oof_accuracy: 0.674, paired_delta: 0.317, promoted,
  // 10-13 改版欄位：難題數、教師不可信丟掉幾題、訓練題族、耗時。
  hard_n: 142, easy_n: 142, trusted_drop_n: 318, train_seconds: 912, qids: QIDS,
  live_gated: { qids: QIDS, ...live, conf_min: 0.7, pilot: ['noul', 'score'] },
  coverage_curve: [{ threshold: 0.7, coverage: 0.278, accuracy: 0.952 }],
  ...extra,
});

// n same-paper rows, all routed locally; `wrong` lists the indices answered wrong.
const DUMP = (n, wrong) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ key: `k${i}`, qid: 'difficulty', routed: true, correct: !wrong.includes(i) })).join('\n') + '\n';
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const serving = (at) => fs.readFileSync(at('.jevgate/laya-trained-onnx/laya.onnx'), 'utf8').trim();

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-nightly-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.jevgate'));
  const at = (f) => path.join(home, f);
  fs.writeFileSync(at('bin/hpush'), `#!/bin/sh\necho "$*" >> ${at('pushes.txt')}\n`, { mode: 0o755 });
  // Shadow node so the labelling step records the bundle it was pointed at, and
  // leaves the label.done the summary reads its deferred count from.
  fs.writeFileSync(at('bin/node'), `#!/bin/sh
echo "$JEV_LAYA_MODEL_DIR" > ${at('labelled-with.txt')}
echo "{\\"deferred\\": \${FAKE_DEFERRED:-0}}" > "$JEV_LAYA_LABEL_DONE"
`, { mode: 0o755 });
  // Stand in for the train venv: write the report, and mark that export ran.
  // Export lands in the candidate dir it is pointed at; eval writes the gate dump
  // for whichever bundle it was given (fixtures dump-champ / dump-cand); the
  // paired gate itself is the real script, so the tests exercise its verdict.
  fs.writeFileSync(at('bin/fakepy'), `#!/bin/sh
case "$1" in
  *laya-train.py) cat ${at('next-report.json')} > "$JEV_LAYA_TRAIN_REPORT" ;;
  *laya-export-onnx.py) echo ran >> ${at('exported.txt')}; mkdir -p "$JEV_LAYA_EXPORT_DIR"; echo cand > "$JEV_LAYA_EXPORT_DIR/laya.onnx" ;;
  *laya-eval-onnx.py)
    while [ $# -gt 0 ]; do case "$1" in --bundle) B="$2"; shift ;; --gate-dump) G="$2"; shift ;; esac; shift; done
    case "$B" in *candidate*) cp ${at('dump-cand.jsonl')} "$G" ;; *) cp ${at('dump-champ.jsonl')} "$G" ;; esac ;;
  *laya_paired_gate.py) exec python3 "$@" ;;
  *laya-calibrate.py)
    [ -n "$FAKE_CALIB_FAIL" ] && { echo "boom: samples unreadable"; exit 1; }
    echo '{"entries":[{"caller":"cascade:compact","family":"result_t#","threshold":0.9}],"rejected":[{},{}]}' > "$HOME/.jevgate/laya-whitelist.json" ;;
esac
exit 0
`, { mode: 0o755 });
  // A serving bundle, and same-paper dumps where both models are equally good.
  fs.mkdirSync(at('.jevgate/laya-trained-onnx'));
  fs.writeFileSync(at('.jevgate/laya-trained-onnx/laya.onnx'), 'champ');
  fs.writeFileSync(at('dump-champ.jsonl'), DUMP(338, []));
  fs.writeFileSync(at('dump-cand.jsonl'), DUMP(338, []));
  // befa3dd 起摘要不走 hpush，改寫 LAYA_DIGEST_OUT（`日期<TAB>摘要`）交給 state-digest；
  // 它是夜訓最後一步，所以接在 hpush 紀錄之後，.at(-1) 仍是那晚的摘要。
  const lines = (f) => (fs.existsSync(at(f)) ? fs.readFileSync(at(f), 'utf8').trim().split('\n') : []);
  const pushes = () => [...lines('pushes.txt'), ...lines('digest.tsv').map(l => l.split('\t').slice(1).join('\t'))];
  const run = (extraEnv = {}) => execFileSync('bash', [path.join(ROOT, 'scripts/laya-nightly.sh')], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      JEV_LAYA_TRAIN_REPORT: at('report.json'), JEV_LAYA_PYTHON: at('bin/fakepy'),
      JEV_LAYA_LABEL_DONE: at('label.done'), LAYA_DIGEST_OUT: at('digest.tsv'),
      JEV_LAYA_BASELINE_DIR: '/sentinel/int8', JEV_LAYA_MODEL_DIR: '/sentinel/trained-must-not-be-used',
      // sysctl is an absolute path (a56bb86), so PATH cannot stub it: the gate
      // reads this machine's real memory and skipped training whenever the real
      // nightly ran beside the suite (6–12 flaky fails, 10-13). Open the gate.
      JEV_LAYA_MEM_LEVEL_MIN: '0',
      // The suite runs in daytime, past the 05:50 deadline.
      JEV_LAYA_TRAIN_DEADLINE: 'none',
      ...extraEnv },
    encoding: 'utf8',
  });
  return { at, run, pushes };
}

test('a promoted night labels against int8, exports, and says what it gained', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  run();

  // Labelling must stay on the frozen int8 baseline even though a trained
  // bundle is configured, or the next night compares the model with itself.
  assert.equal(fs.readFileSync(at('labelled-with.txt'), 'utf8').trim(), '/sentinel/int8');
  assert.equal(fs.readFileSync(at('exported.txt'), 'utf8').trim(), 'ran', 'promotion without an ONNX export is unreachable');

  const summary = pushes().at(-1);
  assert.match(summary, /units=533/);
  assert.match(summary, /OOF=67\.4%/);
  assert.match(summary, /vs int8 31\.7pp/);
  assert.match(summary, /線上 lane n=170 準確 99\.4%/, 'summary must quote the online lanes, not an all-qtype fiction');
  assert.match(summary, /已換權重/);
  assert.doesNotMatch(summary, /n\/a|null|undefined/);
  // 低強度增量可以「跑完但什麼都沒學」：難題 0 題、或教師標籤全被可信度閘濾掉。
  // 只看 units 與 OOF 分不出那種空轉，所以摘要必須帶這幾個數字（10-13 改版）。
  assert.match(summary, /難題 142／防遺忘 142/);
  assert.match(summary, /教師不可信丟 318/);
  assert.match(summary, /題族 3/);
  assert.match(summary, /耗時 15 分/);

  // Only a bundle that actually reached production may become the champion,
  // and it records the same-paper number (the paired eval), not the OOF one —
  // a number nobody can re-measure is what froze the gate from 10-02 on.
  assert.equal(serving(at), 'cand');
  const champ = JSON.parse(fs.readFileSync(at('.jevgate/laya-champion.json'), 'utf8'));
  assert.equal(champ.accuracy, 1);
  assert.equal(champ.n, 338);
  assert.equal(champ.units, 533);
  // Without the question list on the record there is nothing for the next night
  // to compare against, and the population gate silently stops gating.
  assert.deepEqual(champ.qids, QIDS);
});

test('training runs under the launchd PATH, which has no /usr/sbin', () => {
  const { at, run } = sandbox();
  // The plist PATH. The suite's own PATH has /usr/sbin, so a bare sbin tool
  // passed here while every night died rc=127 (taskpolicy, 10-13).
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  run({ PATH: `${at('bin')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` });
  assert.equal(fs.readFileSync(at('exported.txt'), 'utf8').trim(), 'ran', 'training never ran under launchd PATH');
});

test('a night with too little time left before the deadline skips training', () => {
  const { at, run, pushes } = sandbox();
  // Labelling length varies; training that starts late runs into Hindsight's
  // 06:10 morning cruise. A deadline of "now" leaves no time.
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  run({ JEV_LAYA_TRAIN_DEADLINE: hhmm });
  assert.equal(fs.existsSync(at('exported.txt')), false, 'trained past the deadline');
  assert.match(pushes().join('\n'), /收工/);
});

test('a question that was never measured locally cannot enter the local lane', () => {
  const { at, run, pushes } = sandbox();
  // Neither lane gates on question identity: the confidence lane keys on qtype,
  // the state lane on the shape of the state keys. So a caller that drops a
  // field from its state, or a new caller altogether, puts a question nobody
  // measured on local weights. Averaged accuracy hides it while the new
  // question is a minority of the batch, which is exactly when it lands.
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 0.994, n: 170, conf_min: 0.7, qids: QIDS }));
  fs.writeFileSync(at('next-report.json'),
    REPORT(true, { n: 190, accuracy: 0.991, qids: [...QIDS, 'route'] }));
  run();
  assert.equal(fs.existsSync(at('exported.txt')), false, 'shipped an unmeasured question onto local weights');
  assert.match(pushes().join('\n'), /出現現役沒有的題目 route/);
});

test('a question that stopped appearing does not block the night', () => {
  const { at, run, pushes } = sandbox();
  // Traffic ebbs. A shrinking question list is not drift — nothing new is being
  // served — and blocking on it would freeze the model whenever a caller idles.
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 0.994, n: 170, conf_min: 0.7, qids: QIDS }));
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 120, accuracy: 0.99, qids: ['difficulty'] }));
  run();
  assert.equal(fs.readFileSync(at('exported.txt'), 'utf8').trim(), 'ran');
  assert.doesNotMatch(pushes().join('\n'), /沒有的題目/);
});

test('a champion with no question list falls back to the paired gate instead of reading "no list" as "no new questions"', () => {
  const { at, run, pushes } = sandbox();
  // An old champion file predates the field. There is nothing to compare, so the
  // night proceeds on the paired gate alone — but it must not read "no list" as "no new
  // questions" for a champion that does have one.
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 0.98, n: 170, conf_min: 0.7 }));
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 190, accuracy: 0.991, qids: ['route'] }));
  run();
  assert.equal(fs.readFileSync(at('exported.txt'), 'utf8').trim(), 'ran');
  assert.doesNotMatch(pushes().join('\n'), /沒有的題目/);
});

test('an unpromoted night neither exports nor claims a gain it did not get', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), JSON.stringify({
    units: 40, oof_accuracy: 0.4, paired_delta: null, promoted: false,
    live_gated: { n: 0, accuracy: null },
  }));
  run();
  assert.equal(fs.existsSync(at('exported.txt')), false, 'exported an unpromoted model');
  assert.equal(fs.existsSync(at('.jevgate/laya-champion.json')), false, 'crowned a model that never shipped');
  const summary = pushes().at(-1);
  assert.match(summary, /vs int8 n\/a/);
  assert.match(summary, /線上 lane 無樣本/);
  assert.match(summary, /未達標/);
  // 這份報告沒有 10-13 改版的欄位（舊檔／訓練在寫完它們之前就失敗）。摘要要整段省略，
  // 不是印 null——推播是唯一有人看的輸出，印 null 會被當成「學了 null 題」。
  assert.doesNotMatch(summary, /null|undefined|難題|教師不可信|題族|耗時/);
});

// 10-11: the absolute floor and MIN_N used to sit here. With them, local
// answers never got a teacher label so n never grew, and 10-07's OOF 0.637
// model never reached serving. Shipping now asks one relative question: is it
// worse than what is serving, on the same paper. These two tests turn red if
// either old precondition comes back.
test('few online-lane rows no longer block shipping when the paired gate passes', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 5, accuracy: 1.0 }));
  run();
  assert.equal(fs.readFileSync(at('exported.txt'), 'utf8').trim(), 'ran');
  assert.equal(serving(at), 'cand');
  assert.doesNotMatch(pushes().join('\n'), /不導出|最少/);
});

test('an online-lane accuracy below 0.95 does not block shipping when not worse than serving', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 300, accuracy: 0.88 }));
  run();
  assert.equal(serving(at), 'cand');
  assert.doesNotMatch(pushes().join('\n'), /地板|不導出/);
});

test('a model that beats stock int8 but answers significantly more wrong on the same paper is not served', () => {
  const { at, run, pushes } = sandbox();
  // The trainer's upgrade gate compares against frozen int8, so this model got
  // its weights written. On the same questions the serving model gets right,
  // it is wrong 12 more times (vs 1 the other way): McNemar p≈0.003.
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 0.994, n: 170, units: 533, conf_min: 0.7, qids: QIDS }));
  fs.writeFileSync(at('dump-champ.jsonl'), DUMP(338, [300]));
  fs.writeFileSync(at('dump-cand.jsonl'), DUMP(338, range(0, 12)));
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 340, accuracy: 0.98 }));
  run();
  assert.equal(serving(at), 'champ', 'replaced the champion with a worse model');
  assert.match(pushes().join('\n'), /不導出：同卷 n=338 新版 96\.4%（本機 338）vs 現役 99\.7%（本機 338），新版多錯 12／少錯 1，McNemar p=0\.0034 < 0\.05/);
  // The champion record must survive a rejected challenger, and the rejected
  // candidate must not linger at 500MB.
  assert.equal(JSON.parse(fs.readFileSync(at('.jevgate/laya-champion.json'), 'utf8')).accuracy, 0.994);
  assert.equal(fs.existsSync(at('.jevgate/laya-candidate-onnx')), false);
});

test('a stale champion number cannot block: same paper 98.8% vs 98.2% on 338 ships and is re-recorded', () => {
  const { at, run, pushes } = sandbox();
  // The 10-02 bug: champion said 1.0 on 186 old questions, the new model was
  // measured on 338 that night, and 98.2% < 1.0 - 0.01 blocked every night.
  // On the same paper the serving model also misses some; 4 vs 2 discordant
  // is noise (p≈0.69), so it ships and the champion takes the re-measured numbers.
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 1.0, n: 186, conf_min: 'score=0.65,noul=0.70', qids: QIDS }));
  fs.writeFileSync(at('dump-champ.jsonl'), DUMP(338, [4, 5, 6, 7]));
  fs.writeFileSync(at('dump-cand.jsonl'), DUMP(338, [0, 1, 2, 3, 4, 5]));
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 338, accuracy: 0.982 }));
  run();
  assert.equal(serving(at), 'cand');
  assert.equal(fs.readFileSync(at('.jevgate/laya-trained-onnx.prev/laya.onnx'), 'utf8').trim(), 'champ');
  const champ = JSON.parse(fs.readFileSync(at('.jevgate/laya-champion.json'), 'utf8'));
  assert.equal(champ.n, 338);
  assert.equal(Math.round(champ.accuracy * 1000), 982);
  assert.equal(Math.round(champ.paired.prev_accuracy * 1000), 988);
  assert.deepEqual([champ.paired.b, champ.paired.c], [4, 2]);
  assert.doesNotMatch(pushes().join('\n'), /不導出/);
  assert.match(pushes().at(-1), /已換權重，同卷 n=338 新版 98\.2%.*McNemar p=0\.6875/);
});

test('a champion younger than the freeze keeps serving, so the whitelist window can fill', () => {
  const { at, run, pushes } = sandbox();
  // 10-14：白名單只吃現役上線後的 shadow 列，夜夜換版窗口就夜夜歸零。
  const at2d = new Date(Date.now() - 2 * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 0.9, n: 48, qids: QIDS, promoted_at: at2d }));
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  run();
  assert.equal(serving(at), 'champ');
  assert.equal(fs.existsSync(at('exported.txt')), false, 'exported during the freeze');
  assert.match(pushes().at(-1), /校準凍結：現役上線 2 天 < 7/);
});

test('a champion past the freeze goes through the paired gate as before', () => {
  const { at, run } = sandbox();
  const at8d = new Date(Date.now() - 8 * 86400e3).toISOString();  // 帶毫秒也要能解析
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 0.9, n: 48, qids: QIDS, promoted_at: at8d }));
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  run();
  assert.equal(serving(at), 'cand');
});

test('no serving bundle: nothing to pair, the candidate ships', () => {
  const { at, run } = sandbox();
  fs.rmSync(at('.jevgate/laya-trained-onnx'), { recursive: true });
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 175, accuracy: 0.99 }));
  run();
  assert.equal(serving(at), 'cand');
});

test('a failed paired evaluation keeps the serving bundle', () => {
  const { at, run, pushes } = sandbox();
  fs.rmSync(at('dump-cand.jsonl'));  // the candidate has no gate dump, so the paired gate fails
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 175, accuracy: 0.99 }));
  run();
  assert.equal(serving(at), 'champ');
  assert.match(pushes().join('\n'), /同卷配對評估失敗/);
});

test('a labelling backlog is named in the summary, not left to rot silently', () => {
  const { at, run, pushes } = sandbox();
  // Labelling stops at its time budget so training still runs before morning
  // (10-09: a 186-question row walked the labeller to 31GB, ram_guard killed it
  // at rc=143, and training never started). The leftover rows then stay pending
  // for the next night — invisible unless the summary says how many.
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  run({ FAKE_DEFERRED: '37' });
  assert.match(pushes().at(-1), /標註尚餘 37 筆/);
});

test('no backlog says nothing about one', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  run();
  assert.doesNotMatch(pushes().at(-1), /標註尚餘/);
});

test('a missing train venv is reported, not silently skipped', () => {
  const { run, pushes } = sandbox();
  run({ JEV_LAYA_PYTHON: '/nonexistent/python' });
  assert.match(pushes().at(-1), /訓練跳過/);
});

test('too little free memory skips training and says so, instead of fighting Hindsight', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), REPORT(true));
  const out = run({ JEV_LAYA_MEM_LEVEL_MIN: '101' }); // no real level reaches 101%
  assert.match(out, /train=skipped mem_level=\d+/);
  assert.match(pushes().at(-1), /夜訓今晚跳過/);
  assert.equal(fs.existsSync(at('exported.txt')), false, 'a skipped night must not export');
});

test('every finished night recalibrates the handoff whitelist and names its size', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), REPORT(false));
  run();
  assert.match(pushes().at(-1), /白名單 1 族／未過 2 族/);
});

test('a failed calibration is pushed, and the night still writes its summary', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), REPORT(false));
  run({ FAKE_CALIB_FAIL: '1' });
  assert.ok(pushes().some(l => /白名單校準失敗.*boom/.test(l)), pushes().join('\n'));
  assert.doesNotMatch(pushes().at(-1), /白名單 \d/);
  assert.match(pushes().at(-1), /units=/);
});

test('calibration selftest (CP bound, multi-start fixed-sequence, request floor)', () => {
  assert.match(execFileSync('python3', [path.join(ROOT, 'scripts/laya-calibrate.py'), '--selftest'], { encoding: 'utf8' }), /selftest ok/);
});

test('paired gate selftest (McNemar arithmetic and the ship/block cases)', () => {
  assert.match(execFileSync('python3', [path.join(ROOT, 'scripts/laya_paired_gate.py'), '--selftest'], { encoding: 'utf8' }), /selftest ok/);
});
