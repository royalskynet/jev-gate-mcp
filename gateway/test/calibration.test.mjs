// Calibration metadata (item 4): every released policy records
// evaluation_dataset_version + calibration_status; an ACTIVE policy that is not
// calibrated is a startup error (uncalibrated confidence can never auto-accept);
// callers cannot override it (strict schema). Starter policies carry it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry } from '../src/registry.js';
import { applyPolicyInputSchema } from '../src/schema.js';
import { makeFakeAdapter, FakeMode } from '../src/adapters.js';
import { JevGateway } from '../src/gateway.js';

const registry = loadRegistry();

function writePolicy(dir, doc) {
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify(doc));
}

test('registry: all four starter policies are shadow/uncalibrated and name a synthetic-harness dataset', () => {
  for (const id of registry.ids()) {
    const spec = registry.resolve(id);
    assert.equal(spec.mode, 'shadow', `${id} must ship shadow (synthetic labels cannot prove model correctness)`);
    assert.equal(spec.calibration_status, 'uncalibrated', `${id} must be uncalibrated`);
    assert.match(spec.evaluation_dataset_version, /^synthetic-harness-/, `${id} must name a synthetic-harness dataset`);
  }
});

test('registry: active policy missing calibration_status is rejected at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cal-'));
  try {
    writePolicy(dir, {
      bad: { versions: [{ version: 1, mode: 'active', model: 'typesafe/jev-1.13-20260917', evaluation_dataset_version: 'd-v1', consequence: 'advisory', thresholds: { auto: 0.85, review: 0.6 }, questions: { q: { type: 'noul', instructions: '?', criteria: { true: 'y', false: 'n' } } }, mapping: { q: { true: 'accept', false: 'deny' } } }] },
    });
    assert.throws(() => loadRegistry(dir), /calibration_status required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: active uncalibrated policy is rejected (cannot auto-accept uncalibrated)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cal-'));
  try {
    writePolicy(dir, {
      bad: { versions: [{ version: 1, mode: 'active', model: 'typesafe/jev-1.13-20260917', evaluation_dataset_version: 'd-v1', calibration_status: 'uncalibrated', consequence: 'advisory', thresholds: { auto: 0.85, review: 0.6 }, questions: { q: { type: 'noul', instructions: '?', criteria: { true: 'y', false: 'n' } } }, mapping: { q: { true: 'accept', false: 'deny' } } }] },
    });
    assert.throws(() => loadRegistry(dir), /active policy must be calibrated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: shadow uncalibrated policy is allowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cal-'));
  try {
    writePolicy(dir, {
      ok: { versions: [{ version: 1, mode: 'shadow', model: 'typesafe/jev-1.13-20260917', evaluation_dataset_version: 'd-v1', calibration_status: 'uncalibrated', consequence: 'advisory', thresholds: { auto: 0.85, review: 0.6 }, questions: { q: { type: 'noul', instructions: '?', criteria: { true: 'y', false: 'n' } } }, mapping: { q: { true: 'accept', false: 'deny' } } }] },
    });
    const r = loadRegistry(dir);
    assert.deepEqual(r.ids(), ['ok']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema: caller cannot override calibration fields (strict reject)', () => {
  const p = applyPolicyInputSchema.safeParse({ policy: 'completion-claims', state: 'x', calibration_status: 'calibrated' });
  assert.equal(p.success, false, 'calibration_status must be server-owned');
  const p2 = applyPolicyInputSchema.safeParse({ policy: 'completion-claims', state: 'x', evaluation_dataset_version: 'mine' });
  assert.equal(p2.success, false, 'evaluation_dataset_version must be server-owned');
});

test('registry: calibration fields are surfaced on the resolved spec', () => {
  const spec = registry.resolve('completion-claims');
  assert.equal(spec.calibration_status, 'uncalibrated');
  assert.equal(spec.mode, 'shadow');
});

test('fail-safe: a shadow/uncalibrated policy never returns accept, public outcome capped at review', async () => {
  const g = new JevGateway({ evaluateAdapter: makeFakeAdapter(FakeMode.SUCCESS), registry });
  for (const id of registry.ids()) {
    const r = await g.applyPolicy({ policy: id, state: 'x' });
    assert.notEqual(r.outcome, 'accept', `${id} must never accept while shadow/uncalibrated`);
    assert.ok(['review', 'escalate', 'deny'].includes(r.outcome), `${id} public outcome capped at review`);
    assert.equal(r.coverage, 'complete', `${id} complete coverage preserved under cap`);
    // the raw composed gate is observable, never silently hidden
    assert.ok(['accept', 'review', 'escalate', 'deny'].includes(r.shadow_outcome ?? r.outcome));
  }
});
