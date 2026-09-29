// Shared Laya bundle loader (gateway + agent-glue).
//
// The upstream tokenizer ships `<bos>/<eos>/<mask>/<pad>` but not the
// `[CLS]/[SEP]/[MASK]/[PAD]` names receptron's `Laya.load` resolves over its
// id() helper. We never rewrite the model dir's tokenizer.json (it stays the
// pristine upstream file); instead, when the needed names are missing we copy
// the bundle to a per-process shadow dir under the OS tmpdir and add the four
// aliases — `[CLS]`→`<bos>`(id 2), `[SEP]`→`<eos>`(id 1), `[MASK]`→`<mask>`(id
// 4), `[PAD]`→`<pad>`(id 0) — to that copy's added_tokens. `Laya.load` then
// resolves the alias ids (same integers, so the ONNX graph is untouched).
//
// ORT memory pressure: `sessionOptions` are passed straight through a receptron
// `Laya.load({ ..., sessionOptions })` (laya.js:46 spread), and `loadLaya`
// always sets the CPU-memory-audit knobs that keep resident set size down.
import { readFile, stat, cp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// (receptron name, upstream alias) -> same id in every laya checkpoint.
const ALIASES = [
  ['[CLS]', '<bos>'],
  ['[SEP]', '<eos>'],
  ['[MASK]', '<mask>'],
  ['[PAD]', '<pad>'],
];

// Default model bundle: the quantized int8 checkpoint. JEV_LAYA_MODEL_DIR
// still wins; the fp16 bundle stays available at the fallback path.
export function layaModelDir() {
  return process.env.JEV_LAYA_MODEL_DIR || path.join(os.homedir(), '.jevgate', 'laya-multilingual-int8');
}

async function hasAliases(dir) {
  const f = path.join(dir, 'tokenizer', 'tokenizer.json');
  try {
    const tok = JSON.parse(await readFile(f, 'utf8'));
    const present = new Set((tok.added_tokens ?? []).map((t) => t.content));
    return ALIASES.every(([name]) => present.has(name));
  } catch {
    return false;
  }
}

// A fresh per-process shadow for one source model dir. Refresh when the source
// files are newer than our copy (so model/tokenizer updates take effect).
async function shadowDirFor(src) {
  const base = path.join(os.tmpdir(), 'jevgate-laya-shadows');
  const slug = crypto.createHash('sha1').update(path.resolve(src)).digest('hex').slice(0, 12);
  const dir = path.join(base, `${process.pid}-${slug}`);
  try {
    const [sTok, sOnnx, xTok, xOnnx] = await Promise.all([
      stat(path.join(src, 'tokenizer', 'tokenizer.json')),
      stat(path.join(src, 'laya.onnx')),
      stat(path.join(dir, 'tokenizer', 'tokenizer.json')).catch(() => null),
      stat(path.join(dir, 'laya.onnx')).catch(() => null),
    ]);
    const fresh = xTok && xOnnx && xTok.mtimeMs >= sTok.mtimeMs && xOnnx.mtimeMs >= sOnnx.mtimeMs;
    if (fresh) return dir;
  } catch {
    // fall through to rebuild
  }
  await mkdir(dir, { recursive: true });
  // Copy the whole bundle, then rewrite only our shadow tokenizer copy.
  await cp(src, dir, { recursive: true });
  const tokPath = path.join(dir, 'tokenizer', 'tokenizer.json');
  const tok = JSON.parse(await readFile(tokPath, 'utf8'));
  const added = tok.added_tokens ?? [];
  const byAlias = new Map(added.map((t) => [t.content, t.id]));
  const present = new Set(added.map((t) => t.content));
  for (const [name, alias] of ALIASES) {
    if (present.has(name)) continue;
    const id = byAlias.get(alias);
    if (id === undefined) {
      throw new Error(`tokenizer lacks ${name} and ${alias} — cannot alias ${name}`);
    }
    added.push({ content: name, id, lstrip: false, rstrip: false, single_word: false, specialized: false, normal: true });
  }
  tok.added_tokens = added;
  await mkdir(path.dirname(tokPath), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tokPath, JSON.stringify(tok));
  return dir;
}

/**
 * Load the Laya bundle at `dir` (default JEV_LAYA_MODEL_DIR or the int8
 * checkpoint), transparently preparing a shadow tokenizer copy when upstream
 * tokenizer.json lacks `[CLS]/[SEP]/[MASK]/[PAD]`.
 * @param {object} [opts]
 * @param {string} [opts.modelDir]
 * @param {object} [opts.sessionOptions] extra ORT session options (spread last)
 */
export async function loadLaya({ modelDir, sessionOptions } = {}) {
  const { Laya } = await import('@receptron/laya');
  const dir = modelDir || layaModelDir();
  const useDir = (await hasAliases(dir)) ? dir : await shadowDirFor(dir);
  return Laya.load({
    modelDir: useDir,
    sessionOptions: {
      enableCpuMemArena: false,
      enableMemPattern: false,
      intraOpNumThreads: 2,
      ...(sessionOptions ?? {}),
    },
  });
}