#!/usr/bin/env node
// 回測：把過去 N 天的 Claude Code 逐字稿重放成線上會送的兩組題，交付費 Jev（OpenRouter）
// 判一次，答案以 label_source=backtest:transcripts 追加進 teacher-corpus。之後夜間
// laya-label-corpus／laya-train 照常接手（Laya 對照、訓練、升級閘），不用改。
//
// 兩組題，都逐字取自 teacher-corpus 裡該組最新一列（question_digest 同線上，同一題同一組）：
//   route  ← ~/dev/Ether-claude/scripts/route-judge.mjs：每則真人 prompt，過同一道灰帶閘
//            （問句 skip、短句 skip、危險詞必送），state 同形 {user_request, dirty_paths, phase}。
//   claim  ← plugin/hooks/gate.js handleStop：每個跑過工具、結尾有完成字眼的回合，
//            state 同形 {claims:[last assistant text], evidence: 該輪工具輸出}。
//
// 不變式：
//   * 只走 OpenRouter 付費那條，不碰 zen free（免費額度留給線上，回測燒光會讓線上 429）。
//   * 不佔 cascade 的 JEV_OR_DAILY_MAX；自己的上限是 --max-usd（以 usage token 估）。
//   * 同 (digest, state) 已在語料裡的跳過，重跑冪等。
//   * 送出前一律過 withRedaction（與 cascade 同一層）。
//
//   node scripts/backtest-teacher.mjs --dry            # 只數樣本、估價，不打 Jev
//   node scripts/backtest-teacher.mjs --max-usd 1      # 真跑
//
// ponytail: 灰帶閘與 lastTurn 是 route-judge.mjs 的複本（那支是頂層執行的 hook，不能 import）。
// 那邊改閘門要同步改這裡；回測只跑一次，漂移代價是樣本分佈略偏，不值得先抽共用模組。
// ponytail: dirty_paths 歷史上查不到，一律 []；線上 acting 的比例會被低估一點。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evidenceFromLines } from '../plugin/lib/transcript.js';
import { isDangerous, DEFAULT_TRIAGE } from '../agent-glue/src/triage.js';

const HOME = homedir();
const sha = (s) => createHash('sha256').update(s).digest('hex');
// 10-09 OpenRouter 後台實測：689 次、2.89M token、0.12 USD → 每 token 約 4.15e-8 USD。
export const USD_PER_TOKEN = 0.12 / 2.89e6;

const DANGER = [...DEFAULT_TRIAGE.danger_words,
  '部署', '上線', '正式機', '刪掉', '刪除', '憑證', '密鑰', '金鑰', '付款', '資料庫',
  '強推', '排程', '不可逆', '重構', '遷移', '改規則', '制度'];
const QUESTION = /[？?]\s*$|(嗎|呢|吧)[？?]?$/;
const GREY_LEN = Number(process.env.JEV_ROUTE_GREY_LEN ?? 25);
// ~/bots/mythos/bin/stop-gate.mjs 的 DONE：只回測帶完成宣告的回合，壓成本。
const DONE = /完成|搞定|已修|修好|已上線|上線了|已部署|已推|做好了|驗收(過|通過)|PASS|\bdone\b|\bfixed\b|\bshipped\b/i;

export function routeGrey(prompt) {
  const dangerous = isDangerous(prompt, DANGER);
  if (!dangerous && prompt.length < 200 && QUESTION.test(prompt)) return false;
  return dangerous || prompt.length >= GREY_LEN || prompt.includes('\n');
}

const isPrompt = (e) => e?.type === 'user' && typeof e.message?.content === 'string'
  && !e.isMeta && !e.isCompactSummary;
// 指令輸出、通知、channel 訊息都以標籤開頭，不是使用者打的字。
const isHumanText = (t) => t && !t.startsWith('<') && !t.startsWith('Caveat:');

function turnFacts(evts) {
  const tools = [], paths = new Set();
  let errors = 0;
  for (const e of evts) {
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (x.type === 'tool_use') {
        tools.push(x.name);
        if (/^(Edit|Write|NotebookEdit)$/.test(x.name) && x.input?.file_path) paths.add(x.input.file_path);
      }
      if (x.type === 'tool_result' && x.is_error) errors++;
    }
  }
  return { tools, paths: [...paths], errors };
}

// route-judge 的 lastTurn：往回最多三則 prompt，取第一個真的動過工具的那段。
function lastTurn(evts, marks, upto) {
  const before = marks.filter((m) => m < upto).slice(-3).reverse();
  for (const start of before) {
    const end = marks.find((m) => m > start) ?? upto;
    const t = turnFacts(evts.slice(start + 1, Math.min(end, upto)));
    if (t.tools.length) return t;
  }
  return null;
}
const phaseOf = (t) => (t?.errors ? 'debugging' : t?.paths.length ? 'acting' : t ? 'planning' : 'unknown');

function lastAssistantText(evts) {
  for (let i = evts.length - 1; i >= 0; i--) {
    const e = evts[i];
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    const text = e.message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

/** 一份逐字稿 → 兩種樣本的 state。純函式，測試直接餵 lines。 */
export function samplesFromLines(lines, { since = 0 } = {}) {
  const evts = [], lineOf = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try { evts.push(JSON.parse(l)); lineOf.push(i); } catch { /* 半截行 */ }
  });
  const marks = evts.map((e, i) => (isPrompt(e) ? i : -1)).filter((i) => i >= 0);
  const route = [], claim = [];
  marks.forEach((m, k) => {
    const e = evts[m];
    if (since && Date.parse(e.timestamp ?? 0) < since) return;
    const prompt = String(e.message.content).trim();
    if (isHumanText(prompt) && routeGrey(prompt)) {
      route.push({ user_request: prompt.slice(0, 2500), dirty_paths: [], phase: phaseOf(lastTurn(evts, marks, m)) });
    }
    const end = marks[k + 1] ?? evts.length;
    const seg = evts.slice(m + 1, end);
    if (!turnFacts(seg).tools.length) return;
    const text = lastAssistantText(seg).slice(0, 4000);
    if (!DONE.test(text)) return;
    const evidence = evidenceFromLines(lines.slice(0, (lineOf[end - 1] ?? lines.length - 1) + 1));
    if (evidence.trim()) claim.push({ claims: [text], evidence });
  });
  return { route, claim };
}

/** 最新一列的 questions，逐字照抄；digest 與線上同一組。 */
export function latestQuestions(rows, qid) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].questions?.[qid]) return rows[i].questions;
  return null;
}
export const sampleKey = (questions, state) =>
  sha(sha(JSON.stringify(questions)) + JSON.stringify(state));

function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function transcripts(days) {
  const root = join(HOME, '.claude', 'projects');
  const cutoff = Date.now() - days * 864e5;
  const out = [];
  for (const d of readdirSync(root)) {
    let names;
    try { names = readdirSync(join(root, d)); } catch { continue; }
    // 只收頂層：subagents/ 底下是子代理的 prompt，不是使用者的話，也沒有 Stop gate。
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = join(root, d, n);
      try { if (statSync(p).mtimeMs >= cutoff) out.push(p); } catch { /* 被刪了 */ }
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
  const dry = argv.includes('--dry');
  const days = Number(arg('--days', 30));
  const maxUsd = Number(arg('--max-usd', 1));
  const limit = Number(arg('--limit', Infinity));
  const conc = Number(arg('--concurrency', 2));
  const corpusFile = process.env.JEV_TEACHER_CORPUS ?? join(HOME, '.jevgate', 'teacher-corpus.jsonl');
  const runLog = join(HOME, '.jevgate', 'backtest', `run-${new Date().toISOString().slice(0, 10)}.log`);
  mkdirSync(join(HOME, '.jevgate', 'backtest'), { recursive: true, mode: 0o700 });
  const note = (s) => { const line = `${new Date().toISOString()}\t${s}`; console.log(line); appendFileSync(runLog, line + '\n'); };

  const corpus = readJsonl(corpusFile);
  const groups = { route: latestQuestions(corpus, 'route'), claim: latestQuestions(corpus, 'claim_0') };
  if (!groups.route || !groups.claim) throw new Error('teacher-corpus 裡找不到 route 或 claim_0 的題組');
  const seen = new Set(corpus.map((r) => sampleKey(r.questions, r.state)));

  const since = Date.now() - days * 864e5;
  const jobs = [];
  for (const p of transcripts(days)) {
    let lines;
    try { lines = readFileSync(p, 'utf8').split('\n'); } catch { continue; }
    const s = samplesFromLines(lines, { since });
    for (const kind of ['route', 'claim']) {
      for (const state of s[kind]) {
        const key = sampleKey(groups[kind], state);
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({ kind, state });
      }
    }
  }
  const todo = jobs.slice(0, limit);
  const count = (k) => todo.filter((j) => j.kind === k).length;
  const estTokens = todo.reduce((n, j) => n + JSON.stringify(j.state).length / 2.5 + 1200, 0);
  note(`samples route=${count('route')} claim=${count('claim')} est_usd=${(estTokens * USD_PER_TOKEN).toFixed(3)} max_usd=${maxUsd}${dry ? ' DRY' : ''}`);
  if (dry || !todo.length) return;

  process.env.JEV_USAGE_CALLER ??= 'backtest:teacher';
  const { DEFAULTS } = await import('../gateway/src/config.js');
  const { makeOpenrouterAdapter } = await import('../gateway/src/adapters.js');
  const { withPaymentStop } = await import('../gateway/src/budget.js');
  const { withRedaction } = await import('../gateway/src/redact.js');
  const { recordTeacherSample } = await import('../gateway/src/teacher-corpus.js');
  let key = null;
  try { key = readFileSync(DEFAULTS.zenBackupKeyFile, 'utf8').trim() || null; } catch { /* 下面報錯 */ }
  if (!key) throw new Error('OpenRouter key 檔讀不到（DEFAULTS.zenBackupKeyFile）');
  const judge = withRedaction(withPaymentStop(makeOpenrouterAdapter({ apiKey: key })));

  let spent = 0, ok = 0, fail = 0, stop = false, i = 0;
  const extra = { label_source: 'backtest:transcripts', split: 'unassigned' };
  async function worker() {
    while (!stop && i < todo.length) {
      const j = todo[i++];
      const questions = groups[j.kind];
      try {
        const result = await judge(j.state, questions, {});
        const u = result.usage ?? {};
        spent += ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) * USD_PER_TOKEN;
        if (recordTeacherSample({ state: j.state, questions, result }, corpusFile, extra)) ok++;
        else fail++;
      } catch (e) {
        fail++;
        if (e?.code === 'JEV_PAYMENT_REQUIRED' || /payment|402/i.test(String(e?.message))) { stop = true; note(`stop: ${e.code ?? e.message}`); }
      }
      if (spent >= maxUsd) { stop = true; note(`stop: max-usd ${maxUsd} reached`); }
      if ((ok + fail) % 100 === 0) note(`progress ok=${ok} fail=${fail} usd=${spent.toFixed(3)}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, conc) }, worker));
  note(`done ok=${ok} fail=${fail} usd=${spent.toFixed(3)} of ${todo.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
