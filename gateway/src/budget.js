import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function defaultNotify(msg) {
  execFile('hpush', [msg], () => {});
}

function localDay(ts) {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${date}`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

// The last `reserve` calls of the day are kept for `reservedFor` callers, so a
// chatty caller (stop-gate) cannot starve compaction into the built-in summary.
export function withDailyBudget(adapter, {
  max = Number(process.env.JEV_OR_DAILY_MAX ?? 200),
  reserve = Number(process.env.JEV_OR_RESERVE ?? Math.floor(max / 4)),
  reservedFor = ['cascade:compact'],
  file = join(homedir(), '.jevgate', 'or-budget.json'),
  notify = defaultNotify,
  now = Date.now,
} = {}) {
  return async (state, questions, opts) => {
    const today = localDay(now());
    const data = readJson(file);
    const sameDay = data !== null && data.day === today;
    const calls = sameDay && Number.isFinite(data.calls) ? data.calls : 0;
    const notified = sameDay && data.notified === true;
    const limit = reservedFor.includes(opts?.caller) ? max : max - reserve;

    if (calls >= limit) {
      if (limit < max) {
        const err = new Error(`Jev OpenRouter 一般額度 ${limit} 次已到，剩餘 ${max - calls} 次保留給 ${reservedFor.join(',')}`);
        err.code = 'JEV_BUDGET_EXCEEDED';
        throw err;
      }
      if (!notified) {
        notify(`Jev OpenRouter 日上限 ${max} 次已到，今日其餘呼叫 fail-open`);
        writeJson(file, { day: today, calls, notified: true });
      }
      const err = new Error(`Jev OpenRouter 日上限 ${max} 次已到，今日其餘呼叫 fail-open`);
      err.code = 'JEV_BUDGET_EXCEEDED';
      throw err;
    }

    writeJson(file, { day: today, calls: calls + 1, notified: false });
    return adapter(state, questions, opts);
  };
}

// Zen free tier: past `max` calls a day, hand the rest to the backup. 10-18 the
// egress IP was flagged as abusive after 114–365 Zen calls a day; the cap keeps
// our share of that traffic flat. Returns true when this call may go to Zen.
export function makeZenDailyTake({
  max = Number(process.env.JEV_ZEN_DAILY_MAX ?? 150),
  file = process.env.JEV_ZEN_BUDGET_FILE ?? join(homedir(), '.jevgate', 'zen-budget.json'),
  now = Date.now,
} = {}) {
  return () => {
    const today = localDay(now());
    const data = readJson(file);
    const calls = data !== null && data.day === today && Number.isFinite(data.calls) ? data.calls : 0;
    if (calls >= max) return false;
    writeJson(file, { day: today, calls: calls + 1 });
    return true;
  };
}

export function withPaymentStop(adapter, {
  file = join(homedir(), '.jevgate', 'or-status.json'),
  holdMs = 3600000,
  notify = defaultNotify,
  now = Date.now,
} = {}) {
  return async (state, questions, opts) => {
    const data = readJson(file);
    const blockedUntil = data !== null && Number.isFinite(data.blocked_until)
      ? data.blocked_until
      : null;
    if (blockedUntil !== null && blockedUntil > now()) {
      const err = new Error('Jev OpenRouter 付款問題（402），停用中');
      err.code = 'JEV_PAYMENT_REQUIRED';
      throw err;
    }
    try {
      return await adapter(state, questions, opts);
    } catch (e) {
      if (e && (e.status === 402 || e.cause?.status === 402)) {
        writeJson(file, { blocked_until: now() + holdMs });
        notify('Jev OpenRouter 回 402（額度不足），停用 1 小時');
      }
      throw e;
    }
  };
}
