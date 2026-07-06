# Disaster recovery — D1 database

Two independent recovery lines. Reach for them in this order.

## Line 1: D1 Time Travel (point-in-time, ≤30 days)

Cloudflare D1 keeps 30 days of write history natively. For "we corrupted /
deleted data at time T" incidents this is the precise tool — restore the whole
database to any minute in the window:

```bash
# Find the bookmark closest to a timestamp
npx wrangler d1 time-travel info medina-ventures-db --timestamp "2026-07-05T14:00:00Z"

# Restore (destructive: rewinds the WHOLE database to that bookmark)
npx wrangler d1 time-travel restore medina-ventures-db --timestamp "2026-07-05T14:00:00Z"
```

Limits that motivate Line 2: Time Travel dies with the database (does not
survive database deletion or account compromise) and cannot reach past 30
days. It is also all-or-nothing — no per-table restore.

## Line 2: scheduled R2 exports (this repo's backup job)

`D1BackupWorkflow` (src/workflows/d1-backup.ts, logic in src/lib/d1-backup.ts)
exports every base table to R2 daily, dispatched from the minute-tick
scheduled handler on the **pipelines** Worker inside a 03:15–03:29 UTC window
(`handleScheduled`, src/index.ts — deliberately not a third cron trigger; a
4th trigger registration broke CF cron dispatch on 2026-04-28). The window
gives the dispatch up to 15 attempts against transient failures; the
date-keyed workflow instance id (`d1-backup-YYYY-MM-DD`, checked via `get()`
before `create()`) guarantees at most one backup per day.

Properties:

- **Read-only against D1.** The job never mutates schema or data — safe
  against the in-flight V2 overhaul's tables by construction.
- **Layout** (bucket `medina-ventures-storage`):
  ```
  backups/d1/<YYYY-MM-DD>/schema.sql          full DDL (tables, indexes, triggers, views, virtual tables)
  backups/d1/<YYYY-MM-DD>/parts/NNNN-<table>.jsonl   row data, one JSON object per line
  backups/d1/<YYYY-MM-DD>/manifest.json       completion marker — written only after every part landed
  backups/d1/latest.json                      pointer to the newest complete backup
  ```
- **What's excluded:** `sqlite_*` / `_cf_*` internals, and FTS5 virtual-table
  content + shadow tables (derived storage; the CREATE VIRTUAL TABLE statement
  IS in schema.sql, and content is rebuilt after restore — see step 4 below).
  The manifest's `skipped` array records every exclusion with a reason.
- **BLOBs** are preserved (tagged base64 in JSONL → `X'…'` literals on
  restore); raw `JSON.stringify` would have corrupted them.
- **Consistency:** per-table sequential snapshot, not point-in-time — writers
  may be active during the dump (the manifest carries this note). For precise
  point-in-time recovery inside 30 days use Time Travel; the exports cover
  catastrophe and long horizon.
- **Retention:** the newest 14 date partitions are kept; older partitions are
  deleted by the workflow's final step. Only date-shaped prefixes under
  `backups/d1/` are candidates — nothing else in the bucket is touched.
- **Observability:** each dispatch attempt writes a `task_runs` row
  (`d1_backup_dispatch`, idempotency-keyed per date+minute; once the day's
  instance exists, later window minutes close as `skipped`). The workflow
  instance id is the single-backup-per-day authority. Workflow progress:
  `npx wrangler workflows instances list d1-backup-workflow`.

Manual trigger (any time, e.g. before a risky migration):

```bash
npx wrangler workflows trigger d1-backup-workflow --config wrangler.pipelines.toml
# or with an explicit partition (a same-date re-run needs a fresh instance id):
#   the workflow accepts params {"date":"YYYY-MM-DD"}
```

## Restore runbook

`scripts/restore-d1-backup.mjs` replays a backup with `INSERT OR REPLACE`
(idempotent; rows created after the backup are NOT deleted — for a byte-clean
rebuild restore into a fresh database).

Known limitation (audit round 4, structural, deliberately unpatched): a
RE-RUN over already-restored data aborts loudly (UNIQUE constraint; no
corruption — batches are atomic per file locally) if a table's only
PK/UNIQUE key is itself an oversized (>~44KB) value. No current table can
hit this (all unique keys are short ids); it matters only if a future
schema puts huge values in unique columns. First restores into an empty
database are unaffected.

```bash
# 1. Drill (fresh, isolated local D1) — fetches from R2, rebuilds schema,
#    replays, verifies counts. --persist-to points wrangler's local state
#    at a scratch dir so the drill starts from a genuinely EMPTY database;
#    --schema expects an empty target (plain CREATE statements) and will
#    correctly fail with "table already exists" on a non-empty one.
node scripts/restore-d1-backup.mjs --date 2026-07-06 --local --schema --verify \
  --persist-to /tmp/d1-restore-drill

# 2. Single-table surgical restore (into existing local state):
node scripts/restore-d1-backup.mjs --date 2026-07-06 --local --table contacts

# 3. Production restore (deliberate friction):
node scripts/restore-d1-backup.mjs --date 2026-07-06 --remote --yes --verify
```

4. **Rebuild derived search state** (not part of the export): the FTS modules
   ship admin rebuild endpoints (`contact-search` / `company-search` house
   pattern — index-state sidecar + rebuild endpoint). Hit those after a
   restore, or let their drift-repair converge.

5. **Vectorize is not covered here.** Vector indexes are re-derivable from D1
   + R2 sources through the existing embed-backfill self-heal paths; expect
   them to reconverge after a restore rather than restoring them.

Legacy note: `scripts/restore-maintenance-snapshot.mjs` restores the
*maintenance* snapshots (`maintenance/d1/...`, taken before destructive
cleanup steps). Same JSONL shape, single-table, kept as-is.

## Post-deploy verification (owner checklist, first run)

1. Deploy pipelines (`npm run deploy:pipelines`).
2. Either wait for 03:15 UTC or trigger manually (command above).
3. Confirm `backups/d1/<today>/manifest.json` exists and `total_rows` looks
   sane; confirm the `d1_backup_dispatch` task_run row.
4. Run the local drill (restore runbook step 1) once and file the result.
5. ONCE, before ever relying on a `--remote` restore: run a supervised
   remote drill against a THROWAWAY D1 database (create a scratch DB,
   `--database <scratch> --remote --yes --verify`, then delete it).
   Rationale: `wrangler d1 execute --remote --file` uses a different
   transport than local (service-side import pipeline, no client-side
   statement splitting); the restore audits exercised the local path
   exhaustively but deliberately never wrote to remote resources.

## R2 ops report

`node scripts/r2-ops-report.mjs` — read-only report of lifecycle rules,
backup storage economics, and maintenance-snapshot accumulation (via the
`maintenance_runs` table; the CLI has no object listing). Run it before
deciding on the proposals below.

## Proposed (not implemented): R2 lifecycle & orphan hygiene

Flagged for a future pass, owner decision needed:

- **R2 lifecycle rules** on the bucket (dashboard/API, not wrangler.toml):
  e.g. abort incomplete multipart uploads after 7 days; optionally transition
  `backups/d1/` objects to Infrequent Access after ~30 days. Native lifecycle
  would also be a second, platform-level guard on backup retention.
- **Orphan sweep:** artifacts under `maintenance/d1/` accumulate forever
  (maintenance snapshots have no retention step of their own), and other
  prefixes hold objects for rows deleted from D1. A read-only audit script
  reporting orphan counts per prefix would make a cleanup decision
  evidence-based. Not built: any deletion policy should be an explicit owner
  call, and cleanup belongs decoupled from the backup path.
