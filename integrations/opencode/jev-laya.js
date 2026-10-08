import { l0Prune } from '../../agent-glue/src/l0-prune.js';

export const MIN_CHARS = 2000;

export const JevLaya = async () => ({
  'tool.execute.after': async (input, output) => {
    try {
      if (typeof output?.output !== 'string' || output.output.length < MIN_CHARS) return;
      const r = l0Prune(output.output);
      if (r.savedChars > 0) output.output = r.text;
    } catch {
      // fail-open: leave original output untouched
    }
  },
});
