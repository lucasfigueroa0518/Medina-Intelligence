// TRD §5.1, §11.1-§11.2 — Contact CRUD, merge, timeline, associations, enrich
import type { Env } from '../types/env';
import type { AuthContext, ContactFilter } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { mergeContacts, resolveMergedContact } from '../lib/merge';
import { canReadEmailContent } from '../lib/helpers';
import { triggerContactEnrichment } from '../lib/enrichment';

// --- GET /api/contacts ---

export async function listContacts(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const filter = parseContactFilter(url);

  const where: string[] = ['c.org_id = ?', 'c.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (filter.contact_types?.length) {
    where.push(
      `c.contact_type IN (${filter.contact_types.map(() => '?').join(',')})`
    );
    binds.push(...filter.contact_types);
  }

  if (filter.company_id) {
    where.push('c.company_id = ?');
    binds.push(filter.company_id);
  }

  if (filter.last_contact_before) {
    where.push('c.last_contact_date < ?');
    binds.push(filter.last_contact_before);
  }

  if (filter.last_contact_after) {
    where.push('c.last_contact_date > ?');
    binds.push(filter.last_contact_after);
  }

  if (filter.meetings_last_30d_min !== undefined) {
    where.push('c.meetings_last_30d >= ?');
    binds.push(filter.meetings_last_30d_min);
  }

  if (filter.keyword) {
    where.push('(c.full_name LIKE ? OR c.email LIKE ?)');
    binds.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
  }

  if (filter.has_followup_overdue) {
    where.push(
      `c.next_followup_date IS NOT NULL AND c.next_followup_date < strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    );
  }

  // Tag filtering — AND logic uses GROUP BY/HAVING
  let tagJoin = '';
  if (filter.tags?.length) {
    tagJoin = `JOIN contact_tags ct ON c.id = ct.contact_id
               JOIN tags t ON ct.tag_id = t.id`;
    where.push(`t.name IN (${filter.tags.map(() => '?').join(',')})`);
    binds.push(...filter.tags);
  }

  const sortBy = filter.sort_by || 'last_contact_date';
  const sortDir = filter.sort_dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(filter.limit || 50, 500);
  const offset = filter.offset || 0;

  const havingClause =
    filter.tags?.length && filter.tag_logic === 'and'
      ? `HAVING COUNT(DISTINCT t.id) = ${filter.tags.length}`
      : '';

  const sql = `
    SELECT c.*, co.name as company_name
    FROM contacts c
    LEFT JOIN companies co ON c.company_id = co.id
    ${tagJoin}
    WHERE ${where.join(' AND ')}
    GROUP BY c.id
    ${havingClause}
    ORDER BY ${sanitizeSortColumn(sortBy)} ${sortDir} NULLS LAST
    LIMIT ? OFFSET ?
  `;

  const result = await env.D1.prepare(sql).bind(...binds, limit, offset).all();

  return jsonResponse({ contacts: result.results, limit, offset });
}

function sanitizeSortColumn(col: string): string {
  const allowed = new Set([
    'last_contact_date',
    'total_interactions',
    'full_name',
    'name',
    'created_at',
  ]);
  const mapped = col === 'name' ? 'full_name' : col;
  return allowed.has(mapped) ? `c.${mapped}` : 'c.last_contact_date';
}

function parseContactFilter(url: URL): ContactFilter {
  const f: ContactFilter = {};
  const sp = url.searchParams;
  if (sp.getAll('contact_types').length) f.contact_types = sp.getAll('contact_types');
  if (sp.getAll('tags').length) f.tags = sp.getAll('tags');
  if (sp.get('tag_logic')) f.tag_logic = sp.get('tag_logic') as 'and' | 'or';
  if (sp.get('company_id')) f.company_id = sp.get('company_id')!;
  if (sp.get('last_contact_before'))
    f.last_contact_before = sp.get('last_contact_before')!;
  if (sp.get('last_contact_after'))
    f.last_contact_after = sp.get('last_contact_after')!;
  if (sp.get('keyword')) f.keyword = sp.get('keyword')!;
  if (sp.get('has_followup_overdue') === 'true') f.has_followup_overdue = true;
  if (sp.get('sort_by'))
    f.sort_by = sp.get('sort_by') as ContactFilter['sort_by'];
  if (sp.get('sort_dir'))
    f.sort_dir = sp.get('sort_dir') as ContactFilter['sort_dir'];
  if (sp.get('limit')) f.limit = parseInt(sp.get('limit')!, 10);
  if (sp.get('offset')) f.offset = parseInt(sp.get('offset')!, 10);
  return f;
}

// --- POST /api/contacts ---

export async function createContact(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.full_name || typeof body.full_name !== 'string' || !body.full_name.trim()) {
    return errorResponse('VALIDATION_ERROR', 400, 'full_name is required');
  }

  // Light validation before hitting D1.
  if (body.email && typeof body.email === 'string' && !/^\S+@\S+\.\S+$/.test(body.email)) {
    return errorResponse('VALIDATION_ERROR', 400, 'email is not a valid address');
  }

  const allowedTypes = new Set([
    'individual',
    'family',
    'institutional_investor',
    'company',
    'other',
  ]);
  const contactType = allowedTypes.has(body.contact_type)
    ? body.contact_type
    : 'individual';

  // Map frontend "notes" alias onto bio_summary — same field the contact detail
  // Overview tab renders as "Bio Summary".
  const bioSummary: string | null = body.bio_summary || body.notes || null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO contacts
       (id, org_id, full_name, email, phone, linkedin_url, contact_type, relationship_status,
        company_id, job_title, bio_summary,
        source, source_confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1.0, ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      body.full_name.trim(),
      body.email ? String(body.email).toLowerCase().trim() : null,
      body.phone || null,
      body.linkedin_url || null,
      contactType,
      body.relationship_status || null,
      body.company_id || null,
      body.job_title || null,
      bioSummary,
      now,
      now
    )
    .run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'contact',
    entity_id: id,
    after_data: { id, full_name: body.full_name },
    created_at: now,
  });

  await invalidateRagCache(ctx.orgId, env);

  const created = await env.D1.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
  return jsonResponse({ contact: created }, 201);
}

// --- GET /api/contacts/:id ---

export async function getContact(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const contact = await env.D1.prepare(
    `SELECT c.*, co.name as company_name
     FROM contacts c LEFT JOIN companies co ON c.company_id = co.id
     WHERE c.id = ? AND c.org_id = ? AND c.deleted_at IS NULL`
  ).bind(id, ctx.orgId).first();

  if (!contact) return errorResponse('CONTACT_NOT_FOUND', 404);

  const tags = await env.D1.prepare(
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN contact_tags ct ON t.id = ct.tag_id
     WHERE ct.contact_id = ?`
  ).bind(id).all();

  const associations = await env.D1.prepare(
    `SELECT ca.contact_id_a, ca.contact_id_b, ca.relationship, ca.confidence
     FROM contact_associations ca
     WHERE ca.contact_id_a = ? OR ca.contact_id_b = ?`
  ).bind(id, id).all();

  return jsonResponse({ contact, tags: tags.results, associations: associations.results });
}

// --- PATCH /api/contacts/:id ---

export async function updateContact(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body) return errorResponse('VALIDATION_ERROR', 400);

  const before = await env.D1.prepare(
    'SELECT * FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!before) return errorResponse('CONTACT_NOT_FOUND', 404);

  const allowed = [
    'full_name',
    'email',
    'phone',
    'linkedin_url',
    'twitter_url',
    'contact_type',
    'relationship_status',
    'company_id',
    'job_title',
    'next_followup_date',
    'next_followup_note',
    'investment_amount',
    'fund_commitment',
    'bio_summary',
    'topics_of_interest',
    'pain_points',
    'investment_thesis_tags',
    'custom_fields',
  ];

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      updates.push(`${k} = ?`);
      binds.push(body[k]);
    }
  }
  if (updates.length === 0) return jsonResponse({ contact: before });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

  await env.D1.prepare(
    `UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds, id).run();

  const after = await env.D1.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'contact',
    entity_id: id,
    before_data: before,
    after_data: after,
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ contact: after });
}

// --- DELETE /api/contacts/:id ---

export async function deleteContact(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const before = await env.D1.prepare(
    'SELECT * FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!before) return errorResponse('CONTACT_NOT_FOUND', 404);

  await env.D1.prepare(
    `UPDATE contacts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(id).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'soft_delete',
    entity_type: 'contact',
    entity_id: id,
    before_data: before,
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true });
}

// --- POST /api/contacts/:id/tags ---

export async function applyContactTags(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ tag_ids: string[] }>(request);
  if (!body?.tag_ids?.length) return errorResponse('VALIDATION_ERROR', 400);

  const now = new Date().toISOString();
  for (const tagId of body.tag_ids) {
    await env.D1.prepare(
      `INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, applied_by, applied_at)
       VALUES (?, ?, ?, ?)`
    ).bind(id, tagId, ctx.userId, now).run();

    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'tag_apply',
      entity_type: 'contact',
      entity_id: id,
      metadata: { tag_id: tagId },
      created_at: now,
    });
  }

  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true });
}

export async function removeContactTag(
  id: string,
  tagId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    'DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?'
  ).bind(id, tagId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'tag_remove',
    entity_type: 'contact',
    entity_id: id,
    metadata: { tag_id: tagId },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

// --- POST /api/contacts/merge ---

export async function postContactMerge(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ keep_id: string; discard_id: string }>(request);
  if (!body?.keep_id || !body?.discard_id) {
    return errorResponse('VALIDATION_ERROR', 400);
  }

  const resolved = await resolveMergedContact(body.keep_id, env);
  if (resolved !== body.keep_id) {
    return errorResponse('MERGE_CHAIN_RESOLVED', 409, `keep_id already merged into ${resolved}`);
  }

  const result = await mergeContacts(
    body.keep_id,
    body.discard_id,
    ctx.userId,
    ctx.orgId,
    env
  );

  if (!result.success) {
    const status = result.error === 'MERGE_LOCK_CONFLICT' || result.error === 'ACTIVE_CAMPAIGN' ? 409 : 500;
    return jsonResponse({ error: result.error, message: result.message }, status);
  }
  return jsonResponse({ ok: true });
}

// --- GET /api/contacts/:id/timeline ---

export async function getContactTimeline(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

  const [events, conversations, tasks, documents] = await Promise.all([
    env.D1.prepare(
      `SELECT e.id, e.title, e.start_time as timestamp, 'event' as type, e.event_type as subtype
       FROM events e JOIN event_attendees ea ON e.id = ea.event_id
       WHERE ea.contact_id = ? AND e.org_id = ? AND e.deleted_at IS NULL
       ORDER BY e.start_time DESC LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),
    env.D1.prepare(
      `SELECT c.id, c.subject as title, c.sent_at as timestamp, 'conversation' as type,
              c.source as subtype, c.body_preview, c.participant_user_ids,
              c.source as conv_source, c.is_campaign_email, c.from_email
       FROM conversations c JOIN conversation_contacts cc ON c.id = cc.conversation_id
       WHERE cc.contact_id = ? AND c.org_id = ?
       ORDER BY c.sent_at DESC LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),
    env.D1.prepare(
      `SELECT id, title, due_date as timestamp, 'task' as type, status as subtype
       FROM tasks WHERE contact_id = ? AND org_id = ? AND deleted_at IS NULL
       ORDER BY due_date DESC LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),
    env.D1.prepare(
      `SELECT id, title, created_at as timestamp, 'document' as type, document_type as subtype
       FROM documents WHERE contact_id = ? AND org_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),
  ]);

  const conversationsWithAccess = conversations.results.map((c: any) => {
    const canRead = canReadEmailContent(
      {
        source: c.conv_source,
        participant_user_ids: c.participant_user_ids,
        is_campaign_email: c.is_campaign_email,
      } as any,
      ctx.userId,
      ctx.userRole
    );
    return {
      ...c,
      canReadContent: canRead,
      body_preview: canRead ? c.body_preview : null,
    };
  });

  const entries = [
    ...events.results,
    ...conversationsWithAccess,
    ...tasks.results,
    ...documents.results,
  ]
    .sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);

  return jsonResponse({ entries });
}

// --- GET /api/contacts/:id/associations ---

export async function getContactAssociations(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT ca.*, c.id as other_id, c.full_name, c.avatar_url, c.company_id
     FROM contact_associations ca
     JOIN contacts c ON (ca.contact_id_a = c.id OR ca.contact_id_b = c.id) AND c.id != ?
     WHERE (ca.contact_id_a = ? OR ca.contact_id_b = ?) AND ca.org_id = ?`
  ).bind(id, id, id, ctx.orgId).all();

  return jsonResponse({ associations: rows.results });
}

// --- POST /api/contacts/:id/enrich ---

export async function enrichContactEndpoint(
  id: string,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  ctxExec.waitUntil(triggerContactEnrichment(id, ctx.orgId, env));
  return jsonResponse({ ok: true, message: 'Enrichment queued' });
}

// --- GET /api/contacts/:id/enrichment ---
// Returns the FULL enrichment bio from R2 (the short bio lives on contacts.bio_summary).
export async function getContactEnrichment(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const contact = await env.D1.prepare(
    `SELECT id, full_name, web_enrichment_r2_key, bio_summary,
            enrichment_confidence, enrichment_last_run
     FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.orgId).first<{
    id: string;
    full_name: string;
    web_enrichment_r2_key: string | null;
    bio_summary: string | null;
    enrichment_confidence: number | null;
    enrichment_last_run: string | null;
  }>();

  if (!contact) return errorResponse('CONTACT_NOT_FOUND', 404);

  if (!contact.web_enrichment_r2_key) {
    return jsonResponse({
      contact_id: contact.id,
      short_bio: contact.bio_summary,
      full_bio: null,
      enrichment_confidence: contact.enrichment_confidence,
      enrichment_last_run: contact.enrichment_last_run,
      status: 'not_enriched',
    });
  }

  const obj = await env.R2.get(contact.web_enrichment_r2_key);
  if (!obj) {
    return jsonResponse({
      contact_id: contact.id,
      short_bio: contact.bio_summary,
      full_bio: null,
      enrichment_confidence: contact.enrichment_confidence,
      enrichment_last_run: contact.enrichment_last_run,
      status: 'r2_missing',
    });
  }

  const raw = await obj.text();
  let fullBio: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { full_bio?: string };
    fullBio = parsed.full_bio ?? null;
  } catch {
    // Legacy format: raw body IS the bio text.
    fullBio = raw;
  }

  return jsonResponse({
    contact_id: contact.id,
    short_bio: contact.bio_summary,
    full_bio: fullBio,
    enrichment_confidence: contact.enrichment_confidence,
    enrichment_last_run: contact.enrichment_last_run,
    status: 'ok',
  });
}
