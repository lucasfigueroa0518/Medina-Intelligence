// TRD §5.1, §16.7 — Bulk import with LLM column mapping
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { callClaude } from '../lib/claude';
import { IMPORT_COLUMN_MAPPING_PROMPT } from '../prompts/import-mapping';

export async function listImports(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const imports = await env.D1.prepare(
    `SELECT id, source_type, source_r2_key, status,
            total_rows, processed_rows, created_rows, updated_rows,
            skipped_rows, failed_rows, created_at, updated_at
       FROM import_jobs
      WHERE org_id = ?
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
    'SELECT * FROM import_jobs WHERE id = ? AND org_id = ?'
  ).bind(id, ctx.orgId).first();
  if (!job) return errorResponse('IMPORT_NOT_FOUND', 404);
  return jsonResponse({ job });
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
