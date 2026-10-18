# vendor/fast-jev

`tsc` output of **fast-jev-compaction** — the Anthropic-shaped compaction core.

| | |
|---|---|
| source | `royalskynet/fast-jev-compaction-openrouter` (local checkout `~/dev/fast-jev-compaction-openrouter`) |
| package | `fast-jev-compaction` 0.2.0 (plugin 0.5.0) |
| vendored | 2026-09-26 |
| refresh | `node scripts/vendor-fast-jev.mjs [<checkout>]` |

Why vendored and not a `file:` dependency: m2 and DESKTOP-N63AOMF have no
checkout of that repo, and this plugin must stay dependency-free so the hook
runtime can load it. Built JS (not `.ts`) because the sources use NodeNext
`.js` specifiers, which plain `node --test` will not resolve from `.ts`.

**Upstream is gone** (checked 2026-10-18): neither the local checkout nor the
GitHub repository `royalskynet/fast-jev-compaction-openrouter` exists any more,
so `scripts/vendor-fast-jev.mjs` cannot run and there is nothing to fix
upstream. These files are now the only copy — edit them here, keep the edits
surgical, and cover each one with a test under `tests/agent-glue/`. If the
upstream ever comes back, diff before re-vendoring; local changes so far:

- `compact.js`: two-pass questions (`call_#` first, `result_#` only for calls
  that cleared `keepThreshold`) — halves the requests per compaction, fix 10629.
