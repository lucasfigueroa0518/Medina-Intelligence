// TRD §5.1, §11.1-§11.2 — Contact CRUD, merge, timeline, associations, enrich
import type { Env } from '../types/env';
import type { AuthContext, ContactFilter } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { mergeContacts, resolveMergedContact, cleanupVectorsForEntity } from '../lib/merge';
import { triggerContactEnrichment } from '../lib/enrichment';
import { updateContactFields } from '../lib/entity-writes';
import { cleanIntelligenceBrief } from '../lib/intelligence-briefing';
import {
  buildContactSearchQuery,
  contactSearchCteBinds,
  contactSearchCteSql,
  ensureContactSearchIndexReady,
  rebuildContactSearchIndexForOrg,
  safelyDeleteContactSearchIndexForContact,
  safelyRebuildContactSearchIndexForContact,
} from '../lib/contact-search';
import {
  listContactTimelineItems,
  loadContactActivityRollup,
  rebuildContactDetailReadModelForOrg,
  resolveCanonicalContactId,
  safelyDeleteContactDetailReadModelForContact,
  safelyRebuildContactDetailReadModelForContact,
} from '../lib/contact-detail-read-model';

// --- GET /api/contacts ---

// Maps the `sort` query param to a SQL column. Defaults to last_contact.
const CONTACT_SORT_MAP: Record<string, { col: string; defaultDir: 'ASC' | 'DESC' }> = {
  last_contact: { col: 'c.last_contact_date', defaultDir: 'DESC' },
  name: { col: 'c.full_name', defaultDir: 'ASC' },
  company: { col: 'co.name', defaultDir: 'ASC' },
  interactions: { col: 'c.total_interactions', defaultDir: 'DESC' },
  status: { col: 'c.engagement_status', defaultDir: 'ASC' },
  type: { col: 'c.contact_type', defaultDir: 'ASC' },
  created_at: { col: 'c.created_at', defaultDir: 'DESC' },
};

// Buckets that map the `last_contact` enum to a SQL predicate. The strings
// rely on D1's strftime/datetime functions; null handling stays explicit so
// `never` doesn't accidentally match every NULL row when the user picks a
// different bucket.
function lastContactPredicate(bucket: string): string | null {
  switch (bucket) {
    case 'today': return `c.last_contact_date >= datetime('now','start of day')`;
    case 'this_week': return `c.last_contact_date >= datetime('now','-7 days')`;
    case 'this_month': return `c.last_contact_date >= datetime('now','-30 days')`;
    case '1_3_months': return `c.last_contact_date >= datetime('now','-90 days') AND c.last_contact_date < datetime('now','-30 days')`;
    case '3_plus_months': return `c.last_contact_date IS NOT NULL AND c.last_contact_date < datetime('now','-90 days')`;
    case 'never': return `c.last_contact_date IS NULL`;
    default: return null;
  }
}

function interactionsPredicate(bucket: string): string | null {
  switch (bucket) {
    case '0': return `(c.total_interactions IS NULL OR c.total_interactions = 0)`;
    case '1_10': return `c.total_interactions BETWEEN 1 AND 10`;
    case '11_50': return `c.total_interactions BETWEEN 11 AND 50`;
    case '51_200': return `c.total_interactions BETWEEN 51 AND 200`;
    case '200_plus': return `c.total_interactions > 200`;
    default: return null;
  }
}

export async function listContacts(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const filter = parseContactFilter(url);
  const sp = url.searchParams;

  const where: string[] = ['c.org_id = ?', 'c.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  // Type — accepts new comma-separated `type` param OR legacy `contact_types`
  // multi-value param. Both bucket into the same IN clause.
  const typeList = readMulti(sp, 'type') ?? filter.contact_types;
  if (typeList?.length) {
    where.push(`c.contact_type IN (${typeList.map(() => '?').join(',')})`);
    binds.push(...typeList);
  }

  // Status — `status` is the user-facing alias for engagement_status. Legacy
  // `engagement_statuses` still works.
  const statusList = readMulti(sp, 'status') ?? filter.engagement_statuses;
  if (statusList?.length) {
    where.push(`c.engagement_status IN (${statusList.map(() => '?').join(',')})`);
    binds.push(...statusList);
  }

  if (filter.company_id) {
    where.push('c.company_id = ?');
    binds.push(filter.company_id);
  }

  // Last-contact bucket. Multi-value via comma-separated list ORs the buckets
  // (covers the "Stale 30+ Days" quick-filter that combines 1_3_months and
  // 3_plus_months).
  const lastContactBuckets = readMulti(sp, 'last_contact');
  if (lastContactBuckets?.length) {
    const predicates = lastContactBuckets
      .map(b => lastContactPredicate(b))
      .filter((p): p is string => !!p);
    if (predicates.length) where.push(`(${predicates.join(' OR ')})`);
  }

  // Legacy date range filters still honored.
  if (filter.last_contact_before) {
    where.push('c.last_contact_date < ?');
    binds.push(filter.last_contact_before);
  }
  if (filter.last_contact_after) {
    where.push('c.last_contact_date > ?');
    binds.push(filter.last_contact_after);
  }

  // Interactions bucket.
  const interactionsBucket = sp.get('interactions');
  if (interactionsBucket) {
    const pred = interactionsPredicate(interactionsBucket);
    if (pred) where.push(pred);
  }

  if (filter.meetings_last_30d_min !== undefined) {
    where.push('c.meetings_last_30d >= ?');
    binds.push(filter.meetings_last_30d_min);
  }

  const search = sp.get('search') ?? filter.keyword;
  const contactSearch = buildContactSearchQuery(search);

  if (filter.has_followup_overdue) {
    where.push(
      `c.next_followup_date IS NOT NULL AND c.next_followup_date < strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    );
  }

  // "In active deals" — quick-filter predicate. Active = stage NOT closed_*.
  if (sp.get('in_active_deals') === 'true') {
    where.push(
      `EXISTS (SELECT 1 FROM deal_contacts dc
               JOIN deals d ON dc.deal_id = d.id
               WHERE dc.contact_id = c.id
                 AND d.deleted_at IS NULL
                 AND d.stage NOT IN ('closed','closed_won','closed_lost'))`
    );
  }

  // Tag filtering — `tags` accepts comma-separated tag IDs (new behavior) OR
  // the legacy `tags` multi-value with names. Production tag IDs are UUIDs,
  // while older local/dev rows may use dashless hex IDs.
  let tagJoin = '';
  const tagsParam = readMulti(sp, 'tags') ?? filter.tags;
  if (tagsParam?.length) {
    const looksLikeIds = looksLikeTagIds(tagsParam);
    tagJoin = `JOIN contact_tags ct ON c.id = ct.contact_id
               JOIN tags t ON ct.tag_id = t.id`;
    if (looksLikeIds) {
      where.push(`t.id IN (${tagsParam.map(() => '?').join(',')})`);
    } else {
      where.push(`t.name IN (${tagsParam.map(() => '?').join(',')})`);
    }
    binds.push(...tagsParam);
  }

  // Sort. New `sort`/`order` aliases take precedence; legacy `sort_by`/
  // `sort_dir` still works for older clients.
  const sortKey = sp.get('sort') ?? legacySortAlias(filter.sort_by);
  const sortMeta = CONTACT_SORT_MAP[sortKey ?? 'last_contact'] ?? CONTACT_SORT_MAP.last_contact;
  const orderParam = sp.get('order') ?? filter.sort_dir;
  const sortDir = orderParam
    ? (orderParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC')
    : sortMeta.defaultDir;

  // Default to 100/page, ceiling 500. Frontend uses cumulative "load more"
  // pagination so initial load stays fast even at 10k+ records.
  const limit = Math.min(filter.limit || 100, 500);
  const offset = filter.offset || 0;

  const havingClause =
    tagsParam?.length && filter.tag_logic === 'and'
      ? `HAVING COUNT(DISTINCT t.id) = ${tagsParam.length}`
      : '';

  // status sort breaks ties alphabetically so the "groups by status" output
  // matches user expectation; otherwise just append id for stable pagination.
  const tieBreak = sortKey === 'status' ? ', c.full_name ASC' : ', c.id ASC';

  const companyNameSql = `
    COALESCE(
      co.name,
      (
        SELECT eco.name
          FROM entity_associations ea
          JOIN companies eco
            ON eco.id = CASE
                 WHEN ea.entity_a_type = 'company' THEN ea.entity_a_id
                 ELSE ea.entity_b_id
               END
         WHERE ea.org_id = c.org_id
           AND eco.org_id = c.org_id
           AND eco.deleted_at IS NULL
           AND eco.merged_into IS NULL
           AND (
             (ea.entity_a_type = 'contact' AND ea.entity_a_id = c.id AND ea.entity_b_type = 'company')
             OR (ea.entity_b_type = 'contact' AND ea.entity_b_id = c.id AND ea.entity_a_type = 'company')
           )
         ORDER BY ea.strength DESC
         LIMIT 1
      ),
      (
        SELECT dco.name
          FROM deal_contacts dc
          JOIN deals d ON d.id = dc.deal_id
          JOIN companies dco ON dco.id = d.company_id
         WHERE dc.contact_id = c.id
           AND d.org_id = c.org_id
           AND d.deleted_at IS NULL
           AND dco.org_id = c.org_id
           AND dco.deleted_at IS NULL
           AND dco.merged_into IS NULL
         ORDER BY d.updated_at DESC
         LIMIT 1
      ),
      (
        SELECT sco.name
          FROM companies sco
         WHERE sco.org_id = c.org_id
           AND sco.deleted_at IS NULL
           AND sco.merged_into IS NULL
           AND sco.domain IS NOT NULL
           AND sco.domain != ''
           AND c.email IS NOT NULL
           AND (
             LOWER(c.email) LIKE '%@' || LOWER(sco.domain)
             OR LOWER(c.email) LIKE '%@%.' || LOWER(sco.domain)
           )
         ORDER BY LENGTH(sco.domain) DESC
         LIMIT 1
      )
    )
  `;

  let sql: string;
  let countSql: string;
  let resultBinds: unknown[];
  let countBinds: unknown[];

  if (contactSearch) {
    const ready = await ensureContactSearchIndexReady(env, ctx.orgId);
    if (!ready.ok) return errorResponse(ready.code, 503, ready.message);

    const searchBinds = contactSearchCteBinds(contactSearch, ctx.orgId);
    const cte = contactSearchCteSql();

    sql = `
      ${cte}
      SELECT c.*, ${companyNameSql} as company_name
      FROM matched m
      JOIN contacts c ON c.id = m.contact_id
      LEFT JOIN companies co ON c.company_id = co.id
      ${tagJoin}
      WHERE ${where.join(' AND ')}
      GROUP BY c.id
      ${havingClause}
      ORDER BY m.search_rank ASC, m.fts_rank ASC, ${sortMeta.col} ${sortDir} NULLS LAST${tieBreak}
      LIMIT ? OFFSET ?
    `;

    const countFrom = `
      FROM matched m
      JOIN contacts c ON c.id = m.contact_id
      LEFT JOIN companies co ON c.company_id = co.id
      ${tagJoin}
      WHERE ${where.join(' AND ')}
    `;
    countSql = havingClause
      ? `${cte} SELECT COUNT(*) as n FROM (SELECT c.id ${countFrom} GROUP BY c.id ${havingClause})`
      : `${cte} SELECT COUNT(DISTINCT c.id) as n ${countFrom}`;
    resultBinds = [...searchBinds, ...binds, limit, offset];
    countBinds = [...searchBinds, ...binds];
  } else {
    sql = `
      SELECT c.*, ${companyNameSql} as company_name
      FROM contacts c
      LEFT JOIN companies co ON c.company_id = co.id
      ${tagJoin}
      WHERE ${where.join(' AND ')}
      GROUP BY c.id
      ${havingClause}
      ORDER BY ${sortMeta.col} ${sortDir} NULLS LAST${tieBreak}
      LIMIT ? OFFSET ?
    `;

    const countFrom = `
      FROM contacts c
      LEFT JOIN companies co ON c.company_id = co.id
      ${tagJoin}
      WHERE ${where.join(' AND ')}
    `;
    countSql = havingClause
      ? `SELECT COUNT(*) as n FROM (SELECT c.id ${countFrom} GROUP BY c.id ${havingClause})`
      : `SELECT COUNT(DISTINCT c.id) as n ${countFrom}`;
    resultBinds = [...binds, limit, offset];
    countBinds = binds;
  }

  const [result, countResult] = await Promise.all([
    env.D1.prepare(sql).bind(...resultBinds).all(),
    env.D1.prepare(countSql).bind(...countBinds).first<{ n: number }>(),
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

  return jsonResponse({
    contacts,
    limit,
    offset,
    total,
    has_more: offset + contacts.length < total,
  });
}

function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

// Reads a query param that may be supplied either as multiple
// instances (legacy `tags=foo&tags=bar`) or as a single
// comma-separated string (new `tags=foo,bar`). Returns undefined when
// the param is absent so callers can fall through to other sources.
function readMulti(sp: URLSearchParams, key: string): string[] | undefined {
  const all = sp.getAll(key);
  if (all.length === 0) return undefined;
  if (all.length === 1) return parseList(all[0]);
  return all;
}

function looksLikeTagIds(values: string[]): boolean {
  return values.every(value =>
    /^[a-f0-9]{16,}$/i.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// Old `sort_by` values still used by some callers — translate to the new keys.
function legacySortAlias(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key === 'last_contact_date') return 'last_contact';
  if (key === 'total_interactions') return 'interactions';
  if (key === 'full_name') return 'name';
  return key;
}

// --- GET /api/contacts/companies ---
// Distinct companies that have at least one contact, with contact counts.
// Powers the typeahead in the contacts filter rail.
export async function listContactCompanies(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT co.id, co.name, COUNT(c.id) as count
     FROM companies co
     JOIN contacts c ON c.company_id = co.id
     WHERE co.org_id = ? AND co.deleted_at IS NULL AND c.deleted_at IS NULL
     GROUP BY co.id
     ORDER BY co.name COLLATE NOCASE ASC`
  ).bind(ctx.orgId).all<{ id: string; name: string; count: number }>();

  return jsonResponse(
    { companies: rows.results },
    200,
    { 'Cache-Control': 'private, max-age=300' }
  );
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
  await safelyRebuildContactSearchIndexForContact(env, ctx.orgId, id);
  ctxExec.waitUntil(safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, id, 'contact_created'));

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
  env: Env,
  ctxExec?: ExecutionContext
): Promise<Response> {
  const canonical = await resolveCanonicalContactId(env, ctx.orgId, id);
  if (!canonical) return errorResponse('CONTACT_NOT_FOUND', 404);
  const contactId = canonical.contactId;

  const contact = await env.D1.prepare(
    `SELECT c.*, co.name as company_name,
            u.full_name as owner_name, u.avatar_url as owner_avatar, u.email as owner_email
     FROM contacts c
     LEFT JOIN companies co ON c.company_id = co.id
     LEFT JOIN users u ON c.relationship_owner_id = u.id
     WHERE c.id = ? AND c.org_id = ? AND c.deleted_at IS NULL`
  ).bind(contactId, ctx.orgId).first();

  if (!contact) return errorResponse('CONTACT_NOT_FOUND', 404);

  const [tags, assocRows, signals, rollup] = await Promise.all([
    env.D1.prepare(
      `SELECT t.id, t.name, t.color FROM tags t
       JOIN contact_tags ct ON t.id = ct.tag_id
       WHERE ct.contact_id = ?`
    ).bind(contactId).all(),
    env.D1.prepare(
      `SELECT ca.contact_id_a, ca.contact_id_b, ca.relationship, ca.confidence,
              c2.full_name as other_name, c2.job_title as other_title, c2.company_id as other_company_id
       FROM contact_associations ca
       LEFT JOIN contacts c2 ON c2.id = CASE WHEN ca.contact_id_a = ? THEN ca.contact_id_b ELSE ca.contact_id_a END
       WHERE (ca.contact_id_a = ? OR ca.contact_id_b = ?)
       ORDER BY ca.confidence DESC
       LIMIT 20`
    ).bind(contactId, contactId, contactId).all(),
    env.D1.prepare(
      `SELECT field_name, proposed_value, confidence, status, change_type, source_communication_id, created_at
       FROM approval_queue
       WHERE org_id = ? AND entity_type = 'contact' AND entity_id = ?
         AND change_type NOT IN ('enrichment_report', 'progressive_update')
       ORDER BY created_at DESC LIMIT 10`
    ).bind(ctx.orgId, contactId).all(),
    loadContactActivityRollup(env, ctx.orgId, contactId),
  ]);

  if (!rollup) {
    ctxExec?.waitUntil(
      safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, contactId, 'missing_rollup_on_detail_load')
    );
  }

  return jsonResponse({
    contact,
    tags: tags.results,
    associations: assocRows.results,
    signals: signals.results,
    weekly_interactions: rollup?.weekly_interactions || [],
    first_interaction_date: rollup?.first_interaction_date || null,
    activity_rollup: rollup,
    canonical_contact_id: contactId,
    redirected_from: canonical.redirectedFrom,
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

  // Phase 1 refactor: all write logic, lock checks, audit, and
  // entity_field_state sync now lives in src/lib/entity-writes.ts.
  // Same code path that MARTy's update_contact_field tool will call
  // in Phase 2 — single source of truth for human-edit semantics.
  const result = await updateContactFields(id, body, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    userRole: ctx.userRole,
    origin: 'manual_ui',
  }, env);

  if (!result.ok && result.error) {
    return errorResponse(result.error.code, result.error.status, result.error.message);
  }

  // Surface per-field rejections (lock violations, unknown fields) so
  // the UI can render "this field couldn't be updated because…"
  // alongside the successful subset. Backward-compat: when nothing
  // was rejected, the response body is identical to the pre-refactor
  // shape ({ contact }).
  const responseBody: Record<string, unknown> = { contact: result.after };
  if (result.rejected.length > 0) {
    responseBody.rejected_fields = result.rejected;
  }
  return jsonResponse(responseBody);
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
  await safelyDeleteContactSearchIndexForContact(env, ctx.orgId, id);
  await safelyDeleteContactDetailReadModelForContact(env, ctx.orgId, id);
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
  await safelyRebuildContactSearchIndexForContact(env, ctx.orgId, id);
  await safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, id, 'contact_tags_changed');
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

  await safelyRebuildContactSearchIndexForContact(env, ctx.orgId, id);
  await safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, id, 'contact_tags_changed');
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
  await safelyRebuildContactSearchIndexForContact(env, ctx.orgId, body.keep_id);
  await safelyDeleteContactSearchIndexForContact(env, ctx.orgId, body.discard_id);
  await safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, body.keep_id, 'contact_merge');
  await safelyDeleteContactDetailReadModelForContact(env, ctx.orgId, body.discard_id);
  return jsonResponse({ ok: true });
}

export async function rebuildContactSearchIndexEndpoint(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin' && ctx.userRole !== 'super_admin') {
    return errorResponse('FORBIDDEN', 403, 'owner/admin only');
  }
  const result = await rebuildContactSearchIndexForOrg(env, ctx.orgId);
  return jsonResponse({ ok: result.errors === 0, ...result });
}

export async function rebuildContactDetailReadModelEndpoint(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin' && ctx.userRole !== 'super_admin') {
    return errorResponse('FORBIDDEN', 403, 'owner/admin only');
  }

  const body = await parseJsonBody<{ contact_id?: string; limit?: number }>(request);
  if (body?.contact_id) {
    const canonical = await resolveCanonicalContactId(env, ctx.orgId, body.contact_id);
    if (!canonical) return errorResponse('CONTACT_NOT_FOUND', 404);
    await safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, canonical.contactId, 'admin_rebuild');
    return jsonResponse({
      ok: true,
      rebuilt: 1,
      contact_id: canonical.contactId,
      redirected_from: canonical.redirectedFrom,
    });
  }

  const result = await rebuildContactDetailReadModelForOrg(env, ctx.orgId, body?.limit || 500);
  return jsonResponse({ ok: result.errors === 0, ...result });
}

// --- GET /api/contacts/:id/timeline ---

export async function getContactTimeline(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const canonical = await resolveCanonicalContactId(env, ctx.orgId, id);
  if (!canonical) return errorResponse('CONTACT_NOT_FOUND', 404);

  let result = await listContactTimelineItems(request, env, ctx, canonical.contactId);

  // During rollout or after drift, do a bounded self-heal once instead of
  // showing an empty timeline for a known contact. Warmed contacts stay on the
  // indexed path after this repair.
  if (result.entries.length === 0 && !new URL(request.url).searchParams.get('cursor')) {
    await safelyRebuildContactDetailReadModelForContact(
      env,
      ctx.orgId,
      canonical.contactId,
      'empty_timeline_on_detail_load'
    );
    result = await listContactTimelineItems(request, env, ctx, canonical.contactId);
  }

  return jsonResponse({
    entries: result.entries,
    next_cursor: result.next_cursor,
    canonical_contact_id: canonical.contactId,
    redirected_from: canonical.redirectedFrom,
  });
}

// --- GET /api/contacts/:id/associations ---

export async function getContactAssociations(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const canonical = await resolveCanonicalContactId(env, ctx.orgId, id);
  if (!canonical) return errorResponse('CONTACT_NOT_FOUND', 404);
  const contactId = canonical.contactId;

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
  ).bind(contactId, contactId, ctx.orgId, contactId, contactId).all<any>();

  const byType = new Map<string, Set<string>>();
  for (const row of rows.results) {
    if (!byType.has(row.other_type)) byType.set(row.other_type, new Set());
    byType.get(row.other_type)!.add(row.other_id);
  }

  const loadByIds = async <T extends Record<string, any>>(
    table: string,
    fields: string,
    ids: string[]
  ): Promise<Map<string, T>> => {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const result = await env.D1.prepare(
      `SELECT id, ${fields} FROM ${table} WHERE org_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`
    ).bind(ctx.orgId, ...ids).all<T & { id: string }>();
    return new Map(result.results.map(row => [row.id, row as T]));
  };

  const [contactMap, companyMap, dealMap] = await Promise.all([
    loadByIds<{ full_name: string; job_title: string | null; avatar_url: string | null }>(
      'contacts',
      'full_name, job_title, avatar_url',
      Array.from(byType.get('contact') || [])
    ),
    loadByIds<{ name: string; sector: string | null }>(
      'companies',
      'name, sector',
      Array.from(byType.get('company') || [])
    ),
    loadByIds<{ title: string; stage: string | null }>(
      'deals',
      'title, stage',
      Array.from(byType.get('deal') || [])
    ),
  ]);

  const hydrated = [];
  for (const row of rows.results as any[]) {
    let entityName: string | null = null;
    let entityTitle: string | null = null;
    let entityAvatar: string | null = null;

    if (row.other_type === 'contact') {
      const c = contactMap.get(row.other_id);
      if (c) {
        entityName = c.full_name;
        entityTitle = c.job_title;
        entityAvatar = c.avatar_url;
      }
    } else if (row.other_type === 'company') {
      const c = companyMap.get(row.other_id);
      if (c) {
        entityName = c.name;
        entityTitle = c.sector;
      }
    } else if (row.other_type === 'deal') {
      const d = dealMap.get(row.other_id);
      if (d) {
        entityName = d.title;
        entityTitle = d.stage;
      }
    }

    if (entityName) hydrated.push({ ...row, entity_name: entityName, entity_title: entityTitle, entity_avatar: entityAvatar });
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

  return jsonResponse({
    associations: Array.from(grouped.values()),
    canonical_contact_id: canonical.contactId,
    redirected_from: canonical.redirectedFrom,
  });
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
  const canonical = await resolveCanonicalContactId(env, ctx.orgId, id);
  if (!canonical) return errorResponse('CONTACT_NOT_FOUND', 404);

  const contact = await env.D1.prepare(
    `SELECT id, full_name, web_enrichment_r2_key, bio_summary,
            enrichment_confidence, enrichment_last_run
     FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(canonical.contactId, ctx.orgId).first<{
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
      canonical_contact_id: canonical.contactId,
      redirected_from: canonical.redirectedFrom,
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
      canonical_contact_id: canonical.contactId,
      redirected_from: canonical.redirectedFrom,
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
    fullBio = cleanIntelligenceBrief(parsed.full_bio) || null;
  } catch {
    // Legacy format: raw body IS the bio text.
    fullBio = cleanIntelligenceBrief(raw) || null;
  }

  return jsonResponse({
    contact_id: contact.id,
    canonical_contact_id: canonical.contactId,
    redirected_from: canonical.redirectedFrom,
    short_bio: contact.bio_summary,
    full_bio: fullBio,
    enrichment_confidence: contact.enrichment_confidence,
    enrichment_last_run: contact.enrichment_last_run,
    status: 'ok',
  });
}
