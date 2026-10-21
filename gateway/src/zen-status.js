// Risk control for the free Jev tier. This file is the durable, zero-token
// record of whether that tier is answering and, after a failure, until when it
// is cooling down — every consumer with an OpenRouter key reads that to pick
// primary (Zen) or backup (OpenRouter); a background probe (not a model) warns.
//
// It records a *flip*, not every call: an OK-on-OK rewrite would turn each
// judgement into a disk write for no new information.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ZEN_STATUS_FILE = process.env.JEV_ZEN_STATUS_FILE
  ?? join(homedir(), '.jevgate', 'zen-free-status.json');

let last = null;

export function readZenStatus(file = ZEN_STATUS_FILE) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Record the free tier's health. Returns true when the file was written.
 * @param {boolean} ok
 * @param {object} [detail] { model, error, error_class, retry_after_s, reset_at, remediation }
 */
export function recordZenStatus(ok, detail = {}, file = ZEN_STATUS_FILE) {
  if (last === null) last = readZenStatus(file);
  const error = ok ? null : String(detail.error ?? 'unknown');
  const cooldownUntil = ok ? null : (detail.cooldown_until ?? null);
  if (last && last.ok === ok && (last.error ?? null) === error
    && (last.cooldown_until ?? null) === cooldownUntil
    && Boolean(last.blocked) === Boolean(!ok && detail.blocked)) return false;
  const next = {
    ok,
    at: new Date().toISOString(),
    // Epoch ms before which every consumer skips Zen and asks the backup
    // (OpenRouter). Set from the 429's retry-after; null = Zen is primary.
    cooldown_until: cooldownUntil,
    model: detail.model ?? last?.model ?? null,
    error,
    error_class: ok ? null : (detail.error_class ?? null),
    // 403 FreeTierError (IP flagged as abusive): unlike a quota cooldown it does not heal on its own.
    blocked: ok ? false : Boolean(detail.blocked),
    // Consecutive 403 FreeTierError hits; the adapter doubles the ban cooldown on each (10-19).
    block_streak: ok ? 0 : (detail.block_streak ?? 0),
    // Spelled out here because the consumer of this file is a script, not a
    // reader with the context in front of them.
    // 429 only: seconds the provider asked us to wait, and the wall-clock it implies.
    retry_after_s: ok ? null : (detail.retry_after_s ?? null),
    reset_at: ok ? null : (detail.reset_at ?? null),
    remediation: ok ? null : (detail.remediation
      ?? (cooldownUntil
        ? `Zen 免費層冷卻至 ${new Date(cooldownUntil).toISOString()}：有 OpenRouter key 的消費端改走備援，沒有的中止裁決；到期自動回 Zen。`
        : 'Jev 免費層失效且無備援：裁決中止。設 OpenRouter key 或改 JEV_PROVIDER 後重啟 session。')),
  };
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) chmodSync(file, 0o600);
    // Rename, not write: a reader (the probe) may be mid-read, and a torn file
    // would read as "free tier down" when it is not.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    last = next;
    return true;
  } catch {
    return false;
  }
}

/** True while Zen is in its quota cooldown and the backup should answer. */
export function zenCoolingDown(now = Date.now(), file = ZEN_STATUS_FILE) {
  const until = readZenStatus(file)?.cooldown_until;
  return Number.isFinite(until) && until > now;
}

/** Test seam: forget the cached last state so the next record always writes. */
export function resetZenStatusCache() {
  last = null;
}
