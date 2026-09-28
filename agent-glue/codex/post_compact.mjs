#!/usr/bin/env node
/**
 * Codex PostCompact hook — verbatim original-text restoration layer.
 *
 * Reads the snapshot written by PreCompact for this session and re-injects the
 * original user/assistant prose as `additionalContext` so a verbatim-compaction
 * pass cannot silently drop prose. This is a restoration layer only: it never
 * rewrites or claims to rewrite Codex's core transcript. If there is no
 * snapshot (or the transcript format never parsed), it returns no additional
 * context and compaction proceeds — fail-open.
 */
import { readFileSync, existsSync } from 'node:fs';
import { readEvent, respond, respondNothing, appendLedger, runtimePath } from './io.mjs';

const event = await readEvent();
const session = event?.session_id ?? 'anon';

const key = `compact-${session.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
let restored = [];
try {
  if (existsSync(runtimePath(key))) {
    const snap = JSON.parse(readFileSync(runtimePath(key), 'utf8'));
    restored = Array.isArray(snap.prose)
      ? snap.prose.map((p) => `${p.role}: ${p.text}`)
      : [];
  }
} catch {
  /* no usable snapshot — restoration is a no-op */
}

appendLedger('codex-compact.log', `postcompact\tsession=${session}\trestored=${restored.length}`);
// PostCompact has no `additionalContext` and no `decision` — common fields
// only. `systemMessage` is the one channel that survives, so the restored
// prose rides there; empty restoration stays silent.
if (restored.length) {
  respond({ systemMessage: `jev-agent restored ${restored.length} verbatim turn(s) after compaction:\n${restored.join('\n')}` });
} else {
  respondNothing();
}
