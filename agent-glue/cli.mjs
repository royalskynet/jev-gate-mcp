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
 *   echo '<json>' | node agent-glue/cli.mjs verify
 *   echo '<json>' | node agent-glue/cli.mjs review
 *   echo '<json>' | node agent-glue/cli.mjs route
 *   echo '<json>' | node agent-glue/cli.mjs prune
 *
 * `prune` is the exception to the paragraph above: it wires a real Jev judge
 * over `globalThis.fetch`, because it exists for hosts that cannot run this
 * repo's in-process hooks (Hermes' Python `tool_execution` middleware). One
 * judge, two runtimes — the alternative was a second judge in Python.
 */
import { compactMessages, verifyCompletion, reviewDiff, route, describeCandidates } from './src/index.js';
import { pruneCommand } from './src/prune.js';

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
  default: {
    process.stderr.write('agent-glue: unknown subcommand (compact|verify|review|route|prune)\n');
    process.exit(2);
  }
}
