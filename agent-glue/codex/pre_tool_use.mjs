#!/usr/bin/env node
/**
 * Codex PreToolUse hook — advisory only.
 *
 * Every policy is shadow/uncalibrated, so a Jev opinion must never block or
 * rewrite a not-yet-executed action. This hook records one bounded line and
 * always returns `decision: allow`. Real blocking stays with the existing
 * deterministic safety rules upstream, not here.
 */
import { readEvent, respondNothing, appendLedger } from './io.mjs';

const event = await readEvent();
const tool = typeof event?.tool_name === 'string' ? event.tool_name : '?';
appendLedger('codex-tooluse.log', `pretool\t${tool}\tadvisory`);
respondNothing(); // no `allow` exists for PreToolUse; silence is the advisory no-op
