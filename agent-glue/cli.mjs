#!/usr/bin/env node
/**
 * agent-glue CLI — shared, offline entry point to the four Jev decision
 * capabilities, used by both the Claude and Codex adapters (and by acceptance).
 *
 * Reads one JSON document on stdin. The `judge`/`jev` observers are *not*
 * wired here: a bare CLI run has no live adapter, so every judgment fails open
 * (compact keeps verbatim, verify stays deterministic, review is advisory-free,
 * route runs the real judgment and fail-opens itself when no live model is present).
 * Adapters that want live Jev call the core functions directly with a real injected
 * judge, not through this CLI.
 *
 *   echo '<json>' | node agent-glue/cli.mjs compact
 *   echo '<json>' | node agent-glue/cli.mjs compact-live
 *   echo '<json>' | node agent-glue/cli.mjs verify
 *   echo '<json>' | node agent-glue/cli.mjs review
 *   echo '<json>' | node agent-glue/cli.mjs route
 *   echo '<json>' | node agent-glue/cli.mjs prune
 *
 * `prune` is the exception to the paragraph above: it wires a real Jev judge
 * over `globalThis.fetch`, because it exists for hosts that cannot run this
 * repo's in-process hooks (Hermes' Python `tool_execution` middleware). One
 * judge, two runtimes — the alternative was a second judge in Python.
 *
 * `compact-live` is the second exception: it wires the same Jev judge over a
 * Node `$` host, for callers that want live compaction from a bare CLI run.
 * Privacy is pinned here, not defaulted — `judgeHeadChars` is fixed at 0 and
 * the user request at '', so only tool names and char counts cross the wire.
 */
import { readFile } from 'node:fs/promises';

import { compactMessages, verifyCompletion, reviewDiff, route, describeCandidates } from './src/index.js';
import { pruneCommand } from './src/prune.js';
import { apiKey, judgePairs, refreshConfig } from './claude/compact-hook.mjs';
import { followsZen, zenCooling } from './claude/env.mjs';

/**
 * Node-side `$` for the shared judge, written the same way as
 * `integrations/openclaw/compact-provider.mjs`: `fetch` there returns a
 * Response (`.text()` is a method), the hook contract wants `{ ok, text }`.
 */
const node$ = {
  fs: { read: (p) => readFile(p, 'utf8') },
  http: {
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
  },
};

const sub = process.argv[2];

let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload = {};
try {
  payload = input.trim() ? JSON.parse(input) : {};
} catch {
  process.stderr.write('agent-glue: stdin is not valid JSON\n');
  process.exit(2);
}

function respond(v) {
  process.stdout.write(JSON.stringify(v) + '\n');
}

switch (sub) {
  case 'compact': {
    const { messages = [], ...rest } = payload;
    respond(await compactMessages({ messages, judge: async () => 'keep', ...rest }));
    break;
  }
  case 'verify': {
    respond(await verifyCompletion(payload));
    break;
  }
  case 'review': {
    respond(await reviewDiff(payload));
    break;
  }
  case 'route': {
    // Real route judgment; with no live Jev model `route` itself fail-opens.
    // Empty/malformed candidates throw as EmptyCandidatesError -> bounded no-candidates.
    // Bare ids score 2/4 where the same candidates with one sentence each score
    // 4/4, so fill the map from the skill catalog unless the caller said what
    // its candidates are (or passed `descriptions: null` to force bare labels).
    try {
      const descriptions = payload.descriptions === undefined
        ? await describeCandidates(payload.candidates)
        : payload.descriptions;
      respond(await route({ ...payload, descriptions }));
    } catch {
      respond({ no_match: true, top: [], dispatch: null, reason: 'no-candidates' });
    }
    break;
  }
  case 'prune': {
    respond(await pruneCommand(payload));
    break;
  }
  case 'compact-live': {
    // Live judge over the real Jev endpoint, unlike `compact`'s stub. Privacy
    // is a hard rule, not a default: `judgeHeadChars` is pinned to 0 and the
    // user request to '', so only tool names and char counts cross the wire —
    // no payload, no user message, whatever the caller asked for.
    const { messages = [], pinFirst, pinLast, minReductionChars } = payload;
    // Zen free in its quota cooldown: ask OpenRouter until it lapses, as the
    // Claude Code hook does. Without this Hermes got 429 for the whole cooldown.
    if (followsZen()) {
      const status = await readFile(`${process.env.HOME}/.jevgate/zen-free-status.json`, 'utf8').catch(() => '');
      refreshConfig(zenCooling(status, Date.now()));
    }
    const key = await apiKey(node$, {});
    if (!key) {
      respond({ messages, compacted: false, reason: 'no key', reducedBy: 0 });
      break;
    }
    const opts = { messages, pinFirst, pinLast, minReductionChars, judgeHeadChars: 0 };
    // Pass 1 only collects the pairs; they are judged in batched, parallel
    // requests (judgePairs), not one sequential round trip each.
    const pairs = [];
    await compactMessages({ ...opts, judge: async (pair) => { pairs.push(pair); return 'keep'; } });
    const { choices, failed } = await judgePairs(node$, key, '', pairs);
    // ponytail: pass 2 replays verdicts by call order — compactMessages walks
    // pairs in Map insertion order, so its i-th judge call is pass 1's i-th pair.
    let i = 0;
    const result = await compactMessages({ ...opts, judge: async () => choices[i++] ?? 'keep' });
    respond(failed !== null ? { ...result, reason: `judge-http-${failed}` } : result);
    break;
  }
  default: {
    process.stderr.write('agent-glue: unknown subcommand (compact|compact-live|verify|review|route|prune)\n');
    process.exit(2);
  }
}
