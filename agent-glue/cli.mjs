#!/usr/bin/env node
/**
 * agent-glue CLI — shared, offline entry point to the four Jev decision
 * capabilities, used by both the Claude and Codex adapters (and by acceptance).
 *
 * Reads one JSON document on stdin. The `judge`/`jev` observers are *not*
 * wired here: a bare CLI run has no live adapter, so every judgment fails open
 * (compact keeps verbatim, verify stays deterministic, review is advisory-free,
 * route returns no_match). Adapters that want live Jev call the core functions
 * directly with a real injected judge, not through this CLI.
 *
 *   echo '<json>' | node agent-glue/cli.mjs compact
 *   echo '<json>' | node agent-glue/cli.mjs verify
 *   echo '<json>' | node agent-glue/cli.mjs review
 *   echo '<json>' | node agent-glue/cli.mjs route
 */
import { compactMessages, verifyCompletion, reviewDiff, route } from './src/index.js';

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
    // No live scorer in the bare CLI: small model cannot pick -> fail-open.
    respond({ no_match: true, top: [], dispatch: null, reason: 'cli-no-model' });
    break;
  }
  default: {
    process.stderr.write('agent-glue: unknown subcommand (compact|verify|review|route)\n');
    process.exit(2);
  }
}
