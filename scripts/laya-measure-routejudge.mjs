// 現役 Laya（laya-trained-onnx）重答 route-judge 的 teacher-corpus 列；不寫回 corpus。
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { makeLayaAdapter } = await import(`${homedir()}/dev/jev-gate-mcp/gateway/src/adapters.js`);
const N = Number(process.env.N ?? 300);
const MARK = 'Classify the request for a coding agent';
const rows = readFileSync(`${homedir()}/.jevgate/teacher-corpus.jsonl`, 'utf8').split('\n')
  .filter((l) => l.includes(MARK)).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && String(r.questions?.tier?.instructions ?? '').includes(MARK) && r.teacher_answer);
const pick = rows.slice(-N);
const laya = makeLayaAdapter({ modelDir: `${homedir()}/.jevgate/laya-trained-onnx`, timeoutMs: 120000, cropStates: true });
const out = []; const t0 = Date.now(); const lat = [];
for (const r of pick) {
  const qs = Object.fromEntries(Object.entries(r.questions).filter(([id, q]) => ['choice', 'noul'].includes(q?.type) && r.teacher_answer[id]));
  const s = Date.now();
  try { const a = await laya(r.state, qs, {}); lat.push(Date.now() - s); out.push({ ts: r.ts, teacher: r.teacher_answer, local: a.answers ?? a }); }
  catch (e) { out.push({ ts: r.ts, err: String(e?.message ?? e) }); }
}
writeFileSync('/tmp/laya-measure/out.json', JSON.stringify({ n: pick.length, secs: (Date.now() - t0) / 1000, lat, out }));
console.log('done', pick.length, (Date.now() - t0) / 1000);
