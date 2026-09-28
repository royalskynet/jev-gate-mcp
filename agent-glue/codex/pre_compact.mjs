#!/usr/bin/env node
/**
 * Codex PreCompact hook — snapshot of the verbatim original, so the
 * restoration layer (PostCompact) can put dropped prose back after the built-in
 * compaction runs.
 *
 * This is explicitly a *restoration layer*, not a rewrite of core compaction:
 * Codex cannot replace its built-in compaction from a hook, so we capture the
 * prose as it is now and re-inject it as additionalContext afterward. The
 * snapshot is a bounded, repo-relative runtime file keyed by session id and
 * never committed. Failure to snapshot is fail-open (compaction proceeds
 * untouched).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readEvent, respondNothing, appendLedger, runtimePath, RUNTIME_DIR, REPO_ROOT, boundedSummary } from './io.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const event = await readEvent();
const session = event?.session_id ?? 'anon';

// Extract verbatim prose from the transcript if it exists; otherwise record
// that there was nothing to snapshot. The transcript path is advisory
// (format may change), so every read is guarded and bounds-trimmed.
const snapshot = { session, at: new Date().toISOString(), prose: [], trigger: event?.hook_event_name ?? 'precompact' };
try {
  if (event?.transcript_path && typeof event.transcript_path === 'string') {
    const raw = readFileSync(event.transcript_path, 'utf8');
    // JSONL transcript: pull the `text` of user/assistant entries (best-effort,
    // bounded to ~2000 chars each, at most 20 entries). Never commits.
    for (const line of raw.split('\n').slice(0, 2000)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const role = rec?.type ?? rec?.role;
        const text = typeof rec?.text === 'string' ? rec.text : null;
        if (text && text.trim() && (role === 'user' || role === 'assistant')) {
          snapshot.prose.push({ role, text: text.slice(0, 2000) });
        }
      } catch {
        /* skip malformed line */
      }
      if (snapshot.prose.length >= 20) break;
    }
  }
} catch {
  /* no transcript: snapshot stays empty, restoration is a no-op */
}

const key = `compact-${session.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
try {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(runtimePath(key), JSON.stringify(snapshot));
  appendLedger('codex-compact.log', `precompact\tsession=${session}\tprose=${snapshot.prose.length}`);
} catch {
  /* snapshot failed — fail open, keep compaction untouched */
}

const root = REPO_ROOT;
void root; // (REPO_ROOT import kept for the runtime path contract)
// PreCompact takes the common fields only (continue/stopReason/systemMessage/
// suppressOutput). `{snapshot, boundedSummary}` was not a wire Codex knows, so
// it failed the event. The snapshot is a side effect; nothing to say here.
void path.basename(key); void boundedSummary(snapshot);
respondNothing();
