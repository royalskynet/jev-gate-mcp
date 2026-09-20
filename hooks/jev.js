/**
 * jev-gate — prune long Bash output with a Jev (System One) keep/drop judgment
 * before it enters the model's context.
 *
 * This is a function hook, not a settings `command` hook, on purpose: a
 * PostToolUse command hook cannot rewrite a tool result that core has already
 * recorded. `tool.call` can: await `next(e)`, then answer with `{ result }`
 * (no `ref`) so core re-maps the pruned record for the model.
 *
 * The module runs with no Node: everything outside it comes through `$`.
 */

export const CONFIG = {
  endpoint: 'https://openrouter.ai/api/v1/systemone',
  model: 'typesafe/jev-1.13',
  apiKeyFile: '/Users/51mini/.creds/kv/OPENROUTER_API_KEY.txt',
  thresholdChars: 4000,
  chunkChars: 16000,
  // ponytail: judge at most this many chunks per call; the rest passes through
  // verbatim (never truncated). Raise it if the log shows tails going unjudged.
  maxJudgedChunks: 8,
};

const QUESTION = {
  type: 'choice',
  instructions:
    "Decide whether the chunk of tool output is relevant to the user's current request/task. Keep output that helps answer or complete the task; drop output that is noise, repeated boilerplate, or unrelated.",
  criteria: {
    keep: "The chunk contains information directly needed to complete the user's current request/task.",
    drop: "The chunk is unrelated noise, duplicated boilerplate, or otherwise does not help complete the user's current request/task.",
  },
};

/** Split on line boundaries, each part at most `chunkChars`. Lines longer than that stand alone. */
export function chunkLines(text, chunkChars = CONFIG.chunkChars) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of text.split('\n')) {
    if (len + line.length + 1 > chunkChars && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

/**
 * One Jev Choice over a chunk. Returns 'keep' | 'drop'; every failure path
 * answers 'keep', so a bad key, a 4xx or a bad schema can only pass output
 * through unchanged.
 */
export async function judgeChunk($, key, userRequest, chunk) {
  let res;
  try {
    res = await $.http.fetch(CONFIG.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CONFIG.model,
        state: { user_request: userRequest, chunk },
        questions: { q: QUESTION },
      }),
    });
  } catch {
    return 'keep';
  }
  if (!res || !res.ok) return 'keep';
  try {
    const answer = JSON.parse(res.text)?.answers?.q;
    return answer?.choice === 'drop' ? 'drop' : 'keep';
  } catch {
    return 'keep';
  }
}

/**
 * Prune `text` chunk by chunk. `judge` is `(chunk) => Promise<'keep'|'drop'>`.
 * Returns `{ kept, droppedLines }`; kept text is always verbatim or a marker.
 */
export async function pruneText(text, judge, maxJudged = CONFIG.maxJudgedChunks) {
  const chunks = chunkLines(text);
  const judged = chunks.slice(0, maxJudged);
  const verdicts = await Promise.all(judged.map((c) => judge(c).catch(() => 'keep')));
  let droppedLines = 0;
  const parts = chunks.map((chunk, i) => {
    if (verdicts[i] !== 'drop') return chunk;
    const n = chunk.split('\n').length;
    droppedLines += n;
    return `[jev-prune: dropped ${n} lines]`;
  });
  return { kept: parts.join('\n'), droppedLines };
}

let keyPromise;
function apiKey($) {
  keyPromise ??= Promise.resolve()
    .then(() => $.fs.read(CONFIG.apiKeyFile))
    .then((t) => String(t).trim() || null)
    .catch(() => null);
  return keyPromise;
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  // ponytail: Bash only. That is where the 50k-char outputs come from; add
  // Read/Grep once a prune log says their tails matter.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e);
    const out = r?.result?.stdout;
    if (typeof out !== 'string' || out.length < CONFIG.thresholdChars) return r;
    if (r.isError) return r;

    const key = await apiKey($);
    if (!key) return r;

    const request = e.description || e.command || '';
    const { kept, droppedLines } = await pruneText(out, (chunk) =>
      judgeChunk($, key, request, chunk),
    );
    if (!droppedLines) return r;

    $.ui.log(`jev-prune: ${out.length} → ${kept.length} chars, ${droppedLines} lines dropped`);
    // No `ref`: core re-maps this record for the model instead of reusing its own.
    return { result: { ...r.result, stdout: kept } };
  });
};
