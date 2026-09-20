// MCP surface: exactly two tools on the same McpServer, transport-agnostic.
// The tool surface is intentionally small and stable; new domains arrive as
// policies, not as new tools (ADR-0001).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GatewayError } from './core.js';
import { applyPolicyInputSchema, evaluateInputSchema } from './schema.js';

const CAPABILITY = [
  'Jev judges caller-supplied state with typed Choice, Score, and Noul judgments.',
  'It never generates text, never executes actions, and never authorizes consequential work.',
  'jev_evaluate is advisory; jev_apply_policy runs server-owned, versioned policies.',
].join(' ');

export function buildServer(gateway) {
  const server = new McpServer(
    { name: 'jev-gate-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'jev_evaluate',
    {
      title: 'Jev advisory evaluation',
      description:
        'Advisory, caller-defined batched Choice/Score/Noul judgments over supplied state. Returns typed answers, resolved model, usage, latency, coverage, and typed errors. Cannot authorize any action.',
      inputSchema: evaluateInputSchema,
    },
    awaitWrap((args) => gateway.evaluate(args)),
  );

  server.registerTool(
    'jev_apply_policy',
    {
      title: 'Jev governed policy',
      description:
        'Runs a server-owned, versioned Decision Policy. The caller supplies state only; questions, thresholds, model, and composition cannot be overridden. Returns a deterministic accept/review/escalate/deny Gate with reasons.',
      inputSchema: applyPolicyInputSchema,
    },
    awaitWrap((args) => gateway.applyPolicy(args)),
  );

  return server;
}

function awaitWrap(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      if (e instanceof GatewayError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code, category: e.category, message: e.message } }) }],
          isError: true,
        };
      }
      throw e;
    }
  };
}

export { CAPABILITY };
