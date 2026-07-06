// Thin Workflow shell around runD1Backup(). All backup logic lives in
// src/lib/d1-backup.ts (testable without cloudflare:workers); this class
// only adapts it to the Workflows runtime. Dispatched daily at 03:15 UTC
// by the minute-tick gate in handleScheduled (src/index.ts) with
// id `d1-backup-YYYY-MM-DD`; manually triggerable any time with
//   npx wrangler workflows trigger d1-backup-workflow --config wrangler.pipelines.toml
// See docs/disaster-recovery.md.

import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runD1Backup, type D1BackupParams } from '../lib/d1-backup';

export class D1BackupWorkflow extends WorkflowEntrypoint<Env, D1BackupParams> {
  async run(event: WorkflowEvent<D1BackupParams>, step: WorkflowStep): Promise<void> {
    const result = await runD1Backup(this.env, step, event?.payload ?? {});
    console.log(
      `[D1BackupWorkflow] completed prefix=${result.prefix} tables=${result.tables} rows=${result.rows} parts=${result.parts} retention_deleted=${result.retention.deleted_prefixes.length}`
    );
  }
}
