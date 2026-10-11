// Immutable, versioned Decision Policy registry.
//
// Policies are data, never code. A released version is frozen: the registry
// only hands out a shallow-cloned, deep-frozen spec so a caller cannot weaken
// thresholds, model, or composition at runtime. A version is selected by exact
// match or, when omitted, the highest released version in `active` mode; if no
// version is `active` (e.g. starter policies shipped as shadow/uncalibrated),
// the highest `shadow` version is resolved instead — the gateway's fail-safe
// caps a shadow/uncalibrated outcome at `review`, so it still never auto-accepts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERR } from './core.js';
import { validateStateSchema } from './policy-controls.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GATES = new Set(['accept', 'review', 'escalate', 'deny']);

function deepFreeze(o) {
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(o);
}

/** Load and validate every policy file under <dir>/*.json. Duplicate ids and
 *  non-versioned defs are startup errors (fail loud, never half-run). */
export function loadRegistry(dir) {
  if (!dir) dir = path.join(here, '..', 'policies');
  const raw = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [id, def] of Object.entries(doc)) {
      if (raw[id]) throw new Error(`duplicate policy id in registry: ${id}`);
      if (!Array.isArray(def?.versions) || def.versions.length === 0) {
        throw new Error(`policy ${id}: must declare a non-empty versions array`);
      }
      for (const v of def.versions) {
        if (!v || typeof v.version !== 'number' || v.version < 1) {
          throw new Error(`policy ${id}: version must be a positive integer`);
        }
        validatePolicyVersion(id, v);
      }
      raw[id] = def;
    }
  }
  return new Registry(raw);
}

function validatePolicyVersion(id, v) {
  if (typeof v.model !== 'string' || v.model.trim() === '') throw new Error(`policy ${id}@${v.version}: pinned model required`);
  if (!['active', 'shadow'].includes(v.mode ?? 'active')) throw new Error(`policy ${id}@${v.version}: invalid mode`);
  // Every released version records what it was tuned against and whether it was
  // calibrated. An ACTIVE (consequential or auto-accepting) policy that is not
  // calibrated is a startup error: it must never quietly auto-accept on
  // uncalibrated confidence. Shadow versions may still be uncalibrated — that
  // is exactly what shadow mode is for (PRD: calibrate before activation).
  if (typeof v.evaluation_dataset_version !== 'string' || v.evaluation_dataset_version.trim() === '') {
    throw new Error(`policy ${id}@${v.version}: evaluation_dataset_version required`);
  }
  if (v.calibration_status == null || v.calibration_status === '') {
    throw new Error(`policy ${id}@${v.version}: calibration_status required`);
  }
  if (!['calibrated', 'uncalibrated'].includes(v.calibration_status)) {
    throw new Error(`policy ${id}@${v.version}: calibration_status must be calibrated|uncalibrated`);
  }
  if ((v.mode ?? 'active') === 'active' && v.calibration_status !== 'calibrated') {
    throw new Error(`policy ${id}@${v.version}: active policy must be calibrated (uncalibrated cannot auto-accept)`);
  }
  if (typeof v.consequence !== 'string' || v.consequence === '') throw new Error(`policy ${id}@${v.version}: consequence required`);
  if (!v.state_schema || typeof v.state_schema !== 'object') throw new Error(`policy ${id}@${v.version}: state_schema required`);
  try { validateStateSchema(v.state_schema); } catch (e) {
    throw new Error(`policy ${id}@${v.version}: invalid state_schema: ${e.message}`);
  }
  if (!Array.isArray(v.state_projection) || v.state_projection.length === 0 || v.state_projection.some((x) => typeof x !== 'string' || x === '')) {
    throw new Error(`policy ${id}@${v.version}: non-empty state_projection required`);
  }
  if (new Set(v.state_projection).size !== v.state_projection.length) throw new Error(`policy ${id}@${v.version}: state_projection contains duplicates`);
  const activation = v.activation;
  if (!activation || !Number.isFinite(activation.rollout_percent) || activation.rollout_percent < 0 || activation.rollout_percent > 100) {
    throw new Error(`policy ${id}@${v.version}: activation.rollout_percent must be 0..100`);
  }
  if (!Array.isArray(activation.allow_outcomes) || activation.allow_outcomes.some((gate) => !GATES.has(gate))) {
    throw new Error(`policy ${id}@${v.version}: activation.allow_outcomes contains an invalid Gate`);
  }
  if (typeof activation.salt !== 'string' || activation.salt.length < 1) throw new Error(`policy ${id}@${v.version}: activation.salt required`);
  if (v.quality_thresholds != null) {
    const { min_margin, max_entropy, max_variance } = v.quality_thresholds;
    if (min_margin != null && (!Number.isFinite(min_margin) || min_margin < 0 || min_margin > 1)) {
      throw new Error(`policy ${id}@${v.version}: quality_thresholds.min_margin must be 0..1`);
    }
    if (max_entropy != null && (!Number.isFinite(max_entropy) || max_entropy < 0 || max_entropy > 1)) {
      throw new Error(`policy ${id}@${v.version}: quality_thresholds.max_entropy must be 0..1`);
    }
    if (max_variance != null && (!Number.isFinite(max_variance) || max_variance < 0)) {
      throw new Error(`policy ${id}@${v.version}: quality_thresholds.max_variance must be >= 0`);
    }
    if ([min_margin, max_entropy, max_variance].every((x) => x == null)) {
      throw new Error(`policy ${id}@${v.version}: quality_thresholds must declare at least one threshold`);
    }
  }
  const { auto, review } = v.thresholds ?? {};
  if (![auto, review].every((x) => Number.isFinite(x) && x >= 0 && x <= 1) || review > auto) {
    throw new Error(`policy ${id}@${v.version}: thresholds must satisfy 0 <= review <= auto <= 1`);
  }
  if (!v.questions || typeof v.questions !== 'object' || Object.keys(v.questions).length === 0) {
    throw new Error(`policy ${id}@${v.version}: questions required`);
  }
  if (!v.mapping || typeof v.mapping !== 'object') throw new Error(`policy ${id}@${v.version}: mapping required`);
  const questionIds = Object.keys(v.questions).sort();
  const mappingIds = Object.keys(v.mapping).sort();
  if (JSON.stringify(questionIds) !== JSON.stringify(mappingIds)) {
    throw new Error(`policy ${id}@${v.version}: mapping must cover exactly every question`);
  }
  for (const qid of questionIds) {
    const q = v.questions[qid];
    const mapping = v.mapping[qid];
    const expected = q.type === 'choice'
      ? Object.keys(q.criteria ?? {})
      : q.type === 'score'
        ? q.criteria.map((_, i) => String(i))
        : q.type === 'noul'
          ? ['true', 'false']
          : [];
    const actual = Object.keys(mapping ?? {});
    if (expected.length === 0 || expected.some((key) => !actual.includes(key)) || actual.some((key) => !expected.includes(key))) {
      throw new Error(`policy ${id}@${v.version}: mapping ${qid} must cover exactly its answer space`);
    }
    if (Object.values(mapping).some((gate) => !GATES.has(gate))) {
      throw new Error(`policy ${id}@${v.version}: mapping ${qid} contains an invalid Gate`);
    }
  }
}

export class Registry {
  constructor(raw) {
    this._raw = raw;
  }

  ids() {
    return Object.keys(this._raw);
  }

  spec(id) {
    const def = this._raw[id];
    if (!def) return null;
    return { id, versions: def.versions };
  }

  resolve(id, version) {
    const def = this._raw[id];
    if (!def) throw ERR.badRequest(`unknown policy: ${id}`);
    if (version !== undefined) {
      const v = def.versions.find((x) => String(x.version) === String(version));
      if (!v) throw ERR.badRequest(`policy ${id}: unknown version ${version}`);
      return deepFreeze({ id, version: v.version, ...v });
    }
    // Highest released ACTIVE version; if none is active (shadow-only starter
    // policies), fall back to the highest SHADOW version so the policy stays
    // resolvable and observable (its outcome is capped by the gateway).
    const active = def.versions
      .filter((x) => (x.mode ?? 'active') === 'active')
      .sort((a, b) => b.version - a.version);
    if (active.length === 0) {
      const shadow = def.versions
        .filter((x) => (x.mode ?? 'active') === 'shadow')
        .sort((a, b) => b.version - a.version);
      if (shadow.length === 0) throw ERR.badRequest(`policy ${id}: no active version`);
      return deepFreeze({ id, version: shadow[0].version, ...shadow[0] });
    }
    return deepFreeze({ id, version: active[0].version, ...active[0] });
  }
}
