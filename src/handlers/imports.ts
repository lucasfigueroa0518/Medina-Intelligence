// TRD §5.1, §16.7 — Bulk import with LLM column mapping
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { callClaude } from '../lib/claude';
import { IMPORT_COLUMN_MAPPING_PROMPT } from '../prompts/import-mapping';
import { isTextExtractionSupported } from '../lib/file-extraction';

interface ImportJobRow {
  id: string;
  org_id: string;
  created_by: string | null;
  source_type: string;
  source_r2_key: string;
  status: string;
  column_mapping?: string | null;
  preview_data?: string | null;
  total_rows?: number | null;
  processed_rows?: number | null;
  created_rows?: number | null;
  updated_rows?: number | null;
  skipped_rows?: number | null;
  failed_rows?: number | null;
  error_log_r2_key?: string | null;
  hidden_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface ImportDocumentReport {
  id: string;
  title: string;
  file_name: string | null;
  document_type: string | null;
  source: string | null;
  mime_type: string | null;
  file_size: number | null;
  processing_status: string | null;
  error_message: string | null;
  extracted_text_length: number | null;
  created_at: string | null;
  updated_at: string | null;
  vector_count: number;
}

interface ImportCreatedEntity {
  id: string;
  type: 'contact' | 'company' | 'deal' | 'document';
  name: string;
  subtitle: string | null;
  created_at: string | null;
}

interface ImportWorkItem {
  id: string;
  domain: string;
  status: string;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface ImportReport {
  job_id: string;
  file_name: string;
  source_r2_key: string;
  status: string;
  source_type: string;
  created_at: string;
  updated_at: string | null;
  summary: string;
  counters: {
    total_rows: number;
    processed_rows: number;
    created_rows: number;
    updated_rows: number;
    skipped_rows: number;
    failed_rows: number;
  };
  lineage_counts: Record<string, number>;
  documents: ImportDocumentReport[];
  created_entities: {
    contacts: ImportCreatedEntity[];
    companies: ImportCreatedEntity[];
    deals: ImportCreatedEntity[];
    documents: ImportCreatedEntity[];
  };
  stages: Array<{
    key: string;
    label: string;
    status: 'completed' | 'running' | 'pending' | 'failed' | 'warning';
    detail: string;
  }>;
  work_items: ImportWorkItem[];
  errors: string[];
  notes: string[];
  ingestion: {
    stored_only: boolean;
    readable: boolean;
    reason: 'unsupported_format' | 'no_extractable_text' | 'extraction_failed' | null;
    message: string | null;
  };
}

function numberish(value: unknown): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function fileNameFromR2Key(key?: string | null): string {
  if (!key) return 'Uploaded file';
  const leaf = key.split('/').pop() || key;
  return leaf.replace(/^[0-9a-f-]{36}_/i, '');
}

function stageStatusForJob(status: string): 'completed' | 'running' | 'pending' | 'failed' | 'warning' {
  if (status === 'completed' || status === 'reverted') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'warning';
  if (status === 'processing') return 'running';
  return 'pending';
}

function documentSupportsTextExtraction(doc: ImportDocumentReport, fallbackName: string): boolean {
  return isTextExtractionSupported({
    name: doc.file_name || doc.title || fallbackName,
    type: doc.mime_type || '',
  });
}

export async function listImports(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const imports = await env.D1.prepare(
    `SELECT id, source_type, source_r2_key, status,
            total_rows, processed_rows, created_rows, updated_rows,
            skipped_rows, failed_rows, hidden_at, deleted_at, created_at, updated_at
       FROM import_jobs
      WHERE org_id = ?
        AND hidden_at IS NULL
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50`
  ).bind(ctx.orgId).all();

  return jsonResponse({ imports: imports.results || [] });
}

export async function uploadImport(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file') as File | null;
  const sourceType = form.get('source_type') as string | null;
  if (!file || !sourceType) return errorResponse('VALIDATION_ERROR', 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `${ctx.orgId}/imports/${now.slice(0, 7)}/${id}_${file.name}`;

  const buffer = await file.arrayBuffer();
  await env.R2.put(r2Key, buffer);

  await env.D1.prepare(
    `INSERT INTO import_jobs (id, org_id, created_by, source_type, source_r2_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'mapping', ?, ?)`
  ).bind(id, ctx.orgId, ctx.userId, sourceType, r2Key, now, now).run();

  // Pre-parse CSV/XLSX and build column mapping suggestion via Claude
  if (sourceType === 'csv') {
    try {
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim()).slice(0, 4);
      if (lines.length >= 2) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const row1 = lines[1]?.split(',').map(c => c.trim()) || [];
        const row2 = lines[2]?.split(',').map(c => c.trim()) || [];
        const row3 = lines[3]?.split(',').map(c => c.trim()) || [];

        const userPrompt = `Columns: ${JSON.stringify(headers)}
Sample row 1: ${JSON.stringify(row1)}
Sample row 2: ${JSON.stringify(row2)}
Sample row 3: ${JSON.stringify(row3)}`;

        try {
          const response = await callClaude(
            {
              system: IMPORT_COLUMN_MAPPING_PROMPT,
              user: userPrompt,
              max_tokens: 600,
              orgId: ctx.orgId,
            },
            'low',
            env
          );
          const cleaned = response
            .trim()
            .replace(/```json\s*/g, '')
            .replace(/```/g, '')
            .trim();
          const mapping = JSON.parse(cleaned);
          await env.D1.prepare(
            `UPDATE import_jobs SET column_mapping = ?, preview_data = ? WHERE id = ?`
          )
            .bind(
              JSON.stringify(mapping),
              JSON.stringify({ headers, rows: [row1, row2, row3] }),
              id
            )
            .run();
        } catch (e) {
          console.error('AI column mapping failed:', e);
        }
      }
    } catch (e) {
      console.error('CSV preview failed:', e);
    }
  }

  const job = await env.D1.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(id).first();
  return jsonResponse({ job }, 201);
}

export async function getImportJob(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const job = await env.D1.prepare(
    'SELECT * FROM import_jobs WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first<ImportJobRow>();
  if (!job) return errorResponse('IMPORT_NOT_FOUND', 404);
  const report = await buildImportReport(job, env);
  return jsonResponse({ job, report });
}

export async function hideImportJob(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const now = new Date().toISOString();
  const result = await env.D1.prepare(
    `UPDATE import_jobs
        SET hidden_at = COALESCE(hidden_at, ?),
            updated_at = ?
      WHERE id = ?
        AND org_id = ?
        AND deleted_at IS NULL`
  ).bind(now, now, id, ctx.orgId).run();

  if (!result.meta.changes) return errorResponse('IMPORT_NOT_FOUND', 404);
  return jsonResponse({ ok: true, job_id: id, hidden_at: now });
}

export async function deleteImportJob(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const now = new Date().toISOString();
  const result = await env.D1.prepare(
    `UPDATE import_jobs
        SET deleted_at = COALESCE(deleted_at, ?),
            hidden_at = COALESCE(hidden_at, ?),
            updated_at = ?
      WHERE id = ?
        AND org_id = ?
        AND deleted_at IS NULL`
  ).bind(now, now, now, id, ctx.orgId).run();

  if (!result.meta.changes) return errorResponse('IMPORT_NOT_FOUND', 404);
  return jsonResponse({
    ok: true,
    job_id: id,
    deleted_at: now,
    note: 'Only the import history row was hidden. Use Undo Import when you need to revert records created by an import.',
  });
}

async function buildImportReport(job: ImportJobRow, env: Env): Promise<ImportReport> {
  const fileName = fileNameFromR2Key(job.source_r2_key);
  const counters = {
    total_rows: numberish(job.total_rows),
    processed_rows: numberish(job.processed_rows),
    created_rows: numberish(job.created_rows),
    updated_rows: numberish(job.updated_rows),
    skipped_rows: numberish(job.skipped_rows),
    failed_rows: numberish(job.failed_rows),
  };

  const lineageRows = await env.D1.prepare(
    `SELECT entity_type, COUNT(*) AS count
       FROM import_lineage
      WHERE import_job_id = ?
      GROUP BY entity_type`
  ).bind(job.id).all<{ entity_type: string; count: number }>();

  const lineageCounts: Record<string, number> = {};
  for (const row of lineageRows.results || []) {
    lineageCounts[row.entity_type] = numberish(row.count);
  }

  const documents = await env.D1.prepare(
    `SELECT d.id, d.title, d.file_name, d.document_type, d.source, d.mime_type,
            d.file_size, d.processing_status, d.error_message, d.created_at, d.updated_at,
            LENGTH(COALESCE(d.extracted_text_preview, '')) AS extracted_text_length,
            COUNT(vei.vector_id) AS vector_count
       FROM import_lineage il
       JOIN documents d
         ON d.id = il.entity_id
        AND d.org_id = ?
       LEFT JOIN vector_entity_index vei
         ON vei.entity_id = d.id
        AND vei.source_table = 'documents'
        AND vei.org_id = d.org_id
      WHERE il.import_job_id = ?
        AND il.entity_type = 'document'
      GROUP BY d.id
      ORDER BY d.created_at DESC`
  ).bind(job.org_id, job.id).all<ImportDocumentReport>();

  const documentRows = documents.results || [];
  const documentIds = documentRows.map(d => d.id);
  const createdEntities = await loadCreatedEntities(job.id, job.org_id, env);
  const workItems = await loadImportWorkItems(job, documentIds, env);
  const errors = await loadImportErrors(job, env, workItems, documentRows);

  const totalVectors = documentRows.reduce((sum, doc) => sum + numberish(doc.vector_count), 0);
  const readableDocumentCount = documentRows.filter(doc =>
    numberish(doc.extracted_text_length) >= 20 || numberish(doc.vector_count) > 0
  ).length;
  const unreadableDocuments = documentRows.filter(doc =>
    numberish(doc.extracted_text_length) < 20 && numberish(doc.vector_count) === 0
  );
  const unsupportedDocuments = unreadableDocuments.filter(doc => !documentSupportsTextExtraction(doc, fileName));
  const extractionFailedDocuments = unreadableDocuments.filter(doc =>
    doc.processing_status === 'failed' || /extract|readable|unsupported/i.test(doc.error_message || '')
  );
  const crmRoutedRows = counters.created_rows + counters.updated_rows;
  const storedOnly = job.status === 'completed' &&
    documentRows.length > 0 &&
    readableDocumentCount === 0 &&
    crmRoutedRows === 0;
  const ingestionReason: ImportReport['ingestion']['reason'] = storedOnly
    ? unsupportedDocuments.length > 0
        ? 'unsupported_format'
        : extractionFailedDocuments.length > 0
          ? 'extraction_failed'
          : 'no_extractable_text'
    : null;
  const ingestionMessage = storedOnly
    ? ingestionReason === 'unsupported_format'
      ? `${fileName} was stored in Documents, but this file format is not readable by the importer. No CRM records were created or updated, and no document chunks were added to MARTy.`
      : `${fileName} was stored in Documents, but no readable text could be extracted. No CRM records were created or updated, and no document chunks were added to MARTy.`
    : null;
  const documentStageStatus = documentRows.length === 0
    ? 'pending'
    : 'completed';
  const extractionStageStatus: ImportReport['stages'][number]['status'] = documentRows.length === 0
    ? 'pending'
    : storedOnly
      ? 'warning'
      : documentRows.some(doc => doc.processing_status === 'failed')
        ? 'failed'
        : documentRows.every(doc => doc.processing_status === 'completed')
          ? 'completed'
          : 'running';
  const routingStageStatus = storedOnly
    ? 'warning'
    : stageStatusForJob(job.status);
  const embedWork = workItems.filter(item => item.domain === 'embed_retry');
  const embeddingStageStatus: ImportReport['stages'][number]['status'] = storedOnly
    ? 'warning'
    : totalVectors > 0
      ? 'completed'
      : embedWork.some(item => item.status === 'dead_letter' || item.status === 'failed')
        ? 'failed'
        : embedWork.some(item => item.status === 'pending' || item.status === 'in_progress')
          ? 'running'
          : documentRows.length > 0
            ? 'pending'
            : 'pending';

  const stages: ImportReport['stages'] = [
    {
      key: 'upload',
      label: 'Uploaded original file',
      status: 'completed',
      detail: `Stored ${fileName} in durable storage for this org.`,
    },
    {
      key: 'document',
      label: 'Added to Documents',
      status: documentStageStatus,
      detail: documentRows.length > 0
        ? `${documentRows.length} document record${documentRows.length === 1 ? '' : 's'} created.`
        : 'No document record has been linked to this import yet.',
    },
    {
      key: 'classification',
      label: 'Classified and extracted',
      status: extractionStageStatus,
      detail: ingestionMessage
        ? 'No readable content was extracted, so the importer stored the file without ingesting CRM data.'
        : documentRows[0]?.document_type
          ? `Classified as ${documentRows[0].document_type.replace(/_/g, ' ')}.`
        : job.status === 'failed'
          ? 'Classification or extraction failed.'
          : 'Classification details are not available yet.',
    },
    {
      key: 'routing',
      label: 'Routed into CRM',
      status: routingStageStatus,
      detail: ingestionMessage
        ? 'CRM routing had no readable contact, company, or deal data to ingest.'
        : `${counters.processed_rows || 0} processed, ${counters.created_rows || 0} created, ${counters.updated_rows || 0} updated, ${counters.failed_rows || 0} failed.`,
    },
    {
      key: 'embedding',
      label: 'Made searchable by MARTy',
      status: embeddingStageStatus,
      detail: ingestionMessage
        ? 'No searchable chunks were created because the importer could not read text from the file.'
        : totalVectors > 0
        ? `${totalVectors} document chunk${totalVectors === 1 ? '' : 's'} embedded for semantic search.`
        : 'No document vectors found yet. Preview/download still works, but MARTy semantic retrieval is weaker until embedding completes.',
    },
  ];

  const notes: string[] = [];
  if (counters.updated_rows > 0) {
    notes.push('Updates were applied to existing CRM records. The system tracks update counts, but import lineage only stores records created by this import.');
  }
  if (job.status === 'reverted') {
    notes.push('This import has been reverted. Created records were soft-deleted and document vectors were removed where available.');
  }
  if (ingestionMessage) {
    notes.push(ingestionMessage);
  }

  const summary = ingestionMessage
    ? ingestionMessage
    : job.status === 'completed'
    ? `${fileName} was analyzed and routed. ${counters.created_rows} records were created, ${counters.updated_rows} existing records were updated, and ${totalVectors} document chunks are searchable by MARTy.`
    : job.status === 'processing'
      ? `${fileName} is still being analyzed in the background.`
      : job.status === 'failed'
        ? `${fileName} failed during analysis. See the processing trail below for the failure details.`
        : `${fileName} is currently ${job.status}.`;

  return {
    job_id: job.id,
    file_name: fileName,
    source_r2_key: job.source_r2_key,
    status: job.status,
    source_type: job.source_type,
    created_at: job.created_at,
    updated_at: job.updated_at || null,
    summary,
    counters,
    lineage_counts: lineageCounts,
    documents: documentRows.map(doc => ({
      ...doc,
      vector_count: numberish(doc.vector_count),
      file_size: doc.file_size == null ? null : numberish(doc.file_size),
      extracted_text_length: numberish(doc.extracted_text_length),
    })),
    created_entities: createdEntities,
    stages,
    work_items: workItems,
    errors,
    notes,
    ingestion: {
      stored_only: storedOnly,
      readable: readableDocumentCount > 0,
      reason: ingestionReason,
      message: ingestionMessage,
    },
  };
}

async function loadCreatedEntities(
  jobId: string,
  orgId: string,
  env: Env
): Promise<ImportReport['created_entities']> {
  const [contacts, companies, deals, documents] = await Promise.all([
    env.D1.prepare(
      `SELECT c.id, 'contact' AS type, c.full_name AS name,
              COALESCE(c.email, cmp.name, c.job_title) AS subtitle,
              il.created_at
         FROM import_lineage il
         JOIN contacts c ON c.id = il.entity_id AND c.org_id = ?
         LEFT JOIN companies cmp ON cmp.id = c.company_id AND cmp.org_id = c.org_id
        WHERE il.import_job_id = ?
          AND il.entity_type = 'contact'
        ORDER BY il.created_at DESC
        LIMIT 25`
    ).bind(orgId, jobId).all<ImportCreatedEntity>(),
    env.D1.prepare(
      `SELECT c.id, 'company' AS type, c.name,
              COALESCE(c.domain, c.website, c.company_type) AS subtitle,
              il.created_at
         FROM import_lineage il
         JOIN companies c ON c.id = il.entity_id AND c.org_id = ?
        WHERE il.import_job_id = ?
          AND il.entity_type = 'company'
        ORDER BY il.created_at DESC
        LIMIT 25`
    ).bind(orgId, jobId).all<ImportCreatedEntity>(),
    env.D1.prepare(
      `SELECT d.id, 'deal' AS type, d.title AS name,
              c.name AS subtitle,
              il.created_at
         FROM import_lineage il
         JOIN deals d ON d.id = il.entity_id AND d.org_id = ?
         LEFT JOIN companies c ON c.id = d.company_id AND c.org_id = d.org_id
        WHERE il.import_job_id = ?
          AND il.entity_type = 'deal'
        ORDER BY il.created_at DESC
        LIMIT 25`
    ).bind(orgId, jobId).all<ImportCreatedEntity>(),
    env.D1.prepare(
      `SELECT d.id, 'document' AS type, COALESCE(d.file_name, d.title) AS name,
              d.document_type AS subtitle,
              il.created_at
         FROM import_lineage il
         JOIN documents d ON d.id = il.entity_id AND d.org_id = ?
        WHERE il.import_job_id = ?
          AND il.entity_type = 'document'
        ORDER BY il.created_at DESC
        LIMIT 25`
    ).bind(orgId, jobId).all<ImportCreatedEntity>(),
  ]);

  return {
    contacts: contacts.results || [],
    companies: companies.results || [],
    deals: deals.results || [],
    documents: documents.results || [],
  };
}

async function loadImportWorkItems(
  job: ImportJobRow,
  documentIds: string[],
  env: Env
): Promise<ImportWorkItem[]> {
  const clauses = ['payload LIKE ?'];
  const binds: unknown[] = [`%${job.id}%`];
  for (const documentId of documentIds.slice(0, 10)) {
    clauses.push('payload LIKE ?');
    binds.push(`%${documentId}%`);
  }

  const rows = await env.D1.prepare(
    `SELECT id, domain, status, attempt, max_attempts, last_error,
            created_at, started_at, completed_at
       FROM work_queue
      WHERE org_id = ?
        AND (${clauses.join(' OR ')})
      ORDER BY created_at DESC
      LIMIT 25`
  ).bind(job.org_id, ...binds).all<ImportWorkItem>();

  return (rows.results || []).map(row => ({
    ...row,
    attempt: numberish(row.attempt),
    max_attempts: numberish(row.max_attempts),
  }));
}

async function loadImportErrors(
  job: ImportJobRow,
  env: Env,
  workItems: ImportWorkItem[],
  documents: ImportDocumentReport[]
): Promise<string[]> {
  const errors: string[] = [];
  if (numberish(job.failed_rows) > 0) {
    errors.push(`${numberish(job.failed_rows)} row${numberish(job.failed_rows) === 1 ? '' : 's'} failed during routing.`);
  }

  for (const doc of documents) {
    if (doc.error_message) errors.push(`Document "${doc.file_name || doc.title}" failed: ${doc.error_message}`);
  }
  for (const item of workItems) {
    if ((item.status === 'failed' || item.status === 'dead_letter') && item.last_error) {
      errors.push(`${item.domain} ${item.status}: ${item.last_error}`);
    }
  }

  if (job.error_log_r2_key) {
    try {
      const object = await env.R2.get(job.error_log_r2_key);
      const text = object ? await object.text() : '';
      if (text.trim()) {
        errors.push(...text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 10));
      }
    } catch (e: any) {
      errors.push(`Could not read import error log: ${e?.message || e}`);
    }
  }

  return Array.from(new Set(errors)).slice(0, 25);
}

export async function setImportMapping(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ mapping: Record<string, string | null> }>(request);
  if (!body?.mapping) return errorResponse('VALIDATION_ERROR', 400);

  await env.D1.prepare(
    `UPDATE import_jobs SET column_mapping = ?, status = 'preview' WHERE id = ? AND org_id = ?`
  ).bind(JSON.stringify(body.mapping), id, ctx.orgId).run();

  return jsonResponse({ ok: true });
}

export async function confirmImport(
  id: string,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const job = await env.D1.prepare(
    'SELECT * FROM import_jobs WHERE id = ? AND org_id = ? AND status = ?'
  ).bind(id, ctx.orgId, 'preview').first<any>();
  if (!job) return errorResponse('IMPORT_NOT_FOUND', 404);

  await env.D1.prepare(
    `UPDATE import_jobs SET status = 'processing' WHERE id = ?`
  ).bind(id).run();

  ctxExec.waitUntil(processImport(id, ctx.orgId, env));

  return jsonResponse({ ok: true });
}

export async function cancelImport(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    `UPDATE import_jobs SET status = 'cancelled' WHERE id = ? AND org_id = ?`
  ).bind(id, ctx.orgId).run();
  return jsonResponse({ ok: true });
}

async function processImport(id: string, orgId: string, env: Env): Promise<void> {
  try {
    const job = await env.D1.prepare('SELECT * FROM import_jobs WHERE id = ?')
      .bind(id)
      .first<any>();
    if (!job) return;

    const file = await env.R2.get(job.source_r2_key);
    if (!file) throw new Error('source file missing');

    const text = await file.text();
    const mapping: Record<string, string | null> = JSON.parse(job.column_mapping || '{}');

    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      await env.D1.prepare(
        `UPDATE import_jobs SET status = 'completed', total_rows = 0 WHERE id = ?`
      ).bind(id).run();
      return;
    }

    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 1; i < lines.length; i++) {
      try {
        const cells = parseCsvLine(lines[i]);
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          row[headers[j]] = cells[j] || '';
        }

        // Apply mapping
        const mapped: Record<string, string> = {};
        for (const [src, target] of Object.entries(mapping)) {
          if (target && row[src]) mapped[target] = row[src];
        }

        if (!mapped.full_name && !mapped.email) {
          skipped++;
          continue;
        }

        // Upsert contact
        let contactId: string | null = null;
        if (mapped.email) {
          const existing = await env.D1.prepare(
            'SELECT id FROM contacts WHERE org_id = ? AND email = ? AND deleted_at IS NULL'
          ).bind(orgId, mapped.email).first<{ id: string }>();
          if (existing) contactId = existing.id;
        }

        if (contactId) {
          // Update
          const fields: string[] = [];
          const binds: unknown[] = [];
          for (const [k, v] of Object.entries(mapped)) {
            if (k === 'email' || !v) continue;
            fields.push(`${k} = ?`);
            binds.push(v);
          }
          if (fields.length > 0) {
            await env.D1.prepare(
              `UPDATE contacts SET ${fields.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
            ).bind(...binds, contactId).run();
          }
          updated++;
        } else {
          const newId = crypto.randomUUID();
          await env.D1.prepare(
            `INSERT INTO contacts (id, org_id, full_name, email, phone, job_title, linkedin_url, source, source_confidence, contact_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'import', 0.9, 'individual')`
          )
            .bind(
              newId,
              orgId,
              mapped.full_name || mapped.email || 'Unknown',
              mapped.email || null,
              mapped.phone || null,
              mapped.job_title || null,
              mapped.linkedin_url || null
            )
            .run();
          created++;
        }
      } catch (e) {
        failed++;
        console.error(`Import row ${i} failed:`, e);
      }
    }

    await env.D1.prepare(
      `UPDATE import_jobs SET
         status = 'completed',
         total_rows = ?, processed_rows = ?,
         created_rows = ?, updated_rows = ?,
         skipped_rows = ?, failed_rows = ?
       WHERE id = ?`
    )
      .bind(lines.length - 1, lines.length - 1, created, updated, skipped, failed, id)
      .run();
  } catch (e) {
    await env.D1.prepare(
      `UPDATE import_jobs SET status = 'failed' WHERE id = ?`
    ).bind(id).run();
    console.error('Import processing failed:', e);
  }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result.map(c => c.replace(/^"|"$/g, ''));
}
