import type { Env } from '../types/env';
import type { AuthContext, ContactFilter } from '../types/interfaces';
import { conversationAclSql } from './email-derived-visibility';
import { getSharingFlags, hasOrgWidePrivateDataAccess } from './helpers';
import {
  buildContactSearchQuery,
  contactSearchCteBinds,
  contactSearchCteSql,
  ensureContactSearchIndexReady,
} from './contact-search';

const DEFAULT_LIMIT = 100;
const BOOTSTRAP_LIMIT = 250;
const MAX_LIMIT = 500;
const CONTACT_LIST_REPAIR_LIMIT = 100;

type SortDir = 'ASC' | 'DESC';

interface ContactSortMeta {
  col: string;
  defaultDir: SortDir;
}

const CONTACT_SORT_MAP: Record<string, ContactSortMeta> = {
  last_contact: { col: 'activity_last_contact_date', defaultDir: 'DESC' },
  name: { col: 'cle.full_name COLLATE NOCASE', defaultDir: 'ASC' },
  company: { col: 'cle.company_name COLLATE NOCASE', defaultDir: 'ASC' },
  interactions: { col: 'activity_total_interactions', defaultDir: 'DESC' },
  status: { col: 'cle.engagement_status', defaultDir: 'ASC' },
  type: { col: 'cle.contact_type', defaultDir: 'ASC' },
  created_at: { col: 'cle.contact_created_at', defaultDir: 'DESC' },
};

interface ParsedContactListRequest {
  filter: ContactFilter;
  search: string | null;
  typeList?: string[];
  statusList?: string[];
  lastContactBuckets?: string[];
  interactionsBucket: string | null;
  tagsParam?: string[];
  sortKey: string;
  sortMeta: ContactSortMeta;
  sortDir: SortDir;
  limit: number;
  offset: number;
  cursor: ContactListCursor | null;
  useOffsetCursor: boolean;
}

export interface ContactListCursor {
  mode: 'seek' | 'offset';
  offset: number;
  sort: string;
  order: 'asc' | 'desc';
  value?: string | number | null;
  id?: string;
}

export interface ContactListFacets {
  tags: any[];
  companies: Array<{ id: string; name: string; count: number }>;
  filter_counts: {
    contact_type: Record<string, number>;
    engagement_status: Record<string, number>;
    tags: Record<string, number>;
    overdue_followups: number;
  };
}

export interface ContactListResult {
  contacts: any[];
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
  next_cursor: string | null;
  facets?: ContactListFacets;
}

export interface ContactListErrorResult {
  error: { code: string; status: number; message?: string };
}

function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

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

function lastContactPredicate(bucket: string, col: string): string | null {
  switch (bucket) {
    case 'today': return `${col} >= datetime('now','start of day')`;
    case 'this_week': return `${col} >= datetime('now','-7 days')`;
    case 'this_month': return `${col} >= datetime('now','-30 days')`;
    case '1_3_months': return `${col} >= datetime('now','-90 days') AND ${col} < datetime('now','-30 days')`;
    case '3_plus_months': return `${col} IS NOT NULL AND ${col} < datetime('now','-90 days')`;
    case 'never': return `${col} IS NULL`;
    default: return null;
  }
}

function interactionsPredicate(bucket: string, col: string): string | null {
  switch (bucket) {
    case '0': return `${col} = 0`;
    case '1_10': return `${col} BETWEEN 1 AND 10`;
    case '11_50': return `${col} BETWEEN 11 AND 50`;
    case '51_200': return `${col} BETWEEN 51 AND 200`;
    case '200_plus': return `${col} > 200`;
    default: return null;
  }
}

function legacySortAlias(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key === 'last_contact_date') return 'last_contact';
  if (key === 'total_interactions') return 'interactions';
  if (key === 'full_name') return 'name';
  return key;
}

function parseContactFilter(url: URL): ContactFilter {
  const f: ContactFilter = {};
  const sp = url.searchParams;
  if (sp.getAll('contact_types').length) f.contact_types = sp.getAll('contact_types');
  if (sp.getAll('engagement_statuses').length) f.engagement_statuses = sp.getAll('engagement_statuses');
  if (sp.getAll('tags').length) f.tags = sp.getAll('tags');
  if (sp.get('tag_logic')) f.tag_logic = sp.get('tag_logic') as 'and' | 'or';
  if (sp.get('company_id')) f.company_id = sp.get('company_id')!;
  if (sp.get('last_contact_before')) f.last_contact_before = sp.get('last_contact_before')!;
  if (sp.get('last_contact_after')) f.last_contact_after = sp.get('last_contact_after')!;
  if (sp.get('keyword')) f.keyword = sp.get('keyword')!;
  if (sp.get('has_followup_overdue') === 'true') f.has_followup_overdue = true;
  if (sp.get('sort_by')) f.sort_by = sp.get('sort_by') as ContactFilter['sort_by'];
  if (sp.get('sort_dir')) f.sort_dir = sp.get('sort_dir') as ContactFilter['sort_dir'];
  if (sp.get('limit')) f.limit = parseInt(sp.get('limit')!, 10);
  if (sp.get('offset')) f.offset = parseInt(sp.get('offset')!, 10);
  return f;
}

function base64UrlEncode(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  if (typeof atob === 'function') {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return atob(padded);
  }
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function encodeContactListCursor(cursor: ContactListCursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeContactListCursor(raw: string | null): ContactListCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(raw));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.mode !== 'seek' && parsed.mode !== 'offset') return null;
    if (typeof parsed.offset !== 'number' || parsed.offset < 0) return null;
    if (typeof parsed.sort !== 'string') return null;
    if (parsed.order !== 'asc' && parsed.order !== 'desc') return null;
    return parsed as ContactListCursor;
  } catch {
    return null;
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value || NaN)) return fallback;
  return Math.max(1, Math.min(Number(value), MAX_LIMIT));
}

function parseRequest(url: URL, defaultLimit: number): ParsedContactListRequest {
  const filter = parseContactFilter(url);
  const sp = url.searchParams;
  const search = sp.get('search') ?? filter.keyword ?? null;
  const sortKey = sp.get('sort') ?? legacySortAlias(filter.sort_by) ?? 'last_contact';
  const sortMeta = CONTACT_SORT_MAP[sortKey] ?? CONTACT_SORT_MAP.last_contact;
  const orderParam = sp.get('order') ?? filter.sort_dir;
  const sortDir: SortDir = orderParam
    ? (orderParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC')
    : sortMeta.defaultDir;
  const cursor = decodeContactListCursor(sp.get('cursor'));
  const useOffsetCursor = Boolean(search && buildContactSearchQuery(search));
  const offsetFromCursor = cursor?.mode === 'offset' ? cursor.offset : undefined;

  return {
    filter,
    search,
    typeList: readMulti(sp, 'type') ?? filter.contact_types,
    statusList: readMulti(sp, 'status') ?? filter.engagement_statuses,
    lastContactBuckets: readMulti(sp, 'last_contact'),
    interactionsBucket: sp.get('interactions'),
    tagsParam: readMulti(sp, 'tags') ?? filter.tags,
    sortKey,
    sortMeta,
    sortDir,
    limit: boundedLimit(filter.limit, defaultLimit),
    offset: offsetFromCursor ?? filter.offset ?? 0,
    cursor,
    useOffsetCursor,
  };
}

function tagFilterPredicate(tags: string[], tagLogic: 'and' | 'or' | undefined, binds: unknown[]): string {
  const looksLikeIds = looksLikeTagIds(tags);
  const tagColumn = looksLikeIds ? 'ct.tag_id' : 't.name';
  const joinTags = looksLikeIds ? '' : 'JOIN tags t ON t.id = ct.tag_id';
  const placeholders = tags.map(() => '?').join(',');
  binds.push(...tags);

  if (tagLogic === 'and') {
    return `cle.contact_id IN (
      SELECT ct.contact_id
        FROM contact_tags ct
        ${joinTags}
       WHERE ${tagColumn} IN (${placeholders})
       GROUP BY ct.contact_id
      HAVING COUNT(DISTINCT ${tagColumn}) = ${tags.length}
    )`;
  }

  return `EXISTS (
    SELECT 1
      FROM contact_tags ct
      ${joinTags}
     WHERE ct.contact_id = cle.contact_id
       AND ${tagColumn} IN (${placeholders})
  )`;
}

function cursorPredicate(
  cursor: ContactListCursor | null,
  req: ParsedContactListRequest,
  sortExpr: string,
  binds: unknown[]
): string | null {
  if (!cursor || cursor.mode !== 'seek') return null;
  if (cursor.sort !== req.sortKey || cursor.order !== req.sortDir.toLowerCase()) return null;
  if (!cursor.id) return null;

  if (cursor.value == null) {
    binds.push(cursor.id);
    return `(${sortExpr} IS NULL AND cle.contact_id > ?)`;
  }

  const op = req.sortDir === 'ASC' ? '>' : '<';
  binds.push(cursor.value, cursor.value, cursor.id);
  return `((${sortExpr} ${op} ?) OR ${sortExpr} IS NULL OR (${sortExpr} = ? AND cle.contact_id > ?))`;
}

function parseTags(raw: unknown): any[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mapContactRow(row: any): any {
  const contact = { ...row };
  contact.id = row.id || row.contact_id;
  contact.last_contact_date = row.__last_contact_date || null;
  contact.total_interactions = Number(row.__total_interactions || 0);
  contact.tags = parseTags(row.__tags_json);
  contact.active_deal_count = Number(row.active_deal_count || 0);
  contact.in_active_deals = Number(row.in_active_deals || 0) === 1;
  delete contact.__last_contact_date;
  delete contact.__total_interactions;
  delete contact.__tags_json;
  delete contact.__cursor_sort_value;
  return contact;
}

export async function loadContactListFacets(ctx: AuthContext, env: Env): Promise<ContactListFacets> {
  const [typeCounts, statusCounts, tagCounts, overdueCount, tags, companies] = await Promise.all([
    env.D1.prepare(
      `SELECT contact_type, COUNT(*) as cnt
         FROM contact_list_entries
        WHERE org_id = ?
        GROUP BY contact_type`
    ).bind(ctx.orgId).all<{ contact_type: string; cnt: number }>(),
    env.D1.prepare(
      `SELECT engagement_status, COUNT(*) as cnt
         FROM contact_list_entries
        WHERE org_id = ?
        GROUP BY engagement_status`
    ).bind(ctx.orgId).all<{ engagement_status: string | null; cnt: number }>(),
    env.D1.prepare(
      `SELECT ct.tag_id, COUNT(*) as cnt
         FROM contact_tags ct
         JOIN contact_list_entries cle ON cle.contact_id = ct.contact_id
        WHERE cle.org_id = ?
        GROUP BY ct.tag_id`
    ).bind(ctx.orgId).all<{ tag_id: string; cnt: number }>(),
    env.D1.prepare(
      `SELECT COUNT(*) as cnt
         FROM contact_list_entries
        WHERE org_id = ?
          AND next_followup_date IS NOT NULL
          AND next_followup_date < strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(ctx.orgId).first<{ cnt: number }>(),
    env.D1.prepare(
      `SELECT t.*,
              COALESCE(tc.cnt, 0) as contact_count,
              0 as company_count
         FROM tags t
         LEFT JOIN (
           SELECT ct.tag_id, COUNT(*) as cnt
             FROM contact_tags ct
             JOIN contact_list_entries cle ON cle.contact_id = ct.contact_id
            WHERE cle.org_id = ?
            GROUP BY ct.tag_id
         ) tc ON tc.tag_id = t.id
        WHERE t.org_id = ?
          AND t.entity_type = 'contact'
        ORDER BY t.name COLLATE NOCASE ASC`
    ).bind(ctx.orgId, ctx.orgId).all<any>(),
    env.D1.prepare(
      `SELECT company_id as id, company_name as name, COUNT(*) as count
         FROM contact_list_entries
        WHERE org_id = ?
          AND company_id IS NOT NULL
          AND company_name IS NOT NULL
          AND company_name != ''
        GROUP BY company_id, company_name
        ORDER BY company_name COLLATE NOCASE ASC`
    ).bind(ctx.orgId).all<{ id: string; name: string; count: number }>(),
  ]);

  const contact_type: Record<string, number> = {};
  for (const row of typeCounts.results) contact_type[row.contact_type] = row.cnt;

  const engagement_status: Record<string, number> = {};
  for (const row of statusCounts.results) {
    if (row.engagement_status) engagement_status[row.engagement_status] = row.cnt;
  }

  const tagCountMap: Record<string, number> = {};
  for (const row of tagCounts.results) tagCountMap[row.tag_id] = row.cnt;

  return {
    tags: tags.results,
    companies: companies.results,
    filter_counts: {
      contact_type,
      engagement_status,
      tags: tagCountMap,
      overdue_followups: overdueCount?.cnt || 0,
    },
  };
}

export async function listContactsFromReadModel(
  request: Request,
  ctx: AuthContext,
  env: Env,
  opts: { includeFacets?: boolean; defaultLimit?: number } = {}
): Promise<ContactListResult | ContactListErrorResult> {
  const url = new URL(request.url);
  const req = parseRequest(url, opts.defaultLimit || DEFAULT_LIMIT);
  const where: string[] = ['cle.org_id = ?', 'c.deleted_at IS NULL', 'c.merged_into IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  const searchQuery = buildContactSearchQuery(req.search);

  const orgWideActivity = hasOrgWidePrivateDataAccess(ctx.userRole);
  let activityLastCol = 'cle.last_contact_date';
  let activityInteractionsCol = 'COALESCE(cle.total_interactions, 0)';
  let viewerRollupJoin = '';
  let viewerRollupBinds: unknown[] = [];

  if (!orgWideActivity) {
    const sharingFlags = await getSharingFlags(ctx.orgId, env);
    const sharedUserIds = Object.keys(sharingFlags).filter(userId => sharingFlags[userId]);
    const acl = conversationAclSql('vc', ctx, sharingFlags, 'vsc.is_private');
    const eventAclParts = ['all_ea.user_id = ?'];
    if (sharedUserIds.length) {
      eventAclParts.push(`all_ea.user_id IN (${sharedUserIds.map(() => '?').join(',')})`);
    }
    viewerRollupBinds = [ctx.orgId, ...acl.binds, ctx.orgId, ctx.userId, ...sharedUserIds];
    viewerRollupJoin = `
      LEFT JOIN (
        SELECT cc.contact_id,
               MAX(vc.sent_at) AS viewer_last_contact_date,
               COUNT(*) AS viewer_total_interactions
          FROM conversation_contacts cc
          JOIN conversations vc
            ON vc.id = cc.conversation_id
           AND vc.org_id = ?
          LEFT JOIN slack_channels vsc
            ON vc.source = 'slack'
           AND vsc.org_id = vc.org_id
           AND vsc.channel_id = CASE
             WHEN instr(vc.external_message_id, ':') > 0
             THEN substr(vc.external_message_id, 1, instr(vc.external_message_id, ':') - 1)
             ELSE vc.external_message_id
           END
         WHERE ${acl.sql}
         GROUP BY cc.contact_id
      ) vr ON vr.contact_id = cle.contact_id
      LEFT JOIN (
        SELECT ea.contact_id,
               MAX(e.start_time) AS viewer_last_event_date,
               COUNT(DISTINCT e.id) AS viewer_event_interactions
          FROM event_attendees ea
          JOIN events e
            ON e.id = ea.event_id
           AND e.org_id = ?
           AND e.deleted_at IS NULL
          LEFT JOIN event_attendees all_ea
            ON all_ea.event_id = e.id
         WHERE ea.contact_id IS NOT NULL
           AND e.start_time IS NOT NULL
           AND (${eventAclParts.join(' OR ')})
         GROUP BY ea.contact_id
      ) ver ON ver.contact_id = cle.contact_id
    `;
    activityLastCol = `CASE
      WHEN vr.viewer_last_contact_date IS NULL THEN ver.viewer_last_event_date
      WHEN ver.viewer_last_event_date IS NULL THEN vr.viewer_last_contact_date
      WHEN vr.viewer_last_contact_date >= ver.viewer_last_event_date THEN vr.viewer_last_contact_date
      ELSE ver.viewer_last_event_date
    END`;
    activityInteractionsCol = 'COALESCE(vr.viewer_total_interactions, 0) + COALESCE(ver.viewer_event_interactions, 0)';
  }

  if (req.typeList?.length) {
    where.push(`cle.contact_type IN (${req.typeList.map(() => '?').join(',')})`);
    binds.push(...req.typeList);
  }

  if (req.statusList?.length) {
    where.push(`cle.engagement_status IN (${req.statusList.map(() => '?').join(',')})`);
    binds.push(...req.statusList);
  }

  if (req.filter.company_id) {
    where.push('cle.company_id = ?');
    binds.push(req.filter.company_id);
  }

  if (req.lastContactBuckets?.length) {
    const predicates = req.lastContactBuckets
      .map(bucket => lastContactPredicate(bucket, activityLastCol))
      .filter((p): p is string => Boolean(p));
    if (predicates.length) where.push(`(${predicates.join(' OR ')})`);
  }

  if (req.filter.last_contact_before) {
    where.push(`${activityLastCol} < ?`);
    binds.push(req.filter.last_contact_before);
  }
  if (req.filter.last_contact_after) {
    where.push(`${activityLastCol} > ?`);
    binds.push(req.filter.last_contact_after);
  }

  if (req.interactionsBucket) {
    const predicate = interactionsPredicate(req.interactionsBucket, activityInteractionsCol);
    if (predicate) where.push(predicate);
  }

  if (req.filter.meetings_last_30d_min !== undefined) {
    where.push('cle.meetings_last_30d >= ?');
    binds.push(req.filter.meetings_last_30d_min);
  }

  if (req.filter.has_followup_overdue) {
    where.push(
      `cle.next_followup_date IS NOT NULL
       AND cle.next_followup_date < strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    );
  }

  if (url.searchParams.get('in_active_deals') === 'true') {
    where.push('cle.in_active_deals = 1');
  }

  if (req.tagsParam?.length) {
    where.push(tagFilterPredicate(req.tagsParam, req.filter.tag_logic, binds));
  }

  const searchCte = searchQuery ? contactSearchCteSql() : '';
  const searchJoin = searchQuery ? 'JOIN matched m ON m.contact_id = cle.contact_id' : '';
  const searchOrder = searchQuery ? 'm.search_rank ASC, m.fts_rank ASC, ' : '';
  const cteBinds = searchQuery ? contactSearchCteBinds(searchQuery, ctx.orgId) : [];

  if (searchQuery) {
    const ready = await ensureContactSearchIndexReady(env, ctx.orgId);
    if (!ready.ok) {
      return { error: { code: ready.code, status: 503, message: ready.message } };
    }
  }

  const sortExpr = req.sortMeta.col
    .replace('activity_last_contact_date', activityLastCol)
    .replace('activity_total_interactions', activityInteractionsCol);
  const countWhere = [...where];
  const cursorBinds: unknown[] = [];
  const cursorClause = req.useOffsetCursor
    ? null
    : cursorPredicate(req.cursor, req, sortExpr, cursorBinds);
  if (cursorClause) where.push(cursorClause);

  const fromSql = `
    FROM contact_list_entries cle
    JOIN contacts c ON c.id = cle.contact_id AND c.org_id = cle.org_id
    ${searchJoin}
    ${viewerRollupJoin}
    WHERE ${where.join(' AND ')}
  `;
  const countFromSql = `
    FROM contact_list_entries cle
    JOIN contacts c ON c.id = cle.contact_id AND c.org_id = cle.org_id
    ${searchJoin}
    ${viewerRollupJoin}
    WHERE ${countWhere.join(' AND ')}
  `;

  const selectSql = `
    ${searchCte}
    SELECT c.*,
           cle.company_name,
           cle.active_deal_count,
           cle.in_active_deals,
           ${activityLastCol} AS __last_contact_date,
           ${activityInteractionsCol} AS __total_interactions,
           cle.tags_json AS __tags_json,
           ${sortExpr} AS __cursor_sort_value
    ${fromSql}
    ORDER BY ${searchOrder}${sortExpr} ${req.sortDir} NULLS LAST, cle.contact_id ASC
    LIMIT ?${req.useOffsetCursor || !cursorClause ? ' OFFSET ?' : ''}
  `;
  const selectBinds = [
    ...cteBinds,
    ...viewerRollupBinds,
    ...binds,
    ...cursorBinds,
    req.limit,
    ...(req.useOffsetCursor || !cursorClause ? [req.offset] : []),
  ];

  const countSql = `${searchCte} SELECT COUNT(*) as n ${countFromSql}`;
  const countBinds = [...cteBinds, ...viewerRollupBinds, ...binds];

  const facetsPromise = opts.includeFacets ? loadContactListFacets(ctx, env) : Promise.resolve(null);
  const [rows, countResult, facets] = await Promise.all([
    env.D1.prepare(selectSql).bind(...selectBinds).all<any>(),
    env.D1.prepare(countSql).bind(...countBinds).first<{ n: number }>(),
    facetsPromise,
  ]);

  const contacts = rows.results.map(mapContactRow);
  const total = countResult?.n ?? 0;
  const nextOffset = req.offset + contacts.length;
  const lastRaw = rows.results[rows.results.length - 1];
  const hasMore = req.useOffsetCursor || !cursorClause
    ? nextOffset < total
    : contacts.length === req.limit;
  const nextCursor = hasMore && lastRaw
    ? encodeContactListCursor({
        mode: req.useOffsetCursor ? 'offset' : 'seek',
        offset: nextOffset,
        sort: req.sortKey,
        order: req.sortDir.toLowerCase() as 'asc' | 'desc',
        value: lastRaw.__cursor_sort_value ?? null,
        id: lastRaw.id,
      })
    : null;

  const result: ContactListResult = {
    contacts,
    limit: req.limit,
    offset: req.offset,
    total,
    has_more: hasMore,
    next_cursor: nextCursor,
  };

  if (facets) {
    result.facets = facets;
  }

  return result;
}

export async function bootstrapContactList(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<ContactListResult | ContactListErrorResult> {
  return listContactsFromReadModel(request, ctx, env, {
    includeFacets: true,
    defaultLimit: BOOTSTRAP_LIMIT,
  });
}

const CONTACT_LIST_ENTRY_COLUMNS = `
  org_id,
  contact_id,
  full_name,
  email,
  company_id,
  company_name,
  contact_type,
  engagement_status,
  relationship_status,
  job_title,
  next_followup_date,
  meetings_last_30d,
  last_contact_date,
  total_interactions,
  active_deal_count,
  in_active_deals,
  tags_json,
  contact_created_at,
  contact_updated_at,
  rebuilt_at
`;

function contactListEntrySelectSql(): string {
  return `
    SELECT
      c.org_id,
      c.id,
      c.full_name,
      c.email,
      COALESCE(
        co.id,
        (
          SELECT eco.id
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
          SELECT dco.id
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
          SELECT sco.id
            FROM companies sco
           WHERE sco.org_id = c.org_id
             AND sco.deleted_at IS NULL
             AND sco.merged_into IS NULL
             AND sco.domain IS NOT NULL
             AND sco.domain != ''
             AND c.email IS NOT NULL
             AND (
               lower(c.email) LIKE '%@' || lower(sco.domain)
               OR lower(c.email) LIKE '%@%.' || lower(sco.domain)
             )
           ORDER BY length(sco.domain) DESC
           LIMIT 1
        )
      ) AS company_id,
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
               lower(c.email) LIKE '%@' || lower(sco.domain)
               OR lower(c.email) LIKE '%@%.' || lower(sco.domain)
             )
           ORDER BY length(sco.domain) DESC
           LIMIT 1
        )
      ) AS company_name,
      c.contact_type,
      c.engagement_status,
      c.relationship_status,
      c.job_title,
      c.next_followup_date,
      COALESCE(c.meetings_last_30d, 0),
      COALESCE(r.last_conversation_at, r.last_event_at),
      COALESCE(r.conversation_count, 0) + COALESCE(r.event_count, 0),
      COALESCE((
        SELECT COUNT(*)
          FROM deal_contacts dc
          JOIN deals d ON d.id = dc.deal_id
         WHERE dc.contact_id = c.id
           AND d.org_id = c.org_id
           AND d.deleted_at IS NULL
           AND d.stage NOT IN ('closed','closed_won','closed_lost')
      ), 0),
      CASE WHEN EXISTS (
        SELECT 1
          FROM deal_contacts dc
          JOIN deals d ON d.id = dc.deal_id
         WHERE dc.contact_id = c.id
           AND d.org_id = c.org_id
           AND d.deleted_at IS NULL
           AND d.stage NOT IN ('closed','closed_won','closed_lost')
      ) THEN 1 ELSE 0 END,
      COALESCE((
        SELECT json_group_array(json_object('id', id, 'name', name, 'color', color))
          FROM (
            SELECT t.id, t.name, t.color
              FROM contact_tags ct
              JOIN tags t ON t.id = ct.tag_id
             WHERE ct.contact_id = c.id
               AND t.org_id = c.org_id
               AND t.entity_type = 'contact'
             ORDER BY t.name COLLATE NOCASE ASC
          )
      ), '[]'),
      c.created_at,
      c.updated_at,
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM contacts c
    LEFT JOIN companies co
      ON co.id = c.company_id
     AND co.org_id = c.org_id
     AND co.deleted_at IS NULL
     AND co.merged_into IS NULL
    LEFT JOIN contact_activity_rollups r
      ON r.org_id = c.org_id
     AND r.contact_id = c.id
  `;
}

export async function upsertContactListEntry(env: Env, orgId: string, contactId: string): Promise<void> {
  const contact = await env.D1.prepare(
    `SELECT id
       FROM contacts
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
  ).bind(contactId, orgId).first<{ id: string }>();

  if (!contact) {
    await deleteContactListEntry(env, orgId, contactId);
    return;
  }

  await env.D1.prepare(
    `INSERT OR REPLACE INTO contact_list_entries (${CONTACT_LIST_ENTRY_COLUMNS})
     ${contactListEntrySelectSql()}
     WHERE c.id = ? AND c.org_id = ? AND c.deleted_at IS NULL AND c.merged_into IS NULL`
  ).bind(contactId, orgId).run();
}

export async function safelyUpsertContactListEntry(
  env: Env,
  orgId: string,
  contactId: string | null | undefined,
  reason = 'contact_list_upsert'
): Promise<void> {
  if (!contactId) return;
  try {
    await upsertContactListEntry(env, orgId, contactId);
  } catch (error) {
    console.error('[contact-list] upsert failed', { orgId, contactId, reason, error });
  }
}

export async function deleteContactListEntry(env: Env, orgId: string, contactId: string): Promise<void> {
  await env.D1.prepare(
    `DELETE FROM contact_list_entries WHERE org_id = ? AND contact_id = ?`
  ).bind(orgId, contactId).run();
}

export async function safelyDeleteContactListEntry(
  env: Env,
  orgId: string,
  contactId: string | null | undefined
): Promise<void> {
  if (!contactId) return;
  try {
    await deleteContactListEntry(env, orgId, contactId);
  } catch (error) {
    console.error('[contact-list] delete failed', { orgId, contactId, error });
  }
}

export async function rebuildContactListEntriesForCompany(
  env: Env,
  orgId: string,
  companyId: string,
  extraDomain?: string | null
): Promise<{ rebuilt: number }> {
  const company = await env.D1.prepare(
    `SELECT domain FROM companies WHERE id = ? AND org_id = ?`
  ).bind(companyId, orgId).first<{ domain: string | null }>();
  const domains = Array.from(new Set([company?.domain, extraDomain].map(d => String(d || '').trim().toLowerCase()).filter(Boolean)));
  const domainPredicates = domains.map(() => `(c.email IS NOT NULL AND (lower(c.email) LIKE ? OR lower(c.email) LIKE ?))`);
  const domainBinds = domains.flatMap(domain => [`%@${domain}`, `%@%.${domain}`]);

  const rows = await env.D1.prepare(
    `SELECT id FROM (
       SELECT c.id AS id
         FROM contacts c
        WHERE c.org_id = ?
          AND c.deleted_at IS NULL
          AND c.merged_into IS NULL
          AND c.company_id = ?
       UNION
       SELECT cle.contact_id AS id
         FROM contact_list_entries cle
        WHERE cle.org_id = ?
          AND cle.company_id = ?
       ${domainPredicates.length ? `
       UNION
       SELECT c.id AS id
         FROM contacts c
        WHERE c.org_id = ?
          AND c.deleted_at IS NULL
          AND c.merged_into IS NULL
          AND (${domainPredicates.join(' OR ')})
       ` : ''}
     )
     LIMIT 5000`
  ).bind(
    orgId,
    companyId,
    orgId,
    companyId,
    ...(domainPredicates.length ? [orgId, ...domainBinds] : [])
  ).all<{ id: string }>();

  let rebuilt = 0;
  for (const row of rows.results) {
    await upsertContactListEntry(env, orgId, row.id);
    rebuilt++;
  }
  return { rebuilt };
}

export async function safelyRebuildContactListEntriesForCompany(
  env: Env,
  orgId: string,
  companyId: string | null | undefined,
  extraDomain?: string | null
): Promise<void> {
  if (!companyId) return;
  try {
    await rebuildContactListEntriesForCompany(env, orgId, companyId, extraDomain);
  } catch (error) {
    console.error('[contact-list] company rebuild failed', { orgId, companyId, error });
  }
}

export async function rebuildContactListEntriesForTag(
  env: Env,
  orgId: string,
  tagId: string
): Promise<{ rebuilt: number }> {
  const rows = await env.D1.prepare(
    `SELECT contact_id FROM (
       SELECT ct.contact_id
         FROM contact_tags ct
         JOIN contacts c ON c.id = ct.contact_id
        WHERE ct.tag_id = ?
          AND c.org_id = ?
          AND c.deleted_at IS NULL
       UNION
       SELECT cle.contact_id
         FROM contact_list_entries cle
        WHERE cle.org_id = ?
          AND cle.tags_json LIKE ?
     )
     LIMIT 5000`
  ).bind(tagId, orgId, orgId, `%"id":"${tagId}"%`).all<{ contact_id: string }>();

  let rebuilt = 0;
  for (const row of rows.results) {
    await upsertContactListEntry(env, orgId, row.contact_id);
    rebuilt++;
  }
  return { rebuilt };
}

export async function safelyRebuildContactListEntriesForTag(
  env: Env,
  orgId: string,
  tagId: string | null | undefined
): Promise<void> {
  if (!tagId) return;
  try {
    await rebuildContactListEntriesForTag(env, orgId, tagId);
  } catch (error) {
    console.error('[contact-list] tag rebuild failed', { orgId, tagId, error });
  }
}

export async function rebuildContactListForOrg(
  env: Env,
  orgId: string,
  limit = 1000
): Promise<{ rebuilt: number; errors: number; has_more: boolean }> {
  const bounded = Math.max(1, Math.min(limit, 2000));
  const rows = await env.D1.prepare(
    `SELECT c.id
       FROM contacts c
       LEFT JOIN contact_list_entries cle
         ON cle.org_id = c.org_id
        AND cle.contact_id = c.id
       LEFT JOIN contact_activity_rollups r
         ON r.org_id = c.org_id
        AND r.contact_id = c.id
      WHERE c.org_id = ?
        AND c.deleted_at IS NULL
        AND c.merged_into IS NULL
        AND (
          cle.contact_id IS NULL
          OR COALESCE(c.updated_at, c.created_at, '') > COALESCE(cle.contact_updated_at, '')
          OR COALESCE(r.updated_at, '') > COALESCE(cle.rebuilt_at, '')
        )
      ORDER BY
        CASE WHEN cle.contact_id IS NULL THEN 0 ELSE 1 END,
        c.updated_at DESC,
        c.id ASC
      LIMIT ?`
  ).bind(orgId, bounded + 1).all<{ id: string }>();

  let rebuilt = 0;
  let errors = 0;
  for (const row of rows.results.slice(0, bounded)) {
    try {
      await upsertContactListEntry(env, orgId, row.id);
      rebuilt++;
    } catch (error) {
      errors++;
      console.error('[contact-list] org rebuild row failed', { orgId, contactId: row.id, error });
    }
  }
  return { rebuilt, errors, has_more: rows.results.length > bounded };
}

export async function repairContactListReadModelDrift(
  orgId: string,
  env: Env,
  limit = CONTACT_LIST_REPAIR_LIMIT
): Promise<{ scanned: number; repaired: number; deleted: number; errors: number }> {
  const bounded = Math.max(1, Math.min(limit, 500));
  const staleRows = await env.D1.prepare(
    `SELECT id FROM (
       SELECT c.id AS id
         FROM contacts c
         LEFT JOIN contact_list_entries cle
           ON cle.org_id = c.org_id
          AND cle.contact_id = c.id
         LEFT JOIN contact_activity_rollups r
           ON r.org_id = c.org_id
          AND r.contact_id = c.id
        WHERE c.org_id = ?
          AND c.deleted_at IS NULL
          AND c.merged_into IS NULL
          AND (
            cle.contact_id IS NULL
            OR COALESCE(c.updated_at, c.created_at, '') > COALESCE(cle.contact_updated_at, '')
            OR COALESCE(r.updated_at, '') > COALESCE(cle.rebuilt_at, '')
          )
     )
     LIMIT ?`
  ).bind(orgId, bounded).all<{ id: string }>();

  let repaired = 0;
  let errors = 0;
  for (const row of staleRows.results) {
    try {
      await upsertContactListEntry(env, orgId, row.id);
      repaired++;
    } catch (error) {
      errors++;
      console.error('[contact-list] drift repair row failed', { orgId, contactId: row.id, error });
    }
  }

  const deleted = await env.D1.prepare(
    `DELETE FROM contact_list_entries
      WHERE org_id = ?
        AND contact_id NOT IN (
          SELECT id FROM contacts
           WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL
        )`
  ).bind(orgId, orgId).run();

  return {
    scanned: staleRows.results.length,
    repaired,
    deleted: Number(deleted.meta?.changes || 0),
    errors,
  };
}

export const __contactListReadModelTestHooks = {
  encodeContactListCursor,
  decodeContactListCursor,
  parseRequest,
  lastContactPredicate,
  interactionsPredicate,
  tagFilterPredicate,
  cursorPredicate,
};
