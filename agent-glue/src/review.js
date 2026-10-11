/**
 * agent-glue review — staged diff review shared by Claude and Codex.
 *
 * The pipeline is staged in a fixed order; each stage is deterministic code or
 * an injected observer whose output is advisory and never treated as proof:
 *
 *     risk filter → file profile → evidence selection → mechanism → severity
 *                 → reviewer route
 *
 * Thresholds, diff extraction and evidence bounding are owned by deterministic
 * code here. Jev (injected) provides mechanism/severity *opinions* only; a
 * finding from Jev never gates a route decision — only the deterministic
 * severity does. Uncalibrated/shadow reviewers therefore stay advisory.
 */

const SEVERITY = ['low', 'medium', 'high', 'critical'];

/**
 * Deterministic risk filter: which files' diffs warrant review at all.
 * `risk` is additions + removals (a removals-heavy change is still a change),
 * and any sensitive path (credentials, calibration, policy config) always
 * passes regardless of size because a change there can flip enforcement.
 */
export function riskFilter(files = [], threshold = 100) {
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => ({
      path: f.path ?? null,
      added: typeof f.added === 'number' ? f.added : 0,
      removed: typeof f.removed === 'number' ? f.removed : 0,
      risk: (typeof f.added === 'number' ? f.added : 0) + (typeof f.removed === 'number' ? f.removed : 0),
    }))
    .filter((f) => f.path && (isSensitivePath(f.path) || f.risk >= threshold));
}

/** Per-file deterministic profile: size + extension risk heuristics. */
export function fileProfile(f) {
  const ext = f?.path ? String(f.path).split('.').pop() : '';
  const riskyExt = /^(sh|py|js|ts|go|rb|php|cs|sql)$/.test(ext);
  const sizeRisk = (f?.added ?? 0) > 300 ? 'large' : (f?.added ?? 0) > 60 ? 'medium' : 'small';
  return {
    path: f?.path ?? '',
    ext,
    sizeRisk,
    engineRisky: riskyExt,
    sensitive: isSensitivePath(f?.path),
    added: typeof f?.added === 'number' ? f.added : 0,
    removed: typeof f?.removed === 'number' ? f.removed : 0,
    profile: riskyExt || isSensitivePath(f?.path) ? 'engine' : 'data',
  };
}

/**
 * A path counts as sensitive when touching credentials, secrets, keys, policy
 * configuration, or calibration data — a change here can flip enforcement or
 * leak keys, so it must always surface for review regardless of size.
 */
const SENSITIVE_PATH = /(^|\/)(\.env|\.env\..+|secrets?[^/]*|.*(_key|_token|_secret|_creds).*|\.creds.*|.*\.jsonl|.*polic(y|ies).*\.json|.*calibration.*|\.aws|\.ssh|id_rsa.*)/i;

export function isSensitivePath(path) {
  return typeof path === 'string' && SENSITIVE_PATH.test(path);
}

/** Evidence bounding: cap lines/hunks we cite per file (deterministic). */
export function boundEvidence(hunks = [], maxHunks = 8, maxLinesPerHunk = 40) {
  if (!Array.isArray(hunks)) return [];
  return hunks.slice(0, maxHunks).map((h) => ({
    hunk: h.hunk ?? 0,
    lines: Array.isArray(h.lines) ? h.lines.slice(0, maxLinesPerHunk) : [],
  }));
}

/**
 * Parse a unified git diff into deterministic per-file records: path, added /
 * removed counts, hunks (with line-level +/- for evidence), and whether the
 * path is sensitive. This is the real-diff input for the staged review; the
 * caller passes the raw `git diff` output and deterministic code owns the
 * extraction (the model never parses a diff by hand).
 */
export function parseGitDiff(diffText = '') {
  if (typeof diffText !== 'string') return [];
  const files = [];
  let cur = null;
  for (const raw of diffText.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // `diff --git a/x b/x` opens a new file section.
    const header = line.match(/^diff --git a\/(.+?) b\/(.+?)(\s|$)/);
    if (header) {
      cur = { path: header[1], added: 0, removed: 0, hunks: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      cur.hunks.push({ hunk: cur.hunks.length + 1, lines: [] });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const last = cur.hunks[cur.hunks.length - 1];
    if (line.startsWith('+') && !line.startsWith('+++')) {
      cur.added++;
      if (last) last.lines.push({ kind: '+', text: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      cur.removed++;
      if (last) last.lines.push({ kind: '-', text: line.slice(1) });
    } else if (last) {
      last.lines.push({ kind: ' ', text: line.slice(1) });
    }
  }
  return files;
}

/**
 * Run the staged review. `files` may be pre-parsed records or, when `diff` is
 * given, parsed here from a real git diff. `jev` is an optional injectable
 * observer returning `{ mechanism, severity, confidence }`; its output is
 * attached as advisory and never moves the deterministic route across a
 * decision boundary.
 */
export async function reviewDiff(opts = {}) {
  const { files = [], diff = null, userIntent = '', jev, riskThreshold = 100 } = opts;
  const source = diff ? parseGitDiff(diff) : files;
  const riskyFiles = riskFilter(source, riskThreshold).map((f) => fileProfile(f));

  // Stage 1+2: risk filter + file profile. Empty pass -> no review.
  if (!riskyFiles.length) {
    return { stage: 'risk-filter', route: 'skip', files: [], reason: 'below-risk-threshold' };
  }

  // Stage 3: evidence selection (which files/hunks are cited).
  const cited = riskyFiles.map((f) => ({
    path: f.path,
    ...f,
    hunks: boundEvidence(source.find((x) => x.path === f.path)?.hunks ?? []),
  }));

  // Stage 4: mechanism + Stage 5: severity. Deterministic default severity
  // from profile; Jev opinion is advisory and clamped into known set.
  let jevOpinion = null;
  if (jev) {
    try {
      const j = await jev({ files: cited, userIntent });
      jevOpinion = {
        mechanism: typeof j?.mechanism === 'string' ? j.mechanism : null,
        severity: SEVERITY.includes(j?.severity) ? j.severity : null,
        confidence: typeof j?.confidence === 'number' ? j.confidence : null,
      };
    } catch {
      jevOpinion = null; // advisory only
    }
  }

  const severity = deterministicSeverity(cited, jevOpinion);

  // Stage 6: reviewer route.
  const route = severityRoute(severity);

  return { stage: 'review', files: cited, userIntent, jev: jevOpinion, severity, route };
}

/**
 * Deterministic severity — derived from the diff profile alone. Jev's opinion
 * is excluded on purpose: the five policies are all shadow/uncalibrated, so an
 * uncalibrated finding must never move a deterministic severity or reviewer
 * route. Jev opinions stay advisory (attached on the review result, a ledger
 * note) and never cross a decision boundary.
 */
export function deterministicSeverity(fileProfiles, jevOpinion = null) {
  void jevOpinion; // advisory only; severity is deterministic
  const anyEngine = fileProfiles.some((f) => f.engineRisky);
  const anyLarge = fileProfiles.some((f) => f.sizeRisk === 'large');
  const anySensitive = fileProfiles.some((f) => f.sensitive);
  let sev = anySensitive ? 'high' : anyEngine ? 'medium' : anyLarge ? 'medium' : 'low';
  if (fileProfiles.length >= 5 && anyEngine) sev = 'high';
  return sev;
}

/** Deterministic route: what reviewer class handles this severity. */
export function severityRoute(severity) {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'senior';
    case 'medium':
      return 'peer';
    default:
      return 'auto';
  }
}
