import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { enqueueIngestionTreatment, type IngestionTreatmentSourceTable } from '../lib/ingestion-treatment';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';

const SOURCE_TABLES: IngestionTreatmentSourceTable[] = [
  'conversations',
  'events',
  'documents',
  'news_articles',
];

interface RepairBody {
  source_tables?: IngestionTreatmentSourceTable[];
  start_date?: string;
  end_date?: string;
  dry_run?: boolean;
  limit?: number;
  confirm?: string;
}

function sixMonthsAgo(): string {
  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0
  ));
  start.setUTCMonth(start.getUTCMonth() - 6);
  return start.toISOString();
}

function validTables(input: unknown): IngestionTreatmentSourceTable[] {
  if (!Array.isArray(input) || input.length === 0) return SOURCE_TABLES;
  return input.filter((table): table is IngestionTreatmentSourceTable =>
    SOURCE_TABLES.includes(table as IngestionTreatmentSourceTable)
  );
}

function tableDatePredicate(table: IngestionTreatmentSourceTable): { column: string; kind: string } {
  if (table === 'conversations') return { column: 'sent_at', kind: 'conversation' };
  if (table === 'events') return { column: 'start_time', kind: 'event' };
  if (table === 'documents') return { column: 'created_at', kind: 'document' };
  return { column: 'COALESCE(published_at, created_at)', kind: 'news' };
}

function sourceWhere(table: IngestionTreatmentSourceTable): string {
  if (table === 'events') return 'deleted_at IS NULL';
  if (table === 'documents') return "deleted_at IS NULL AND processing_status = 'completed'";
  return '1=1';
}

async function coverageForTable(
  env: Env,
  orgId: string,
  table: IngestionTreatmentSourceTable,
  startDate: string,
  endDate: string
): Promise<Record<string, unknown>> {
  const { column } = tableDatePredicate(table);
  const where = sourceWhere(table);
  const row = await env.D1.prepare(
    `WITH src AS (
       SELECT id
         FROM ${table}
        WHERE org_id = ?
          AND ${where}
          AND ${column} >= ?
          AND ${column} <= ?
     )
     SELECT
       COUNT(*) AS source_rows,
       SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END) AS with_receipt,
       SUM(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END) AS missing_receipt,
       SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN r.status = 'partial' THEN 1 ELSE 0 END) AS partial,
       SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN r.prospect_status LIKE 'queued%' OR r.prospect_status = 'present' THEN 1 ELSE 0 END) AS prospect_routed,
       SUM(CASE WHEN r.deal_status LIKE 'queued%' OR r.deal_status = 'present' THEN 1 ELSE 0 END) AS deal_routed,
       SUM(CASE WHEN r.contact_enrichment_status LIKE 'queued%' THEN 1 ELSE 0 END) AS contact_enrichment_routed,
       SUM(CASE WHEN r.company_enrichment_status LIKE 'queued%' THEN 1 ELSE 0 END) AS company_enrichment_routed,
       SUM(CASE WHEN r.embedding_status IN ('present','queued','queued_existing') THEN 1 ELSE 0 END) AS embedding_routed,
       SUM(CASE WHEN r.rag_status IN ('enqueued','queued','already_queued','queued_existing') THEN 1 ELSE 0 END) AS rag_routed
      FROM src
      LEFT JOIN ingestion_treatment_receipts r
        ON r.org_id = ?
       AND r.source_table = ?
       AND r.source_id = src.id`
  ).bind(orgId, startDate, endDate, orgId, table).first<Record<string, unknown>>();
  return { source_table: table, ...(row || {}) };
}

export async function handleIngestionTreatmentCoverage(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can view ingestion treatment coverage.');
  }
  const url = new URL(request.url);
  const monthsRaw = Number(url.searchParams.get('months') || '6');
  const months = Number.isFinite(monthsRaw) ? Math.max(1, Math.min(24, Math.floor(monthsRaw))) : 6;
  const endDate = new Date().toISOString();
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - months);
  const startDate = url.searchParams.get('start_date') || start.toISOString() || sixMonthsAgo();
  const requestedTable = url.searchParams.get('source_table');
  const tables = requestedTable && SOURCE_TABLES.includes(requestedTable as IngestionTreatmentSourceTable)
    ? [requestedTable as IngestionTreatmentSourceTable]
    : SOURCE_TABLES;

  const bySource = [];
  for (const table of tables) {
    bySource.push(await coverageForTable(env, ctx.orgId, table, startDate, endDate));
  }

  const activeWork = await env.D1.prepare(
    `SELECT domain, status, COUNT(*) AS count
       FROM work_queue
      WHERE org_id = ?
        AND domain IN ('ingestion_treatment','prospect_detect','deal_evidence_detect','embed_retry','rag_reindex_v2','contact_enrichment','company_enrichment')
        AND status IN ('pending','in_progress','failed','dead_letter')
      GROUP BY domain, status
      ORDER BY domain, status`
  ).bind(ctx.orgId).all<{ domain: string; status: string; count: number }>();

  return jsonResponse({
    org_id: ctx.orgId,
    start_date: startDate,
    end_date: endDate,
    by_source: bySource,
    active_work: activeWork.results,
  });
}

async function repairRowsForTable(
  env: Env,
  orgId: string,
  table: IngestionTreatmentSourceTable,
  startDate: string,
  endDate: string,
  dryRun: boolean,
  limit: number
): Promise<Record<string, unknown>> {
  const { column, kind } = tableDatePredicate(table);
  const where = sourceWhere(table);
  const rows = await env.D1.prepare(
    `SELECT s.id
       FROM ${table} s
       LEFT JOIN ingestion_treatment_receipts r
         ON r.org_id = s.org_id
        AND r.source_table = ?
        AND r.source_id = s.id
      WHERE s.org_id = ?
        AND ${where}
        AND ${column} >= ?
        AND ${column} <= ?
        AND (r.id IS NULL OR r.status != 'completed')
      ORDER BY ${column} DESC
      LIMIT ?`
  ).bind(table, orgId, startDate, endDate, limit).all<{ id: string }>();

  let enqueued = 0;
  let existing = 0;
  if (!dryRun) {
    for (const row of rows.results) {
      const result = await enqueueIngestionTreatment(env, {
        orgId,
        sourceTable: table,
        sourceId: row.id,
        sourceKind: kind,
        ingestionMode: 'repair',
        origin: 'admin_ingestion_treatment_repair',
        priority: 25,
      });
      if (result.inserted) enqueued++;
      else existing++;
    }
  }

  return {
    source_table: table,
    candidates: rows.results.length,
    enqueued,
    existing,
    dry_run: dryRun,
  };
}

export async function handleIngestionTreatmentRepair(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can repair ingestion treatment coverage.');
  }
  const body = (await parseJsonBody<RepairBody>(request)) || {};
  const tables = validTables(body.source_tables);
  const endDate = body.end_date || new Date().toISOString();
  const startDate = body.start_date || sixMonthsAgo();
  const dryRun = body.dry_run === true;
  const limit = Math.max(1, Math.min(body.limit ?? 1000, 5000));
  if (!dryRun && body.confirm !== 'enqueue-ingestion-treatment-repair') {
    return errorResponse(
      'VALIDATION_ERROR',
      400,
      'Non-dry-run treatment repair requires confirm="enqueue-ingestion-treatment-repair".'
    );
  }

  const results = [];
  for (const table of tables) {
    results.push(await repairRowsForTable(env, ctx.orgId, table, startDate, endDate, dryRun, limit));
  }

  return jsonResponse({
    org_id: ctx.orgId,
    start_date: startDate,
    end_date: endDate,
    dry_run: dryRun,
    results,
  });
}
