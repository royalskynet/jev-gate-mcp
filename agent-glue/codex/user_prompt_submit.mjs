#!/usr/bin/env node
/**
 * Codex UserPromptSubmit hook — run the real triage, advisory only.
 *
 * Runs the shared agent-glue `triage` over the user prompt. The result is
 * strictly advisory: a Codex UserPromptSubmit hook cannot change the model, so
 * it only emits a one-line `additionalContext` notice and records one bounded
 * line to the runtime ledger. Every policy is shadow/uncalibrated, so this
 * hook never blocks and never rewrites the user prompt.
 *
 * Fail-open: the in-process gateway is built lazily and yields `null` when the
 * provider key file is absent, in which case the triage fail-opens to "retain
 * status quo" and the notice says so. It never guesses a tier without a Jev
 * answer.
 */
import { readEvent, respond, appendLedger, boundedSummary } from './io.mjs';
import { triage } from '../src/triage.js';
import { liveTransport } from '../src/live.js';

const event = await readEvent();
const prompt = typeof event?.prompt === 'string' ? event.prompt : '';

// The live gateway when the provider is configured, otherwise undefined -> the
// triage's own fail-open path (status quo, one ledger line saying so).
const transport = (await liveTransport()) ?? undefined;
const decision = await triage(
  { text: prompt, contextChars: Number(process.env.JEV_CTX_CHARS ?? 0) },
  { transport },
);

const notice =
  decision.failOpen
    ? 'jev-triage: no live transport, retaining status quo (advisory)'
    : decision.unchanged
      ? `jev-triage: status quo — ${decision.notice ?? ''}`.trim()
      : `jev-triage: ${decision.tier ?? 'status-quo'} / ${decision.specialty ?? '?'} / conf ${(decision.confidence ?? 0).toFixed(2)}${decision.cached ? ' [cached]' : ''}`;

appendLedger(
  'codex-route.log',
  `userprompt\ttier=${decision.tier ?? 'status-quo'}\tspecialty=${decision.specialty ?? '-'}\t` +
  `conf=${(decision.confidence ?? 0).toFixed(2)}\tcached=${decision.cached}\t` +
  `lat=${decision.latency_ms}\tfailopen=${decision.failOpen}\tlen=${prompt.length}\t${boundedSummary(decision)}`,
);

// Advisory only: the hook cannot change the model, so it just lets the prompt
// through with a single-line notice the model can (but need not) act on.
respond({ decision: 'allow', additionalContext: [{ type: 'text', text: notice }] });

