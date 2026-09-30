// Risk control for the free Jev tier: the gateway is configured with one
// credential and no paid fallback, so when the free tier stops the only correct
// behaviour is to stop judging. This file is the durable, zero-token record of
// whether that tier is answering, so a background probe (not a model) can warn.
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
 * @param {object} [detail] { model, error, error_class, remediation }
 */
export function recordZenStatus(ok, detail = {}, file = ZEN_STATUS_FILE) {
  if (last === null) last = readZenStatus(file);
  const error = ok ? null : String(detail.error ?? 'unknown');
  if (last && last.ok === ok && (last.error ?? null) === error) return false;
  const next = {
    ok,
    at: new Date().toISOString(),
    model: detail.model ?? last?.model ?? null,
    error,
    error_class: ok ? null : (detail.error_class ?? null),
    // Spelled out here because the consumer of this file is a script, not a
    // reader with the context in front of them.
    remediation: ok ? null : (detail.remediation
      ?? 'Jev 免費層失效：gateway 已中止裁決（不換付費供應商）。恢復免費層或改 JEV_PROVIDER/JEV_FALLBACK_PROVIDER 後重啟 session。'),
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

/** Test seam: forget the cached last state so the next record always writes. */
export function resetZenStatusCache() {
  last = null;
}
