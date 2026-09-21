/**
 * jev-gate — prune long tool output with a Jev (System One) keep/drop judgment
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
  chunkChars: 16000,
  // ponytail: judge at most this many chunks per call; the rest passes through
  // verbatim (never truncated). Raise it if the log shows tails going unjudged.
  maxJudgedChunks: 8,
};

/**
 * The tools worth pruning, how to reach the long string in each one's result
 * record, and how to put a pruned one back.
 *
 * Read's threshold is higher than the others'. Bash and Grep output is a
 * report about files; a Read result *is* the file, and the model usually asked
 * for it by name to act on it. Pruning a 5 KB source file would trade a few
 * hundred tokens for the risk of reasoning about a file it only half saw, so
 * only big reads are judged, and Read's criteria drop mechanical bulk only.
 * The `[jev-prune: ...]` marker stays inline either way, so a removal is
 * visible to the model rather than silent.
 *
 * 12000 rather than the 20000 this started at: core token-caps a Read before
 * the hook sees it, and measured delivery is 8,000 chars for a 207 KB log and
 * 16,571 for a 114 KB base64 blob. At 20000 the hook could never fire — the
 * threshold has to sit under core's cap or Read is decoration.
 */
const TARGETS = {
  Bash: {
    thresholdChars: 4000,
    get: (r) => (typeof r?.stdout === 'string' ? r.stdout : undefined),
    set: (r, text) => ({ ...r, stdout: text }),
    criteria: {
      keep: "The chunk contains information directly needed to complete the user's current request/task.",
      drop: "The chunk is unrelated noise, duplicated boilerplate, or otherwise does not help complete the user's current request/task.",
    },
  },
  Grep: {
    thresholdChars: 4000,
    get: (r) => (typeof r?.content === 'string' ? r.content : undefined),
    set: (r, text) => ({ ...r, content: text, numLines: countLines(text) }),
    criteria: {
      keep: "The chunk holds matches that help answer the user's current request/task.",
      drop: "The chunk holds only matches from vendored, generated, minified or test-fixture files, or matches that cannot bear on the user's current request/task.",
    },
  },
  Read: {
    thresholdChars: 12000,
    get: (r) => (r?.type === 'text' && typeof r?.file?.content === 'string' ? r.file.content : undefined),
    set: (r, text) => ({ ...r, file: { ...r.file, content: text, numLines: countLines(text) } }),
    criteria: {
      keep: 'The chunk is source, configuration or prose the user could read, reference or edit. When in doubt, keep.',
      drop: 'The chunk is mechanical bulk that carries no meaning to read: minified or bundled code, base64 or hex blobs, lock-file bodies, generated tables, or long runs of repeated near-identical lines.',
    },
  },
};

const INSTRUCTIONS =
  "Decide whether the chunk of tool output is relevant to the user's current request/task. Keep output that helps answer or complete the task; drop output that is noise, repeated boilerplate, or unrelated.";

function countLines(text) {
  return text.split('\n').length;
}

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
export async function judgeChunk($, key, userRequest, chunk, criteria = TARGETS.Bash.criteria) {
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
        questions: { q: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
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
    const n = countLines(chunk);
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

/**
 * What the pruning is relative to. The newest real user turn beats anything on
 * the call: a Read carries only a path, a Grep only a pattern, and Bash's
 * `description` is the model's own gloss on its plan, not the ask.
 */
export async function userRequestOf($, e) {
  try {
    const messages = await $.session.messages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && typeof m.text === 'string' && m.text.trim()) {
        return m.text.trim().slice(0, 2000);
      }
    }
  } catch {
    /* fall through to what the call itself carries */
  }
  return e.description || e.pattern || e.command || e.file_path || '';
}

/** Durable mirror of each judged-prunable outcome; see appendLedger's comment. */
const LEDGER = '/Users/51mini/.openclaw/state/jev-prune.log';

/**
 * Append one prune line to the ledger, read-then-write because `$.fs` has no
 * append. Never throws: the ledger is observation only, so a broken clock or a
 * write refusal must never break the caller (prune). `$.clock.now` for a real
 * ISO timestamp.
 * @returns {Promise<void>}
 */
export async function appendLedger($, line) {
  try {
    const at = new Date(await $.clock.now()).toISOString();
    const previous = await $.fs.read(LEDGER).catch(() => '');
    await $.fs.write(LEDGER, `${previous}${at}\t${line}\n`);
  } catch {
    /* ledger is observation only — a failure must not stop the prune */
  }
}

/** The body of every pruning hook; `tool` picks the row of TARGETS to use. */
async function prune(tool, $, e, next) {
  const target = TARGETS[tool];
  const r = await next(e);
  if (r?.isError) return r;
  const out = target.get(r?.result);
  if (typeof out !== 'string' || out.length < target.thresholdChars) return r;

  const key = await apiKey($);
  if (!key) return r;

  const request = await userRequestOf($, e);
  const { kept, droppedLines } = await pruneText(out, (chunk) =>
    judgeChunk($, key, request, chunk, target.criteria),
  );
  const line = `jev-prune(${tool}): ${out.length} → ${kept.length} chars, ${droppedLines} lines dropped`;
  $.ui.log(line);
  // ponytail: the ui.log above is TUI-only and reaches no file unless --debug;
  // on a headless box the prune outcome would be unobservable and the threshold
  // impossible to tune, so mirror it to a ledger. Ledger writes on EVERY
  // judged-prunable call, keep or drop. It used to sit under the
  // `if (!droppedLines) return r` gate and in a swallow-all catch, so a hook
  // that fired but judged everything `keep` left zero durable trace —
  // indistinguishable from a hook that never loaded. appendLedger never throws,
  // so a broken ledger cannot stop the prune itself.
  await appendLedger($, line);
  if (!droppedLines) return r;
  // No `ref`: core re-maps this record for the model instead of reusing its own.
  return { result: target.set(r.result, kept) };
}

/**
 * Three spelled-out registrations rather than a loop over TARGETS, and a hook
 * literal rather than a factory call: `claude plugin validate` reads this
 * source statically. A loop variable makes it report `tool.call{tool=tool}`,
 * and a `prune('Bash')` in the hook slot makes it refuse the module outright —
 * the one check that the engine sees what was meant. The test asserts these
 * names match TARGETS, which is what the loop was buying.
 *
 * @type {import('claude-code').Register}
 */
export const register = (on) => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => prune('Bash', $, e, next));
  on('tool.call', { tool: 'Grep' }, ($, e, next) => prune('Grep', $, e, next));
  on('tool.call', { tool: 'Read' }, ($, e, next) => prune('Read', $, e, next));
};

export const TARGET_NAMES = Object.keys(TARGETS);
export { TARGETS };
