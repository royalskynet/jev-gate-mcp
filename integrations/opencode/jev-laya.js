import { existsSync } from 'node:fs';
import { MIN_CHARS, shrink, lastUserText, defaultJevEnv } from './prune-core.js';

// Only the plugin is exported: opencode runs every exported function as one.
export const JevLaya = async ({ client } = {}) => {
  defaultJevEnv(process.env, existsSync);
  // Read by usage-ledger at import time, so it must be set before the import.
  process.env.JEV_USAGE_CALLER ??= 'prune:opencode';
  let prune;
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (typeof output?.output !== 'string' || output.output.length < MIN_CHARS) return;
        prune ??= import('../../agent-glue/src/prune.js').then((m) => m.pruneCommand).catch(() => null);
        const getRequest = async () => {
          if (!client?.session?.messages || !input?.sessionID) return '';
          const r = await client.session.messages({ path: { id: input.sessionID } });
          return lastUserText(r?.data ?? r);
        };
        const text = await shrink({ tool: input?.tool, text: output.output }, { prune: await prune, getRequest });
        if (text.length < output.output.length) output.output = text;
      } catch {
        // fail-open: leave original output untouched
      }
    },
  };
};
