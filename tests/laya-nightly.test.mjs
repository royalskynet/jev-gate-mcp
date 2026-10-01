// The nightly job trains; the only output a human sees is the hpush, so test
// that. Three things can silently rot here: labelling could drift onto the
// trained weights (which turns the "vs int8" baseline into self-comparison),
// a promotion could land without the ONNX export that makes it reachable, and
// the summary line is jq string-building that has been wrong before.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const REPORT = (promoted) => JSON.stringify({
  units: 533, oof_accuracy: 0.674, paired_delta: 0.317, promoted,
  coverage_curve: [
    { threshold: 0.5, coverage: 0.61, accuracy: 0.84 },
    { threshold: 0.7, coverage: 0.278, accuracy: 0.952 },
    { threshold: 0.9, coverage: 0.09, accuracy: 0.979 },
  ],
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
  assert.match(summary, /可接手 27\.8% @0\.7/, 'must report the widest threshold still at >=95% accuracy');
  assert.match(summary, /已換權重/);
  assert.doesNotMatch(summary, /n\/a|null|undefined/);
});

test('an unpromoted night neither exports nor claims a gain it did not get', () => {
  const { at, run, pushes } = sandbox();
  fs.writeFileSync(at('next-report.json'), JSON.stringify({
    units: 40, oof_accuracy: 0.4, paired_delta: null, promoted: false,
    coverage_curve: [{ threshold: 0.7, coverage: 0.1, accuracy: 0.6 }],
  }));
  run();
  assert.equal(fs.existsSync(at('exported.txt')), false, 'exported an unpromoted model');
  const summary = pushes().at(-1);
  assert.match(summary, /vs int8 n\/a/);
  assert.match(summary, /無可用閾值/);
  assert.match(summary, /未達標/);
});

test('a missing train venv is reported, not silently skipped', () => {
  const { run, pushes } = sandbox();
  run({ JEV_LAYA_PYTHON: '/nonexistent/python' });
  assert.match(pushes().at(-1), /訓練跳過/);
});
