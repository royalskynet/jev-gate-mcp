// The nightly job trains; the only output a human sees is the hpush, so test
// that. Three things can silently rot here: labelling could drift onto the
// trained weights (which turns the "vs int8" baseline into self-comparison),
// a promotion could land without the ONNX export that makes it reachable, and
// the summary line is jq string-building that has been wrong before. The gate
// itself reads report.live_gated (the online lanes' own accuracy) and refuses
// both an absolute floor breach and a regression against the serving model.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const REPORT = (promoted, live = { n: 170, accuracy: 0.994 }) => JSON.stringify({
  units: 533, oof_accuracy: 0.674, paired_delta: 0.317, promoted,
  live_gated: { ...live, conf_min: 0.7, pilot: ['noul', 'score'] },
  coverage_curve: [{ threshold: 0.7, coverage: 0.278, accuracy: 0.952 }],
});

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-nightly-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.jevgate'));
  const at = (f) => path.join(home, f);
  fs.writeFileSync(at('bin/hpush'), `#!/bin/sh\necho "$*" >> ${at('pushes.txt')}\n`, { mode: 0o755 });
  // Shadow node so the labelling step records the bundle it was pointed at.
  fs.writeFileSync(at('bin/node'), `#!/bin/sh\necho "$JEV_LAYA_MODEL_DIR" > ${at('labelled-with.txt')}\n`, { mode: 0o755 });
  // Stand in for the train venv: write the report, and mark that export ran.
  fs.writeFileSync(at('bin/fakepy'), `#!/bin/sh
case "$1" in
  *laya-train.py) cat ${at('next-report.json')} > "$JEV_LAYA_TRAIN_REPORT" ;;
  *laya-export-onnx.py) echo ran >> ${at('exported.txt')} ;;
esac
exit 0
`, { mode: 0o755 });
  const pushes = () => (fs.existsSync(at('pushes.txt')) ? fs.readFileSync(at('pushes.txt'), 'utf8').trim().split('\n') : []);
  const run = (extraEnv = {}) => execFileSync('bash', [path.join(ROOT, 'scripts/laya-nightly.sh')], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      JEV_LAYA_TRAIN_REPORT: at('report.json'), JEV_LAYA_PYTHON: at('bin/fakepy'),
      JEV_LAYA_BASELINE_DIR: '/sentinel/int8', JEV_LAYA_MODEL_DIR: '/sentinel/trained-must-not-be-used',
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

  // Only a bundle that actually reached production may become the champion.
  const champ = JSON.parse(fs.readFileSync(at('.jevgate/laya-champion.json'), 'utf8'));
  assert.equal(champ.accuracy, 0.994);
  assert.equal(champ.units, 533);
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
});

test('a better model that lost its calibration at the gate is not served', () => {
  const { at, run, pushes } = sandbox();
  // Overall gain clears the upgrade gate, but the online lanes are worse than
  // the floor, which is the only number live traffic actually experiences.
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 300, accuracy: 0.88 }));
  run();
  assert.equal(fs.existsSync(at('exported.txt')), false, 'served a bundle that failed the gate floor');
  assert.match(pushes().join('\n'), /不導出：線上 lane 準確率 0\.88（n=300）< 地板 0\.95/);
});

test('a model that beats stock int8 but regresses against the serving one is not served', () => {
  const { at, run, pushes } = sandbox();
  // The trainer's upgrade gate compares against frozen int8, so this model got
  // its weights written. Against the model actually serving traffic it is worse.
  fs.writeFileSync(at('.jevgate/laya-champion.json'),
    JSON.stringify({ accuracy: 0.994, n: 170, units: 533 }));
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 180, accuracy: 0.96 }));
  run();
  assert.equal(fs.existsSync(at('exported.txt')), false, 'replaced the champion with a worse model');
  assert.match(pushes().join('\n'), /比現役 0\.994 退步超過 0\.01/);
  // The champion record must survive a rejected challenger.
  assert.equal(JSON.parse(fs.readFileSync(at('.jevgate/laya-champion.json'), 'utf8')).accuracy, 0.994);
});

test('noise within tolerance still ships', () => {
  const { at, run } = sandbox();
  fs.writeFileSync(at('.jevgate/laya-champion.json'), JSON.stringify({ accuracy: 0.994, n: 170 }));
  fs.writeFileSync(at('next-report.json'), REPORT(true, { n: 175, accuracy: 0.99 }));
  run();
  assert.equal(fs.readFileSync(at('exported.txt'), 'utf8').trim(), 'ran',
    'a 0.4pp wobble is sampling noise, not a regression — blocking it freezes the model forever');
});

test('a missing train venv is reported, not silently skipped', () => {
  const { run, pushes } = sandbox();
  run({ JEV_LAYA_PYTHON: '/nonexistent/python' });
  assert.match(pushes().at(-1), /訓練跳過/);
});
