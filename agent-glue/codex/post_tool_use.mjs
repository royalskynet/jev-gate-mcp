#!/usr/bin/env node
/**
 * Codex PostToolUse hook — prune long Bash output before the model reads it.
 *
 * Same pipeline as the Claude Code function hook and the opencode plugin
 * (integrations/opencode/prune-core.js `shrink`): L0 trim locally, then past
 * 16 KB the Jev keep/drop judgment against the session's latest prompt. Codex
 * has no "replace output" field (`updatedMCPToolOutput` is parsed, not
 * supported), but `decision: "block"` + `reason` "replaces the tool result with
 * that feedback, and continues the model" without failing the tool
 * (learn.chatgpt.com/docs/hooks) — so the pruned text is sent as the reason.
 * Only when it is actually shorter; any failure says nothing (fail-open).
 * `JEV_PRUNE_ENABLED=0` turns it off.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readEvent, respond, respondNothing, appendLedger, promptFile } from './io.mjs';
import { MIN_CHARS, shrink, defaultJevEnv } from '../../integrations/opencode/prune-core.js';

/** Bash's `tool_response` as text: a string, or the documented-ish fields. */
export function outputText(r) {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  for (const k of ['output', 'stdout', 'aggregated_output', 'formatted_output']) {
    if (typeof r[k] === 'string') return r[k];
  }
  return '';
}

const event = await readEvent();
const tool = typeof event?.tool_name === 'string' ? event.tool_name : '?';
try {
  const text = tool === 'Bash' && process.env.JEV_PRUNE_ENABLED !== '0' ? outputText(event?.tool_response) : '';
  if (text.length < MIN_CHARS) {
    appendLedger('codex-tooluse.log', `posttool\t${tool}\tskip\tlen=${text.length}`);
    respondNothing();
  } else {
    defaultJevEnv(process.env, existsSync);
    process.env.JEV_USAGE_CALLER ??= 'codex';
    const { pruneCommand } = await import('../src/prune.js');
    const getRequest = async () => {
      const f = promptFile(event?.session_id);
      return f && existsSync(f) ? readFileSync(f, 'utf8') : '';
    };
    const out = await shrink({ tool: 'bash', text }, { prune: pruneCommand, getRequest });
    appendLedger('codex-tooluse.log', `posttool\t${tool}\tprune\t${text.length}->${out.length}`);
    if (out.length < text.length) respond({ decision: 'block', reason: out });
    else respondNothing();
  }
} catch {
  respondNothing(); // fail-open: the built-in result stands
}
