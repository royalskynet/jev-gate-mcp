/**
 * Environment for a hooks module, which has no Node.
 *
 * `process` is a ReferenceError inside a function hook — and `hooks/index.js`
 * is a single aggregator, so one touch of it takes every hook in this plugin
 * down at load time. `claude plugin validate` cannot see it: it reads the
 * source statically and only checks the shape of the `$` calls. `claude
 * --debug` says it in one line, in the debug log:
 *
 *   [ERROR] hooks module jev-gate@inline failed to load:
 *           ReferenceError: process is not defined
 *
 * That is the fifth way the ledger stays empty, and none of the four in the
 * README's "An empty ledger" can tell it apart from the rest: every check that
 * asks "is it installed" answers yes.
 *
 * These same files are imported by Node too (`npm test`, `scripts/*.mjs`,
 * `agent-glue/cli.mjs`), where `process.env` is the right source. So: read it
 * when it exists, and in the hook fill the same names from `$.env`.
 *
 * ponytail: this file holds no `$`. The validator follows `$` only inside the
 * file it was handed to and refuses it across an import, so each hook file
 * spells its own `$.env.get("NAME")` calls — which is also what makes
 * `claude plugin validate` list the names each module reads — and hands the
 * values here.
 */

/**
 * Every environment variable this plugin's hooks read. Under Node this *is*
 * `process.env`, not a copy, so a test that sets a variable after import is
 * seen. In the hook it starts empty and each module's own `hydrate($)` fills
 * it from `$.env` — where there is no `process` to write through.
 */
export const ENV = typeof process === 'undefined' ? {} : process.env;

/**
 * Merge values read from `$.env` into `ENV`, ignoring the ones that are unset.
 * @param {Record<string, string | undefined>} values
 */
export function fillEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) ENV[name] = value;
  }
}

/**
 * Zen free has a quota; while the gateway/probe have it in cooldown
 * (`cooldown_until` in ~/.jevgate/zen-free-status.json) the hooks ask
 * OpenRouter instead, and go back to Zen once it lapses. Pure: each hook reads
 * the file through its own `$.fs` (see the ponytail note above).
 */
export const ZEN_PRIMARY = Object.freeze({
  endpoint: 'https://opencode.ai/zen/v1/systemone',
  model: 'jev-1.13-free',
  keyName: 'OPENCODE_ZEN_API_KEY.txt',
});

export const ZEN_BACKUP = Object.freeze({
  endpoint: 'https://openrouter.ai/api/v1/systemone',
  model: 'typesafe/jev-1.13',
  keyName: 'OPENROUTER_SECOND_API_KEY.txt',
});

/** True when the status text's cooldown is still ahead of `now` (ms). */
export function zenCooling(statusText, now) {
  try {
    const until = JSON.parse(statusText).cooldown_until;
    return Number.isFinite(until) && Number.isFinite(now) && until > now;
  } catch {
    return false;
  }
}

/**
 * Only Zen fails over; a host pinned elsewhere is left alone. Judged by value,
 * not by presence: M2 exports the three names set to the Zen defaults, and the
 * presence check read that as a pin, so a Zen cooldown kept every prune (#28).
 */
export function followsZen() {
  return (!ENV.JEV_ENDPOINT || ENV.JEV_ENDPOINT === ZEN_PRIMARY.endpoint)
    && (!ENV.JEV_MODEL || ENV.JEV_MODEL === ZEN_PRIMARY.model)
    && (!ENV.JEV_API_KEY_FILE || ENV.JEV_API_KEY_FILE.endsWith(`/${ZEN_PRIMARY.keyName}`));
}
