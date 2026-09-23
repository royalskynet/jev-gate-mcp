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
