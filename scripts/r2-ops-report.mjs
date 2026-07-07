#!/usr/bin/env node
// Read-only R2 operations report. The wrangler CLI has no object-level
// list, so this measures through what IS observable without S3 keys:
//   1. bucket lifecycle rules (wrangler r2 bucket lifecycle list),
//   2. backup storage economics (backups/d1/latest.json + manifest —
//      per-day bytes and the 14-day retention steady state),
//   3. maintenance snapshot accumulation (the maintenance_runs D1 table
//      records every snapshot prefix — REMOTE READ-ONLY query).
// Prints a report + a retention proposal. Changes NOTHING.
//
// Usage: node scripts/r2-ops-report.mjs   (needs wrangler auth)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUCKET = 'medina-ventures-storage';
const DB = 'medina-ventures-db';

function wrangler(args, { json = false } = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 4).join(' ')}… failed:\n${result.stderr || result.stdout}`);
  return json ? JSON.parse(result.stdout) : result.stdout;
}

const tmp = mkdtempSync(join(tmpdir(), 'r2-ops-'));
try {
  console.log('# R2 ops report (read-only)\n');

  console.log('## Lifecycle rules');
  console.log(wrangler(['r2', 'bucket', 'lifecycle', 'list', BUCKET]).split('\n').filter(l => /name:|enabled:|prefix:|action:/.test(l)).join('\n'));

  console.log('\n## Backup storage (backups/d1/)');
  wrangler(['r2', 'object', 'get', `${BUCKET}/backups/d1/latest.json`, '--file', join(tmp, 'latest.json'), '--remote']);
  const latest = JSON.parse(readFileSync(join(tmp, 'latest.json'), 'utf8'));
  wrangler(['r2', 'object', 'get', `${BUCKET}/${latest.manifest_key}`, '--file', join(tmp, 'manifest.json'), '--remote']);
  const manifest = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8'));
  const dayGB = manifest.total_bytes / 1024 ** 3;
  console.log(`latest backup: ${latest.date} — ${manifest.tables.length} tables, ${manifest.total_rows.toLocaleString()} rows, ${dayGB.toFixed(2)} GB serialized`);
  console.log(`retention steady state (14 daily): ~${(dayGB * 14).toFixed(1)} GB ≈ $${(dayGB * 14 * 0.015).toFixed(2)}/month at Standard storage`);
  console.log(`optional: Infrequent Access transition for backups/ (~40% cheaper at rest; retrieval fees apply on restore) —`);
  console.log(`  wrangler r2 bucket lifecycle add ${BUCKET} backups-ia backups/ (dashboard/API for storage-class transitions if the CLI lacks the flag)`);

  console.log('\n## Maintenance snapshots (maintenance/d1/ — via maintenance_runs, read-only)');
  const rows = wrangler(['d1', 'execute', DB, '--remote', '--json', '--command',
    "SELECT COUNT(*) AS runs, MIN(created_at) AS oldest, MAX(created_at) AS newest, SUM(CASE WHEN created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days') THEN 1 ELSE 0 END) AS older_than_90d FROM maintenance_runs"], { json: true })[0].results[0];
  console.log(`runs recorded: ${rows.runs} (oldest ${rows.oldest}, newest ${rows.newest}); older than 90d: ${rows.older_than_90d}`);
  console.log('proposal: delete maintenance/d1/<date>/<runId> prefixes older than 90 days');
  console.log('(maintenance snapshots exist to undo a specific cleanup run; 90d far exceeds any realistic undo window).');
  console.log('NOT implemented — deletion policy is an owner decision; see docs/disaster-recovery.md.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
