#!/usr/bin/env node
/**
 * Closes the claimcheck loop: claims judged not_addressed (no source in the
 * thread, the bot's files or the wiki) are queued by claimcheck-watch; this
 * sends them to the research bot (法規雷達) through `openmausbot run`, has
 * the writer bot (文件起草) ingest a supported/contradicted report into the
 * wiki, then re-checks the claim against the new evidence.
 *
 * One reply's claims (up to --batch) per run; meant for launchd StartInterval.
 * Research bots bill per turn, so nothing is sent without --dispatch, and at
 * most --daily-cap jobs per day (Asia/Taipei). Without --dispatch it prints
 * the next job and exits.
 *
 *   node research-dispatch.mjs [--dispatch] [--daily-cap 3] [--batch 3]
 *     [--queue FILE] [--ledger FILE] [--radar 法規雷達] [--writer 文件起草]
 *     [--all] [--min-gaps 2] [--recur 2] [--radar-dir D] [--wiki-dir D] [--omb PATH] [--timeout-min 30] [--no-recheck]
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const DIR = join(HOME, '.openmausbot-claimcheck');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const keyOf = (claim) => createHash('sha1').update(norm(claim)).digest('hex').slice(0, 12);
// The radar researches public rules; internal facts (our process, a letter we sent) are not its job.
// ponytail: keyword gate; widen with --all or extend the list as regulators come up.
export const REGULATORY = /VARA|FATF|MiCA|ESMA|FCA|MAS|SFC|FinCEN|FIU|ADGM|DFSA|AUSTRAC|FINTRAC|CVM|Travel Rule|AML|CFT|KYC|VASP|CASP|監管|法規|法令|條例|規則|規定|指引|條款|第\s*\d+\s*條|牌照|執照|許可|主管機關|生效|通函|Circular|Rulebook|Regulation|Directive/i;
const day = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); // Asia/Taipei

export function parseArgs(argv) {
  const a = { dispatch: false, dailyCap: 3, batch: 3, queue: join(DIR, 'research-queue.jsonl'), ledger: join(DIR, 'research.jsonl'),
    radar: '法規雷達', writer: '文件起草', radarDir: join(HOME, 'compliance-agents', 'work', 'radar'),
    wikiDir: join(HOME, 'llm-wiki'), omb: 'openmausbot', timeoutMin: 30, recheck: true, all: false, minGaps: 2, recur: 2 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = () => argv[++i];
    if (k === '--dispatch') a.dispatch = true;
    else if (k === '--daily-cap') a.dailyCap = Number(v());
    else if (k === '--batch') a.batch = Number(v());
    else if (k === '--queue') a.queue = v();
    else if (k === '--ledger') a.ledger = v();
    else if (k === '--radar') a.radar = v();
    else if (k === '--writer') a.writer = v();
    else if (k === '--radar-dir') a.radarDir = v();
    else if (k === '--wiki-dir') a.wikiDir = v();
    else if (k === '--omb') a.omb = v();
    else if (k === '--timeout-min') a.timeoutMin = Number(v());
    else if (k === '--no-recheck') a.recheck = false;
    else if (k === '--all') a.all = true;
    else if (k === '--min-gaps') a.minGaps = Number(v());
    else if (k === '--recur') a.recur = Number(v());
    else throw new Error(`unknown arg ${k}`);
  }
  return a;
}

const readJsonl = (f) => existsSync(f)
  ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
  : [];

/**
 * Next job: the oldest reply over the research threshold, with claims never
 * researched; null if none or capped. Threshold: the reply has at least
 * `minGaps` unsourced (regulatory) claims, or one of its claims was left
 * unsourced in at least `recur` different replies.
 */
export function nextJob({ queue, ledger, now = Date.now(), dailyCap = 3, batch = 3, all = false, minGaps = 2, recur = 2 }) {
  const done = new Set(ledger.flatMap((e) => e.keys ?? []));
  const today = ledger.filter((e) => e.dispatched && day(e.ts) === day(now)).length;
  if (today >= dailyCap) return { capped: true, today };
  const byMsg = new Map();
  const seenIn = new Map(); // key -> Set(msgId)
  for (const q of queue) {
    const k = keyOf(q.claim);
    if (!seenIn.has(k)) seenIn.set(k, new Set());
    seenIn.get(k).add(q.msgId);
  }
  for (const q of queue) {
    const key = keyOf(q.claim);
    if (done.has(key) || (!all && !REGULATORY.test(q.claim))) continue;
    const g = byMsg.get(q.msgId) ?? { msgId: q.msgId, bot: q.bot, context: q.context, items: [] };
    if (!g.items.some((x) => x.key === key)) g.items.push({ key, claim: q.claim });
    byMsg.set(q.msgId, g);
  }
  for (const g of byMsg.values()) {
    if (g.items.length < minGaps && !g.items.some((x) => seenIn.get(x.key).size >= recur)) continue;
    // A claim queued under two replies goes with the first one only.
    g.items = g.items.filter((x) => !done.has(x.key)).slice(0, batch);
    g.items.forEach((x) => done.add(x.key));
    if (g.items.length) return { job: g, today };
  }
  return { job: null, today };
}

export function radarPrompt(job, reportPath) {
  return [
    `claimcheck 補證：${job.bot} 的回覆裡下列論點在對話、團隊檔案與 wiki 都找不到出處。請逐條查證。`,
    '',
    ...job.items.map((x, i) => `${i + 1}. ${x.claim}`),
    '',
    '回覆原文（節錄，僅供理解語境）：',
    String(job.context ?? '').slice(0, 1500),
    '',
    '做法：照你平常的規則（官方來源優先、ladder-search、每條附 URL、標發布日）。內部事實（公司內部流程、系統、合約）沒有公開來源的，直接標「非公開」，不要硬查。',
    `把完整查證寫成一份 markdown 存到 ${reportPath}（每條論點一節：結論、原文引述、來源網址）。`,
    '回覆最後每條一行，格式固定：',
    'CLAIMCHECK <編號> 支持|反駁|查無|非公開 <最主要的來源網址或 ->',
  ].join('\n');
}

/** CLAIMCHECK lines -> {n: verdict}. */
export function parseRadar(out) {
  const v = {};
  for (const m of String(out ?? '').matchAll(/CLAIMCHECK\s+(\d+)\s+(支持|反駁|查無|非公開)(?:\s+(\S+))?/g)) v[Number(m[1])] = { verdict: m[2], url: m[3] && m[3] !== '-' ? m[3] : undefined };
  return v;
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message) }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/**
 * One job end to end. `exec(bin, args)` runs openmausbot (injectable);
 * `recheck(claim)` returns a verdict string or null.
 */
export async function runJob(job, a, { exec = (b, args) => run(b, args, (a.timeoutMin + 5) * 60000), recheck = null, now = Date.now() } = {}) {
  const name = `${day(now)}_claimcheck_${job.items[0].key}.md`;
  const reportPath = join(a.radarDir, name);
  const msgFile = join(tmpdir(), `claimcheck-radar-${job.items[0].key}.txt`);
  writeFileSync(msgFile, radarPrompt(job, reportPath));
  const common = ['--wait', 'job', '--timeout', `${a.timeoutMin}m`, '--on-input', 'stop', '--on-timeout', 'stop'];
  const r = await exec(a.omb, ['run', a.radar, '--message-file', msgFile, '--title', `claimcheck 補證 ${job.items[0].key}`, ...common]);
  try { unlinkSync(msgFile); } catch { /* gone */ }
  const verdicts = parseRadar(r.out);
  const entry = { ts: now, dispatched: true, msgId: job.msgId, bot: job.bot, keys: job.items.map((x) => x.key), radarRc: r.code,
    report: existsSync(reportPath) ? reportPath : null,
    items: job.items.map((x, i) => ({ key: x.key, claim: x.claim, radar: verdicts[i + 1]?.verdict ?? null, url: verdicts[i + 1]?.url })) };
  const worth = entry.items.some((x) => x.radar === '支持' || x.radar === '反駁');
  if (r.code === 0 && entry.report && worth) {
    const rawRel = join('raw', 'claimcheck', name);
    mkdirSync(join(a.wikiDir, 'raw', 'claimcheck'), { recursive: true });
    copyFileSync(entry.report, join(a.wikiDir, rawRel));
    const w = await exec(a.omb, ['run', a.writer,
      `ingest ${rawRel}\n（使用者已授權 claimcheck 補證流程寫入 wiki：照 llm-wiki 技能的寫入規則與 CLAUDE.md 階段一；這是法規雷達的查證報告，結論與原文引述照抄，不要補編。）`,
      '--title', `claimcheck ingest ${job.items[0].key}`, ...common]);
    entry.ingest = { rc: w.code, raw: rawRel };
  }
  if (recheck) for (const x of entry.items) if (x.radar === '支持' || x.radar === '反駁') x.recheck = await recheck(x.claim);
  if (r.code !== 0) entry.error = `radar rc=${r.code} ${String(r.err).slice(-200)}`.trim();
  return entry;
}

function lock(file) {
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs > 3 * 3600e3) unlinkSync(file); // stale
    closeSync(openSync(file, 'wx'));
    return () => { try { unlinkSync(file); } catch { /* gone */ } };
  } catch { return null; }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const { job, capped, today } = nextJob({ queue: readJsonl(a.queue), ledger: readJsonl(a.ledger), dailyCap: a.dailyCap, batch: a.batch, all: a.all, minGaps: a.minGaps, recur: a.recur });
  if (capped) { console.log(`research: daily cap reached (${today}/${a.dailyCap})`); return; }
  if (!job) { console.log('research: queue empty'); return; }
  if (!a.dispatch) { console.log(`research: next job (dry run, add --dispatch to send) ${job.bot} ${job.msgId}\n${job.items.map((x) => `  ${x.key} ${x.claim}`).join('\n')}`); return; }
  const unlock = lock(join(dirname(a.ledger), 'research.lock'));
  if (!unlock) { console.log('research: another job is running'); return; }
  try {
    let recheck = null;
    if (a.recheck) {
      const { checkClaims } = await import('../../plugin/lib/claimcheck.js');
      const { ocVerifier } = await import('./oc-verify.mjs');
      const { makeRetriever } = await import('./evidence.mjs');
      const verify = ocVerifier({});
      const { retrieve } = makeRetriever({ radarDir: a.radarDir, wikiRoot: join(a.wikiDir, 'wiki') });
      recheck = async (claim) => {
        const ev = retrieve({ text: claim, claims: [claim], budget: 30000 });
        const r = await checkClaims({ text: claim, evidence: ev.text, kinds: ['fact'], verify, cfg: {} });
        return r.error ? `error: ${r.error}` : r.judged?.[0]?.verdict ?? r.skipped ?? null;
      };
    }
    const entry = await runJob(job, a, { recheck });
    mkdirSync(dirname(a.ledger), { recursive: true });
    appendFileSync(a.ledger, JSON.stringify(entry) + '\n', { mode: 0o600 });
    console.log(`research: ${job.msgId} radar=${entry.items.map((x) => x.radar ?? '?').join(',')} ingest=${entry.ingest?.rc ?? '-'} recheck=${entry.items.map((x) => x.recheck ?? '-').join(',')}`);
    if (entry.error) process.exitCode = 1;
  } finally { unlock(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
