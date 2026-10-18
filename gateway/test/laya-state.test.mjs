// Laya sees a per-call crop of compact state (fix 10632: the head-kept 1024
// tokens held 7.4% of the state, never the call being asked about).
// scripts/laya_state.py reads the same golden file; the two must not drift.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { cropKey, cropState, groupByCrop } from '../src/laya-state.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChunked, bundleCrops } from '../src/adapters.js';

const golden = JSON.parse(readFileSync(new URL('../../tests/fixtures/laya-crop-golden.json', import.meta.url)));
const { state } = golden;

test('golden: JS crop matches the fixture shared with laya_state.py', () => {
  for (const c of golden.cases) {
    const s = c.state ?? state;
    const key = cropKey(s, c.qid);
    assert.equal(key, c.key, c.qid);
    assert.deepEqual(key ? cropState(s, key) : s, c.expected, c.qid);
  }
});

test('crop keeps the asked call, its neighbours and the tail, and marks gaps', () => {
  const out = cropState(state, 't5');
  const ids = out.history.flatMap((e) => (e.tool_calls ?? []).map((c) => c.id));
  assert.ok(ids.includes('t5'), 'asked call missing');
  assert.ok(!ids.includes('t6'), 'sibling call in the anchor entry should be dropped');
  assert.ok(!ids.includes('t1'), 'far-away call should be omitted');
  assert.ok(out.history.some((e) => e.omitted > 0), 'gap marker missing');
  assert.equal(out.history.at(-1).i, state.history.at(-1).i, 'tail missing');
  assert.ok(out.goal.length <= 201);
  assert.ok(JSON.stringify(out).length < JSON.stringify(state).length / 2);
});

test('non-tool questions and unknown calls keep the full state', () => {
  assert.equal(cropKey(state, 'tier'), null);
  assert.equal(cropKey('text state', 'call_t1'), null);
  assert.equal(cropState(state, 't99'), state);
});

test('runChunked feeds each tool id its own crop and never mixes crops in a batch', async () => {
  const seen = [];
  const laya = {
    systemOne: async (s, qs) => {
      seen.push({ s, qids: Object.keys(qs) });
      return { model: 'm', answers: Object.fromEntries(Object.keys(qs).map((k) => [k, { noul: 0.5 }])), usage: {} };
    },
  };
  const qs = { call_t1: {}, result_t1: {}, call_t5: {}, tier: {} };
  const r = await runChunked(laya, state, qs, 10_000, 4, true);
  assert.equal(Object.keys(r.answers).length, 4);
  assert.deepEqual(seen.map((x) => x.qids), [['call_t1', 'result_t1'], ['call_t5'], ['tier']]);
  assert.deepEqual(seen[0].s, cropState(state, 't1'));
  assert.equal(seen[2].s, state);
  assert.equal(groupByCrop(state, qs).length, 3);
});

test('without the bundle flag runChunked keeps the whole state', async () => {
  // The serving champion was trained on whole states; cropping its input would
  // feed it something it never saw.
  const seen = [];
  const laya = { systemOne: async (s, qs) => { seen.push(s); return { answers: {}, usage: {} }; } };
  await runChunked(laya, state, { call_t1: {}, call_t5: {} }, 10_000, 4);
  assert.deepEqual(seen, [state]);
});

test('bundleCrops reads state_crop from laya_config.json and defaults to false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'laya-bundle-'));
  assert.equal(bundleCrops(dir), false);
  writeFileSync(join(dir, 'laya_config.json'), JSON.stringify({ max_len: 1024 }));
  assert.equal(bundleCrops(dir), false);
  writeFileSync(join(dir, 'laya_config.json'), JSON.stringify({ max_len: 1024, state_crop: true }));
  assert.equal(bundleCrops(dir), true);
});
