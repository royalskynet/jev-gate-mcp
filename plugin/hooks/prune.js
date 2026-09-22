import { appendFileSync, readFileSync } from 'node:fs';
import { promises as fsP } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeJudge, DEFAULT_CONFIG } from '../lib/judge.js';

// Never below `chunkChars`: under one chunk the judge is asked to drop the whole
// output or keep it, and it answers keep — in 19 real prune calls on the hook
// side of this repo, every call under one chunk dropped 0 lines while the single
// 44 KB call produced all 28,015 saved chars. A sub-chunk threshold buys latency
// and spend, not savings (DEVLOG §23.2). Asserted rather than clamped: a config
// that silently means something else is worse than one that refuses to load.
export const THRESHOLD_CHARS = DEFAULT_CONFIG.thresholdChars;
if (THRESHOLD_CHARS < DEFAULT_CONFIG.chunkChars) {
  throw new Error(`thresholdChars ${THRESHOLD_CHARS} is under one chunk (${DEFAULT_CONFIG.chunkChars})`);
}
const DROP_MARKER = (n) => `[jev-prune: dropped ${n} lines]`;

/**
 * Split into chunks preserving line boundaries, each at most chunkChars.
 * Lines longer than chunkChars stand alone.
 * ponytail: no overlap (unlike jevwire's screen) — pruning noise, not hunting
 * cross-boundary injections. Upgrade path: add overlap if chunk-edge misses matter.
 */
export function chunkLines(text, chunkChars = DEFAULT_CONFIG.chunkChars, maxChunks = DEFAULT_CONFIG.maxChunks) {
  const lines = text.split('\n');
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    if (line.length > chunkChars) {
      if (buf.length) { chunks.push(buf.join('\n')); buf = []; len = 0; }
      chunks.push(line);
    } else if (len + line.length + 1 > chunkChars && buf.length) {
      chunks.push(buf.join('\n'));
      buf = []; len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks.slice(0, maxChunks);
}

/**
 * Core pruning. `judge` is `(state) => Promise<'keep'|'drop'>` and already
 * wraps its own errors to 'keep' (fail-open). This returns the transformed
 * output plus counts and timing.
 */
export async function pruneOutput({ output, userRequest, judge }) {
  const started = Date.now();
  if (typeof output !== 'string') {
    return { kept: output, droppedLines: 0, shortCircuited: false, latencyMs: 0 };
  }
  if (output.length < THRESHOLD_CHARS) {
    return { kept: output, droppedLines: 0, shortCircuited: true, latencyMs: 0 };
  }
  const chunks = chunkLines(output);
  const keptParts = [];
  let droppedLines = 0;
  for (const chunk of chunks) {
    if (!chunk) { keptParts.push(chunk); continue; }
    let verdict = 'keep';
    try {
      verdict = (await judge({ user_request: userRequest, chunk })) === 'drop' ? 'drop' : 'keep';
    } catch {
      verdict = 'keep'; // fail-open: never drop on a judge error
    }
    if (verdict === 'keep') {
      keptParts.push(chunk);
    } else {
      droppedLines += chunk.split('\n').length;
      keptParts.push(DROP_MARKER(chunk.split('\n').length));
    }
  }
  return { kept: keptParts.join('\n'), droppedLines, shortCircuited: false, latencyMs: Date.now() - started };
}

/** One JSONL decision line per pruning event. Never logs state content or keys. */
export function logDecision(logPath, { tool, origLen, keptLen, latencyMs, model }) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool,
    original_len: origLen,
    kept_len: keptLen,
    latency_ms: latencyMs,
    model,
  });
  try { appendFileSync(logPath, line + '\n', 'utf8'); } catch { /* logging never blocks */ }
}

export async function prunePayload(payload, cfg = DEFAULT_CONFIG) {
  if (!payload) return payload;
  const tool = payload.tool_name;
  const out = payload.tool_response;
  const output = out && typeof out === 'object' ? out.output : undefined;
  const userRequest =
    (payload.tool_input && typeof payload.tool_input === 'object' && payload.tool_input.description) ||
    payload.prompt ||
    '';

  const judge = makeJudge(cfg); // each returned fn is fail-open already

  const r = await pruneOutput({ output, userRequest, judge });

  if (out && typeof out === 'object' && r.kept !== output) {
    out.output = r.kept;
  }

  if (!r.shortCircuited && typeof output === 'string') {
    try {
      await fsP.mkdir(dirname(cfg.pruneLog), { recursive: true });
    } catch { /* ignore */ }
    logDecision(cfg.pruneLog, {
      tool,
      origLen: output.length,
      keptLen: r.kept.length,
      latencyMs: r.latencyMs,
      model: cfg.model,
    });
  }
  return payload;
}

/** CLI: read hook payload (or fixture) on stdin, write modified payload to stdout. */
export async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8')); // stdin fd; readFileSync accepts fd
  } catch {
    return; // not hook JSON -> pass through untouched (fail-open)
  }
  const result = await prunePayload(payload);
  process.stdout.write(JSON.stringify(result));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) main().catch(() => process.exit(1));
