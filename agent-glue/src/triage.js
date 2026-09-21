/**
 * agent-glue triage — one Jev request, three answers, a money-saving layer.
 *
 * One request asks Jev three questions at once (`difficulty` score / `kind`
 * choice / `costly_mistake` noul), then deterministic code maps them onto a
 * tier (cheap → medium → hard) under floor rules and a configurable set of
 * thresholds. The whole layer is advisory and fail-open: with no live
 * transport, every risky or low-confidence or transport-broken case keeps the
 * status quo (unchanged), never upgrades, never blocks.
 *
 * Money-saving gates that run before any Jev call:
 *   - free pre-gates: empty turn / pinned / no tiers -> unchanged, no request
 *   - dangerous regex: scanned over the FULL original text, not the slice
 *   - slicing: `ask_chars` cap, first 1/4 + last 3/4, after unwrapping the
 *     schedule envelope
 *   - decision cache: key includes the context bucket so a small-context
 *     answer is never served to a large-context hit
 *   - privacy: `features` mode sends only statistics, never the original text;
 *     a sensitive profile forces features on
 *
 * Transport is injected (src/client.js) so tests use a fake. The cache is
 * injected so callers control lifetime and so tests can prove bucket-miss.
 */

export const DEFAULT_TRIAGE = {
  // tier ladder, index 0 is the cheapest; the decision never lands cheaper
  // than the floor allows. `null` (status quo) is a valid outcome.
  tiers: ['cheap', 'medium', 'hard'],
  // how much of the original text the Jev call may see
  ask_chars: 2500,
  // thresholds consumed by the deterministic tier mapping
  min_confidence: 0.6,
  simple_needs_probability: 0.7,
  simple_needs_confidence: 0.7,
  hard_needs_probability: 0.7,
  // risk word list scanned over the whole original text
  danger_words: [
    'prod', 'deploy', 'migrate', 'rm -rf', 'force-push', 'force push',
    'secret', 'auth', 'credential', 'payment', 'pii', 'password', 'token',
    'production', 'database', 'drop table', 'delete from', 'chmod', 'sudo',
  ],
  // 4-level difficulty rubric is fixed; level boundaries used to call simple/hard
  simple_score_at: 1.5,   // difficulty.score < this  -> simple-leaning
  hard_score_at: 2.0,     // difficulty.score >= this -> hard-leaning
};

/** Stable short fingerprint of the config surface that should split the cache. */
export function configFingerprint(cfg = {}) {
  const c = { ...DEFAULT_TRIAGE, ...cfg };
  const s = JSON.stringify([
    c.tiers, c.ask_chars, c.min_confidence, c.simple_needs_probability,
    c.simple_needs_confidence, c.hard_needs_probability, c.danger_words,
  ]);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Map a context length onto a coarse bucket; the bucket is part of the cache key. */
export function contextBucket(contextChars = 0) {
  if (contextChars < 8000) return 's';
  if (contextChars < 32000) return 'm';
  return 'l';
}

const DANGER_RE = (words) =>
  new RegExp(`(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');

/** Is there a risk word in the FULL original text? (Scanned pre-slice.) */
export function isDangerous(text, words = DEFAULT_TRIAGE.danger_words) {
  if (!text) return false;
  return DANGER_RE(words).test(text);
}

/** Unwrap a schedule envelope: keep `## Prompt|Task|Request` sections, drop `previous output`. */
export function unwrapEnvelope(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const keep = [];
  let dropSection = false; // inside a `previous output` block until the next heading
  for (const line of lines) {
    const heading = /^#{1,4}\s*([A-Za-z][\w -]*)$/.exec(line.trim());
    if (heading) {
      const t = heading[1].toLowerCase();
      dropSection = /(previous output|previous result|transcript|history)/.test(t);
      if (!dropSection) keep.push(line);
      continue;
    }
    if (!dropSection) keep.push(line);
  }
  return keep.join('\n');
}

/** Slice a text to `askChars`: first 1/4 + last 3/4 of an overlong body. */
export function sliceText(text, askChars = DEFAULT_TRIAGE.ask_chars) {
  const body = unwrapEnvelope(text ?? '');
  if (body.length <= askChars) return body;
  const headLen = Math.floor(askChars / 4);
  const tailLen = askChars - headLen;
  return body.slice(0, headLen) + '\n[...]\n' + body.slice(-tailLen);
}

/** Statistical features used in `features` privacy mode (never the original text). */
export function textFeatures(text) {
  const t = text ?? '';
  const hasCode = /[{};()]|function |=>|def |import |SELECT|async /i.test(t);
  // approximate step count by markdown bullets / numbered lines
  const steps = (t.match(/^\s*[-*]\s/mg) || []).length + (t.match(/^\s*\d+[.)]\s/mg) || []).length;
  const bucket = contextBucket(t.length);
  return {
    len_bucket: bucket,
    chars: t.length,
    has_code: hasCode,
    steps,
  };
}

/** Build the Jev question set for one triage request. */
export function triageQuestions() {
  return {
    difficulty: {
      type: 'score',
      instructions:
        'Rate the difficulty of the task in the request on a 4-level scale (rubric, lowest first).',
      criteria: [
        'trivial — a single well-known action, no research, no real risk of getting it wrong',
        'simple — a small, well-scoped edit or answer, limited context needed',
        'moderate — multi-step work, some investigation or judgement, some chance of a costly mistake',
        'hard — large or unfamiliar scope, open-ended, lots of context, high chance something breaks if rushed',
      ],
    },
    kind: {
      type: 'choice',
      instructions: 'What kind of task is this? Pick the single best fit.',
      criteria: {
        coding: 'writing, editing, debugging or reasoning about code',
        writing: 'prose, docs, content, summaries, review of writing',
        research: 'reading, searching, gathering and synthesizing information',
        general: 'anything else — planning, meta, mixed or unclear',
      },
    },
    costly_mistake: {
      type: 'noul',
      instructions: 'Is a mistake here likely to be costly — e.g. destructive, irreversible, on production, involving secrets, payment or user data?',
      criteria: { true: 'yes, a wrong move would be hard or expensive to undo', false: 'no — reversible, sandboxed, or low blast radius' },
    },
  };
}

/**
 * Decide a tier for one request.
 *
 * @param {object} input
 * @param {string}  input.text          full original request (risk-scanned whole)
 * @param {number}  [input.contextChars] context size for the cache bucket
 * @param {boolean} [input.has_images]
 * @param {boolean} [input.pinned]
 * @param {string}  [input.profile]      profile id; a sensitive profile forces features
 * @param {string[]} [input.tiers]       tier ladder (default DEFAULT_TRIAGE.tiers)
 * @param {object}  [input.config]       threshold overrides over DEFAULT_TRIAGE
 * @param {boolean} [input.features]     privacy mode: send only statistics
 * @param {object}  deps
 * @param {object}  deps.transport      injected client transport (src/client.js)
 * @param {Map}     [deps.cache]        decision cache (key -> answer); injected
 *
 * @returns {Promise<object>} bounded decision:
 *   { tier, specialty, confidence, cached, latency_ms, failOpen, featuresOnly, untouched }
 *   `tier: null` (or `unchanged:true`) means keep the status quo / no Jev decision.
 */
export async function triage(input = {}, deps = {}) {
  const cfg = { ...DEFAULT_TRIAGE, ...(input.config ?? {}) };
  const tiers = input.tiers ?? cfg.tiers;
  const transport = deps.transport ?? defaultNoTransport;
  const cache = deps.cache ?? new Map();
  const t0 = Date.now();
  const bucket = contextBucket(input.contextChars ?? 0);
  const danger = isDangerous(input.text, cfg.danger_words);
  const featuresOnly = Boolean(input.features) || input.profile === 'sensitive';

  const base = { cached: false, latency_ms: 0, failOpen: false, featuresOnly };

  // Free pre-gates: no text, pinned (fork inherits model — nothing to decide),
  // or an empty tier ladder -> keep status quo, spend no Jev call.
  if (!input.text || !input.text.trim() || input.pinned || !tiers || tiers.length === 0) {
    return { ...base, unchanged: true, tier: null, specialty: null, confidence: null, notice: 'pre-gate' };
  }

  const slice = sliceText(input.text, cfg.ask_chars);
  const fingerprint = configFingerprint(cfg);
  const cacheKey = JSON.stringify([slice, bucket, fingerprint, Boolean(input.has_images), Boolean(input.pinned), input.profile ?? 'default']);

  const hit = cache.get(cacheKey);
  if (hit) {
    return { ...hit, cached: true, latency_ms: 0 };
  }

  // A failing or absent transport fail-opens to status quo (never guesses up or down).
  const res = await safeEvaluate(transport, { slice, featuresOnly, danger, bucket, hasCode: textFeatures(input.text).has_code });
  if (res.error) {
    return { ...base, unchanged: true, tier: null, specialty: null, confidence: null, failOpen: true, notice: 'transport-fail-open' };
  }

  const decision = decideTier(res.answers, { cfg, tierNames: tiers, danger });
  const cheapTier = tiers[0];
  // Large context must never downgrade: a big context stays on the standard
  // (non-cheapest) model even for an easy task — saving there is not worth the
  // risk of a cheap model mis-handling the large surface.
  const tier = decision.tier === cheapTier && bucket === 'l' ? (tiers[1] ?? decision.tier) : decision.tier;
  const out = {
    ...base,
    tier,
    specialty: res.answers.kind?.choice ?? null,
    confidence: decision.confidence,
    latency_ms: res.latency_ms ?? (Date.now() - t0),
    cached: false,
    unchanged: tier === null,
    notice: decision.notice,
  };
  if (tier !== null) cache.set(cacheKey, { ...out, cached: true });
  return out;
}

/** Deterministic tier mapping + floor rules. Pure; unit-testable in isolation. */
export function decideTier(answers, { cfg = {}, tierNames = DEFAULT_TRIAGE.tiers, danger = false } = {}) {
  const c = { ...DEFAULT_TRIAGE, ...cfg };
  const dif = answers?.difficulty;
  const costly = answers?.costly_mistake;
  const score = typeof dif?.score === 'number' ? dif.score : null;
  const confidence = typeof dif?.confidence === 'number' ? dif.confidence : c.min_confidence;
  const stakes = typeof costly?.noul === 'number' ? costly.noul : 0;

  // probability the difficulty leans simple / hard, derived from the score's
  // per-level probabilities when present, else from the single confidence.
  const probs = dif?.probabilities;
  let simpleProb = c.simple_needs_probability;
  let hardProb = 0;
  if (probs && typeof probs === 'object' && Object.keys(probs).length) {
    const entries = Object.entries(probs).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
    if (entries.length) {
      simpleProb = entries.filter(([l]) => l < c.simple_score_at).reduce((s, [, v]) => s + v, 0);
      hardProb = entries.filter(([l]) => l >= c.hard_score_at).reduce((s, [, v]) => s + v, 0);
    }
  } else if (score !== null) {
    // no probabilities: lean by where the point score falls
    simpleProb = score < c.simple_score_at ? confidence : 1 - confidence;
    hardProb = score >= c.hard_score_at ? 0.5 + confidence * 0.5 : 0;
  }

  const [cheap, medium, hard] = tierNames;
  let tier;

  // Floor rules first, deterministic (they cannot be overridden by direction).
  if (danger) {
    // risky: never cheaper than medium
    tier = medium ?? cheap ?? null;
  } else if (confidence < c.min_confidence) {
    // low confidence + not dangerous -> keep status quo (no upgrade, no downgrade)
    tier = null;
  } else if (simpleProb >= c.simple_needs_probability && confidence >= c.simple_needs_confidence) {
    tier = cheap; // confident & simple & safe -> save money
  } else if (hardProb >= c.hard_needs_probability && confidence >= c.min_confidence) {
    tier = hard; // confident & hard -> afford the upgrade
  } else {
    tier = null; // status quo
  }

  // Floor: risky OR stakes>0.4 -> never the cheapest tier.
  if (danger || stakes > 0.4) {
    if (tier === cheap) tier = medium ?? cheap ?? null;
    else if (tier === null) tier = medium ?? cheap ?? null;
  }
  // Floor: stakes>0.85 and already hard-leaning (with enough confidence to trust
  // the hard read — a low-confidence difficulty judgment must not be escalated
  // to the most expensive tier) -> hard.
  if (stakes > 0.85 && confidence >= c.min_confidence && hardProb >= c.hard_needs_probability && tier !== hard) {
    tier = hard;
  }

  const notice = danger
    ? 'danger'
    : tier === cheap ? 'simple'
    : tier === hard ? 'hard'
    : 'status-quo';
  return { tier, confidence, notice };
}

/** Call the injected transport's evaluate; any reject -> { error } (fail-open). */
async function safeEvaluate(transport, { slice, featuresOnly, danger, bucket, hasCode }) {
  const state = featuresOnly
    ? { features: { char_bucket: bucket, has_danger_word: danger, has_code: hasCode } }
    : { user_request: slice, char_bucket: bucket };
  try {
    const res = await transport.evaluate({ state, questions: triageQuestions() });
    return { answers: res?.answers ?? {}, latency_ms: res?.latency_ms };
  } catch (err) {
    return { error: { code: 'ERR_CLIENT', message: err instanceof Error ? err.message : String(err) } };
  }
}

/** A transport that always fail-opens; used when no live client is injected. */
export const defaultNoTransport = {
  async evaluate() { throw new Error('no triage transport injected'); },
  async applyPolicy() { throw new Error('no triage transport injected'); },
};
