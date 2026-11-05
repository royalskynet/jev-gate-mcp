/**
 * Claim verifier backed by the opencode CLI, shaped like jevwire's runVerify
 * so claimcheck.checkClaims can take it as `verify`.
 *
 * Free-tier models (opencode-go/*-free) are CLI-only: never call their API
 * directly. One `opencode run` per reply, all claims in one prompt.
 *
 * Free models fabricate, so a verdict only stands with a verbatim quote that
 * is mechanically found in the evidence; otherwise it is downgraded to
 * not_addressed (gate=review, note=quote-not-in-evidence).
 * ponytail: runs an agent in an empty temp dir and tells it not to use tools;
 *   swap for a tool-less opencode agent config if one is ever needed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const VERDICTS = new Set(['supported', 'contradicted', 'not_addressed']);
const BASES = new Set(['user', 'inference', 'evidence']);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function defaultBin() {
  const local = join(homedir(), '.opencode', 'bin', 'opencode');
  return existsSync(local) ? local : 'opencode';
}

export function buildPrompt(claims, evidence) {
  return [
    'You are a strict fact checker. Do not use any tools. Answer only from the EVIDENCE below.',
    'For each numbered CLAIM decide:',
    '- supported: the evidence states it (an inference from nearby passages is NOT supported)',
    '- contradicted: the evidence states the opposite',
    '- not_addressed: the evidence does not state it either way',
    'For supported and contradicted, copy a short verbatim quote (under 200 characters) from the evidence. For not_addressed, quote is "".',
    'Also give "basis" for each claim:',
    '- user: the claim only restates what the user said under [user messages] (their own backend, invoice, numbers); quote the user\'s words',
    '- inference: the claim draws a conclusion the evidence does not literally state (explains why, predicts, decides, generalises), even if it builds on the user\'s numbers',
    '- evidence: anything else',
    'Reply with only a JSON array, one object per claim, in order: [{"i":1,"verdict":"...","quote":"...","basis":"..."}]',
    '',
    'CLAIMS:',
    ...claims.map((c, i) => `${i + 1}. ${c}`),
    '',
    'EVIDENCE:',
    evidence,
  ].join('\n');
}

/** Last JSON array in the model output, or null. */
export function parseVerdicts(stdout) {
  const text = String(stdout ?? '');
  for (let end = text.lastIndexOf(']'); end >= 0; end = text.lastIndexOf(']', end - 1)) {
    for (let start = text.lastIndexOf('[', end); start >= 0; start = text.lastIndexOf('[', start - 1)) {
      try {
        const v = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(v) && v.every((o) => o && typeof o === 'object')) return v;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

/** Model answers -> jevwire-shaped claims, with the verbatim-quote guard. */
export function grade(claims, answers, evidence) {
  const ev = norm(evidence);
  return claims.map((claim, i) => {
    const a = answers.find((o) => Number(o.i) === i + 1) ?? answers[i] ?? {};
    const verdict = VERDICTS.has(a.verdict) ? a.verdict : 'not_addressed';
    const quote = norm(a.quote);
    const basis = BASES.has(a.basis) ? a.basis : undefined;
    if (verdict === 'not_addressed') return { claim, verdict, gate: 'auto', basis, note: VERDICTS.has(a.verdict) ? undefined : 'no-answer' };
    if (quote.length >= 4 && ev.includes(quote)) return { claim, verdict, gate: 'auto', quote, basis };
    return { claim, verdict: 'not_addressed', gate: 'review', basis, note: 'quote-not-in-evidence', claimed: verdict };
  });
}

// stdin must be closed: `opencode run` appends piped stdin to the message and
// waits for EOF, so an open pipe hangs until the timeout.
function runCli(bin, args, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`opencode run failed: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0 && !timedOut) resolve(out);
      else reject(new Error(`opencode run failed: ${timedOut ? 'timeout' : `rc=${code}`} ${err.slice(-200)}`.trim()));
    });
  });
}

/** Older opencode builds reject --pure; probe once like dispatch-router's dc. */
export function supportsPure(bin) {
  const r = spawnSync(bin, ['run', '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  return /--pure/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
}

export function ocVerifier({ bin = defaultBin(), model = 'opencode-go/beam-free', timeoutMs = 180000, run = runCli, pure = run === runCli ? supportsPure(bin) : true } = {}) {
  const flags = pure ? ['run', '--pure', '-m', model] : ['run', '-m', model];
  return async (_model, { claims, evidence }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'claimcheck-oc-'));
    try {
      const out = await run(bin, [...flags, buildPrompt(claims, evidence)], { timeoutMs, cwd });
      const answers = parseVerdicts(out);
      if (!answers) throw new Error(`opencode run: no JSON verdicts in output: ${String(out).slice(-200)}`);
      return { claims: grade(claims, answers, evidence), usage: { judge: model } };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}
