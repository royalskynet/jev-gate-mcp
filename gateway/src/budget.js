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

export function withDailyBudget(adapter, {
  max = Number(process.env.JEV_OR_DAILY_MAX ?? 200),
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

    if (calls >= max) {
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
