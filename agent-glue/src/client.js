/**
 * agent-glue client — injectable wrapper over the existing in-process gateway's
 * two MCP semantics (`jev_evaluate` / `jev_apply_policy`), shared by the Claude
 * and Codex adapters and by the acceptance smoke.
 *
 * The transport is injected so the four glues never hard-bind to a live
 * provider:
 *   - production: `makeGatewayTransport(gateway)` wraps the real in-process
 *     gateway's `evaluate`/`applyPolicy` (registry, policies, fail-closed
 *     credential handling all live there);
 *   - tests: a fake transport returns canned answers with no network.
 *
 * Every return is bounded: an evaluate surfaces only the typed answers (keys +
 * value), an applyPolicy surfaces only the gate outcome fields. State and
 * secrets are inputs, never echoed back, never logged.
 */

/**
 * @param {object} gateway  a built `JevGateway` (buildGateway().gateway)
 * @returns {import('./client.js')}  client-shaped transport
 */
export function makeGatewayTransport(gateway) {
  return {
    async evaluate(input) {
      const res = await gateway.evaluate(input);
      // Bounded surface: question keys + answers only. raw/questions echoes
      // nothing back; usage/latency are tiny numbers we keep off the wire.
      //
      // `gateway.evaluate` answers as an ARRAY of `{question, answer}`, while
      // every caller (triage, and the fake transport the tests use) reads
      // `answers[<question id>]`. Iterating Object.entries over the array gave
      // `{0:…,1:…}`, so `answers.difficulty` was always undefined and triage
      // fail-opened to status quo on every live turn — invisible to the tests,
      // because only the fake keyed by question id. Key by question id here.
      const answers = {};
      const list = Array.isArray(res?.answers) ? res.answers : [];
      for (const entry of list) {
        if (entry?.question) answers[entry.question] = entry.answer;
      }
      if (!list.length && res?.answers && typeof res.answers === 'object') {
        for (const [key, a] of Object.entries(res.answers)) answers[key] = a;
      }
      return {
        answers,
        model: res?.model ?? null,
        coverage: res?.coverage ?? 'complete',
        latency_ms: res?.latency_ms ?? null,
      };
    },
    async applyPolicy(input) {
      const res = await gateway.applyPolicy(input);
      return {
        outcome: res?.outcome ?? null,
        reasons: Array.isArray(res?.reasons) ? res.reasons : [],
        policy: res?.policy ?? null,
        version: res?.version ?? null,
        calibration_status: res?.calibration_status ?? null,
        mode: res?.mode ?? null,
      };
    },
  };
}

/** A canned fake for tests/offline smoke; never touches the network. */
export function makeFakeTransport(fakeAnswer = { choice: 'no_match', confidence: 0.5 }) {
  const calls = [];
  return {
    calls,
    async evaluate(input) {
      calls.push({ kind: 'evaluate', keys: Object.keys(input?.questions ?? {}) });
      const answers = {};
      for (const key of Object.keys(input?.questions ?? {})) answers[key] = fakeAnswer;
      return { answers, model: 'fake', coverage: 'complete' };
    },
    async applyPolicy(input) {
      calls.push({ kind: 'applyPolicy', policy: input?.policy ?? null });
      return {
        outcome: 'review',
        reasons: ['fake transport'],
        policy: input?.policy ?? null,
        version: '0',
        calibration_status: 'uncalibrated',
        mode: 'shadow',
      };
    },
  };
}

/**
 * Wrap a transport with a safety net: any reject is mapped to a typed
 * fail-open object so a broken provider never throws into the glue core.
 */
export async function safeCall(transport, method, input) {
  try {
    return await transport[method](input);
  } catch (error) {
    return { error: { code: 'ERR_CLIENT', message: error instanceof Error ? error.message : String(error) } };
  }
}
