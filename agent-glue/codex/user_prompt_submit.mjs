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
 * Fail-open: with no live transport injected (a bare CLI has no gateway), the
 * triage fail-opens to "retain status quo" and the notice says so. A wired host
 * can inject a transport by importing the core directly; the hook itself stays
 * transport-free so it can never guess a tier without a Jev answer.
 */
import { readEvent, respond, appendLedger, boundedSummary } from './io.mjs';
import { triage } from '../src/triage.js';

const event = await readEvent();
const prompt = typeof event?.prompt === 'string' ? event.prompt : '';

// Bare CLI: no live transport, so this fail-opens to status quo. A wired host
// runs the core with a real (injected) transport instead of this hook.
const decision = await triage({ text: prompt, contextChars: Number(process.env.JEV_CTX_CHARS ?? 0) });

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

