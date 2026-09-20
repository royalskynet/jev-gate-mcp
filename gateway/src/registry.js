// Immutable, versioned Decision Policy registry.
//
// Policies are data, never code. A released version is frozen: the registry
// only hands out a shallow-cloned, deep-frozen spec so a caller cannot weaken
// thresholds, model, or composition at runtime. A version is selected by exact
// match or, when omitted, the highest released version in `active` mode
// (shadow versions are never selected by default).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERR } from './core.js';

const here = path.dirname(fileURLToPath(import.meta.url));

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
      }
      raw[id] = def;
    }
  }
  return new Registry(raw);
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
    // Highest released ACTIVE version; shadow versions are never auto-selected.
    const active = def.versions
      .filter((x) => (x.mode ?? 'active') === 'active')
      .sort((a, b) => b.version - a.version);
    if (active.length === 0) throw ERR.badRequest(`policy ${id}: no active version`);
    return deepFreeze({ id, version: active[0].version, ...active[0] });
  }
}
