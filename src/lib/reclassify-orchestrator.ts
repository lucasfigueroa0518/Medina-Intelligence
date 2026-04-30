// Wave 5 Phase D — reclassify-existing-documents orchestrator.
//
// Re-runs extraction + classification on documents that landed in the
// pre-Phase-A silent-fail class ('completed' rows with empty preview, all
// stamped 'other') OR that match a caller-supplied filter. Whole point:
// re-fetch from R2 and re-run the new (unpdf-backed) extractor — DO NOT
// trust preExtractedText anywhere in this loop. That shortcut existed in
// the ingest-time pipelines for cost reasons but is exactly what we're
// trying to fix here.
//
// Loop pattern matches src/handlers/admin.ts:1437 backfillAttachments —
// caller-polled, batched, returns rows_remaining for the caller to decide
// when to stop. Cloudflare subrequest cap = 50/request → batch_size capped
// at 10 (memory: classify-batch must stay ≤10 items/step).
//
// Per-row safety:
//   - skip rows with processing_status='excluded' (Phase B denylist) — no
//     point re-extracting an .ics file
//   - re-fetch from R2 every time; never trust preExtractedText
//   - extraction throw → mark 'failed' + error_message, skip classify
//   - dry_run mode returns BEFORE/AFTER for ALL items (not first 5) so
//     Lucas's 20-sample validation gate has the data it needs before
//     unlocking the full drain

import type { Env } from '../types/env';
import { extractTextFromFile } from './file-extraction';
import { classifyDocument } from './document-intelligence';
import { classifyByFilename } from './document-filename-classifier';

interface ReclassifyRow {
  id: string;
  r2_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  document_type: string;
  extracted_text_preview: string | null;
}

export interface ReclassifyChange {
  id: string;
  old_type: string;
  new_type: string;
  file_name: string;
  preview_excerpt: string;  // first 120 chars of new extracted text
  source: 'cheap' | 'llm' | 'unchanged';
}

export interface ReclassifyResult {
  rows_processed: number;
  rows_reclassified: number;
  rows_unchanged: number;
  rows_failed: number;
  errors: { document_id: string; error: string }[];
  sample_changes: ReclassifyChange[];
}

interface BatchOpts {
  orgId: string;
  batchSize: number;
  concurrency: number;
  documentTypeFilter: string;
  mimeTypeFilter?: string;
  dryRun: boolean;
  // Wave 5.5: optional explicit ID targeting. When provided, the orchestrator
  // processes ONLY these IDs (still gated on org_id + deleted_at + non-excluded
  // for safety) and ignores documentTypeFilter / mimeTypeFilter — the caller
  // is asserting "I want to see what the pipeline does with THESE docs."
  // Use case: 20-sample validation gate with deterministic axis coverage,
  // post-incident spot-checks, MARTy-citation re-runs.
  documentIds?: string[];
}

export async function countReclassifyCandidates(
  orgId: string,
  documentTypeFilter: string,
  mimeTypeFilter: string | undefined,
  env: Env
): Promise<number> {
  let sql = `SELECT COUNT(*) as cnt FROM documents
              WHERE org_id = ? AND deleted_at IS NULL
                AND processing_status != 'excluded'
                AND document_type = ?`;
  const binds: unknown[] = [orgId, documentTypeFilter];
  if (mimeTypeFilter) {
    sql += ` AND mime_type LIKE ?`;
    binds.push(`${mimeTypeFilter}%`);
  }
  const row = await env.D1.prepare(sql).bind(...binds).first<{ cnt: number }>();
  return row?.cnt || 0;
}

async function pickBatch(
  opts: BatchOpts,
  env: Env
): Promise<ReclassifyRow[]> {
  // Wave 5.5: explicit ID-targeting branch. Bypasses document_type +
  // mime_type predicates so callers can validate or spot-check arbitrary
  // rows regardless of their current category. The org_id +
  // deleted_at + non-excluded predicates remain (safety floor).
  if (opts.documentIds && opts.documentIds.length > 0) {
    const placeholders = opts.documentIds.map(() => '?').join(',');
    const sql = `SELECT id, r2_key, file_name, mime_type, document_type, extracted_text_preview
                   FROM documents
                  WHERE org_id = ? AND deleted_at IS NULL
                    AND processing_status != 'excluded'
                    AND id IN (${placeholders})
                  ORDER BY id ASC
                  LIMIT ?`;
    const result = await env.D1.prepare(sql)
      .bind(opts.orgId, ...opts.documentIds, opts.batchSize)
      .all<ReclassifyRow>();
    return result.results || [];
  }

  let sql = `SELECT id, r2_key, file_name, mime_type, document_type, extracted_text_preview
               FROM documents
              WHERE org_id = ? AND deleted_at IS NULL
                AND processing_status != 'excluded'
                AND document_type = ?`;
  const binds: unknown[] = [opts.orgId, opts.documentTypeFilter];
  if (opts.mimeTypeFilter) {
    sql += ` AND mime_type LIKE ?`;
    binds.push(`${opts.mimeTypeFilter}%`);
  }
  sql += ` ORDER BY created_at ASC LIMIT ?`;
  binds.push(opts.batchSize);
  const result = await env.D1.prepare(sql).bind(...binds).all<ReclassifyRow>();
  return result.results || [];
}

export async function runReclassifyBatch(opts: BatchOpts, env: Env): Promise<ReclassifyResult> {
  const rows = await pickBatch(opts, env);
  const result: ReclassifyResult = {
    rows_processed: 0,
    rows_reclassified: 0,
    rows_unchanged: 0,
    rows_failed: 0,
    errors: [],
    sample_changes: [],
  };

  // Process in chunks of `concurrency` — keeps subrequest fan-out bounded.
  for (let i = 0; i < rows.length; i += opts.concurrency) {
    const chunk = rows.slice(i, i + opts.concurrency);
    const chunkResults = await Promise.all(chunk.map(row => processRow(row, opts, env)));
    for (const r of chunkResults) {
      result.rows_processed++;
      if (r.error) {
        result.rows_failed++;
        result.errors.push({ document_id: r.id, error: r.error });
        continue;
      }
      if (!r.change) continue;
      if (r.change.old_type !== r.change.new_type) result.rows_reclassified++;
      else result.rows_unchanged++;
      // dry_run → all changes; live → first 5 only (tail logs carry the rest)
      if (opts.dryRun || result.sample_changes.length < 5) {
        result.sample_changes.push(r.change);
      }
    }
  }
  return result;
}

interface RowResult {
  id: string;
  error?: string;
  change?: ReclassifyChange;
}

async function processRow(row: ReclassifyRow, opts: BatchOpts, env: Env): Promise<RowResult> {
  if (!row.r2_key) {
    if (!opts.dryRun) {
      await env.D1.prepare(
        `UPDATE documents
            SET processing_status = 'failed',
                error_message = 'r2_key missing on reclassify',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(row.id).run().catch(() => {});
    }
    return { id: row.id, error: 'r2_key missing' };
  }

  // Re-fetch from R2 — never trust preExtractedText (Phase A pin).
  const obj = await env.R2.get(row.r2_key);
  if (!obj) {
    if (!opts.dryRun) {
      await env.D1.prepare(
        `UPDATE documents
            SET processing_status = 'failed',
                error_message = 'r2 object missing on reclassify',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(row.id).run().catch(() => {});
    }
    return { id: row.id, error: 'r2 object missing' };
  }
  const buffer = await obj.arrayBuffer();
  const file = new File([buffer], row.file_name || 'document', { type: row.mime_type || '' });

  // Extract — Phase A re-throws on parser failure.
  let text: string;
  try {
    text = await extractTextFromFile(file);
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    if (!opts.dryRun) {
      await env.D1.prepare(
        `UPDATE documents
            SET processing_status = 'failed',
                error_message = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(msg, row.id).run().catch(() => {});
    }
    return { id: row.id, error: `extract: ${msg}` };
  }

  // Classify — Phase C cheap-then-LLM three-tier disposition.
  const cheap = classifyByFilename(row.file_name);
  let newType: string;
  let source: ReclassifyChange['source'];
  if (cheap?.confidence === 'high') {
    newType = cheap.category;
    source = 'cheap';
  } else if (text.length > 20) {
    try {
      const cls = await classifyDocument(text, row.file_name || 'document', env, opts.orgId, cheap);
      newType = cls.category;
      source = 'llm';
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      return { id: row.id, error: `classify: ${msg}` };
    }
  } else if (cheap?.confidence === 'medium') {
    newType = cheap.category;
    source = 'cheap';
  } else {
    // No usable text + no cheap match → bucket as 'reference' (the LLM
    // classifier's own explicit fallback per document-intelligence.ts:
    // "anything else"). Pre-Wave-5.6.D this kept the row as 'other',
    // which left it in the reclassify queue forever — orchestrator picks
    // by document_type='other' so unchanged rows would reappear every
    // batch. Tagging 'reference' drains the queue while preserving the
    // semantic ("we couldn't determine, here's the safety-net category").
    // Skip if doc was already 'reference' — leave as-is.
    newType = row.document_type === 'reference' ? row.document_type : 'reference';
    source = 'unchanged';
  }

  const preview = text.slice(0, 500);
  const change: ReclassifyChange = {
    id: row.id,
    old_type: row.document_type,
    new_type: newType,
    file_name: row.file_name || '',
    preview_excerpt: preview.slice(0, 120),
    source,
  };

  if (!opts.dryRun) {
    await env.D1.prepare(
      `UPDATE documents
          SET document_type = ?,
              extracted_text_preview = ?,
              processing_status = 'completed',
              error_message = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(newType, preview, row.id).run();
  }

  return { id: row.id, change };
}
