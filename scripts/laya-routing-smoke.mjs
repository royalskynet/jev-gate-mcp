// Opt-in, local-only smoke: no cloud adapter, no corpus, no model download.
import { loadLaya } from '../gateway/src/laya-loader.js';
import { makeLayaAdapter } from '../gateway/src/adapters.js';
import { makeLayaRouter, TASK_KIND, MESSAGE_TOPIC } from '../gateway/src/laya-routing.js';

const fixtures = [
  ['修正 JavaScript 函式的錯誤', TASK_KIND, 'coding'],
  ['請將這段英文翻譯成中文', TASK_KIND, 'writing'],
  ['幫我搜尋有關太陽能的資料', TASK_KIND, 'research'],
  ['請幫我寫一封邀請信', TASK_KIND, 'writing'],
  ['帳單為什麼被扣了兩次？', MESSAGE_TOPIC, 'billing'],
  ['程式打開就閃退，怎麼處理？', MESSAGE_TOPIC, 'technical'],
  ['你們的營業時間是幾點？', MESSAGE_TOPIC, 'general'],
  ['發票可以補寄嗎？', MESSAGE_TOPIC, 'billing'],
];
const instance = await loadLaya();
try {
  const run = makeLayaRouter({ local: makeLayaAdapter({ load: async () => instance }),
    cloud: null, record: () => {},
  });
  const rows = [];
  for (const [state, q, gold] of fixtures) {
    try {
      const r = await run(state, { q });
      rows.push({ expected: gold, actual: r.answers.q.choice,
        correct: r.answers.q.choice === gold, action_extension_absent: !('rl_agent' in r.answers.q) });
    } catch (e) { rows.push({ expected: gold, correct: false, error: e.code ?? e.name }); }
  }
  console.log(JSON.stringify({ synthetic_diagnostic_only: true, cloud_calls: 0,
    correct: rows.filter(r => r.correct).length, total: rows.length, rows }, null, 2));
  if (rows.some(r => r.error || !r.action_extension_absent)) process.exitCode = 1;
} finally { await instance.close(); }
