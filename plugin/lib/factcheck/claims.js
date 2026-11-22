// Statements about the outside world that a reader will act on: amounts, rates,
// obligations, scope ("includes", "each … separately") and attributions to a
// source ("the docs say"). Hedged or explicitly labelled inferences are not
// fact claims; checking them would punish the honest label.
export const FACT = /(\d+(?:\.\d+)?\s*(?:[uU]\b|USDT?|USD|美元|元|%|％)|月費|年費|收費|計費|費用|價格|定價|費率|另外|另購|分別|各自|每(?:種|個|次|筆|月)|必須|需要|須|應當|規定|要求|義務|禁止|包含|含有|涵蓋|只有|僅|全部|文件(?:寫|說|有|提)|官方(?:說|寫|表示)|條文|第\s*\d+\s*(?:條|行|頁)|\b(?:must|required|includes?|fee|price|charged?)\b)/i;
export const INFER = /(推論|推測|我認為|看起來|據我理解|未驗證|未證實|不確定|待確認|可能|也許|應該是|\binferr?ed\b|\bassum(?:e|ption)\b|\bunverified\b)/i;

const QUOTES = new Map([['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉'], ['"', '"']]);
const TERMINATOR = /[。！？!?；;]/;
const SENTENCE_END = /[。！？!?；;]+|\.(?=\s)/;
const QUOTED_TERMINATOR = /[。！!；;.][」』"]*$/;
const QUESTION_END = /[?？][。！？!?；;.]*\s*$/;
const CLOSING_QUOTES = /[」』"’]+\s*$/;
const QUOTED_LINE = /^(?:「[^」]*」|『[^』]*』|"[^"]*"|‘[^’]*’)$/;
const DENIAL = /(?:錯(?:的|誤)|有誤|不(?:正確|屬實|是真的|是事實)|並非事實|\b(?:false|wrong|incorrect|untrue|not true|inaccurate)\b)/i;
const ABBREVIATION = /\b(?:(?:[a-z]\.){2,}|(?:mr|mrs|ms|dr|prof|sr|jr)\.)$/i;

function* splitLine(line) {
  const quotes = [];
  let start = 0;
  let quoteStart = 0;
  let quoteEnds = [];
  let prefix = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    let boundary = false;
    if (char === quotes.at(-1)) {
      quotes.pop();
      if (!quotes.length && char !== '》' && char !== '〉') {
        const quoted = line.slice(quoteStart, i);
        const quotedQuestion = QUESTION_END.test(quoted.replace(CLOSING_QUOTES, ''));
        boundary = quotedQuestion
          ? !(prefix + line.slice(start, quoteStart)).trim()
          : QUOTED_TERMINATOR.test(quoted);
        const rest = line.slice(i + 1);
        const end = SENTENCE_END.exec(rest);
        const tail = end ? rest.slice(0, end.index + end[0].length) : rest;
        const separateTail = boundary && /^[\s,，]*(?:但|不過|然而|(?:but|however)\b)/i.test(tail);
        if (!separateTail && (INFER.test(tail) || DENIAL.test(tail) || QUESTION_END.test(tail))) continue;
        const attribution = prefix + line.slice(start, quoteStart + 1);
        for (const end of quoteEnds) {
          if (!line.slice(end + 1, i).trim()) break;
          yield prefix + line.slice(start, end + 1).trimEnd() + char;
          prefix = attribution;
          start = end + 1;
          while (/\s/.test(line[start] ?? '')) start++;
        }
      }
    } else if (QUOTES.has(char) && (char !== '"' || (!/\d/.test(line[i - 1] ?? '') && line.includes('"', i + 1)))) {
      if (!quotes.length) {
        quoteStart = i;
        quoteEnds = [];
      }
      quotes.push(QUOTES.get(char));
    } else {
      if (quotes.length <= 1 && TERMINATOR.test(char)) {
        const runStart = i;
        while (TERMINATOR.test(line[i + 1] ?? '')) i++;
        const run = line.slice(runStart, i + 1);
        if (!quotes.length) boundary = true;
        else if (/[。！!]/.test(run) && !QUESTION_END.test(run)) quoteEnds.push(i);
      } else if (char === '.' && /\s/.test(line[i + 1] ?? '')) {
        if (!quotes.length) boundary = true;
        else if (quotes.length === 1 && !ABBREVIATION.test(line.slice(quoteStart + 1, i + 1))) quoteEnds.push(i);
      }
    }
    if (boundary) {
      yield prefix + line.slice(start, i + 1);
      start = i + 1;
      prefix = '';
    }
  }
  yield prefix + line.slice(start);
}

/** Sentence-level split: drops code blocks, list markers and bold markers. */
export function sentences(text) {
  const body = String(text ?? '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/<options>[\s\S]*?<\/options>/g, '\n');
  const out = [];
  for (const line of body.split('\n')) {
    for (const raw of splitLine(line)) {
      const s = raw
        .replace(/^\s*(?:[-*>#]+|\d+[.)、])\s*/, '')
        .replace(/\*\*/g, '')
        .trim();
      if (s.length >= 6 && s.length <= 300 && !/^[\p{P}\s]+$/u.test(s)) out.push(s);
    }
  }
  return out;
}

export function isFactClaim(s) {
  const ending = QUOTED_LINE.test(s.trim()) ? s.replace(CLOSING_QUOTES, '') : s;
  return FACT.test(s) && !INFER.test(s) && !QUESTION_END.test(ending);
}

/**
 * Fact claims worth checking, deduplicated, in reply order.
 * ponytail: keyword heuristic; replace with a measured classifier if a
 *   shadow ledger shows it keeps inferences or drops real claims.
 */
export function selectFacts(text, { max = 8 } = {}) {
  if (max <= 0) return [];
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
