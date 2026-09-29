/**
 * agent-glue retriever — fix store search, with optional Jev relevance scoring.
 *
 * B 段缺口 1 語意檢索（fail-open 降回原序，advisory）:
 *   `fixindex find "<症狀>"` 拿候選（env `FIXINDEX_DIR`/`FIXINDEX_INDEX` 已在
 *   shell 提供），再用 JEV `score` 重排關聯度輸出前 N。
 *
 * 全程 advisory 且 fail-open：
 *   - `fixindex` 本身失敗 → 回 `[]`（呼叫端保有原序，不猜）；
 *   - JEV 不可用或答案不完整 → 直接回 `fixindex` 原序前 N，不重排；
 *   - transport 是 lazy 的，只在真的有候選時才取得。
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);


/** One fixindex hit as a short, score-able candidate label. */
function candidateLabel(hit) {
  const file = (hit.file ?? '').replace(/\.md$/, '');
  const heading = hit.heading ?? hit.section ?? '';
  return [file, heading].filter(Boolean).join(' — ');
}

/**
 * Semantic retrieval: fixindex candidates reranked by Jev score.
 * @param {string} query  the symptom / keyword to search for
 * @param {object} [opts]
 * @param {number}  [opts.limit]     how many fixindex candidates to fetch (default 10)
 * @param {number}  [opts.topN]      how many to return after reranking (default 5)
 * @param {object}  [opts.transport] injected gateway transport for offline tests
 * @param {object}  [opts.fixindex]  { command, args } override for the fixindex CLI
 * @param {object}  [opts.execFile]  injected execFile impl for tests
 * @returns {Promise<object[]>} reranked hits, each `{ key, file, heading, score }` sorted desc
 */
export async function retrieve(query = '', opts = {}) {
  const limit = opts.limit ?? 10;
  const topN = opts.topN ?? 5;
  const fi = opts.fixindex ?? { command: 'fixindex', args: [] };
  const run = opts.execFile ?? execFile;
  if (!query || !query.trim()) return [];

  // 1) fixindex candidates (advisory; a broken CLI returns nothing, never throws).
  let hits;
  try {
    const { stdout } = await run(fi.command, [...fi.args, 'find', query, '--limit', String(limit), '--json'], {
      env: { ...process.env, FIXINDEX_DIR: process.env.FIXINDEX_DIR ?? '', FIXINDEX_INDEX: process.env.FIXINDEX_INDEX ?? '' },
    });
    const parsed = JSON.parse(stdout);
    hits = Array.isArray(parsed?.hits) ? parsed.hits : [];
  } catch {
    return [];
  }
  if (!hits.length) return [];

  // 2) Semantic relevance is not a local classification. Use Jev, one ordinal
  // score per candidate; labels themselves are not ordinal score levels.
  const keepOriginal = () => hits.slice(0, topN);
  try {
    const transport = opts.transport ?? await (await import('./live.js')).liveTransport();
    if (!transport) return keepOriginal();
    const candidates = hits.map(candidateLabel);
    const questions = Object.fromEntries(candidates.map((_, i) => [`fix_${i}`, {
      type: 'score', instructions: `Rate how relevant candidates[${i}] is to query.`,
      criteria: ['unrelated', 'same broad topic', 'partially useful', 'directly addresses the symptom'],
    }]));
    const r = await transport.evaluate({ state: { query, candidates }, questions });
    if (r.coverage !== 'complete' || candidates.some((_, i) =>
      !Number.isFinite(r.answers?.[`fix_${i}`]?.score))) return keepOriginal();
    const scored = hits
      .map((h, i) => ({ ...h, score: r.answers[`fix_${i}`].score }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  } catch {
    return keepOriginal();
  }
}
