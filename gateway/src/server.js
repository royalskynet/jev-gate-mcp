// MCP surface: exactly two tools on the same transport-agnostic server factory.
// The tool surface is intentionally small and stable; new domains arrive as
// policies, not as new tools (ADR-0001). v2 SDK (`@modelcontextprotocol/server`).
import { McpServer } from '@modelcontextprotocol/server';
import { GatewayError } from './core.js';
import {
  applyPolicyInputSchema,
  ApplyPolicyOutputSchema,
  evaluateInputSchema,
  EvaluateOutputSchema,
} from './schema.js';

const CAPABILITY = [
  'Jev judges caller-supplied state with typed Choice, Score, and Noul judgments.',
  'It never generates text, never executes actions, and never authorizes consequential work.',
  'jev_evaluate is advisory; jev_apply_policy runs server-owned, versioned policies.',
].join(' ');

function wrap(gateway, method) {
  return async (args) => {
    try {
      const result = method === 'evaluate' ? await gateway.evaluate(args) : await gateway.applyPolicy(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (e) {
      // Typed error, no state and no secrets; still structured so a client can
      // branch without parsing prose. isError marks it as a failure to the model.
      if (e instanceof GatewayError) {
        const err = { error: { code: e.code, category: e.category, message: e.message } };
        return { content: [{ type: 'text', text: JSON.stringify(err) }], structuredContent: err, isError: true };
      }
      throw e;
    }
  };
}

export function buildServer(gateway) {
  const server = new McpServer({ name: 'jev-gate-mcp', version: '0.1.0' });

  server.registerTool(
    'jev_evaluate',
    {
      title: 'Jev advisory evaluation',
      description:
        'Advisory, caller-defined batched Choice/Score/Noul judgments over supplied state. Returns typed answers, resolved model, usage, latency, coverage, and typed errors. Cannot authorize any action.',
      inputSchema: evaluateInputSchema,
      outputSchema: EvaluateOutputSchema,
    },
    wrap(gateway, 'evaluate'),
  );

  server.registerTool(
    'jev_apply_policy',
    {
      title: 'Jev governed policy',
      description:
        'Runs a server-owned, versioned Decision Policy. The caller supplies state only; questions, thresholds, model, and composition cannot be overridden. Returns a deterministic accept/review/escalate/deny Gate with reasons.',
      inputSchema: applyPolicyInputSchema,
      outputSchema: ApplyPolicyOutputSchema,
    },
    wrap(gateway, 'apply'),
  );

  return server;
}

export { CAPABILITY };
