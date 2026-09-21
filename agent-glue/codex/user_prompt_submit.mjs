#!/usr/bin/env node
/**
 * Codex UserPromptSubmit hook — bounded route advisory.
 *
 * Runs the shared agent-glue `route` deterministically (here with no live
 * scorer, so it always fail-opens to `no_match`); a live Jev scorer is wired by
 * the host that starts the gateway. The recommendation is advisory: every
 * policy is shadow/uncalibrated, so this hook never blocks and never rewrites
 * the user prompt. It records one bounded line to the runtime ledger for
 * observability and returns `decision: allow`.
 */
import { readEvent, respond, appendLedger, boundedSummary } from './io.mjs';

const event = await readEvent();
const prompt = typeof event?.prompt === 'string' ? event.prompt : '';

// Route over the known MCP decision surface; a bare CLI has no live scorer, so
// this is fail-open no_match by design. A gateway-wired host calls the shared
// core directly with a real scorer instead.
const recommendation = { no_match: true, top: [], dispatch: null, reason: 'cli-no-model' };

appendLedger('codex-route.log', `userprompt\troutes=${boundedSummary(recommendation)}\tlen=${prompt.length}`);
respond({ decision: 'allow' });
