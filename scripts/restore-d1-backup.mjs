#!/usr/bin/env node
// Restore a scheduled D1 backup (backups/d1/<date>/ in R2) into a D1
// database. Companion to src/lib/d1-backup.ts; runbook in
// docs/disaster-recovery.md.
//
// Modes:
//   Fetch + restore from R2 (real bucket):
//     node scripts/restore-d1-backup.mjs --date 2026-07-06 --local
//   Restore from an already-downloaded directory:
//     node scripts/restore-d1-backup.mjs --dir ./backup-2026-07-06 --local
//   Production restore (deliberate friction — requires --remote --yes):
//     node scripts/restore-d1-backup.mjs --date 2026-07-06 --remote --yes
//
// Rows replay with INSERT OR REPLACE (idempotent; existing rows with
// the same PK are overwritten, rows created after the backup are NOT
// deleted). For a from-scratch rebuild pass --schema to apply the
// backup's schema.sql first. FTS/virtual-table content is not in the
// backup — rebuild via the admin rebuild endpoints after restoring
// (see runbook).

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { insertSql, rowsFromJsonlText } from './lib/d1-restore-core.mjs';

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error([
    'Usage:',
    '  node scripts/restore-d1-backup.mjs (--date YYYY-MM-DD | --dir <backup-dir>) [options]',
    '',
    'Options:',
    '  --date YYYY-MM-DD   Backup partition to fetch from R2 (backups/d1/<date>/)',
    '  --dir <path>        Use an already-downloaded backup directory (manifest.json inside)',
    '  --database <name>   D1 database name (default: medina-ventures-db)',
    '  --bucket <name>     R2 bucket for --date fetch (default: medina-ventures-storage)',
    '  --table <name>      Restore only this table (repeatable)',
    '  --schema            Apply the backup schema.sql before replaying rows',
    '  --local             Target local D1 (default)',
    '  --remote            Target the REAL production D1 — requires --yes',
    '  --yes               Confirm a --remote restore',
    '  --verify            After restore, compare per-table row counts to the manifest',
    '  --persist-to <dir>  Local-mode state directory (isolated drills against a fresh DB)',
    '  --keep-download     Keep the fetched backup directory instead of deleting it',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    database: 'medina-ventures-db',
    bucket: 'medina-ventures-storage',
    tables: [],
    remote: false,
    yes: false,
    schema: false,
    verify: false,
    keepDownload: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--date') out.date = argv[++i];
    else if (arg === '--dir') out.dir = argv[++i];
    else if (arg === '--database') out.database = argv[++i];
    else if (arg === '--bucket') out.bucket = argv[++i];
    else if (arg === '--table') out.tables.push(argv[++i]);
    else if (arg === '--schema') out.schema = true;
    else if (arg === '--local') out.remote = false;
    else if (arg === '--remote') out.remote = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg === '--verify') out.verify = true;
    else if (arg === '--persist-to') out.persistTo = argv[++i];
    else if (arg === '--keep-download') out.keepDownload = true;
    else usage(`Unknown argument: ${arg}`);
  }
  if (!out.date && !out.dir) usage('Provide --date or --dir');
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) usage(`--date must be YYYY-MM-DD, got: ${out.date}`);
  if (out.remote && !out.yes) usage('--remote restores production data; add --yes to confirm');
  if (out.remote && out.persistTo) usage('--persist-to only applies to --local targets');
  return out;
}

function runWrangler(args, { capture = false } = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    if (capture) console.error(result.stderr || result.stdout || '');
    throw new Error(`wrangler ${args.slice(0, 4).join(' ')}… failed (exit ${result.status})`);
  }
  return result;
}

async function fetchBackup(args) {
  const dir = await mkdtemp(join(tmpdir(), `d1-backup-${args.date}-`));
  const prefix = `backups/d1/${args.date}`;
  console.log(`Fetching ${prefix}/manifest.json from bucket ${args.bucket}…`);
  const manifestPath = join(dir, 'manifest.json');
  runWrangler(['r2', 'object', 'get', `${args.bucket}/${prefix}/manifest.json`, '--file', manifestPath, '--remote']);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const schemaKey = manifest.schema_key || `${prefix}/schema.sql`;
  runWrangler(['r2', 'object', 'get', `${args.bucket}/${schemaKey}`, '--file', join(dir, 'schema.sql'), '--remote']);

  await mkdir(join(dir, 'parts'), { recursive: true });
  const wantedTables = args.tables.length ? new Set(args.tables) : null;
  for (const table of manifest.tables) {
    if (wantedTables && !wantedTables.has(table.name)) continue;
    for (const part of table.parts) {
      const local = join(dir, 'parts', part.key.split('/').pop());
      runWrangler(['r2', 'object', 'get', `${args.bucket}/${part.key}`, '--file', local, '--remote']);
    }
  }
  return dir;
}

async function main() {
  const args = parseArgs(process.argv);
  const backupDir = args.dir ?? await fetchBackup(args);
  const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
  const target = args.remote ? '--remote' : '--local';
  // Isolated local drills: point wrangler's local D1 state at a scratch
  // directory so --schema restores land on a genuinely fresh database
  // instead of colliding with existing local dev state.
  const persistArgs = !args.remote && args.persistTo ? ['--persist-to', args.persistTo] : [];
  const wantedTables = args.tables.length ? new Set(args.tables) : null;

  console.log(`Backup: ${manifest.date} (${manifest.format}) — ${manifest.total_rows} rows across ${manifest.tables.length} tables`);
  console.log(`Consistency note: ${manifest.consistency}`);
  console.log(`Target: ${args.database} (${args.remote ? 'REMOTE/PRODUCTION' : 'local'})`);

  const workDir = await mkdtemp(join(tmpdir(), 'd1-restore-sql-'));
  let batchNo = 0;

  async function executeSqlStatements(statements) {
    if (statements.length === 0) return;
    const file = join(workDir, `restore-${String(++batchNo).padStart(5, '0')}.sql`);
    // No BEGIN/COMMIT wrapper: wrangler's d1 trimmer strips (or errors
    // on) those tokens client-side, so the wrapper never provided
    // atomicity — it only risked colliding with the trimmer. Batches
    // are idempotent (INSERT OR REPLACE), so a mid-batch failure is
    // safely re-runnable.
    await writeFile(file, statements.join('\n'));
    runWrangler(['d1', 'execute', args.database, '--file', file, target, ...persistArgs]);
  }

  try {
    if (args.schema) {
      const schemaPath = join(backupDir, 'schema.sql');
      if (!existsSync(schemaPath)) throw new Error(`--schema requested but ${schemaPath} is missing`);
      // schema.sql is plain CREATE statements: it expects an EMPTY
      // database (from-scratch rebuild). For local drills use
      // --persist-to with a fresh directory; on a non-empty target this
      // step fails with "table already exists" by design.
      console.log('Applying schema.sql…');
      runWrangler(['d1', 'execute', args.database, '--file', schemaPath, target, ...persistArgs]);
    }

    let restoredRows = 0;
    for (const table of manifest.tables) {
      if (wantedTables && !wantedTables.has(table.name)) continue;
      let tableRows = 0;
      let batch = [];
      for (const part of table.parts) {
        const partPath = join(backupDir, 'parts', part.key.split('/').pop());
        const text = await readFile(partPath, 'utf8');
        for (const row of rowsFromJsonlText(text)) {
          const sql = insertSql(table.name, row);
          if (!sql) continue;
          batch.push(sql);
          if (batch.length >= 200) {
            await executeSqlStatements(batch);
            tableRows += batch.length;
            batch = [];
          }
        }
      }
      await executeSqlStatements(batch);
      tableRows += batch.length;
      restoredRows += tableRows;
      console.log(`  ${table.name}: ${tableRows} rows replayed (manifest says ${table.rows})`);
    }
    console.log(`Restored ${restoredRows} rows.`);

    if (args.verify) {
      console.log('Verifying row counts against manifest…');
      let mismatches = 0;
      for (const table of manifest.tables) {
        if (wantedTables && !wantedTables.has(table.name)) continue;
        const result = runWrangler(
          ['d1', 'execute', args.database, '--command', `SELECT COUNT(*) AS cnt FROM "${table.name}"`, '--json', target, ...persistArgs],
          { capture: true }
        );
        const parsed = JSON.parse(result.stdout);
        const cnt = Number(parsed?.[0]?.results?.[0]?.cnt ?? NaN);
        const ok = cnt === table.rows;
        if (!ok) mismatches++;
        console.log(`  ${ok ? '✓' : '✗'} ${table.name}: db=${cnt} manifest=${table.rows}`);
      }
      if (mismatches > 0) {
        console.warn(`${mismatches} table(s) differ — expected when the target was not empty or has taken writes since the backup.`);
      }
    }

    const skipped = (manifest.skipped || []).filter(s => s.reason?.startsWith('virtual'));
    if (skipped.length) {
      console.log('\nNot in backup (rebuild after restore via admin rebuild endpoints):');
      for (const s of skipped) console.log(`  - ${s.name} (${s.reason})`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
    if (!args.dir && !args.keepDownload) await rm(backupDir, { recursive: true, force: true });
    else if (!args.dir) console.log(`Downloaded backup kept at: ${backupDir}`);
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
