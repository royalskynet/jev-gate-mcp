// 夜訓重放：route-judge hook 不走 Laya router（live.js 只有 triage 走），線上沒有它的
// shadow 列，laya-calibrate.py 就給不出它的 lb、target_weights() 也分不到配額。
// 這裡用現役 bundle 重答 teacher-corpus 裡 route-judge 的列，寫成 replay shadow 列
// 追加到 routing-samples.jsonl；calibrate 照常只認 shadow＋caller（舊名 gateway:route-judge 由它映成新名）。
//
// 防洩漏：只重放 corpus ts 晚於現役 champion promoted_at 的列（之前的被訓練看過）。
// 去重：同一 corpus id 在同一 champion 下只重放一次（champion_at 當鍵的一半）。
// 必須在換權重之後、calibrate 之前跑（laya-nightly.sh）。
//   node scripts/laya-replay-routejudge.mjs   零 token；JEV_LAYA_REPLAY_MAX 封頂（預設 800）
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { maxSoftmax, family } from '../gateway/src/laya-routing.js';
import { recordRoutingSample } from '../gateway/src/routing-corpus.js';

// 與線上 cascade shadow 同鍵，calibrate 合併算 lb；10-20 前寫的重放列是舊名，去重兩個都認。
export const CALLER = 'cascade:route-judge';
const OLD_CALLER = 'gateway:route-judge';
export const MARK = 'Classify the request for a coding agent';
const QTYPES = ['choice', 'noul'];

const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

/** 已在 promotedAt 這版 champion 下重放過的 corpus id。 */
export function doneIds(samplesText, promotedAt) {
  const done = new Set();
  for (const l of samplesText.split('\n')) {
    if (!l.includes('"replay":true')) continue;
    const r = parse(l);
    if (r?.replay && (r.caller === CALLER || r.caller === OLD_CALLER) && r.champion_at === promotedAt) done.add(r.request_id);
  }
  return done;
}

/** corpus 行 → 該重放的列：route-judge 直打（非 cascade）、晚於 champion 上線、還沒重放過、有可比的老師答案。 */
export function pickRows(corpusText, promotedAt, done, max = Infinity) {
  const since = Date.parse(promotedAt);
  if (!Number.isFinite(since)) return [];
  const out = [];
  for (const l of corpusText.split('\n')) {
    if (!l.includes(MARK)) continue;
    const r = parse(l);
    if (!r?.id || !r.teacher_answer || done.has(r.id)) continue;
    // 走 cascade 的列 daemon 已即時寫過 shadow，再重放會讓同一題算兩次。
    if (r.caller === CALLER) continue;
    if (!String(r.questions?.tier?.instructions ?? '').includes(MARK)) continue;
    if (!(Date.parse(r.ts) > since)) continue;
    const qs = Object.fromEntries(Object.entries(r.questions)
      .filter(([id, q]) => QTYPES.includes(q?.type) && r.teacher_answer[id] !== undefined));
    if (!Object.keys(qs).length) continue;
    out.push({ ...r, questions: qs });
    if (out.length >= max) break;
  }
  return out;
}

/** 逐列重答並寫 replay shadow 列。回 {rows, written, errors, secs}。 */
export async function replay(rows, laya, record, promotedAt) {
  const t0 = Date.now();
  let written = 0, errors = 0;
  for (const r of rows) {
    let res;
    try { res = await laya(r.state, r.questions, {}); } catch { errors++; continue; }
    for (const [id, q] of Object.entries(r.questions)) {
      const a = res?.answers?.[id];
      if (a === undefined) continue;
      record({ shadow: true, replay: true, champion_at: promotedAt, request_id: r.id, question_id: id,
        caller: CALLER, family: family(id), profile: null, question: q,
        local_model: res.model ?? 'laya', local_answer: a, local_confidence: maxSoftmax(a),
        fallback_reason: null, teacher_model: r.teacher_model ?? null, teacher_answer: r.teacher_answer[id] });
      written++;
    }
  }
  return { rows: rows.length, written, errors, secs: (Date.now() - t0) / 1000 };
}

async function main() {
  const H = homedir();
  const champ = process.env.JEV_LAYA_CHAMPION ?? `${H}/.jevgate/laya-champion.json`;
  const corpus = process.env.JEV_LAYA_REPLAY_CORPUS ?? `${H}/.jevgate/teacher-corpus.jsonl`;
  const samples = process.env.JEV_ROUTING_LOG ?? `${H}/.jevgate/routing-samples.jsonl`;
  const modelDir = process.env.JEV_LAYA_REPLAY_MODEL ?? `${H}/.jevgate/laya-trained-onnx`;
  const max = Number(process.env.JEV_LAYA_REPLAY_MAX ?? 800);
  const promotedAt = existsSync(champ) ? parse(readFileSync(champ, 'utf8'))?.promoted_at : null;
  // 沒有 champion 就沒有洩漏邊界，寧可不重放。
  if (!promotedAt) { console.log('replay skip: 無 champion promoted_at'); return 0; }
  const done = existsSync(samples) ? doneIds(readFileSync(samples, 'utf8'), promotedAt) : new Set();
  const rows = pickRows(readFileSync(corpus, 'utf8'), promotedAt, done, max);
  if (!rows.length) { console.log(`replay route-judge 0 列（已重放 ${done.size}，champion ${promotedAt}）`); return 0; }
  const { makeLayaAdapter } = await import('../gateway/src/adapters.js');
  const laya = makeLayaAdapter({ modelDir, timeoutMs: 120000, cropStates: true });
  const s = await replay(rows, laya, (x) => recordRoutingSample(x, samples), promotedAt);
  console.log(`replay route-judge ${s.rows} 列→${s.written} 題，失敗 ${s.errors}，${s.secs.toFixed(1)}s（champion ${promotedAt}）`);
  return s.errors && !s.written ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
