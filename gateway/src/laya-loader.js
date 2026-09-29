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
import { readFile, writeFile, stat, mkdir, mkdtemp, readdir, symlink, rename, rm } from 'node:fs/promises';
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

// One shared shadow per source tokenizer version (keyed by source path +
// tokenizer size/mtime), never per process: every hook invocation loads Laya,
// so a per-pid copy of the 500MB+ bundle leaked gigabytes into tmpdir. Only
// tokenizer.json is rewritten; the ONNX graph and configs are symlinked. The
// shadow is built in a temp dir and renamed into place so concurrent loaders
// either win the rename or reuse the winner's copy.
export async function shadowDirFor(src) {
  const base = path.join(os.tmpdir(), 'jevgate-laya-shadows');
  const srcTok = path.join(src, 'tokenizer', 'tokenizer.json');
  const st = await stat(srcTok);
  const slug = crypto.createHash('sha1')
    .update(`${path.resolve(src)}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 16);
  const dir = path.join(base, slug);
  if (await hasAliases(dir)) return dir;

  await mkdir(base, { recursive: true });
  const tmp = await mkdtemp(path.join(base, `.tmp-${slug}-`));
  try {
    await mkdir(path.join(tmp, 'tokenizer'));
    for (const f of await readdir(src)) {
      if (f !== 'tokenizer') await symlink(path.resolve(src, f), path.join(tmp, f));
    }
    for (const f of await readdir(path.join(src, 'tokenizer'))) {
      if (f !== 'tokenizer.json') await symlink(path.resolve(src, 'tokenizer', f), path.join(tmp, 'tokenizer', f));
    }
    const tok = JSON.parse(await readFile(srcTok, 'utf8'));
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
    await writeFile(path.join(tmp, 'tokenizer', 'tokenizer.json'), JSON.stringify(tok));
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    // Lost the race to a concurrent loader: its copy is equivalent.
    if (await hasAliases(dir)) return dir;
    throw err;
  }
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