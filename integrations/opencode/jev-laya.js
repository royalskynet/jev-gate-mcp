import { existsSync } from 'node:fs';
import { MIN_CHARS, shrink, lastUserText, defaultJevEnv, compactParts } from './prune-core.js';

// Only the plugin is exported: opencode runs every exported function as one.
export const JevLaya = async ({ client } = {}) => {
  defaultJevEnv(process.env, existsSync);
  // Read by usage-ledger at import time, so it must be set before the import.
  process.env.JEV_USAGE_CALLER ??= 'prune:opencode';
  const glue = () => import('../../agent-glue/src/prune.js').catch(() => null);
  let mod;
  const decisions = new Map(); // callID -> 'keep' | 'drop', for the life of the TUI
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (typeof output?.output !== 'string' || output.output.length < MIN_CHARS) return;
        mod ??= glue();
        const prune = (await mod)?.pruneCommand;
        const getRequest = async () => {
          if (!client?.session?.messages || !input?.sessionID) return '';
          const r = await client.session.messages({ path: { id: input.sessionID } });
          return lastUserText(r?.data ?? r);
        };
        const text = await shrink({ tool: input?.tool, text: output.output }, { prune, getRequest });
        if (text.length < output.output.length) output.output = text;
      } catch {
        // fail-open: leave original output untouched
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      if (process.env.JEV_COMPACT_ENABLED === '0') return;
      try {
        mod ??= glue();
        const judgeSegments = (await mod)?.judgeSegments;
        await compactParts(output?.messages, { judge: judgeSegments, decisions });
      } catch {
        // fail-open: the model sees the history verbatim
      }
    },
  };
};
