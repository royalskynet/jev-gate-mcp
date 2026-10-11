// Deterministic controls surrounding model judgment: minimum-state projection,
// stable decision identity, quality signals, and safest-branch-first rollout.
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { ERR } from './core.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new WeakMap();

export function validateStateSchema(schema) {
  return ajv.compile(schema);
}

export function projectPolicyState(spec, state) {
  let projected = structuredClone(state);
  if (projected && typeof projected === 'object' && !Array.isArray(projected)) {
    projected = Object.fromEntries(
      (spec.state_projection ?? [])
        .filter((key) => Object.prototype.hasOwnProperty.call(projected, key))
        .map((key) => [key, projected[key]]),
    );
  }
  let validate = validators.get(spec.state_schema);
  if (!validate) {
    validate = validateStateSchema(spec.state_schema);
    validators.set(spec.state_schema, validate);
  }
  if (!validate(projected)) {
    const issue = validate.errors?.[0];
    const at = issue?.instancePath || '/';
    throw ERR.badRequest(`state ${at}: ${issue?.message ?? 'does not match policy schema'}`);
  }
  return projected;
}

export function policyDigests(spec) {
  const policyShape = {
    id: spec.id,
    version: spec.version,
    model: spec.model,
    questions: spec.questions,
    mapping: spec.mapping,
    thresholds: spec.thresholds,
    consequence: spec.consequence,
    state_schema: spec.state_schema,
    state_projection: spec.state_projection,
    activation: spec.activation,
    ...(spec.quality_thresholds ? { quality_thresholds: spec.quality_thresholds } : {}),
  };
  return {
    policy_digest: digest(policyShape),
    question_digest: digest(spec.questions),
  };
}

export function decisionQuality(question, answer) {
  const probabilities = distribution(question, answer);
  if (!probabilities) return { margin: null, entropy: null, variance: null };
  const sorted = [...probabilities].sort((a, b) => b - a);
  const margin = sorted.length > 1 ? sorted[0] - sorted[1] : sorted[0];
  const entropy = probabilities.length > 1
    ? -probabilities.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0) / Math.log(probabilities.length)
    : 0;
  let variance = null;
  if (question.type === 'score') {
    const mean = probabilities.reduce((sum, p, i) => sum + p * i, 0);
    variance = probabilities.reduce((sum, p, i) => sum + p * ((i - mean) ** 2), 0);
  }
  return { margin: round4(margin), entropy: round4(entropy), variance: round4(variance) };
}

export function applyActivation(rawOutcome, spec, requestId) {
  if (rawOutcome !== 'accept') return { outcome: rawOutcome, reason: null, cohort: null };
  if ((spec.mode ?? 'active') !== 'active' || spec.calibration_status !== 'calibrated') {
    return { outcome: 'review', reason: 'shadow_or_uncalibrated', cohort: null };
  }
  if (!spec.activation.allow_outcomes.includes('accept')) {
    return { outcome: 'review', reason: 'accept_not_allowlisted', cohort: null };
  }
  const percent = spec.activation.rollout_percent;
  if (percent >= 100) return { outcome: 'accept', reason: null, cohort: 0 };
  if (percent <= 0 || !requestId) return { outcome: 'review', reason: 'outside_canary', cohort: null };
  const cohort = cohortPercent(`${spec.id}@${spec.version}:${spec.activation.salt}:${requestId}`);
  return cohort < percent
    ? { outcome: 'accept', reason: 'canary', cohort: round4(cohort) }
    : { outcome: 'review', reason: 'outside_canary', cohort: round4(cohort) };
}

function distribution(question, answer) {
  if (question.type === 'noul' && Number.isFinite(answer.noul)) return [answer.noul, 1 - answer.noul];
  const keys = question.type === 'choice'
    ? Object.keys(question.criteria)
    : question.type === 'score'
      ? question.criteria.map((_, i) => String(i))
      : [];
  if (!answer.probabilities || keys.length === 0) return null;
  const values = keys.map((key) => Number(answer.probabilities[key] ?? 0));
  if (values.some((p) => !Number.isFinite(p) || p < 0)) return null;
  const total = values.reduce((sum, p) => sum + p, 0);
  return total > 0 ? values.map((p) => p / total) : null;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cohortPercent(seed) {
  const bytes = createHash('sha256').update(seed).digest();
  return bytes.readUInt32BE(0) / 0x1_0000_0000 * 100;
}

function round4(value) {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
}
