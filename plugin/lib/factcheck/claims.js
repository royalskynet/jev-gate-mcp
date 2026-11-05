// Statements about the outside world that a reader will act on: amounts, rates,
// obligations, scope ("includes", "each … separately") and attributions to a
// source ("the docs say"). Hedged or explicitly labelled inferences are not
// fact claims; checking them would punish the honest label.
export const FACT = /(\d+(?:\.\d+)?\s*(?:[uU]\b|USDT?|USD|美元|元|%|％)|月費|年費|收費|計費|費用|價格|定價|費率|另外|另購|分別|各自|每(?:種|個|次|筆|月)|必須|需要|須|應當|規定|要求|義務|禁止|包含|含有|涵蓋|只有|僅|全部|文件(?:寫|說|有|提)|官方(?:說|寫|表示)|條文|第\s*\d+\s*(?:條|行|頁)|\b(?:must|required|includes?|fee|price|charged?)\b)/i;
export const INFER = /(推論|推測|我認為|看起來|據我理解|未驗證|未證實|不確定|待確認|可能|也許|應該是|\binferr?ed\b|\bassum(?:e|ption)\b|\bunverified\b)/i;

/** Sentence-level split: drops code blocks, list markers and bold markers. */
export function sentences(text) {
  const body = String(text ?? '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/<options>[\s\S]*?<\/options>/g, '\n');
  const out = [];
  for (const line of body.split('\n')) {
    for (const raw of line.split(/(?<=[。！!；;])\s*|(?<=\.)\s+/)) {
      const s = raw
        .replace(/^\s*(?:[-*>#]+|\d+[.)、])\s*/, '')
        .replace(/\*\*/g, '')
        .trim();
      if (s.length >= 6 && s.length <= 300) out.push(s);
    }
  }
  return out;
}

export function isFactClaim(s) {
  return FACT.test(s) && !INFER.test(s) && !/[?？]$/.test(s);
}

/**
 * Fact claims worth checking, deduplicated, in reply order.
 * ponytail: keyword heuristic; replace with a measured classifier if a
 *   shadow ledger shows it keeps inferences or drops real claims.
 */
export function selectFacts(text, { max = 8 } = {}) {
  const seen = new Set();
  const out = [];
  for (const s of sentences(text)) {
    if (seen.has(s) || !isFactClaim(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The one verdict worth acting on, most severe first: a confident
 * contradiction, then any contradiction, then a confident `not_addressed`.
 * Everything else ranks 0 and the first claim stands in for the round.
 */
export function decisive(judged = []) {
  const rank = (j) =>
    j?.verdict === 'contradicted' ? (j.gate === 'auto' ? 3 : 2)
      : j?.verdict === 'not_addressed' && j.gate === 'auto' ? 1 : 0;
  let best = judged[0];
  for (const j of judged) if (rank(j) > rank(best)) best = j;
  return best;
}
