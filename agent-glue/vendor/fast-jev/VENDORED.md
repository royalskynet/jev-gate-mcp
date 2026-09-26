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

**Do not edit these files.** Fix upstream, then re-run the refresh script.
