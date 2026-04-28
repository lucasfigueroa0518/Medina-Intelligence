// TRD §5.1, §11.1-§11.2 — Contact CRUD, merge, timeline, associations, enrich
import type { Env } from '../types/env';
import type { AuthContext, ContactFilter } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { mergeContacts, resolveMergedContact, cleanupVectorsForEntity } from '../lib/merge';
import { canReadEmailContent, getSharingFlags } from '../lib/helpers';
import { isDocumentAccessibleToUser } from '../lib/document-acl';
import { triggerContactEnrichment } from '../lib/enrichment';
import { markFieldsHumanEdited } from '../lib/progressive-enrichment';

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

  if (filter.engagement_statuses?.length) {
    where.push(
      `c.engagement_status IN (${filter.engagement_statuses.map(() => '?').join(',')})`
    );
    binds.push(...filter.engagement_statuses);
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
  // Default to 100/page, ceiling 500. Frontend uses cumulative "load more"
  // pagination so initial load stays fast even at 10k+ records.
  const limit = Math.min(filter.limit || 100, 500);
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

  // Count query — same WHERE + same JOINs but bare COUNT, no GROUP BY/HAVING
  // unless we're tag-filtering (which can change cardinality).
  const countSql = `
    SELECT COUNT(DISTINCT c.id) as n
    FROM contacts c
    LEFT JOIN companies co ON c.company_id = co.id
    ${tagJoin}
    WHERE ${where.join(' AND ')}
  `;

  const [result, countResult] = await Promise.all([
    env.D1.prepare(sql).bind(...binds, limit, offset).all(),
    env.D1.prepare(countSql).bind(...binds).first<{ n: number }>(),
  ]);
  const total = countResult?.n ?? 0;

  const contacts = result.results as any[];
  if (contacts.length > 0) {
    const ids = contacts.map(c => c.id);
    const ph = ids.map(() => '?').join(',');
    const tagRows = await env.D1.prepare(
      `SELECT ct.contact_id, t.id, t.name, t.color
       FROM contact_tags ct JOIN tags t ON ct.tag_id = t.id
       WHERE ct.contact_id IN (${ph})`
    ).bind(...ids).all();
    const tagMap = new Map<string, any[]>();
    for (const r of tagRows.results as any[]) {
      const arr = tagMap.get(r.contact_id) || [];
      arr.push({ id: r.id, name: r.name, color: r.color });
      tagMap.set(r.contact_id, arr);
    }
    for (const c of contacts) {
      c.tags = tagMap.get(c.id) || [];
    }
  }

  return jsonResponse({ contacts, limit, offset, total });
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
  if (sp.getAll('engagement_statuses').length) f.engagement_statuses = sp.getAll('engagement_statuses');
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

// --- GET /api/contacts/filter-counts ---

export async function getContactFilterCounts(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const [typeCounts, statusCounts, tagCounts, overdueCount] = await Promise.all([
    env.D1.prepare(
      `SELECT contact_type, COUNT(*) as cnt FROM contacts
       WHERE org_id = ? AND deleted_at IS NULL
       GROUP BY contact_type`
    ).bind(ctx.orgId).all<{ contact_type: string; cnt: number }>(),

    env.D1.prepare(
      `SELECT engagement_status, COUNT(*) as cnt FROM contacts
       WHERE org_id = ? AND deleted_at IS NULL
       GROUP BY engagement_status`
    ).bind(ctx.orgId).all<{ engagement_status: string | null; cnt: number }>(),

    env.D1.prepare(
      `SELECT ct.tag_id, COUNT(*) as cnt FROM contact_tags ct
       JOIN contacts c ON c.id = ct.contact_id
       WHERE c.org_id = ? AND c.deleted_at IS NULL
       GROUP BY ct.tag_id`
    ).bind(ctx.orgId).all<{ tag_id: string; cnt: number }>(),

    env.D1.prepare(
      `SELECT COUNT(*) as cnt FROM contacts
       WHERE org_id = ? AND deleted_at IS NULL
         AND next_followup_date IS NOT NULL
         AND next_followup_date < strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(ctx.orgId).first<{ cnt: number }>(),
  ]);

  const contact_type: Record<string, number> = {};
  for (const r of typeCounts.results) contact_type[r.contact_type] = r.cnt;

  const engagement_status: Record<string, number> = {};
  for (const r of statusCounts.results) {
    if (r.engagement_status) engagement_status[r.engagement_status] = r.cnt;
  }

  const tags: Record<string, number> = {};
  for (const r of tagCounts.results) tags[r.tag_id] = r.cnt;

  return jsonResponse({
    contact_type,
    engagement_status,
    tags,
    overdue_followups: overdueCount?.cnt || 0,
  });
}

// --- POST /api/contacts ---

export async function createContact(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
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

  if (body.auto_enrich !== false) {
    ctxExec.waitUntil(triggerContactEnrichment(id, ctx.orgId, env));
  }

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
    `SELECT c.*, co.name as company_name,
            u.full_name as owner_name, u.avatar_url as owner_avatar, u.email as owner_email
     FROM contacts c
     LEFT JOIN companies co ON c.company_id = co.id
     LEFT JOIN users u ON c.relationship_owner_id = u.id
     WHERE c.id = ? AND c.org_id = ? AND c.deleted_at IS NULL`
  ).bind(id, ctx.orgId).first();

  if (!contact) return errorResponse('CONTACT_NOT_FOUND', 404);

  const tags = await env.D1.prepare(
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN contact_tags ct ON t.id = ct.tag_id
     WHERE ct.contact_id = ?`
  ).bind(id).all();

  const assocRows = await env.D1.prepare(
    `SELECT ca.contact_id_a, ca.contact_id_b, ca.relationship, ca.confidence,
            c2.full_name as other_name, c2.job_title as other_title, c2.company_id as other_company_id
     FROM contact_associations ca
     LEFT JOIN contacts c2 ON c2.id = CASE WHEN ca.contact_id_a = ? THEN ca.contact_id_b ELSE ca.contact_id_a END
     WHERE (ca.contact_id_a = ? OR ca.contact_id_b = ?)
     ORDER BY ca.confidence DESC
     LIMIT 20`
  ).bind(id, id, id).all();

  const signals = await env.D1.prepare(
    `SELECT field_name, proposed_value, confidence, status, change_type, source_communication_id, created_at
     FROM approval_queue
     WHERE org_id = ? AND entity_type = 'contact' AND entity_id = ?
       AND change_type NOT IN ('enrichment_report', 'progressive_update')
     ORDER BY created_at DESC LIMIT 10`
  ).bind(ctx.orgId, id).all();

  const weeklyInteractions = await env.D1.prepare(
    `SELECT strftime('%Y-%W', conv.sent_at) as week,
            MIN(conv.sent_at) as week_start,
            COUNT(*) as cnt
     FROM conversation_contacts cc
     JOIN conversations conv ON cc.conversation_id = conv.id
     WHERE cc.contact_id = ? AND conv.sent_at >= date('now', '-56 days')
     GROUP BY week ORDER BY week`
  ).bind(id).all();

  const firstInteraction = await env.D1.prepare(
    `SELECT MIN(conv.sent_at) as first_date
     FROM conversation_contacts cc
     JOIN conversations conv ON cc.conversation_id = conv.id
     WHERE cc.contact_id = ?`
  ).bind(id).first<{ first_date: string | null }>();

  return jsonResponse({
    contact,
    tags: tags.results,
    associations: assocRows.results,
    signals: signals.results,
    weekly_interactions: weeklyInteractions.results,
    first_interaction_date: firstInteraction?.first_date || null,
  });
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
    'location',
    'introduced_via',
    'investment_focus',
    'check_size_range',
    'fund_name',
    'commitment_status',
    'engagement_status',
    'relationship_owner_id',
  ];

  const updates: string[] = [];
  const binds: unknown[] = [];
  const changedFields: string[] = [];
  for (const k of allowed) {
    if (k in body) {
      updates.push(`${k} = ?`);
      binds.push(body[k]);
      const beforeVal = (before as any)[k];
      const beforeNorm = beforeVal == null ? '' : String(beforeVal).trim();
      const afterNorm = body[k] == null ? '' : String(body[k]).trim();
      if (beforeNorm !== afterNorm) changedFields.push(k);
    }
  }

  if ('engagement_status' in body) {
    updates.push('engagement_status_manual = ?');
    binds.push(1);
  }
  if ('relationship_owner_id' in body) {
    updates.push('relationship_owner_manual = ?');
    binds.push(1);
  }

  if (updates.length === 0) return jsonResponse({ contact: before });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

  await env.D1.prepare(
    `UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds, id).run();

  if (changedFields.length > 0) {
    await markFieldsHumanEdited(ctx.orgId, 'contact', id, changedFields, ctx.userId, env)
      .catch(e => console.error('[contacts] markFieldsHumanEdited failed:', e));
  }

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

  await env.D1.batch([
    env.D1.prepare('DELETE FROM deal_contacts WHERE contact_id = ?').bind(id),
    env.D1.prepare('DELETE FROM entity_associations WHERE (entity_a_type = ? AND entity_a_id = ?) OR (entity_b_type = ? AND entity_b_id = ?)').bind('contact', id, 'contact', id),
  ]);

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'soft_delete',
    entity_type: 'contact',
    entity_id: id,
    before_data: before,
    created_at: new Date().toISOString(),
  });

  try { await cleanupVectorsForEntity(id, 'contacts', env); } catch { /* best-effort */ }
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

  const [events, conversations, tasks, documents, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT e.id, e.title, e.start_time as timestamp, 'event' as type, e.event_type as subtype
       FROM events e JOIN event_attendees ea ON e.id = ea.event_id
       WHERE ea.contact_id = ? AND e.org_id = ? AND e.deleted_at IS NULL
       ORDER BY e.start_time DESC LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),
    env.D1.prepare(
      `SELECT c.id, c.subject as title, c.sent_at as timestamp, 'conversation' as type,
              c.source as subtype, c.body_preview, c.participant_user_ids,
              c.source as conv_source, c.is_campaign_email, c.from_email,
              c.has_attachments, c.attachment_count
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
      // Documents linked to this contact through the junction table. Includes
      // ACL columns so the post-query filter can apply isDocumentAccessibleToUser.
      `SELECT d.id, d.title, d.created_at as timestamp, 'document' as type, d.document_type as subtype,
              d.visibility, d.participant_user_ids, d.uploaded_by
         FROM documents d
         JOIN document_links dl ON dl.document_id = d.id
        WHERE dl.entity_type = 'contact' AND dl.entity_id = ?
          AND dl.deleted_at IS NULL AND d.deleted_at IS NULL
          AND d.org_id = ?
        ORDER BY d.created_at DESC LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const conversationIds = conversations.results
    .filter((c: any) => c.has_attachments)
    .map((c: any) => c.id);

  let attachmentsByConv: Record<string, string[]> = {};
  if (conversationIds.length > 0) {
    const placeholders = conversationIds.map(() => '?').join(',');
    // Junction-based lookup: find every document linked to any of these
    // conversations. ACL fields included so we can hide rows the requester
    // shouldn't see.
    const attRows = await env.D1.prepare(
      `SELECT dl.entity_id as conversation_id, d.file_name,
              d.visibility, d.participant_user_ids, d.uploaded_by
         FROM documents d
         JOIN document_links dl ON dl.document_id = d.id
        WHERE dl.entity_type = 'conversation' AND dl.entity_id IN (${placeholders})
          AND dl.deleted_at IS NULL AND d.deleted_at IS NULL
          AND d.org_id = ?
        ORDER BY d.created_at`
    ).bind(...conversationIds, ctx.orgId).all<{
      conversation_id: string; file_name: string;
      visibility: string | null; participant_user_ids: string | null; uploaded_by: string | null;
    }>();
    const sharingSet = new Set(Object.keys(sharingFlags));
    for (const row of attRows.results) {
      if (!isDocumentAccessibleToUser(row, ctx.userId, ctx.userRole, sharingSet)) continue;
      if (!attachmentsByConv[row.conversation_id]) attachmentsByConv[row.conversation_id] = [];
      attachmentsByConv[row.conversation_id].push(row.file_name);
    }
  }

  const conversationsWithAccess = conversations.results.map((c: any) => {
    const canRead = canReadEmailContent(
      {
        source: c.conv_source,
        participant_user_ids: c.participant_user_ids,
        is_campaign_email: c.is_campaign_email,
      } as any,
      ctx.userId,
      ctx.userRole,
      sharingFlags
    );
    return {
      ...c,
      canReadContent: canRead,
      body_preview: canRead ? c.body_preview : null,
      attachment_names: attachmentsByConv[c.id] || [],
    };
  });

  // ACL-filter the contact-linked documents before they hit the timeline.
  // Same gate as RAG / /api/documents — owner bypass, default-deny on missing
  // visibility, participant-or-uploader for private. Strip the ACL fields
  // from the response shape so the timeline sees only display columns.
  const docSharingSet = new Set(Object.keys(sharingFlags));
  const accessibleDocs = (documents.results as any[])
    .filter(d => isDocumentAccessibleToUser(d, ctx.userId, ctx.userRole, docSharingSet))
    .map(({ visibility: _v, participant_user_ids: _p, uploaded_by: _u, ...rest }) => rest);

  const entries = [
    ...events.results,
    ...conversationsWithAccess,
    ...tasks.results,
    ...accessibleDocs,
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
    `SELECT ea.id, ea.entity_a_type, ea.entity_a_id, ea.entity_b_type, ea.entity_b_id,
            ea.association_type, ea.strength, ea.reason, ea.evidence_count,
            ea.first_seen_at, ea.last_seen_at,
            CASE
              WHEN ea.entity_a_type = 'contact' AND ea.entity_a_id = ? THEN ea.entity_b_type
              ELSE ea.entity_a_type
            END as other_type,
            CASE
              WHEN ea.entity_a_type = 'contact' AND ea.entity_a_id = ? THEN ea.entity_b_id
              ELSE ea.entity_a_id
            END as other_id
     FROM entity_associations ea
     WHERE ea.org_id = ?
       AND ((ea.entity_a_type = 'contact' AND ea.entity_a_id = ?)
         OR (ea.entity_b_type = 'contact' AND ea.entity_b_id = ?))
     ORDER BY ea.strength DESC
     LIMIT 100`
  ).bind(id, id, ctx.orgId, id, id).all();

  const hydrated = [];
  for (const row of rows.results as any[]) {
    let entityName: string | null = null;
    let entityTitle: string | null = null;
    let entityAvatar: string | null = null;

    if (row.other_type === 'contact') {
      const c = await env.D1.prepare(
        'SELECT full_name, job_title, avatar_url FROM contacts WHERE id = ? AND deleted_at IS NULL'
      ).bind(row.other_id).first<{ full_name: string; job_title: string | null; avatar_url: string | null }>();
      if (c) {
        entityName = c.full_name;
        entityTitle = c.job_title;
        entityAvatar = c.avatar_url;
      }
    } else if (row.other_type === 'company') {
      const c = await env.D1.prepare(
        'SELECT name, sector FROM companies WHERE id = ? AND deleted_at IS NULL'
      ).bind(row.other_id).first<{ name: string; sector: string | null }>();
      if (c) {
        entityName = c.name;
        entityTitle = c.sector;
      }
    } else if (row.other_type === 'deal') {
      const d = await env.D1.prepare(
        'SELECT title, stage FROM deals WHERE id = ? AND deleted_at IS NULL'
      ).bind(row.other_id).first<{ title: string; stage: string | null }>();
      if (d) {
        entityName = d.title;
        entityTitle = d.stage;
      }
    }

    if (entityName) {
      hydrated.push({
        ...row,
        entity_name: entityName,
        entity_title: entityTitle,
        entity_avatar: entityAvatar,
      });
    }
  }

  const grouped = new Map<string, any>();
  for (const h of hydrated) {
    const key = `${h.other_type}:${h.other_id}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.association_types.includes(h.association_type)) {
        existing.association_types.push(h.association_type);
      }
      if (h.strength > existing.strength) existing.strength = h.strength;
      if (h.reason && !existing.reason.includes(h.reason)) {
        existing.reason = `${existing.reason} · ${h.reason}`;
      }
      existing.evidence_count = (existing.evidence_count || 0) + (h.evidence_count || 0);
    } else {
      grouped.set(key, {
        ...h,
        association_types: [h.association_type],
      });
    }
  }

  return jsonResponse({ associations: Array.from(grouped.values()) });
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
