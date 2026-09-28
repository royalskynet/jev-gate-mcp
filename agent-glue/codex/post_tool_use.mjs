#!/usr/bin/env node
/**
 * Codex PostToolUse hook — advisory only (side effects already happened).
 *
 * PostToolUse cannot undo an action; at best it could replace the model-facing
 * result. Because policies are uncalibrated, this adapter does not rewrite any
 * result — it records a bounded line and lets the built-in result surface
 * untouched. Rewriting tool feedback for the model is reserved for a
 * calibrated policy path, never added while all five policies are shadow.
 */
import { readEvent, respondNothing, appendLedger } from './io.mjs';

const event = await readEvent();
const tool = typeof event?.tool_name === 'string' ? event.tool_name : '?';
appendLedger('codex-tooluse.log', `posttool\t${tool}\tadvisory`);
respondNothing(); // PostToolUse takes only `block`; silence is the advisory no-op
