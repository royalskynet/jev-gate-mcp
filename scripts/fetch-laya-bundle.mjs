#!/usr/bin/env node
/**
 * Fetch a Laya model bundle into ~/.jevgate/ (weights live outside git, so a
 * `git pull` on a second machine gets the code and none of the 540MB).
 *
 * The bundle is not a single upstream repo: the int8 graph comes from one
 * Hugging Face mirror, `laya_config.json` from another, and the graph output
 * has to be renamed (`act_logits` -> `act_probs`) before `@receptron/laya`
 * can read it. That assembly is what this script pins — see docs/DEVLOG.md §24.
 *
 * Usage:
 *   node scripts/fetch-laya-bundle.mjs                 # int8 (the default bundle)
 *   node scripts/fetch-laya-bundle.mjs --fp16          # fp16 reference for laya-agree
 *   node scripts/fetch-laya-bundle.mjs --dir <path>    # somewhere else
 *   node scripts/fetch-laya-bundle.mjs --self-check <bundle-dir>
 *
 * Downloads resume (`curl -C -`), and every file is size- and sha256-checked
 * against the pinned commit before the ONNX rename runs.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Pinned to commits, not `main`: a mirror that re-quantizes silently would
// otherwise change the weights under a passing checksum-free pull.
const YEHOR = 'yehor-oleksiuk/laya-multilingual-onnx/resolve/4603ff7b55790fa1226809207465f7b26bbaae66';
const KILLKLI = 'killkli/open-jev-laya-multilingual-onnx/resolve/643219b2b3a112ff1c40fb1143f050aa871f76f7';
const HF = (p) => `https://huggingface.co/${p}`;

const TOKENIZER = [
  { dest: 'tokenizer/tokenizer.json', url: HF(`${YEHOR}/tokenizer.json`), size: 34363188,
    sha256: '609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f' },
  { dest: 'tokenizer/tokenizer_config.json', url: HF(`${YEHOR}/tokenizer_config.json`), size: 524,
    sha256: '6c6b2d8e3c84ce0e671c129cd6b374b235d6f9863042a5836358d00a89bbb5a1' },
  // Only killkli ships the runtime config (max_len 1024 / head_max_len 256).
  { dest: 'laya_config.json', url: HF(`${KILLKLI}/laya_config.json`), size: 115,
    sha256: '7de12d5029e6834fa6ce19939380488cf9012e164fe2da91568b23d4075a2ddb' },
];

const BUNDLES = {
  int8: {
    dir: () => process.env.JEV_LAYA_MODEL_DIR || path.join(os.homedir(), '.jevgate', 'laya-multilingual-int8'),
    files: [
      { dest: 'laya.onnx', url: HF(`${YEHOR}/model_int8.onnx`), size: 540524684,
        sha256: '22fdf8b58fb9242d03902f8af4bf339d456732bb1eb0af49c79180f594903631' },
      ...TOKENIZER,
    ],
    // Post-rename: the name is one byte shorter and appears twice (the action
    // head node's output and the graph output). Pinned to the assembled bundle
    // this repo was validated against.
    onnxSize: 540524682,
    onnxSha256: '33f86af38198a1c4ad00f9c2312c28f8e8abf6ddfed1e9e8e82e4dcb5f446baf',
  },
  fp16: {
    dir: () => path.join(os.homedir(), '.jevgate', 'laya-multilingual'),
    files: [
      { dest: 'laya.onnx', url: HF(`${KILLKLI}/onnx/laya_fp16.onnx`), size: 646982318,
        sha256: 'e5a1308865d26b8eff0d33cff193bfbd40b2c7e972aa6e69d007af548f52ed83' },
      ...TOKENIZER,
    ],
    // No pinned post-rename size: this mirror is expected to already export
    // act_probs, and the rename is detected rather than assumed.
  },
};

async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function sizeOf(file) {
  try { return (await stat(file)).size; } catch { return -1; }
}

async function download(spec, dir) {
  const out = path.join(dir, spec.dest);
  await mkdir(path.dirname(out), { recursive: true });
  if (await sizeOf(out) === spec.size && await sha256(out) === spec.sha256) {
    console.log(`ok (cached)  ${spec.dest}`);
    return out;
  }
  console.log(`fetching     ${spec.dest}  <- ${spec.url}`);
  const r = spawnSync('curl', ['-fL', '--retry', '3', '-C', '-', '-o', out, spec.url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`curl failed for ${spec.url}`);
  const [got, digest] = [await sizeOf(out), await sha256(out)];
  if (got !== spec.size) throw new Error(`${spec.dest}: expected ${spec.size} bytes, got ${got}`);
  if (digest !== spec.sha256) throw new Error(`${spec.dest}: sha256 ${digest} != ${spec.sha256}`);
  console.log(`ok           ${spec.dest}  ${got} bytes`);
  return out;
}

// --- ONNX output rename -----------------------------------------------------
// The community int8 graph names its action head output `act_logits`;
// `@receptron/laya` reads `act_probs`. Renaming means rewriting a protobuf
// string one byte shorter, so every enclosing message's length varint has to
// shrink with it. We never parse the whole 540MB model: we find the string,
// walk down from the root along the single path that contains it, and re-emit
// the length prefixes on that path.
// ponytail: targeted path rewrite instead of a protobuf/onnx dependency; if
// this ever needs to edit more than a name, pull in the real `onnx` tooling.
function readVarint(buf, pos) {
  let value = 0, shift = 0, p = pos;
  for (;;) {
    const b = buf[p++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, end: p };
}

function writeVarint(value) {
  const out = [];
  let v = value;
  do { const b = v % 128; v = Math.floor(v / 128); out.push(b | (v > 0 ? 0x80 : 0)); } while (v > 0);
  return Buffer.from(out);
}

// The chain of length-delimited frames from the root down to `target`.
function framesTo(buf, target) {
  const frames = [];
  let start = 0, end = buf.length;
  outer: for (;;) {
    let p = start;
    while (p < end) {
      const tag = readVarint(buf, p);
      const wire = tag.value & 7;
      p = tag.end;
      if (wire === 0) { p = readVarint(buf, p).end; continue; }
      if (wire === 5) { p += 4; continue; }
      if (wire === 1) { p += 8; continue; }
      if (wire !== 2) throw new Error(`unsupported wire type ${wire} at ${p}`);
      const len = readVarint(buf, p);
      const payload = len.end, next = payload + len.value;
      if (target >= payload && target < next) {
        frames.push({ lenStart: p, payload, len: len.value });
        if (payload === target) return frames; // the string field itself
        start = payload; end = next;
        continue outer;
      }
      p = next;
    }
    throw new Error(`offset ${target} not reachable from the root message`);
  }
}

function renameAt(buf, target, from, to) {
  const frames = framesTo(buf, target);
  const last = frames[frames.length - 1];
  if (last.len !== from.length || buf.toString('latin1', target, target + from.length) !== from) {
    throw new Error(`offset ${target} is not the string "${from}"`);
  }
  // Recompute lengths inside out; a shorter length can also need fewer varint bytes.
  let shrink = 0;
  const patches = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const newLen = i === frames.length - 1 ? to.length : f.len - shrink;
    const oldVarint = f.payload - f.lenStart;
    const bytes = writeVarint(newLen);
    patches.unshift({ ...f, bytes });
    shrink = (f.len - newLen) + (oldVarint - bytes.length);
  }
  const parts = [];
  let cursor = 0;
  for (const f of patches) {
    parts.push(buf.subarray(cursor, f.lenStart), f.bytes);
    cursor = f.payload;
  }
  parts.push(Buffer.from(to, 'latin1'), buf.subarray(target + from.length));
  return Buffer.concat(parts);
}

// Name occurrences only: a length-delimited field whose payload is exactly the
// name. Skips the same text inside the embedded python source blobs.
function findNameOffsets(buf, name) {
  const needle = Buffer.from(name, 'latin1');
  const offsets = [];
  let at = 0;
  for (;;) {
    const i = buf.indexOf(needle, at);
    if (i < 0) return offsets;
    at = i + 1;
    if (buf[i - 1] !== name.length) continue;          // length varint
    const tag = buf[i - 2];
    if (tag !== 0x0a && tag !== 0x12) continue;         // ValueInfoProto.name / NodeProto.output
    offsets.push(i);
  }
}

function renameOutput(buf, from, to) {
  let out = buf, renamed = 0;
  for (;;) {
    const [next] = findNameOffsets(out, from);
    if (next === undefined) return { buf: out, renamed };
    out = renameAt(out, next, from, to);
    renamed++;
  }
}

async function patchOnnx(file, expectSize, expectSha) {
  const buf = await readFile(file);
  const { buf: out, renamed } = renameOutput(buf, 'act_logits', 'act_probs');
  if (!renamed) { console.log('ok           laya.onnx already exports act_probs'); return; }
  if (expectSize && out.length !== expectSize) {
    throw new Error(`rename produced ${out.length} bytes, expected ${expectSize}`);
  }
  if (expectSha) {
    const digest = crypto.createHash('sha256').update(out).digest('hex');
    if (digest !== expectSha) throw new Error(`rename produced sha256 ${digest}, expected ${expectSha}`);
  }
  const tmp = `${file}.tmp`;
  await writeFile(tmp, out);
  await rename(tmp, file);
  console.log(`ok           laya.onnx act_logits -> act_probs (${renamed} names, ${out.length} bytes)`);
}

// Round-trip on an already-assembled bundle: renaming back and forth must
// reproduce the original file byte for byte, which is what proves the length
// rewrite above. Costs no download.
async function selfCheck(dir) {
  const file = path.join(dir, 'laya.onnx');
  const original = await readFile(file);
  const before = crypto.createHash('sha256').update(original).digest('hex');
  const back = renameOutput(original, 'act_probs', 'act_logits');
  if (!back.renamed) throw new Error(`${file} exports no act_probs to round-trip`);
  const again = renameOutput(back.buf, 'act_logits', 'act_probs');
  const after = crypto.createHash('sha256').update(again.buf).digest('hex');
  if (again.buf.length !== original.length || after !== before) {
    throw new Error(`round-trip changed the file: ${before} -> ${after}`);
  }
  console.log(`self-check ok  ${back.renamed} name(s), sha256 ${after} unchanged`);
}

export { renameOutput, selfCheck };

// Importable for tests; only the CLI entrypoint fetches anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const bundle = argv.includes('--fp16') ? BUNDLES.fp16 : BUNDLES.int8;
  const dir = flag('--dir') || flag('--self-check') || bundle.dir();

  if (argv.includes('--self-check')) {
    await selfCheck(dir);
  } else {
    console.log(`bundle       ${argv.includes('--fp16') ? 'fp16' : 'int8'} -> ${dir}`);
    await mkdir(dir, { recursive: true });
    for (const spec of bundle.files) await download(spec, dir);
    await patchOnnx(path.join(dir, 'laya.onnx'), bundle.onnxSize, bundle.onnxSha256);
    console.log(`done. smoke test: JEV_LAYA_MODEL_DIR=${dir} node scripts/laya-routing-smoke.mjs`);
  }
}
