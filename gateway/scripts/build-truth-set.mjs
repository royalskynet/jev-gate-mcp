#!/usr/bin/env node
// Builds the noul evaluation set (issue #10, laya noul) from the public
// true/false statement CSVs of Marks & Tegmark, "Geometry of Truth"
// (https://github.com/saprmarks/geometry-of-truth). Upstream licenses:
// cities derives from GeoNames (CC BY 4.0); counterfact derives from ROME
// (MIT). Selection is deterministic: per source, statements are sorted by
// sha1(statement) hex and the first 25 per label are taken; duplicate
// statements keep their first occurrence in source order. No randomness.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCES = [
  'cities',
  'neg_cities',
  'larger_than',
  'sp_en_trans',
  'companies_true_false',
  'common_claim_true_false',
  'counterfact_true_false',
];
const PER_LABEL = 25;
const UPSTREAM_BASE = 'https://github.com/saprmarks/geometry-of-truth/blob/main/datasets/';

function sha1hex(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

// Minimal RFC4180 parser: double-quoted fields may contain commas, escaped
// "" quotes, and newlines. Returns an array of rows (arrays of raw fields).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
      i += 1;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function fail(message) {
  console.error(`build-truth-set: ${message}`);
  process.exitCode = 1;
}

function main() {
  const [rawDir, outFile] = process.argv.slice(2);
  if (!rawDir || !outFile) {
    fail('usage: node build-truth-set.mjs <rawDir> <outFile>');
    return;
  }

  const seen = new Set();
  const records = [];

  // Upstream repeats some statements with opposite labels (e.g. an
  // "official language" row as both 1 and 0). Such a label is noise, not
  // ground truth, so the statement is dropped everywhere rather than letting
  // whichever copy comes first decide.
  const labelsOf = new Map();
  for (const source of SOURCES) {
    let rows;
    try {
      rows = parseCsv(readFileSync(join(rawDir, `${source}.csv`), 'utf8'));
    } catch {
      continue; // reported with context by the main loop below
    }
    const h = rows[0]?.map((x) => x.trim()) ?? [];
    for (const f of rows.slice(1)) {
      const s = (f[h.indexOf('statement')] ?? '').trim();
      if (!labelsOf.has(s)) labelsOf.set(s, new Set());
      labelsOf.get(s).add((f[h.indexOf('label')] ?? '').trim());
    }
  }
  const conflicted = new Set([...labelsOf].filter(([, l]) => l.size > 1).map(([s]) => s));
  if (conflicted.size) process.stderr.write(`dropped ${conflicted.size} statements with conflicting labels\n`);

  for (const source of SOURCES) {
    const path = join(rawDir, `${source}.csv`);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      fail(`cannot read ${path}`);
      return;
    }

    const rows = parseCsv(text);
    if (rows.length < 2) {
      fail(`${path}: no data rows`);
      return;
    }
    const header = rows[0].map((h) => h.trim());
    const statementIdx = header.indexOf('statement');
    const labelIdx = header.indexOf('label');
    if (statementIdx === -1 || labelIdx === -1) {
      fail(`${path}: header must contain "statement" and "label" columns`);
      return;
    }

    const pools = { '1': [], '0': [] };
    for (const fields of rows.slice(1)) {
      const statement = (fields[statementIdx] ?? '').trim();
      const label = (fields[labelIdx] ?? '').trim();
      if (statement === '') continue;
      if (label !== '0' && label !== '1') {
        fail(`${path}: unexpected label ${JSON.stringify(label)}`);
        return;
      }
      if (seen.has(statement) || conflicted.has(statement)) continue;
      seen.add(statement);
      pools[label].push(statement);
    }

    for (const label of ['1', '0']) {
      const pool = pools[label];
      if (pool.length < PER_LABEL) {
        fail(`${source}: only ${pool.length} label=${label} statements, need ${PER_LABEL}`);
        return;
      }
      pool.sort((a, b) => {
        const ha = sha1hex(a);
        const hb = sha1hex(b);
        if (ha < hb) return -1;
        if (ha > hb) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const statement of pool.slice(0, PER_LABEL)) {
        records.push({
          id: sha1hex(statement).slice(0, 12),
          source,
          claim: statement,
          label: label === '1',
          upstream: `${UPSTREAM_BASE}${source}.csv`,
        });
      }
    }
  }

  const sourceOrder = new Map(SOURCES.map((s, i) => [s, i]));
  records.sort((a, b) => {
    const d = sourceOrder.get(a.source) - sourceOrder.get(b.source);
    if (d !== 0) return d;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : 0;
  });

  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, lines, 'utf8');

  const perSource = new Map();
  for (const r of records) perSource.set(r.source, (perSource.get(r.source) ?? 0) + 1);
  console.log(`wrote ${records.length} claims to ${outFile}`);
  for (const source of SOURCES) console.log(`  ${source}: ${perSource.get(source)}`);
}

main();
