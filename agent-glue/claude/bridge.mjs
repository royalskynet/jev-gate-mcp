#!/usr/bin/env node
/**
 * Claude adapter bridge — route / verify / review / compact through the shared
 * agent-glue core, with the injectable gateway client.
 *
 * The existing `hooks/jev.js` prune + ledger is untouched: it stays the
 * verbatim-tool-output pruning hook. This bridge is the other four capabilities
 * exposed to a Claude host as pure, injectable functions — a host wires them by
 * direct `import` (or `echo <json> | node agent-glue/claude/bridge.mjs <cap>`),
 * never as a `tool.call` rewrite and never as a blocking command hook, because
 * every policy is shadow/uncalibrated and a decision must stay advisory.
 *
 * CLI: read one JSON on stdin, dispatch by argv[2], print bounded JSON.
 *    bridge.mjs route    -> real route judgment (no live model -> route itself fail-opens)
 *    bridge.mjs verify   -> verifyCompletion over provided evidence
 *    bridge.mjs review   -> reviewDiff over a provided git diff or parsed files
 *    bridge.mjs compact  -> compactMessages over provided messages
 */
import { route, verifyCompletion, reviewDiff, compactMessages, describeCandidates } from '../src/index.js';

const sub = process.argv[2];

let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload = {};
try {
  payload = input.trim() ? JSON.parse(input) : {};
} catch {
  process.stderr.write('bridge: stdin is not valid JSON\n');
  process.exit(2);
}

function respond(v) {
  process.stdout.write(JSON.stringify(v) + '\n');
}

switch (sub) {
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
  case 'verify': {
    respond(await verifyCompletion(payload));
    break;
  }
  case 'review': {
    respond(await reviewDiff(payload));
    break;
  }
  case 'compact': {
    const { messages = [], ...rest } = payload;
    respond(await compactMessages({ messages, judge: async () => 'keep', ...rest }));
    break;
  }
  default: {
    process.stderr.write('bridge: unknown capability (route|verify|review|compact)\n');
    process.exit(2);
  }
}
