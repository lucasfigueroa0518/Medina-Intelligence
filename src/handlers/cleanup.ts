// Wave 3 cleanup endpoints — owner-only, idempotent, batchable.
//
// Drains the pollution from two root-cause bugs that were active for ~24h:
//   1. webhook handler embed-before-stage (~71k dangling vectors)
//   2. concurrent-backfill FK race in stageAndCommitApprovals (~391 dangling
//      email_attachment docs + ~145 dangling deal signals)
//
// After Terminal 4 + 5 fixes ship, no new pollution. These endpoints do a
// one-time pass over what's already polluted. Phase order: 1 → 2 → 3 → 4 → 5.
// All endpoints are admin-only (owner role) and idempotent — safe to re-run
// at any phase if a partial failure occurs. Stop conditions are baked in
// (rows_remaining=0).

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';

function requireOwner(ctx: AuthContext): Response | null {
  if (ctx.userRole !== 'owner') return errorResponse('FORBIDDEN', 403, 'owner role required');
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Approved deal-signal evidence preservation
// ────────────────────────────────────────────────────────────────────────────
//
// For each of the ~11 approved dangling signals, find the deal that was
// created when the signal was approved (matched by company_id + closest
// created_at to resolved_at) and append the evidence text to deals.notes.
// Idempotent via prefix substring check. Unmigratable rows (no matching
// deal) are stashed in _cleanup_orphaned_evidence for manual review BEFORE
// Phase 2b deletes the approval_queue rows.
//
// POST /api/admin/cleanup-evidence-preservation
// Returns { rows_remaining, migrated, already_migrated, stashed_orphan, errors }
//   rows_remaining = 0 means "every approved signal has either been
//                          migrated or stashed". Phase 2b is then safe.
export async function cleanupEvidencePreservation(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const forbidden = requireOwner(ctx);
  if (forbidden) return forbidden;

  // Idempotent: side table for unmatchable evidence so we never lose human-
  // approved deal text just because the matching deal moved.
  await env.D1.prepare(
    `CREATE TABLE IF NOT EXISTS _cleanup_orphaned_evidence (
       approval_queue_id TEXT PRIMARY KEY,
       proposed_value_json TEXT,
       resolved_at TEXT,
       resolved_by TEXT,
       reason TEXT,
       staged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`
  ).run();

  const signals = await env.D1.prepare(
    `SELECT id, source_communication_id, proposed_value, resolved_at, resolved_by
       FROM approval_queue
      WHERE change_type = 'create_deal'
        AND status = 'approved'
        AND source_communication_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversations c WHERE c.id = source_communication_id
        )`
  ).all<{
    id: string;
    source_communication_id: string;
    proposed_value: string;
    resolved_at: string | null;
    resolved_by: string | null;
  }>();

  let migrated = 0;
  let already_migrated = 0;
  let stashed_orphan = 0;
  const errors: Array<{ approval_queue_id: string; phase: string; error: string }> = [];

  for (const sig of signals.results) {
    try {
      let proposed: any;
      try {
        proposed = JSON.parse(sig.proposed_value);
      } catch (e: any) {
        errors.push({ approval_queue_id: sig.id, phase: 'parse', error: `bad JSON: ${e?.message || e}` });
        continue;
      }
      const evidence = (proposed?.evidence ?? '').toString();
      const companyId = (proposed?.company_id ?? '').toString();
      if (!evidence || !companyId) {
        await stashOrphan(env, sig, 'missing evidence or company_id in proposed_value');
        stashed_orphan += 1;
        continue;
      }

      // Closest deal by created_at to resolved_at (deal creation typically
      // happens within seconds of approval). Falls back to most-recent deal
      // for the company if resolved_at is null.
      const resolvedAt = sig.resolved_at || new Date().toISOString();
      const deal = await env.D1.prepare(
        `SELECT id, notes FROM deals
           WHERE company_id = ? AND deleted_at IS NULL
           ORDER BY ABS(julianday(created_at) - julianday(?)) ASC
           LIMIT 1`
      ).bind(companyId, resolvedAt).first<{ id: string; notes: string | null }>();

      if (!deal) {
        await stashOrphan(env, sig, `no deal found for company_id=${companyId}`);
        stashed_orphan += 1;
        continue;
      }

      // Idempotency: prefix-match on the first 80 chars of the evidence text
      // catches re-runs cleanly. We don't compare exact bodies since notes
      // may have other content appended around our migration block.
      const evidencePrefix = evidence.slice(0, 80);
      const existingNotes = deal.notes || '';
      if (existingNotes.includes(evidencePrefix)) {
        already_migrated += 1;
        continue;
      }

      const block =
        `[migrated from approval_queue ${sig.id} at ${resolvedAt}]\n${evidence}`;
      const newNotes = existingNotes
        ? `${existingNotes}\n\n---\n\n${block}`
        : block;

      await env.D1.prepare(
        `UPDATE deals
            SET notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(newNotes, deal.id).run();
      migrated += 1;
    } catch (e: any) {
      errors.push({ approval_queue_id: sig.id, phase: 'migrate', error: e?.message || String(e) });
    }
  }

  // rows_remaining = how many approved-dangling signals are NOT yet either
  // migrated (deals.notes contains prefix) or stashed in orphaned_evidence.
  // After a successful run, this should be 0.
  const remainingRow = await env.D1.prepare(
    `SELECT COUNT(*) as n FROM approval_queue aq
       WHERE aq.change_type = 'create_deal'
         AND aq.status = 'approved'
         AND aq.source_communication_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = aq.source_communication_id)
         AND NOT EXISTS (SELECT 1 FROM _cleanup_orphaned_evidence oe WHERE oe.approval_queue_id = aq.id)
         AND NOT EXISTS (
           SELECT 1 FROM deals d
            WHERE d.company_id = json_extract(aq.proposed_value, '$.company_id')
              AND COALESCE(d.notes,'') LIKE '%' || substr(json_extract(aq.proposed_value, '$.evidence'), 1, 80) || '%'
         )`
  ).first<{ n: number }>();

  return jsonResponse({
    phase: 'evidence-preservation',
    rows_remaining: remainingRow?.n ?? 0,
    batch_processed: signals.results.length,
    migrated,
    already_migrated,
    stashed_orphan,
    errors,
  });
}

async function stashOrphan(
  env: Env,
  sig: { id: string; proposed_value: string; resolved_at: string | null; resolved_by: string | null },
  reason: string
): Promise<void> {
  await env.D1.prepare(
    `INSERT OR IGNORE INTO _cleanup_orphaned_evidence
       (approval_queue_id, proposed_value_json, resolved_at, resolved_by, reason)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(sig.id, sig.proposed_value, sig.resolved_at, sig.resolved_by, reason).run();
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 2 — D1 cleanup (single-shot, sequential, internal chunking)
// ────────────────────────────────────────────────────────────────────────────
//
// Runs sub-steps 2a → 2e in dependency order:
//   2a  UPDATE stuck `progressive-backfill-window` sync_jobs to 'failed'
//   2b  DELETE dangling approval_queue deal-signal rows
//   2c  CREATE + STAGE _cleanup_dangling_vectors (cursor table for Phase 3)
//   2d  DELETE document_links + embed_retry_queue rows pointing at dangling docs
//   2e  Loop DELETE from vector_entity_index (chunked at 1000)
//
// Idempotent at every step. Re-running picks up wherever a previous run
// stopped. The only step that mutates is 2c if you want to re-stage vectors
// added since the prior run — INSERT OR IGNORE makes that safe.
//
// Phase 1 must run before Phase 2b (so the approval_queue rows aren't
// deleted before their evidence is preserved).
//
// POST /api/admin/cleanup-d1-phase2
// Returns { phase: '2', sub_steps: { 2a..2e: stats }, rows_remaining }
export async function cleanupD1Phase2(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const forbidden = requireOwner(ctx);
  if (forbidden) return forbidden;

  const stats: Record<string, any> = {};

  // 2a — stuck sync_jobs
  {
    const r = await env.D1.prepare(
      `UPDATE sync_jobs
          SET status = 'failed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              error_message = 'orphaned by Worker eviction or unhandled throw — closeSyncJob never fired'
        WHERE workflow_type = 'progressive-backfill-window'
          AND status = 'running'
          AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')`
    ).run();
    stats['2a_stuck_sync_jobs_marked_failed'] = r.meta.changes ?? 0;
  }

  // 2b — dangling approval_queue (Phase 1 must have stashed/migrated first)
  {
    const r = await env.D1.prepare(
      `DELETE FROM approval_queue
        WHERE change_type = 'create_deal'
          AND status IN ('pending','approved')
          AND source_communication_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = source_communication_id)`
    ).run();
    stats['2b_approval_queue_deleted'] = r.meta.changes ?? 0;
  }

  // 2c — staging table + INSERT dangling vector_ids
  await env.D1.prepare(
    `CREATE TABLE IF NOT EXISTS _cleanup_dangling_vectors (
       vector_id TEXT PRIMARY KEY,
       source_table TEXT NOT NULL,
       staged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       vectorize_deleted INTEGER NOT NULL DEFAULT 0
     )`
  ).run();
  {
    const r1 = await env.D1.prepare(
      `INSERT OR IGNORE INTO _cleanup_dangling_vectors (vector_id, source_table)
       SELECT vector_id, 'conversations' FROM vector_entity_index vei
        WHERE vei.org_id = 'medina-ventures'
          AND vei.source_table = 'conversations'
          AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = vei.entity_id)`
    ).run();
    const r2 = await env.D1.prepare(
      `INSERT OR IGNORE INTO _cleanup_dangling_vectors (vector_id, source_table)
       SELECT vector_id, 'documents' FROM vector_entity_index vei
        WHERE vei.org_id = 'medina-ventures'
          AND vei.source_table = 'documents'
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = vei.entity_id AND d.deleted_at IS NULL)`
    ).run();
    stats['2c_vectors_staged_conversations'] = r1.meta.changes ?? 0;
    stats['2c_vectors_staged_documents'] = r2.meta.changes ?? 0;
  }

  // 2d — satellite cleanup for dangling docs (run BEFORE 2e and BEFORE Phase 4
  //      so document_links / embed_retry_queue don't reference soon-deleted rows)
  {
    const r1 = await env.D1.prepare(
      `DELETE FROM document_links
        WHERE document_id IN (
          SELECT d.id FROM documents d
           WHERE d.source = 'email_attachment'
             AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = d.conversation_id)
        )`
    ).run();
    const r2 = await env.D1.prepare(
      `DELETE FROM embed_retry_queue
        WHERE source_table = 'documents'
          AND entity_id IN (
            SELECT d.id FROM documents d
             WHERE d.source = 'email_attachment'
               AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = d.conversation_id)
          )`
    ).run();
    stats['2d_document_links_deleted'] = r1.meta.changes ?? 0;
    stats['2d_embed_retry_queue_deleted'] = r2.meta.changes ?? 0;
  }

  // 2e — chunked DELETE FROM vector_entity_index until changes=0.
  //      Each iteration evaluates NOT EXISTS afresh, so a concurrent insert
  //      (which shouldn't happen post-Terminal-4-fix) wouldn't be touched.
  const CHUNK_SIZE = 1000;
  const MAX_ITERATIONS = 200; // safety cap (200k rows max)
  let total_vei_deleted = 0;
  let iter = 0;
  while (iter < MAX_ITERATIONS) {
    iter += 1;
    const r = await env.D1.prepare(
      `DELETE FROM vector_entity_index
        WHERE rowid IN (
          SELECT rowid FROM vector_entity_index vei
           WHERE vei.org_id = 'medina-ventures'
             AND (
               (vei.source_table = 'conversations'
                AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = vei.entity_id))
               OR
               (vei.source_table = 'documents'
                AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = vei.entity_id AND d.deleted_at IS NULL))
             )
           LIMIT ?
        )`
    ).bind(CHUNK_SIZE).run();
    const changed = r.meta.changes ?? 0;
    total_vei_deleted += changed;
    if (changed === 0) break;
  }
  stats['2e_vector_entity_index_deleted'] = total_vei_deleted;
  stats['2e_iterations'] = iter;

  // Verification — these counters should all be 0 after a clean run
  const verify = await env.D1.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sync_jobs WHERE workflow_type='progressive-backfill-window' AND status='running' AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')) as stuck_jobs_remaining,
       (SELECT COUNT(*) FROM approval_queue aq WHERE aq.change_type='create_deal' AND aq.status IN ('pending','approved') AND aq.source_communication_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = aq.source_communication_id)) as dangling_approvals_remaining,
       (SELECT COUNT(*) FROM vector_entity_index vei WHERE vei.org_id='medina-ventures' AND vei.source_table='conversations' AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = vei.entity_id)) as dangling_conv_vectors_remaining,
       (SELECT COUNT(*) FROM vector_entity_index vei WHERE vei.org_id='medina-ventures' AND vei.source_table='documents' AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = vei.entity_id AND d.deleted_at IS NULL)) as dangling_doc_vectors_remaining`
  ).first<{
    stuck_jobs_remaining: number;
    dangling_approvals_remaining: number;
    dangling_conv_vectors_remaining: number;
    dangling_doc_vectors_remaining: number;
  }>();

  return jsonResponse({
    phase: '2',
    sub_steps: stats,
    rows_remaining: verify,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Vectorize cleanup (batched)
// ────────────────────────────────────────────────────────────────────────────
//
// Reads vector_ids from _cleanup_dangling_vectors WHERE vectorize_deleted=0,
// up to batch_size, calls env.VECTORIZE.deleteByIds(batch), marks the staging
// rows as deleted. Caller loops until rows_remaining=0.
//
// POST /api/admin/cleanup-dangling-vectors-batch
//   Body: { batch_size?: number }  default 50, capped at 200
// Returns { rows_remaining, batch_processed, race_skipped, errors[] }
export async function cleanupDanglingVectorsBatch(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const forbidden = requireOwner(ctx);
  if (forbidden) return forbidden;

  const body = await parseJsonBody<{ batch_size?: number }>(request) || {};
  const batchSize = Math.min(Math.max(1, body.batch_size || 50), 200);

  const errors: Array<{ phase: string; error: string }> = [];
  let batch_processed = 0;
  let race_skipped = 0;

  // Pull a batch of vector_ids that haven't been deleted from Vectorize yet.
  const candidates = await env.D1.prepare(
    `SELECT vector_id FROM _cleanup_dangling_vectors
      WHERE vectorize_deleted = 0
      LIMIT ?`
  ).bind(batchSize).all<{ vector_id: string }>();

  if (candidates.results.length === 0) {
    return jsonResponse({
      phase: '3',
      rows_remaining: 0,
      batch_processed: 0,
      race_skipped: 0,
      errors: [],
    });
  }

  const candidateIds = candidates.results.map(r => r.vector_id);

  // Race-safety pre-check: if any vector_id has reappeared in
  // vector_entity_index since staging (Terminal-4 fix landing + new ingestion
  // wrote a fresh row), skip the Vectorize delete for it but still mark our
  // staging row done so the loop terminates. UUID collision probability is
  // essentially zero, but the cost of this check is one D1 round-trip per
  // batch and the safety value is real.
  const placeholders = candidateIds.map(() => '?').join(',');
  const liveCheck = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index WHERE vector_id IN (${placeholders})`
  ).bind(...candidateIds).all<{ vector_id: string }>();
  const liveSet = new Set(liveCheck.results.map(r => r.vector_id));
  const safeBatch = candidateIds.filter(v => !liveSet.has(v));
  race_skipped = candidateIds.length - safeBatch.length;

  if (safeBatch.length > 0) {
    try {
      await env.VECTORIZE.deleteByIds(safeBatch);
      batch_processed = safeBatch.length;
    } catch (e: any) {
      errors.push({ phase: 'vectorize-delete', error: e?.message || String(e) });
    }
  }

  // Mark BOTH safe-deleted and race-skipped rows as vectorize_deleted=1.
  // Race-skipped rows shouldn't be retried (the Vectorize entry, if any,
  // now belongs to a legitimate VEI row).
  if (errors.length === 0 && candidateIds.length > 0) {
    const updPlaceholders = candidateIds.map(() => '?').join(',');
    await env.D1.prepare(
      `UPDATE _cleanup_dangling_vectors
          SET vectorize_deleted = 1
        WHERE vector_id IN (${updPlaceholders})`
    ).bind(...candidateIds).run();
  }

  const remainingRow = await env.D1.prepare(
    `SELECT COUNT(*) as n FROM _cleanup_dangling_vectors WHERE vectorize_deleted = 0`
  ).first<{ n: number }>();

  return jsonResponse({
    phase: '3',
    rows_remaining: remainingRow?.n ?? 0,
    batch_processed,
    race_skipped,
    errors,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Documents D1 + R2 cleanup (batched)
// ────────────────────────────────────────────────────────────────────────────
//
// Selects up to batch_size dangling email_attachment docs, deletes their R2
// objects (idempotent — missing key = no-op), then deletes the D1 rows.
// Caller loops until rows_remaining=0.
//
// Phase 2d must have run first so document_links + embed_retry_queue widows
// don't survive the doc deletion.
//
// POST /api/admin/cleanup-dangling-docs-batch
//   Body: { batch_size?: number }  default 100, capped at 200
// Returns { rows_remaining, batch_processed, r2_deleted, r2_failed, errors[] }
export async function cleanupDanglingDocsBatch(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const forbidden = requireOwner(ctx);
  if (forbidden) return forbidden;

  const body = await parseJsonBody<{ batch_size?: number }>(request) || {};
  const batchSize = Math.min(Math.max(1, body.batch_size || 100), 200);

  const errors: Array<{ doc_id: string; phase: string; error: string }> = [];

  const rows = await env.D1.prepare(
    `SELECT id, r2_key FROM documents d
      WHERE d.source = 'email_attachment'
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = d.conversation_id)
      LIMIT ?`
  ).bind(batchSize).all<{ id: string; r2_key: string }>();

  if (rows.results.length === 0) {
    return jsonResponse({
      phase: '4',
      rows_remaining: 0,
      batch_processed: 0,
      r2_deleted: 0,
      r2_failed: 0,
      errors: [],
    });
  }

  // Delete R2 objects first. R2.delete is idempotent on missing keys, so
  // re-running the loop after a partial failure is safe — keys already
  // deleted just no-op.
  let r2_deleted = 0;
  let r2_failed = 0;
  for (const row of rows.results) {
    if (!row.r2_key) {
      // Skipped placeholder rows (oversize attachments) had empty r2_key;
      // skip the R2 delete for those.
      continue;
    }
    try {
      await env.R2.delete(row.r2_key);
      r2_deleted += 1;
    } catch (e: any) {
      r2_failed += 1;
      errors.push({ doc_id: row.id, phase: 'r2-delete', error: e?.message || String(e) });
    }
  }

  // Then hard-delete the D1 rows. We don't soft-delete because these rows
  // reference non-existent conversations — they have no provenance to
  // preserve and would only confuse future JOINs.
  const ids = rows.results.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const r = await env.D1.prepare(
    `DELETE FROM documents WHERE id IN (${placeholders})`
  ).bind(...ids).run();
  const d1_deleted = r.meta.changes ?? 0;

  const remainingRow = await env.D1.prepare(
    `SELECT COUNT(*) as n FROM documents d
       WHERE d.source = 'email_attachment'
         AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = d.conversation_id)`
  ).first<{ n: number }>();

  return jsonResponse({
    phase: '4',
    rows_remaining: remainingRow?.n ?? 0,
    batch_processed: d1_deleted,
    r2_deleted,
    r2_failed,
    errors,
  });
}
