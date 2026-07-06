#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';

function usage() {
  console.error([
    'Usage:',
    '  node scripts/restore-maintenance-snapshot.mjs --table <table> --file <snapshot.jsonl> [--database medina-ventures-db] [--remote]',
    '',
    'Notes:',
    '  Download the R2 JSONL snapshot chunk first, then replay it with this script.',
    '  Rows are restored with INSERT OR REPLACE in batches.',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  const out = { database: 'medina-ventures-db', remote: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remote') out.remote = true;
    else if (arg === '--table') out.table = argv[++i];
    else if (arg === '--file') out.file = argv[++i];
    else if (arg === '--database') out.database = argv[++i];
    else usage();
  }
  if (!out.table || !out.file) usage();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(out.table)) {
    throw new Error(`Unsafe table name: ${out.table}`);
  }
  return out;
}

// Literal encoding + statement generation now come from the shared
// restore core (hex-encoded text literals). This closes the same
// wrangler-trimmer hazard the full-backup restore had: a snapshot row
// whose text contains `BEGIN TRANSACTION`/`COMMIT;` used to abort (or
// silently mangle) the replay. See scripts/lib/d1-restore-core.mjs.
import { insertSql } from './lib/d1-restore-core.mjs';

async function* readJsonl(file) {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const dir = await mkdtemp(join(tmpdir(), 'd1-restore-'));
  let batch = [];
  let restored = 0;
  let batchNo = 0;

  async function flush() {
    if (batch.length === 0) return;
    const file = join(dir, `restore-${String(++batchNo).padStart(4, '0')}.sql`);
    // No BEGIN/COMMIT wrapper — wrangler's d1 trimmer strips it anyway
    // (never atomic) and errors when the tokens also appear in data.
    await writeFile(file, batch.join('\n'));
    const cmdArgs = ['wrangler', 'd1', 'execute', args.database, '--file', file];
    if (args.remote) cmdArgs.push('--remote');
    const result = spawnSync('npx', cmdArgs, { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`wrangler d1 execute failed for ${file}`);
    }
    restored += batch.length;
    batch = [];
  }

  try {
    for await (const row of readJsonl(args.file)) {
      const sql = insertSql(args.table, row);
      if (!sql) continue;
      batch.push(sql);
      if (batch.length >= 200) await flush();
    }
    await flush();
    console.log(`Restored ${restored} rows into ${args.table}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
