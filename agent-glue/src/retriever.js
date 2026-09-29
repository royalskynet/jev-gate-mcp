/**
 * agent-glue retriever — semantic search over the fix store, locally.
 *
 * B 段缺口 1 語意檢索（fail-open 降回原序，advisory）:
 *   `fixindex find "<症狀>"` 拿候選（env `FIXINDEX_DIR`/`FIXINDEX_INDEX` 已在
 *   shell 提供），再用本機 Laya `score` 重排關聯度輸出前 N。
 *
 * 全程 advisory 且 fail-open：
 *   - `fixindex` 本身失敗 → 回 `[]`（呼叫端保有原序，不猜）；
 *   - Laya 不可用（無模型目錄／載入失敗）→ 直接回 `fixindex` 原序前 N，不重排；
 *   - Laya 載入是 lazy 的，只在真的需要重排時才 load。
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execFile = promisify(execFileCb);

let layaPromise = null;
/** Lazy Laya handle; a failed load clears the cache so the next call retries. */
function loadLaya(modelDir) {
  if (!layaPromise) {
    layaPromise = (async () => {
      const { Laya } = await import('@receptron/laya');
      const dir = modelDir || process.env.JEV_LAYA_MODEL_DIR || path.join(os.homedir(), '.jevgate', 'laya-multilingual');
      return Laya.load({ modelDir: dir });
    })();
    layaPromise.catch(() => { layaPromise = null; });
  }
  return layaPromise;
}

/** One fixindex hit as a short, score-able candidate label. */
function candidateLabel(hit) {
  const file = (hit.file ?? '').replace(/\.md$/, '');
  const heading = hit.heading ?? hit.section ?? '';
  return [file, heading].filter(Boolean).join(' — ');
}

/**
 * Semantic retrieval: fixindex candidates reranked by local Laya score.
 * @param {string} query  the symptom / keyword to search for
 * @param {object} [opts]
 * @param {number}  [opts.limit]     how many fixindex candidates to fetch (default 10)
 * @param {number}  [opts.topN]      how many to return after reranking (default 5)
 * @param {string}  [opts.modelDir]  override the local Laya model dir
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

  // 2) Rerank with local Laya score; on any Laya failure keep the original order.
  const keepOriginal = () => hits.slice(0, topN);
  let laya;
  try {
    laya = await loadLaya(opts.modelDir);
  } catch {
    return keepOriginal();
  }

  try {
    const labels = hits.map(candidateLabel);
    const r = await laya.systemOne(
      query,
      { relevance: { type: 'score', instructions: 'Rate how relevant each candidate fix is to the symptom.', criteria: labels } },
    );
    const probs = r.answers.relevance.probabilities ?? {};
    const scored = hits
      .map((h, i) => ({ ...h, score: probs[String(i)] ?? 0 }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  } catch {
    return keepOriginal();
  }
}
