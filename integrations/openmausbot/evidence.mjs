/**
 * Extra evidence for claimcheck-watch beyond the thread itself: documents the
 * bot keeps on disk (its own work files, gap analyses, jurisdiction notes) and
 * the llm-wiki via `qmd search`.
 *
 * Retrieval is keyword windows, not whole files: terms come from the claims
 * (ASCII words and numbers weigh 3, CJK bigrams 1), every line is scored by
 * distinct terms hit, and the best ±radius-line windows across all files fill
 * the budget. Windows are verbatim, so the judge's quote guard still works.
 * ponytail: bigram scoring, no BM25/IDF; swap for qmd's vector search
 *   (scripts/vq.sh) if recall on Chinese-only claims turns out poor.
 *
 * Each block is labelled `[source: <tier> <path>]`; sourceOf() maps a verified
 * quote back to its tier so a claim backed only by the wiki can be marked weak.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, resolve, sep } from 'node:path';

const TEXT = /\.(md|txt|csv|json|jsonl|ya?ml)$/i;
const SKIP_DIR = /^(\.|node_modules$|venv$|site-packages$|__pycache__$|dist$|build$)/;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'not', 'per', 'via']);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Text documents under root, skipping dot dirs, venvs and big files. */
export function listDocs(root, { maxBytes = 300000, maxFiles = 3000 } = {}) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= maxFiles) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p); }
      else if (e.isFile() && TEXT.test(e.name) && !e.name.startsWith('.')) {
        try { if (statSync(p).size <= maxBytes) out.push(p); } catch { /* vanished */ }
      }
    }
  };
  if (root && existsSync(root)) walk(root);
  return out;
}

/** Search terms from claim texts. */
export function terms(claims) {
  const ascii = new Set(), cjk = new Set();
  for (const c of claims) {
    for (const w of String(c).match(/[A-Za-z][A-Za-z0-9_-]{2,}|\d+(?:\.\d+)?[A-Za-z%]*/g) ?? []) {
      const k = w.toLowerCase();
      if (!STOP.has(k) && !/^\d$/.test(k)) ascii.add(k);
    }
    for (const run of String(c).match(/[一-鿿]{2,}/g) ?? []) {
      for (let i = 0; i + 2 <= run.length; i++) cjk.add(run.slice(i, i + 2));
    }
  }
  return { ascii: [...ascii], cjk: [...cjk] };
}

function lineScore(line, t) {
  const low = line.toLowerCase();
  let s = 0;
  for (const w of t.ascii) if (low.includes(w)) s += 3;
  for (const b of t.cjk) if (line.includes(b)) s += 1;
  return s;
}

/** Best windows of one document: [{score, from, to}] (inclusive line range). */
export function windows(text, t, { radius = 2, minScore = 3 } = {}) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lineScore(lines[i], t);
    if (s >= minScore) hits.push({ score: s, from: Math.max(0, i - radius), to: Math.min(lines.length - 1, i + radius) });
  }
  return { lines, hits };
}

/**
 * Fill `budget` chars with the best windows across `sources`
 * ([{tier, files}]). Returns {text, blocks:[{tier, path, text}]}.
 */
export function gather({ claims, sources, budget, read = (p) => readFileSync(p, 'utf8') }) {
  const t = terms(claims);
  if (!t.ascii.length && !t.cjk.length) return { text: '', blocks: [] };
  const cands = [];
  const seen = new Set();
  for (const { tier, files } of sources) {
    for (const path of files) {
      if (seen.has(path)) continue;
      seen.add(path);
      let body;
      try { body = read(path); } catch { continue; }
      const { lines, hits } = windows(body, t);
      for (const h of hits) cands.push({ ...h, tier, path, lines });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const taken = new Map(); // path -> [[from,to]]
  const blocks = [];
  let used = 0;
  for (const c of cands) {
    const spans = taken.get(c.path) ?? [];
    if (spans.some(([f, to]) => c.from <= to && c.to >= f)) continue;
    const body = c.lines.slice(c.from, c.to + 1).join('\n');
    const piece = `[source: ${c.tier} ${c.path}]\n${body}`;
    if (used + piece.length > budget) continue;
    spans.push([c.from, c.to]);
    taken.set(c.path, spans);
    blocks.push({ tier: c.tier, path: c.path, text: body });
    used += piece.length + 2;
  }
  return { text: blocks.map((b) => `[source: ${b.tier} ${b.path}]\n${b.text}`).join('\n\n'), blocks };
}

/** Tier of the first block holding the quote verbatim, else `fallback`. */
export function sourceOf(quote, blocks, fallback = 'thread') {
  const q = norm(quote);
  if (q.length < 4) return undefined;
  const b = blocks.find((x) => norm(x.text).includes(q));
  return b ? b.tier : fallback;
}

/** {tier, path} of the first block holding the quote verbatim, else `undefined`. */
export function refOf(quote, blocks) {
  const q = norm(quote);
  if (q.length < 4) return undefined;
  const b = blocks.find((x) => norm(x.text).includes(q));
  return b ? { tier: b.tier, path: b.path } : undefined;
}

/** Paths the bot read or wrote (Read/Write/Edit file_path) in the given threads. */
export function botFiles(db, threads) {
  const out = new Set();
  if (!threads.length) return out;
  const rows = db.prepare(
    `SELECT json FROM messages WHERE kind = 'activity' AND thread_id IN (${threads.map(() => '?').join(',')})`).all(...threads);
  for (const r of rows) {
    let tool;
    try { tool = JSON.parse(r.json).tool; } catch { continue; }
    if (!tool || !/^(Read|Write|Edit|MultiEdit)$/.test(tool.name ?? '')) continue;
    let input = tool.input;
    try { if (typeof input === 'string') input = JSON.parse(input); } catch { continue; }
    if (typeof input?.file_path === 'string') out.add(input.file_path);
  }
  return out;
}

/** File names cited in a reply (e.g. `docs_travel-rule-overview.md`). */
export function citedNames(text) {
  return new Set((String(text).match(/[\w一-鿿().（）-]+\.(?:md|txt|csv|json|jsonl|ya?ml)\b/gi) ?? []).map((s) => basename(s)));
}

function under(path, roots) {
  const p = resolve(path);
  return roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** qmd search hits in one collection -> file paths under wikiRoot. */
export function qmdFiles(query, { bin = 'qmd', collection = 'wiki-llm', wikiRoot, n = 3, run = spawnSync } = {}) {
  if (!query || !wikiRoot) return [];
  const r = run(bin, ['search', '--json', query, '-c', collection, '-n', String(n)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  let hits;
  try { hits = JSON.parse(r.stdout); } catch { return []; }
  const prefix = `qmd://${collection}/`;
  return (Array.isArray(hits) ? hits : [])
    .map((h) => String(h.file ?? ''))
    .filter((f) => f.startsWith(prefix))
    .map((f) => join(wikiRoot, f.slice(prefix.length)))
    .filter((p) => existsSync(p));
}

/**
 * Retriever for claimcheck-watch. Directory listings are cached until
 * refresh() (once per watcher pass, listed lazily); file reads happen per reply.
 *   workDirs   the bot's own working dirs (cited file names resolve here)
 *   gapDir     gap-analysis outputs
 *   jurDir     jurisdiction notes
 *   wikiRoot   llm-wiki pages dir (qmd collection root)
 *   radarDir   research bot reports (each finding carries its URL)
 *   readRoots  whitelist for files taken from the bot's Read/Write history
 */
export function makeRetriever({ workDirs = [], gapDir, jurDir, wikiRoot, qmdBin = 'qmd', collection = 'wiki-llm', readRoots = [], radarDir, run } = {}) {
  let lists = null;
  const roots = [...workDirs, gapDir, jurDir, wikiRoot, radarDir, ...readRoots].filter(Boolean).map((r) => resolve(r));
  const refresh = () => { lists = null; };
  const retrieve = ({ text, claims, readFiles = new Set(), budget }) => {
    lists ??= { work: workDirs.flatMap((d) => listDocs(d)), gap: listDocs(gapDir), jur: listDocs(jurDir), radar: listDocs(radarDir) };
    const cited = citedNames(text);
    const own = [
      ...lists.work.filter((p) => cited.has(basename(p))),
      ...[...readFiles].filter((p) => TEXT.test(p) && under(p, roots) && existsSync(p)),
    ];
    const t = terms(claims);
    const query = t.ascii.slice(0, 4).join(' ');
    const wiki = qmdFiles(query, { bin: qmdBin, collection, wikiRoot, ...(run ? { run } : {}) });
    return gather({ claims, budget, sources: [
      { tier: 'own-file', files: own },
      { tier: 'gap', files: lists.gap },
      { tier: 'jurisdictions', files: lists.jur },
      { tier: 'radar', files: lists.radar },
      { tier: 'work', files: lists.work },
      { tier: 'wiki', files: wiki },
    ] });
  };
  return { retrieve, refresh };
}
