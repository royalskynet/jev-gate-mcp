// 重放 40 筆 jev-route 真實 state：同一次呼叫同時問原 tier 與三題拆開的 noul，比較答案乾脆度。
// 語料寫入導到 scratchpad，不污染 ~/.jevgate/teacher-corpus.jsonl。
import { readFileSync, writeFileSync } from 'node:fs';
const OUT = process.argv[2];
const GLUE = '/Users/you/dev/jev-gate-mcp/agent-glue/src';
const PII = /[\w.+-]+@[\w-]+\.[\w.]+|0x[0-9a-fA-F]{40}|\b09\d{8}\b|\+\d{8,}|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\bT[A-Za-z1-9]{33}\b/;

const recs = readFileSync('/Users/you/.jevgate/teacher-corpus.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.questions?.tier && r.state?.user_request && !PII.test(JSON.stringify(r.state)));
const seen = new Set(); const pool = [];
for (const r of recs.reverse()) { const k = r.state.user_request.slice(0, 200); if (!seen.has(k)) { seen.add(k); pool.push(r); } }
// 盡量讓三級都有：先各取最多 10 筆，再用最新的補滿 40
const pick = []; for (const t of ['L2', 'L1', 'L0']) pick.push(...pool.filter((r) => r.teacher_answer?.tier?.choice === t).slice(0, 10));
for (const r of pool) { if (pick.length >= 40) break; if (!pick.includes(r)) pick.push(r); }

const noul = (instructions, t, f) => ({ type: 'noul', instructions, criteria: { true: t, false: f } });
const Q = {
  tier: recs[0].questions.tier,
  broken: noul('Is the user reporting that something in an existing system is broken, erroring, or behaving abnormally, so the job is to find a root cause?',
    'yes — an existing thing used to work or should work and does not', 'no — a question, a new request, or a change to something that works'),
  multi_file: noul('Will carrying out this request require creating or editing more than one file? dirty_paths lists files already touched in this work.',
    'yes — two or more files will be created or edited', 'no — at most one file, or no file edits at all (a question or a read-only check)'),
  high_stakes: noul('Does carrying out the request touch any of: rule or policy files for an agent, trading or money movement, cron or scheduled jobs, fallback ordering, or an irreversible operation (deleting data, publishing, force push)?',
    'yes — at least one of these is touched', 'no — none of these is touched'),
};
const { liveTransport } = await import(`${GLUE}/live.js`);
const tr = await liveTransport();
if (!tr) { console.error('no transport'); process.exit(2); }
const out = [];
for (const [i, r] of pick.entries()) {
  try {
    const res = await tr.evaluate({ state: r.state, questions: Q });
    out.push({ i, req: r.state.user_request.slice(0, 300), phase: r.state.phase, dirty: r.state.dirty_paths?.length ?? 0, orig: r.teacher_answer?.tier, a: res.answers, lat: res.latency_ms });
  } catch (e) { out.push({ i, err: String(e?.message ?? e) }); }
  process.stderr.write('.');
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nn=${out.length} err=${out.filter((o) => o.err).length}`);
