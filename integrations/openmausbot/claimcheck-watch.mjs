#!/usr/bin/env node
/**
 * OpenMausBot adapter for plugin/lib/claimcheck.js.
 *
 * Engine-neutral: reads OMB's own messages.db (every engine — claude,
 * claudeApi, opencodeGo — writes `activity` rows with the tool name, input,
 * ok and output, and `text` rows for replies), so it works for bots whose
 * engine has no hooks at all. Each new reply of a watched bot is checked
 * against what that thread actually saw: tool outputs and user messages,
 * newest first, across the whole thread (a document read three turns ago is
 * still evidence).
 *
 * Shadow only: writes a JSONL ledger (and optionally one alert line per
 * flagged reply); never posts back into the thread.
 *
 *   node claimcheck-watch.mjs --bots 合規長[,NS官] [--once] [--db PATH]
 *     [--api http://127.0.0.1:8799] [--state FILE] [--log FILE] [--alerts FILE]
 *     [--backfill-minutes N] [--evidence-chars N]
 *
 * First run starts at "now" unless --backfill-minutes is given, so turning it
 * on never bills Jev for a history nobody asked to re-check.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const DIR = join(HOME, '.openmausbot-claimcheck');
const FLAG = new Set(['contradicted', 'not_addressed']);

export function parseArgs(argv) {
  const a = { once: false, db: join(HOME, '.openmausbot', 'messages.db'), api: 'http://127.0.0.1:8799',
    state: join(DIR, 'state.json'), log: join(DIR, 'claimcheck.jsonl'), alerts: null,
    backfillMinutes: 0, evidenceChars: 60000, bots: [], intervalSec: 60 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = () => argv[++i];
    if (k === '--once') a.once = true;
    else if (k === '--bots') a.bots = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--db') a.db = v();
    else if (k === '--api') a.api = v();
    else if (k === '--state') a.state = v();
    else if (k === '--log') a.log = v();
    else if (k === '--alerts') a.alerts = v();
    else if (k === '--backfill-minutes') a.backfillMinutes = Number(v());
    else if (k === '--evidence-chars') a.evidenceChars = Number(v());
    else if (k === '--interval') a.intervalSec = Number(v());
    else throw new Error(`unknown arg ${k}`);
  }
  if (!a.bots.length) throw new Error('--bots is required');
  return a;
}

/** name -> thread ids, from OMB's GET /api/bots. */
export async function resolveBots(api, names, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(api.replace(/\/+$/, '') + '/api/bots');
  if (!res.ok) throw new Error(`GET /api/bots ${res.status}`);
  const d = await res.json();
  const list = Array.isArray(d) ? d : d.bots ?? [];
  const out = [];
  for (const name of names) {
    const b = list.find((x) => x.name === name);
    if (!b) { out.push({ name, threads: [], missing: true }); continue; }
    const t = new Set([b.threadId, b.mainThreadId].filter(Boolean));
    for (const task of Array.isArray(b.tasks) ? b.tasks : []) if (task?.threadId) t.add(task.threadId);
    out.push({ name, id: b.id, threads: [...t], soul: typeof b.soul === 'string' ? b.soul : '' });
  }
  return out;
}

function clip(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…[clipped]' : s; }

/** What the thread had seen up to `at`, newest first, within `limit` chars. */
export function threadEvidence(db, threadId, at, limit) {
  const rows = db.prepare(
    `SELECT role, kind, text, json FROM messages
      WHERE thread_id = ? AND at <= ? AND (kind = 'activity' OR (role = 'user' AND kind = 'text'))
      ORDER BY at DESC`).all(threadId, at);
  const parts = [];
  let used = 0;
  for (const r of rows) {
    let piece = '';
    if (r.kind === 'activity') {
      let tool;
      try { tool = JSON.parse(r.json).tool; } catch { continue; }
      if (!tool || tool.ok === false || tool.output == null) continue;
      piece = `[tool ${tool.name}] ${clip(tool.input, 400)}\n${clip(tool.output, 8000)}`;
    } else {
      piece = `[user message]\n${clip(r.text, 4000)}`;
    }
    if (used + piece.length > limit) break;
    parts.push(piece);
    used += piece.length;
  }
  return parts.join('\n\n');
}

function loadState(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { cursor: {} }; }
}
function saveState(file, st) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(st), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

/**
 * One pass. `check` is claimcheck's checkClaims (injectable for tests).
 * Returns the ledger entries written.
 */
export async function runOnce({ dbPath, bots, stateFile, logFile, alertsFile, check, now = Date.now(), backfillMinutes = 0, evidenceChars = 60000 }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const st = loadState(stateFile);
  st.cursor ??= {};
  const entries = [];
  try {
    for (const bot of bots) {
      for (const thread of bot.threads) {
        if (st.cursor[thread] == null) st.cursor[thread] = now - backfillMinutes * 60000;
        const replies = db.prepare(
          `SELECT id, at, text FROM messages
            WHERE thread_id = ? AND role = 'bot' AND kind = 'text' AND at > ? ORDER BY at`).all(thread, st.cursor[thread]);
        for (const m of replies) {
          // The bot's own instructions are a source too: restating its soul is not an unsourced claim.
          const soul = bot.soul ? `[bot instructions]\n${clip(bot.soul, 6000)}\n\n` : '';
          const evidence = soul + threadEvidence(db, thread, m.at, evidenceChars);
          const r = await check({ text: m.text ?? '', evidence, kinds: ['fact', 'done'] });
          const judged = r.judged ?? [];
          const flagged = judged.filter((j) => FLAG.has(j.verdict));
          const entry = {
            ts: new Date().toISOString(), bot: bot.name, thread, msgId: m.id, at: m.at,
            claims: judged.map((j) => ({ claim: j.claim, kind: j.kind, verdict: j.verdict, gate: j.gate, confidence: j.confidence })),
            skipped: r.skipped, error: r.error, flagged: flagged.length,
          };
          mkdirSync(dirname(logFile), { recursive: true });
          appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
          if (alertsFile && flagged.length) {
            mkdirSync(dirname(alertsFile), { recursive: true });
            appendFileSync(alertsFile, `[claimcheck] ${bot.name} 回覆有 ${flagged.length} 個論點沒有來源支持：${clip(flagged[0].claim, 80)}\n`);
          }
          entries.push(entry);
          // Advance only past checked replies: a Jev error still advances
          // (logged as error) so one bad reply cannot bill every pass.
          st.cursor[thread] = m.at;
        }
      }
    }
  } finally {
    db.close();
    saveState(stateFile, st);
  }
  return entries;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const { checkClaims } = await import('../../plugin/lib/claimcheck.js');
  const { DEFAULT_CONFIG } = await import('../../plugin/lib/judge.js');
  // Background: no user is waiting, so the Stop gate's 4 s budget does not apply.
  const cfg = { ...DEFAULT_CONFIG, stopCaller: 'omb-claimcheck', timeoutMs: 20000, stopCascadeTimeoutMs: 20000 };
  const check = (o) => checkClaims({ ...o, cfg });
  do {
    try {
      const bots = await resolveBots(a.api, a.bots);
      for (const b of bots) if (b.missing) console.error(`claimcheck: bot not found: ${b.name}`);
      const n = await runOnce({ dbPath: a.db, bots, stateFile: a.state, logFile: a.log, alertsFile: a.alerts, check,
        backfillMinutes: a.backfillMinutes, evidenceChars: a.evidenceChars });
      if (a.once) console.log(`claimcheck: checked ${n.length} replies, flagged ${n.filter((e) => e.flagged).length}`);
    } catch (e) {
      console.error(`claimcheck: ${e.message}`);
      if (a.once) process.exitCode = 1;
    }
    if (!a.once) await new Promise((r) => setTimeout(r, a.intervalSec * 1000));
  } while (!a.once);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
