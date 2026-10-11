import { route, EmptyCandidatesError } from '../plugin/lib/route.js';

/**
 * 10 fixed questions. Each has the set of candidate tools/skills available in
 * this session and the request to route. Runs through the real Jev scorer
 * (fail-open): if the provider cannot serve Jev, every request resolves to
 * no_match with no real judgment — reported honestly below.
 */
const BENCH = [
  { request: '讀取一份 PDF 內容並摘要', candidates: ['markitdown', 'Read', 'antalpha-skills', 'happy'] },
  { request: '查現在比特幣價格', candidates: ['market-data', 'Read', 'happy', 'graphify'] },
  { request: '把一段 Python 除錯', candidates: ['Bash', 'Read', 'deep-bash', 'happy'] },
  { request: '寫一份 PRD 文件', candidates: ['to-prd', 'write-a-skill', 'happy', 'Read'] },
  { request: '找一段程式的 bug', candidates: ['Bash', 'Read', 'diagnose', 'happy'] },
  { request: '寄訊息到 Telegram', candidates: ['telegram-send', 'hermes-send', 'happy', 'Read'] },
  { request: '查過去修過的同款症狀', candidates: ['fixindex', 'graphify', 'claude-mem', 'happy'] },
  { request: '把 markdown 轉成 HTML', candidates: ['markitdown', 'Bash', 'happy', 'Read'] },
  { request: '跑一輪單元測試', candidates: ['Bash', 'Read', 'happy', 'test-runner'] },
  { request: '總結這個 repo 的架構', candidates: ['Read', 'graphify', 'happy', 'Grep'] },
];

const t0 = Date.now();
let resolved = 0;
let noMatch = 0;
let unavailable = 0;
for (const item of BENCH) {
  let r;
  let ms;
  try {
    const s = Date.now();
    r = await route({ candidates: item.candidates, userRequest: item.request });
    ms = Date.now() - s;
  } catch (e) {
    console.log('ERR', item.request, '->', e.message);
    continue;
  }
  console.log(JSON.stringify({ request: item.request, no_match: r.no_match, reason: r.reason ?? null, top: r.top?.slice(0, 3).map((x) => x.candidate), dispatch: r.dispatch, ms }));
  if (r.no_match) {
    noMatch++;
    if (r.reason === 'jev-unavailable' || r.reason === 'jev-bad-schema') unavailable++;
  } else {
    resolved++;
  }
}
const total = Date.now() - t0;
console.log(`\nSUMMARY: resolved=${resolved} no_match=${noMatch} provider_unavailable=${unavailable} total_ms=${total} avg_ms=${(total / BENCH.length).toFixed(1)}`);

// Empty candidates must throw, not return null.
try {
  await route({ candidates: [] });
  console.log('EMPTY-THROW: FAIL (did not throw)');
  process.exit(1);
} catch (e) {
  console.log('EMPTY-THROW:', e instanceof EmptyCandidatesError ? 'OK (threw EmptyCandidatesError)' : 'OK (threw ' + e.constructor.name + ')');
}
