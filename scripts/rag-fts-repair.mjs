#!/usr/bin/env node
// One-time production repair for the FTS duplication incident
// (2026-07-07, audit F1): (1) delete duplicate rag_chunks_v2_fts rows
// (keep the highest rowid per chunk_id — the newest write), by rowid
// (O(1) per delete); (2) reconcile base statuses so the gate invariant
// holds: any base row that HAS an FTS row must not be
// 'pending'/'skipped'. Read → compute → targeted writes; re-runnable.
//
//   node scripts/rag-fts-repair.mjs            # dry-run (default)
//   node scripts/rag-fts-repair.mjs --apply    # execute repairs

import { spawnSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const DB = 'medina-ventures-db';

function d1(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`d1 failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  const parsed = JSON.parse(r.stdout);
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 500));
  return parsed[0].results;
}

// Page the whole FTS id space by rowid keyset (each page is cheap).
const pairs = [];
let last = 0;
for (;;) {
  const rows = d1(`SELECT rowid AS r, chunk_id AS c FROM rag_chunks_v2_fts WHERE rowid > ${last} ORDER BY rowid LIMIT 5000`);
  if (rows.length === 0) break;
  for (const row of rows) pairs.push(row);
  last = rows[rows.length - 1].r;
  process.stdout.write(`\rfts rows read: ${pairs.length}`);
}
console.log();

const keep = new Map(); // chunk_id -> max rowid
for (const { r, c } of pairs) if (!keep.has(c) || r > keep.get(c)) keep.set(c, r);
const losers = pairs.filter(({ r, c }) => keep.get(c) !== r).map(({ r }) => r);
console.log(`fts rows: ${pairs.length}; distinct chunk_ids: ${keep.size}; duplicate rows to delete: ${losers.length}`);

if (APPLY && losers.length) {
  for (let i = 0; i < losers.length; i += 50) {
    d1(`DELETE FROM rag_chunks_v2_fts WHERE rowid IN (${losers.slice(i, i + 50).join(',')})`);
    process.stdout.write(`\rdeleted: ${Math.min(i + 50, losers.length)}/${losers.length}`);
  }
  console.log();
}

// Status reconcile, server-side in rowid ranges (each range = one small
// FTS slice; the UPDATE's IN(SELECT ...) touches only that slice).
const maxRowid = pairs.length ? Math.max(...pairs.map(p => p.r)) : 0;
let reconciled = 0;
if (APPLY) {
  for (let lo = 0; lo <= maxRowid; lo += 5000) {
    const res = d1(`UPDATE rag_chunks_v2 SET opensearch_status = 'synced' WHERE opensearch_status IN ('pending','skipped') AND id IN (SELECT chunk_id FROM rag_chunks_v2_fts WHERE rowid > ${lo} AND rowid <= ${lo + 5000}) RETURNING id`);
    reconciled += res.length;
    process.stdout.write(`\rreconciled statuses: ${reconciled} (rowid ≤ ${lo + 5000})`);
  }
  console.log();
} else {
  const est = d1(`SELECT COUNT(*) AS n FROM rag_chunks_v2 WHERE opensearch_status IN ('pending','skipped') AND id IN (SELECT chunk_id FROM rag_chunks_v2_fts WHERE rowid <= 5000)`);
  console.log(`dry-run: first-slice status mismatches = ${est[0].n} (apply to fix all slices)`);
}
console.log(APPLY ? 'REPAIR APPLIED' : 'DRY RUN ONLY — rerun with --apply');
