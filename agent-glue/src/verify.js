/**
 * agent-glue verify — completion verification shared by Claude and Codex.
 *
 * Deterministic evidence gate + optional Jev `pass|fail|unknown` opinion.
 * `evidence` is the host's *execution* records (command output, test runner
 * output, diff) — never the model's own prose. A completion claim with no
 * supporting execution evidence is always `unknown`, and the model's
 * self-reported "done" is not evidence on its own.
 *
 * The verdict is derived deterministically first; Jev (if given) only annotates
 * it. If evidence is missing or ambiguous the result is `unknown`, never
 * inferred from a claim.
 */

/**
 * @param {object} opts
 * @param {string} opts.claim        the claimed completion ("done", "fixed"…)
 * @param {object[]} opts.evidence   execution records; see shape below
 * @param {object}  [opts.judge]     optional injectable `(ctx)=>Promise<{verdict,confidence}>`
 * @returns {{ verdict:'pass'|'fail'|'unknown', evidence:object[], note?, jev?:object }}
 *
 * evidence record shape: `{ kind, path?, line?, text, ok? }` where `ok` is a
 * boolean only meaningful for executable/runnable evidence.
 */
export async function verifyCompletion(opts = {}) {
  const { claim, evidence = [], judge } = opts;
  const ev = Array.isArray(evidence) ? evidence : [];

  // Deterministic gate: no execution evidence at all -> unknown.
  if (!ev.length) {
    return { verdict: 'unknown', evidence: ev, note: 'no-execution-evidence' };
  }

  const failures = ev.filter((e) => e && e.ok === false);
  if (failures.length) {
    return { verdict: 'fail', evidence: failures, note: 'execution-failure' };
  }

  const located = ev.filter((e) => e && typeof e.path === 'string');
  const executable = ev.filter((e) => e && typeof e.ok === 'boolean');

  // Deterministic pass requires at least one execution record that ran without
  // failure. The cited evidence is the auditable command/log records (all that
  // passed, sorted by locatability) — never an empty list — and `file:line`
  // (the optional `path`/`line` fields) is only attached where the record
  // actually carries it.
  if (executable.length && executable.every((e) => e.ok === true)) {
    const cited = selectEvidence(executable, 20);
    const out = { verdict: 'pass', evidence: cited, note: 'execution-pass' };
    if (judge) {
      try {
        out.jev = await judge({ claim, evidence: ev });
      } catch {
        out.jev = null; // Jev opinion is advisory; its failure doesn't move pass->unknown
      }
    }
    return out;
  }

  // Runnable evidence that is neither pass nor fail (no ok flag) -> we cannot
  // call it done; but the execution happened, so it is not a bare claim either.
  const out = { verdict: 'unknown', evidence: located, note: 'inconclusive-evidence' };
  if (judge) {
    try {
      out.jev = await judge({ claim, evidence: ev });
    } catch {
      out.jev = null;
    }
  }
  return out;
}

/**
 * Deterministic, injectable default: how evidence is *selected* from a larger
 * transcript/diff. The caller passes the full evidence pool; this narrows it to
 * what the verdict should cite — the locatable execution records, capped by
 * `max`. Selection is deterministic code's job, not the model's.
 */
export function selectEvidence(pool = [], max = 20) {
  if (!Array.isArray(pool)) return [];
  const located = pool
    .filter((e) => e && typeof e.text === 'string' && e.text.length > 0)
    .sort((a, b) => {
      const pa = a.path ? 0 : 1;
      const pb = b.path ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (b.text?.length ?? 0) - (a.text?.length ?? 0);
    });
  return located.slice(0, max);
}
