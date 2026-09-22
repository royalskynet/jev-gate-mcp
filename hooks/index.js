// ponytail: single-module aggregator, plugin schema allows only 1 modules entry
import { register as registerJev } from './jev.js';
import { register as registerSpawn } from '../agent-glue/claude/spawn-hook.mjs';
import { register as registerCompact } from '../agent-glue/claude/compact-hook.mjs';

export const register = (on) => {
  registerJev(on);
  registerSpawn(on);
  registerCompact(on);
};
