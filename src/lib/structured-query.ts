import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { createDocumentArtifactTool } from './document-artifacts';
import { extractTextFromFile } from './file-extraction';

type StructuredTarget =
  | 'companies'
  | 'company_contacts'
  | 'contacts'
  | 'deals'
  | 'document_people'
  | 'events'
  | 'event_people'
  | 'campaign_recipients'
  | 'documents';

type StructuredOperation = 'count' | 'list' | 'export_xlsx';

interface PredicateFilter {
  predicate?: string;
  value?: string;
}

interface StructuredFilters {
  keyword?: string;
  keywords?: string[];
  company_types?: string[];
  contact_types?: string[];
  stages?: string[];
  statuses?: string[];
  sectors?: string[];
  locations?: string[];
  semantic_terms?: string[];
  semantic_predicates?: PredicateFilter[];
  investor_only?: boolean;
  has_email?: boolean;
  event_title?: string;
  event_date?: string;
  date_from?: string;
  date_to?: string;
  invited_by_users?: string[];
  include_internal?: boolean;
  document_types?: string[];
  document_query?: string;
  source_document_ids?: string[];
  include_document_people?: boolean;
}

export interface StructuredDataQueryInput {
  target: StructuredTarget;
  operation?: StructuredOperation;
  filters?: StructuredFilters;
  fields?: string[];
  limit?: number;
  export_title?: string;
}

interface StructuredQueryResult {
  ok: true;
  target: StructuredTarget;
  operation: StructuredOperation;
  count: number;
  returned: number;
  rows: Record<string, unknown>[];
  columns: string[];
  semantic_filter_used: boolean;
  caveats: string[];
  document?: unknown;
  document_cards?: unknown[];
  message?: string;
}

interface DocumentPeopleCandidate {
  id: string;
  title: string | null;
  file_name: string | null;
  document_type: string | null;
  mime_type: string | null;
  r2_key: string | null;
  file_size: number | null;
  extracted_text_preview: string | null;
  created_at: string | null;
}

interface DocumentChunkRow {
  id: string;
  text_r2_key: string | null;
  text_preview: string | null;
  chunk_index: number;
}

const MAX_DOCUMENT_PEOPLE_DOCS = 10;
const MAX_DOCUMENT_PEOPLE_CHUNKS_PER_DOC = 140;
const MAX_DOCUMENT_PEOPLE_TEXT_CHARS = 800_000;
const MAX_BINARY_PARSE_BYTES = 12_000_000;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v || '').trim()).filter(Boolean);
}

function clampLimit(value: unknown, operation: StructuredOperation): number {
  const fallback = operation === 'export_xlsx' ? 2500 : operation === 'count' ? 5000 : 100;
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, 1), operation === 'export_xlsx' ? 2500 : operation === 'count' ? 5000 : 500);
}

function likeTerm(value: string): string {
  return `%${value.replace(/[%_]/g, '\\$&')}%`;
}

function firstName(nameOrEmail: unknown): string {
  const raw = String(nameOrEmail || '').trim();
  const source = raw.includes('@') ? raw.split('@')[0].replace(/[._-]+/g, ' ') : raw;
  return source.split(/\s+/).find(Boolean) || '';
}

function addInFilter(where: string[], binds: unknown[], expression: string, values: string[]): void {
  const clean = values.map(v => String(v || '').trim()).filter(Boolean);
  if (clean.length === 0) return;
  where.push(`${expression} IN (${clean.map(() => '?').join(',')})`);
  binds.push(...clean);
}

function addLikeAny(
  where: string[],
  binds: unknown[],
  expressions: string[],
  terms: string[],
  mode: 'any' | 'all' = 'any'
): void {
  const clean = terms.map(t => String(t || '').trim()).filter(Boolean);
  if (clean.length === 0 || expressions.length === 0) return;
  const groups = clean.map(term => {
    binds.push(...expressions.map(() => likeTerm(term)));
    return `(${expressions.map(expr => `${expr} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  });
  where.push(mode === 'all' ? groups.join(' AND ') : `(${groups.join(' OR ')})`);
}

function semanticExistsSql(entityAlias: string, linkedType: string, predicateSql: string, valueSql: string): string {
  return `EXISTS (
    SELECT 1
      FROM semantic_subjects ss
      JOIN semantic_assertions sa ON sa.subject_id = ss.id AND sa.org_id = ss.org_id
     WHERE ss.org_id = ${entityAlias}.org_id
       AND ss.linked_entity_type = '${linkedType}'
       AND ss.linked_entity_id = ${entityAlias}.id
       AND sa.status = 'active'
       AND (${predicateSql})
       AND (${valueSql})
  )`;
}

function addSemanticTermFilters(
  where: string[],
  binds: unknown[],
  entityAlias: string,
  linkedType: string,
  terms: string[],
  predicates?: string[]
): boolean {
  const clean = terms.map(t => String(t || '').trim()).filter(Boolean);
  if (clean.length === 0) return false;
  const predicateSql = predicates?.length
    ? `sa.predicate IN (${predicates.map(() => '?').join(',')})`
    : '1 = 1';
  const valueSql = clean.map(() => 'sa.value LIKE ? ESCAPE \'\\\'').join(' OR ');
  if (predicates?.length) binds.push(...predicates);
  binds.push(...clean.map(likeTerm));
  where.push(semanticExistsSql(entityAlias, linkedType, predicateSql, valueSql));
  return true;
}

function addSemanticPredicateFilters(
  where: string[],
  binds: unknown[],
  entityAlias: string,
  linkedType: string,
  filters: PredicateFilter[] | undefined
): boolean {
  const clean = (filters || []).filter(f => f?.predicate || f?.value);
  let used = false;
  for (const filter of clean) {
    const predicateSql = filter.predicate ? 'sa.predicate = ?' : '1 = 1';
    const valueSql = filter.value ? 'sa.value LIKE ? ESCAPE \'\\\'' : '1 = 1';
    if (filter.predicate) binds.push(filter.predicate);
    if (filter.value) binds.push(likeTerm(filter.value));
    where.push(semanticExistsSql(entityAlias, linkedType, predicateSql, valueSql));
    used = true;
  }
  return used;
}

function addHybridTextSemanticFilters(
  where: string[],
  binds: unknown[],
  textExpressions: string[],
  rollupAlias: string,
  terms: string[],
  mode: 'any' | 'all' = 'all'
): boolean {
  const clean = terms.map(t => String(t || '').trim()).filter(Boolean);
  if (clean.length === 0) return false;
  addLikeAny(where, binds, [
    ...textExpressions,
    `${rollupAlias}.tags_json`,
    `${rollupAlias}.facets_json`,
    `${rollupAlias}.vc_profile_json`,
  ], clean, mode);
  return true;
}

function expandConceptTerms(terms: string[]): string[] {
  const out = new Set<string>();
  for (const term of terms.map(t => String(t || '').trim()).filter(Boolean)) {
    const lower = term.toLowerCase();
    out.add(term);
    if (lower.includes('cyber security')) out.add('cybersecurity');
    if (lower.includes('cybersecurity')) out.add('cyber security');
    if (lower.includes('defense')) out.add('defense tech');
    if (lower.includes('dual use')) out.add('dual-use');
    if (lower.includes('ai infra')) out.add('AI infrastructure');
    if (lower.includes('marketing technology')) out.add('MarTech');
  }
  return [...out];
}

function isLocationTerm(term: string): boolean {
  return /\b(florida|south florida|miami|fort lauderdale|boca raton|palm beach|tampa|orlando|jacksonville| fl\b)\b/i.test(term);
}

function expandLocationTerms(terms: string[]): string[] {
  const out = new Set<string>();
  for (const term of terms.map(t => String(t || '').trim()).filter(Boolean)) {
    const lower = term.toLowerCase();
    out.add(term);
    if (lower === 'florida' || lower === 'fl' || lower.includes('south florida')) {
      ['Florida', 'South Florida', 'Miami', 'Fort Lauderdale', 'Boca Raton', 'Palm Beach', 'Tampa', 'Orlando', 'Jacksonville'].forEach(v => out.add(v));
    }
  }
  return [...out];
}

function requestedColumns(rows: Record<string, unknown>[], requested: string[] | undefined): string[] {
  const all = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const clean = (requested || []).map(f => String(f || '').trim()).filter(Boolean);
  if (clean.length === 0) return all;
  const keep = clean.filter(f => all.includes(f));
  return keep.length > 0 ? keep : all;
}

async function attachSemanticFacts(
  env: Env,
  orgId: string,
  linkedType: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  const ids = rows.map(r => String(r.id || '')).filter(Boolean).slice(0, 200);
  if (ids.length === 0) return;
  const ph = ids.map(() => '?').join(',');
  const facts = await env.D1.prepare(
    `SELECT ss.linked_entity_id AS id, sa.predicate, sa.value, se.quote
       FROM semantic_subjects ss
       JOIN semantic_assertions sa ON sa.subject_id = ss.id AND sa.org_id = ss.org_id
       LEFT JOIN semantic_evidence se ON se.assertion_id = sa.id
      WHERE ss.org_id = ?
        AND ss.linked_entity_type = ?
        AND ss.linked_entity_id IN (${ph})
        AND sa.status = 'active'
      ORDER BY sa.confidence DESC, sa.updated_at DESC`
  ).bind(orgId, linkedType, ...ids).all<any>();

  const grouped = new Map<string, string[]>();
  for (const fact of facts.results || []) {
    const arr = grouped.get(fact.id) || [];
    if (arr.length < 8) arr.push(`${fact.predicate}: ${fact.value}`);
    grouped.set(fact.id, arr);
  }
  for (const row of rows) {
    const id = String(row.id || '');
    const values = grouped.get(id);
    if (values?.length) row.semantic_facts = values.join('; ');
  }
}

async function queryCompanies(env: Env, orgId: string, filters: StructuredFilters, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const where = ['c.org_id = ?', 'c.deleted_at IS NULL'];
  const binds: unknown[] = [orgId];
  let semanticUsed = false;
  addInFilter(where, binds, 'c.company_type', asArray(filters.company_types));
  addInFilter(where, binds, 'c.stage', asArray(filters.stages));
  addInFilter(where, binds, 'c.investment_status', asArray(filters.statuses));
  const semanticTerms = asArray(filters.semantic_terms);
  const sectorTerms = expandConceptTerms([...asArray(filters.sectors), ...semanticTerms.filter(term => !isLocationTerm(term))]);
  const locationTerms = expandLocationTerms([...asArray(filters.locations), ...semanticTerms.filter(isLocationTerm)]);
  addLikeAny(where, binds, ['c.name', 'c.domain', 'c.website', 'c.description', 'c.sector', 'c.custom_fields'], [filters.keyword || '', ...asArray(filters.keywords)]);
  semanticUsed = addHybridTextSemanticFilters(where, binds, ['c.sector', 'c.description', 'c.custom_fields'], 'r', sectorTerms, 'all') || semanticUsed;
  semanticUsed = addHybridTextSemanticFilters(where, binds, ['c.description', 'c.custom_fields'], 'r', locationTerms, 'any') || semanticUsed;
  if (filters.investor_only) {
    where.push(`(c.company_type IN ('vc_firm','family_office','lp') OR c.sector LIKE '%Venture%' OR c.sector LIKE '%Capital%' OR c.description LIKE '%invest%')`);
  }
  semanticUsed = addSemanticPredicateFilters(where, binds, 'c', 'company', filters.semantic_predicates) || semanticUsed;

  const rows = await env.D1.prepare(
    `SELECT c.id, c.name, c.website, c.domain, c.company_type, c.sector, c.stage,
            c.investment_status, c.current_valuation, c.description,
            c.updated_at,
            r.tags_json AS semantic_tags,
            r.vc_profile_json AS vc_profile,
            r.evidence_count AS semantic_evidence_count
       FROM companies c
       LEFT JOIN semantic_subjects ss
         ON ss.org_id = c.org_id AND ss.linked_entity_type = 'company' AND ss.linked_entity_id = c.id
       LEFT JOIN semantic_tag_rollups r
         ON r.org_id = ss.org_id AND r.subject_id = ss.id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name ASC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  const out = (rows.results || []) as any[];
  await attachSemanticFacts(env, orgId, 'company', out);
  return { rows: out, semanticUsed };
}

async function queryContacts(env: Env, orgId: string, filters: StructuredFilters, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const where = ['c.org_id = ?', 'c.deleted_at IS NULL', 'c.merged_into IS NULL'];
  const binds: unknown[] = [orgId];
  let semanticUsed = false;
  addInFilter(where, binds, 'c.contact_type', asArray(filters.contact_types));
  if (filters.has_email) where.push("c.email IS NOT NULL AND c.email != ''");
  addLikeAny(where, binds, ['c.full_name', 'c.email', 'c.job_title', 'c.topics_of_interest', 'c.investment_thesis_tags', 'c.bio_summary', 'co.name'], [filters.keyword || '', ...asArray(filters.keywords)]);
  semanticUsed = addSemanticTermFilters(where, binds, 'c', 'contact', asArray(filters.semantic_terms), undefined) || semanticUsed;
  semanticUsed = addSemanticPredicateFilters(where, binds, 'c', 'contact', filters.semantic_predicates) || semanticUsed;
  const rows = await env.D1.prepare(
    `SELECT c.id, c.full_name, c.email, c.phone, c.contact_type, c.relationship_status,
            c.job_title, c.topics_of_interest, c.investment_thesis_tags,
            c.last_contact_date, co.name AS company_name
       FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.full_name ASC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  const out = (rows.results || []) as any[];
  for (const row of out) row.first_name = firstName(row.full_name || row.email);
  await attachSemanticFacts(env, orgId, 'contact', out);
  return { rows: out, semanticUsed };
}

async function queryCompanyContacts(env: Env, orgId: string, filters: StructuredFilters, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const where = [
    'c.org_id = ?',
    'c.deleted_at IS NULL',
    'c.merged_into IS NULL',
    'co.deleted_at IS NULL',
  ];
  const binds: unknown[] = [orgId];
  let semanticUsed = false;

  if (filters.has_email) where.push("c.email IS NOT NULL AND c.email != ''");
  addInFilter(where, binds, 'c.contact_type', asArray(filters.contact_types));
  addInFilter(where, binds, 'co.company_type', asArray(filters.company_types));
  addInFilter(where, binds, 'co.stage', asArray(filters.stages));
  addInFilter(where, binds, 'co.investment_status', asArray(filters.statuses));

  addLikeAny(
    where,
    binds,
    ['c.full_name', 'c.email', 'c.job_title', 'c.topics_of_interest', 'c.investment_thesis_tags', 'co.name', 'co.domain', 'co.website', 'co.description', 'co.sector', 'co.custom_fields'],
    [filters.keyword || '', ...asArray(filters.keywords)]
  );

  const semanticTerms = asArray(filters.semantic_terms);
  const sectorTerms = expandConceptTerms([...asArray(filters.sectors), ...semanticTerms.filter(term => !isLocationTerm(term))]);
  const locationTerms = expandLocationTerms([...asArray(filters.locations), ...semanticTerms.filter(isLocationTerm)]);
  semanticUsed = addHybridTextSemanticFilters(where, binds, ['co.sector', 'co.description', 'co.custom_fields'], 'r', sectorTerms, 'all') || semanticUsed;
  semanticUsed = addHybridTextSemanticFilters(where, binds, ['co.description', 'co.custom_fields'], 'r', locationTerms, 'any') || semanticUsed;
  if (filters.investor_only) {
    where.push(`(co.company_type IN ('vc_firm','family_office','lp') OR co.sector LIKE '%Venture%' OR co.sector LIKE '%Capital%' OR co.description LIKE '%invest%')`);
  }
  semanticUsed = addSemanticPredicateFilters(where, binds, 'co', 'company', filters.semantic_predicates) || semanticUsed;

  const rows = await env.D1.prepare(
    `SELECT c.id, c.full_name, c.email, c.phone, c.contact_type, c.relationship_status,
            c.job_title, c.last_contact_date,
            co.id AS company_id, co.name AS company_name, co.website AS company_website,
            co.domain AS company_domain, co.company_type, co.sector AS company_sector,
            co.stage AS company_stage, co.investment_status AS company_investment_status,
            r.tags_json AS company_semantic_tags,
            r.vc_profile_json AS company_vc_profile,
            r.evidence_count AS company_semantic_evidence_count
       FROM contacts c
       JOIN companies co ON co.id = c.company_id AND co.org_id = c.org_id
       LEFT JOIN semantic_subjects ss
         ON ss.org_id = co.org_id AND ss.linked_entity_type = 'company' AND ss.linked_entity_id = co.id
       LEFT JOIN semantic_tag_rollups r
         ON r.org_id = ss.org_id AND r.subject_id = ss.id
      WHERE ${where.join(' AND ')}
      ORDER BY co.name ASC, c.full_name ASC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();

  const out = (rows.results || []) as any[];
  for (const row of out) row.first_name = firstName(row.full_name || row.email);
  await attachSemanticFacts(env, orgId, 'contact', out);
  return { rows: out, semanticUsed };
}

async function queryDeals(env: Env, orgId: string, filters: StructuredFilters, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const where = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [orgId];
  let semanticUsed = false;
  addInFilter(where, binds, 'd.stage', asArray(filters.stages));
  addLikeAny(where, binds, ['d.title', 'd.notes', 'd.thesis_fit', 'd.lead_source', 'co.name', 'co.sector'], [filters.keyword || '', ...asArray(filters.keywords), ...asArray(filters.sectors)]);
  semanticUsed = addSemanticTermFilters(where, binds, 'd', 'deal', asArray(filters.semantic_terms), undefined) || semanticUsed;
  semanticUsed = addSemanticPredicateFilters(where, binds, 'd', 'deal', filters.semantic_predicates) || semanticUsed;
  const rows = await env.D1.prepare(
    `SELECT d.id, d.title, d.stage, d.amount, d.currency, d.valuation,
            d.lead_source, d.thesis_fit, d.expected_close,
            co.name AS company_name, co.sector AS company_sector
       FROM deals d
       LEFT JOIN companies co ON co.id = d.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.expected_close ASC NULLS LAST, d.updated_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  const out = (rows.results || []) as any[];
  await attachSemanticFacts(env, orgId, 'deal', out);
  return { rows: out, semanticUsed };
}

function dateBounds(filters: StructuredFilters): { from?: string; to?: string } {
  const date = String(filters.event_date || '').trim();
  if (date) return { from: `${date}T00:00:00`, to: `${date}T23:59:59` };
  return {
    from: filters.date_from ? String(filters.date_from) : undefined,
    to: filters.date_to ? String(filters.date_to) : undefined,
  };
}

async function queryEvents(env: Env, orgId: string, filters: StructuredFilters, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const where = ['e.org_id = ?', 'e.deleted_at IS NULL'];
  const binds: unknown[] = [orgId];
  let semanticUsed = false;
  addLikeAny(where, binds, ['e.title', 'e.description', 'e.summary', 'e.topics_discussed', 'e.location'], [filters.keyword || '', filters.event_title || '', ...asArray(filters.keywords)]);
  const bounds = dateBounds(filters);
  if (bounds.from) { where.push('e.start_time >= ?'); binds.push(bounds.from); }
  if (bounds.to) { where.push('e.start_time <= ?'); binds.push(bounds.to); }
  semanticUsed = addSemanticTermFilters(where, binds, 'e', 'event', asArray(filters.semantic_terms), undefined) || semanticUsed;
  semanticUsed = addSemanticPredicateFilters(where, binds, 'e', 'event', filters.semantic_predicates) || semanticUsed;
  const rows = await env.D1.prepare(
    `SELECT e.id, e.title, e.event_type, e.start_time, e.end_time, e.location,
            e.source, e.summary, e.topics_discussed,
            (SELECT COUNT(*) FROM event_attendees ea WHERE ea.event_id = e.id) AS attendee_count
       FROM events e
      WHERE ${where.join(' AND ')}
      ORDER BY e.start_time DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  const out = (rows.results || []) as any[];
  await attachSemanticFacts(env, orgId, 'event', out);
  return { rows: out, semanticUsed };
}

function userFilterTerms(ctx: AuthContext, filters: StructuredFilters): string[] {
  return asArray(filters.invited_by_users).map(t => {
    const lower = t.toLowerCase();
    if (lower === 'me' || lower === 'myself' || lower === 'i') return ctx.email || ctx.userId;
    return t;
  });
}

async function queryCampaignRecipients(ctx: AuthContext, env: Env, filters: StructuredFilters, limit: number): Promise<any[]> {
  const where = ['ec.org_id = ?', 'ec.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeAny(where, binds, ['ec.title', 'ec.subject', 'ec.body_template'], [filters.keyword || '', filters.event_title || '', ...asArray(filters.keywords)]);
  const bounds = dateBounds(filters);
  if (bounds.from) { where.push('coalesce(ec.sent_at, ec.scheduled_at, ec.created_at) >= ?'); binds.push(bounds.from); }
  if (bounds.to) { where.push('coalesce(ec.sent_at, ec.scheduled_at, ec.created_at) <= ?'); binds.push(bounds.to); }
  const inviters = userFilterTerms(ctx, filters);
  if (inviters.length > 0) {
    addLikeAny(where, binds, ['sender.full_name', 'sender.email', 'creator.full_name', 'creator.email'], inviters);
  }
  const rows = await env.D1.prepare(
    `SELECT ecr.id, ecr.email, c.full_name, c.id AS contact_id,
            co.name AS company_name,
            ec.id AS campaign_id, ec.title AS source_title, ec.subject,
            coalesce(ec.sent_at, ec.scheduled_at, ec.created_at) AS source_date,
            sender.full_name AS sender_name,
            creator.full_name AS creator_name,
            ecr.status,
            'campaign_recipient' AS source_type
       FROM email_campaign_recipients ecr
       JOIN email_campaigns ec ON ec.id = ecr.campaign_id
       LEFT JOIN contacts c ON c.id = ecr.contact_id
       LEFT JOIN companies co ON co.id = c.company_id
       LEFT JOIN users sender ON sender.id = ec.sender_user_id
       LEFT JOIN users creator ON creator.id = ec.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY source_date DESC, c.full_name ASC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  return (rows.results || []).map((row: any) => ({
    ...row,
    first_name: firstName(row.full_name || row.email),
    invited_by: row.sender_name || row.creator_name || null,
  }));
}

async function queryEventAttendees(ctx: AuthContext, env: Env, filters: StructuredFilters, limit: number): Promise<any[]> {
  const where = ['e.org_id = ?', 'e.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeAny(where, binds, ['e.title', 'e.description', 'e.summary', 'e.topics_discussed'], [filters.keyword || '', filters.event_title || '', ...asArray(filters.keywords)]);
  const bounds = dateBounds(filters);
  if (bounds.from) { where.push('e.start_time >= ?'); binds.push(bounds.from); }
  if (bounds.to) { where.push('e.start_time <= ?'); binds.push(bounds.to); }
  if (filters.include_internal !== true) where.push('coalesce(ea.is_internal, 0) = 0');
  if (filters.has_email) where.push("ea.email IS NOT NULL AND ea.email != ''");
  const inviters = userFilterTerms(ctx, filters);
  if (inviters.length > 0) {
    const sub: string[] = [];
    for (const term of inviters) {
      sub.push(`EXISTS (
        SELECT 1 FROM event_attendees org
        LEFT JOIN users u ON u.id = org.user_id
        WHERE org.event_id = e.id
          AND org.role = 'organizer'
          AND (org.email LIKE ? ESCAPE '\\' OR org.display_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.full_name LIKE ? ESCAPE '\\')
      )`);
      binds.push(likeTerm(term), likeTerm(term), likeTerm(term), likeTerm(term));
    }
    where.push(`(${sub.join(' OR ')})`);
  }
  const rows = await env.D1.prepare(
    `SELECT ea.id, ea.email, coalesce(c.full_name, ea.display_name) AS full_name,
            c.id AS contact_id, co.name AS company_name,
            e.id AS event_id, e.title AS source_title, e.start_time AS source_date,
            ea.role AS attendance_status,
            'event_attendee' AS source_type
       FROM event_attendees ea
       JOIN events e ON e.id = ea.event_id
       LEFT JOIN contacts c ON c.id = ea.contact_id
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.start_time DESC, full_name ASC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  return (rows.results || []).map((row: any) => ({
    ...row,
    first_name: firstName(row.full_name || row.email),
  }));
}

function dateSearchTerms(date: string | undefined): string[] {
  const raw = String(date || '').trim();
  if (!raw) return [];
  const out = new Set<string>([raw]);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return [...out];
  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  const dayNum = Number(day);
  if (!Number.isFinite(monthIndex) || !Number.isFinite(dayNum)) return [...out];
  const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][monthIndex];
  if (monthName) {
    out.add(`${monthName} ${dayNum}`);
    out.add(`${monthName} ${dayNum}, ${year}`);
    out.add(`${month}/${day}/${year}`);
    out.add(`${Number(month)}/${dayNum}/${year}`);
  }
  return [...out];
}

function documentPeopleTerms(filters: StructuredFilters): string[] {
  return [
    filters.document_query || '',
    filters.event_title || '',
    filters.keyword || '',
    ...asArray(filters.keywords),
    ...dateSearchTerms(filters.event_date),
  ].map(t => t.trim()).filter(Boolean);
}

function looksLikePeopleDocument(doc: DocumentPeopleCandidate): boolean {
  const text = `${doc.title || ''} ${doc.file_name || ''} ${doc.document_type || ''} ${doc.mime_type || ''}`.toLowerCase();
  return /\b(attendee|attendees|invite|invited|registrant|registrants|mail merge|contact|contacts|directory|people|recipient|recipients|webinar|town hall)\b/.test(text)
    || text.includes('spreadsheet')
    || /\.(xlsx|xls|csv|tsv)\b/.test(text);
}

function splitDelimitedLine(line: string): string[] {
  const raw = line.trim();
  if (!raw) return [];
  const delimiter = raw.includes('\t') ? '\t' : raw.includes('|') ? '|' : ',';
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (quoted && raw[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      cells.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim().replace(/^"|"$/g, ''));
  if (cells.length === 1 && /\s{2,}/.test(raw)) return raw.split(/\s{2,}/).map(v => v.trim()).filter(Boolean);
  return cells.map(v => v.trim()).filter(v => v.length > 0);
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function headerIndex(headers: string[] | null, pattern: RegExp): number {
  if (!headers) return -1;
  return headers.findIndex(h => pattern.test(normalizeHeader(h)));
}

function looksLikeHeader(cells: string[]): boolean {
  if (cells.length < 2) return false;
  const normalized = cells.map(normalizeHeader).join(' | ');
  EMAIL_RE.lastIndex = 0;
  return /\b(email|e mail|first name|last name|full name|attendee|registrant|company|organization|invited by|sender)\b/.test(normalized)
    && !EMAIL_RE.test(cells.join(' '));
}

function cleanEmail(value: string): string {
  const match = value.match(EMAIL_RE);
  return match ? match[0].toLowerCase().replace(/[),.;]+$/g, '') : '';
}

function likelyNameCell(value: string): boolean {
  const clean = value.trim();
  if (!clean || clean.includes('@')) return false;
  if (clean.length > 90) return false;
  if (!/[a-z]/i.test(clean)) return false;
  if (/^(sheet|report|email|e-mail|first name|last name|name|status|role|actual|start|duration|registrants?|cancelled|yes|no|n\/a)$/i.test(clean)) return false;
  if (/^(https?:|www\.|\d+(\.\d+)?%?$)/i.test(clean)) return false;
  return true;
}

function cellByHeader(cells: string[], headers: string[] | null, pattern: RegExp): string {
  const idx = headerIndex(headers, pattern);
  return idx >= 0 && idx < cells.length ? cells[idx].trim() : '';
}

function cellByNormalizedHeader(cells: string[], headers: string[] | null, normalizedHeader: string): string {
  if (!headers) return '';
  const idx = headers.findIndex(header => normalizeHeader(header) === normalizedHeader);
  return idx >= 0 && idx < cells.length ? cells[idx].trim() : '';
}

function numberedPersonSlot(headers: string[] | null, emailIndex: number): string | null {
  if (!headers || emailIndex < 0 || emailIndex >= headers.length) return null;
  const header = normalizeHeader(headers[emailIndex]);
  const match = header.match(/\bperson\s+(\d+)\s+email\b/);
  return match?.[1] || null;
}

function inferNameFromLine(line: string, email: string): string {
  const before = line.slice(0, Math.max(0, line.toLowerCase().indexOf(email.toLowerCase())));
  const candidate = before.split(/[|,;\t<>]/).pop()?.trim() || '';
  return likelyNameCell(candidate) ? candidate : '';
}

function expandedInviterTerms(ctx: AuthContext, filters: StructuredFilters): string[] {
  const out = new Set<string>();
  for (const term of userFilterTerms(ctx, filters)) {
    const clean = term.trim();
    if (!clean) continue;
    out.add(clean.toLowerCase());
    out.add(firstName(clean).toLowerCase());
    if (clean.includes('@')) out.add(clean.split('@')[0].replace(/[._-]+/g, ' ').toLowerCase());
  }
  return [...out].filter(v => v.length >= 2);
}

function documentScopeImpliesInvite(doc: DocumentPeopleCandidate): boolean {
  return /\b(invite|invited|mail merge|recipient)\b/i.test(`${doc.title || ''} ${doc.file_name || ''}`);
}

function documentPersonMatchesInviter(row: any, doc: DocumentPeopleCandidate, ctx: AuthContext, filters: StructuredFilters): boolean {
  const inviters = expandedInviterTerms(ctx, filters);
  if (inviters.length === 0) return true;
  const haystack = `${row.invited_by || ''} ${row.source_excerpt || ''} ${doc.title || ''} ${doc.file_name || ''}`.toLowerCase();
  if (inviters.some(term => haystack.includes(term))) return true;
  return documentScopeImpliesInvite(doc);
}

function rowFromDocumentLine(
  line: string,
  cells: string[],
  headers: string[] | null,
  doc: DocumentPeopleCandidate,
  email: string
): any | null {
  const emailIndex = cells.findIndex(cell => cleanEmail(cell) === email || cell.toLowerCase().includes(email));
  const personSlot = numberedPersonSlot(headers, emailIndex);
  const personPrefix = personSlot ? `person ${personSlot}` : '';
  const first = personPrefix ? cellByNormalizedHeader(cells, headers, `${personPrefix} first name`) : cellByHeader(cells, headers, /\b(first name|firstname|first)\b/);
  const last = personPrefix ? cellByNormalizedHeader(cells, headers, `${personPrefix} last name`) : cellByHeader(cells, headers, /\b(last name|lastname|surname|last)\b/);
  let fullName = personPrefix
    ? cellByNormalizedHeader(cells, headers, `${personPrefix} name`)
    : cellByHeader(cells, headers, /\b(full name|attendee name|registrant name|name)\b/);
  if (!fullName && (first || last)) fullName = `${first} ${last}`.trim();
  if (!fullName && emailIndex > 0) {
    const nameCells = cells.slice(Math.max(0, emailIndex - 2), emailIndex).filter(likelyNameCell);
    fullName = nameCells.join(' ').trim();
  }
  if (!fullName) fullName = inferNameFromLine(line, email);

  let companyName = cellByHeader(cells, headers, /\b(company|organization|organisation|firm|account|employer|vc name|fund name)\b/);
  let jobTitle = personPrefix
    ? cellByNormalizedHeader(cells, headers, `${personPrefix} title`)
    : cellByHeader(cells, headers, /\b(title|job title|role)\b/);
  let invitedBy = cellByHeader(cells, headers, /\b(invited by|inviter|sender|owner|organizer|host|referred by|source)\b/);
  if (emailIndex >= 0 && !companyName && !invitedBy && cells[emailIndex + 1]) {
    const afterEmail = cells[emailIndex + 1].trim();
    if (/^(tony|raul|lucas|medina|host|organizer)$/i.test(afterEmail) || /^[A-Z][a-z]+$/.test(afterEmail)) invitedBy = afterEmail;
    else if (likelyNameCell(afterEmail)) companyName = afterEmail;
  }

  return {
    id: `docperson:${doc.id}:${email}`,
    email,
    full_name: fullName || null,
    first_name: firstName(fullName || email),
    company_name: companyName || null,
    job_title: jobTitle || null,
    contact_id: null,
    event_id: null,
    campaign_id: null,
    source_document_id: doc.id,
    source_title: doc.title || doc.file_name || 'Document',
    source_date: doc.created_at,
    source_type: 'document_person',
    attendance_status: 'document_row',
    invited_by: invitedBy || null,
    source_person_slot: personSlot || null,
    source_excerpt: line.trim().slice(0, 500),
  };
}

function extractPeopleFromDocumentText(
  text: string,
  doc: DocumentPeopleCandidate,
  ctx: AuthContext,
  filters: StructuredFilters,
  limit: number
): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  let headers: string[] | null = null;
  const lines = text.replace(/\r/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = splitDelimitedLine(line);
    if (looksLikeHeader(cells)) {
      headers = cells;
      continue;
    }
    EMAIL_RE.lastIndex = 0;
    const emails = [...line.matchAll(EMAIL_RE)].map(match => cleanEmail(match[0])).filter(Boolean);
    for (const email of emails) {
      if (seen.has(email)) continue;
      const row = rowFromDocumentLine(line, cells, headers, doc, email);
      if (!row) continue;
      if (!documentPersonMatchesInviter(row, doc, ctx, filters)) continue;
      seen.add(email);
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function loadR2Text(env: Env, key: string | null | undefined): Promise<string> {
  if (!key) return '';
  const obj = await env.R2.get(key);
  return obj ? obj.text() : '';
}

function isLikelyParseablePeopleBinary(doc: DocumentPeopleCandidate): boolean {
  const name = `${doc.file_name || doc.title || ''}`.toLowerCase();
  const mime = `${doc.mime_type || ''}`.toLowerCase();
  if (doc.file_size && doc.file_size > MAX_BINARY_PARSE_BYTES && !/\.(xlsx|xls|csv|tsv)\b/.test(name)) return false;
  return mime.startsWith('text/')
    || mime.includes('spreadsheet')
    || mime.includes('excel')
    || mime.includes('csv')
    || mime === 'application/pdf'
    || /\.(xlsx|xls|csv|tsv|txt|pdf)\b/.test(name);
}

async function loadDocumentBinaryText(env: Env, doc: DocumentPeopleCandidate): Promise<string> {
  if (!doc.r2_key || !isLikelyParseablePeopleBinary(doc)) return '';
  const obj = await env.R2.get(doc.r2_key);
  if (!obj) return '';
  const buffer = await obj.arrayBuffer();
  if (buffer.byteLength > MAX_BINARY_PARSE_BYTES && !`${doc.file_name || ''}`.toLowerCase().match(/\.(xlsx|xls|csv|tsv)$/)) return '';
  const file = new File([buffer], doc.file_name || doc.title || 'document', { type: doc.mime_type || '' });
  return extractTextFromFile(file);
}

async function loadDocumentPeopleText(env: Env, orgId: string, doc: DocumentPeopleCandidate): Promise<string> {
  const parts: string[] = [];
  if (doc.extracted_text_preview) parts.push(doc.extracted_text_preview);

  const chunks = await env.D1.prepare(
    `SELECT id, text_r2_key, text_preview, chunk_index
       FROM rag_chunks_v2
      WHERE org_id = ? AND source_table = 'documents' AND source_id = ?
      ORDER BY chunk_index ASC
      LIMIT ?`
  ).bind(orgId, doc.id, MAX_DOCUMENT_PEOPLE_CHUNKS_PER_DOC).all<DocumentChunkRow>();

  for (const chunk of chunks.results || []) {
    let text = '';
    try { text = await loadR2Text(env, chunk.text_r2_key); } catch { /* preview fallback */ }
    if (!text) text = chunk.text_preview || '';
    if (text) parts.push(text);
    if (parts.join('\n').length >= MAX_DOCUMENT_PEOPLE_TEXT_CHARS) break;
  }

  try {
    const binaryText = await loadDocumentBinaryText(env, doc);
    if (binaryText) parts.push(binaryText);
  } catch {
    // Keep the structured query useful even if one uploaded file cannot be parsed.
  }

  return parts.join('\n').slice(0, MAX_DOCUMENT_PEOPLE_TEXT_CHARS);
}

async function queryDocumentPeople(ctx: AuthContext, env: Env, filters: StructuredFilters, limit: number): Promise<any[]> {
  if (filters.include_document_people === false) return [];
  const sourceDocumentIds = asArray(filters.source_document_ids);
  const terms = documentPeopleTerms(filters);
  if (sourceDocumentIds.length === 0 && terms.length === 0) return [];

  const where = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addInFilter(where, binds, 'd.id', sourceDocumentIds);
  if (terms.length > 0) {
    addLikeAny(where, binds, ['d.title', 'd.file_name', 'd.extracted_text_preview'], terms, 'any');
  }

  const docs = await env.D1.prepare(
    `SELECT d.id, d.title, d.file_name, d.document_type, d.mime_type, d.r2_key,
            d.file_size, d.extracted_text_preview, d.created_at
       FROM documents d
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE
          WHEN lower(coalesce(d.title, '') || ' ' || coalesce(d.file_name, '')) LIKE '%mail merge%' THEN 0
          WHEN lower(coalesce(d.title, '') || ' ' || coalesce(d.file_name, '')) LIKE '%invite%' THEN 1
          WHEN lower(coalesce(d.title, '') || ' ' || coalesce(d.file_name, '')) LIKE '%attendee%' THEN 2
          ELSE 3
        END,
        d.created_at DESC
      LIMIT ?`
  ).bind(...binds, MAX_DOCUMENT_PEOPLE_DOCS).all<DocumentPeopleCandidate>();

  const people: any[] = [];
  for (const doc of docs.results || []) {
    if (!looksLikePeopleDocument(doc) && sourceDocumentIds.length === 0) continue;
    const text = await loadDocumentPeopleText(env, ctx.orgId, doc);
    EMAIL_RE.lastIndex = 0;
    if (!text || !EMAIL_RE.test(text)) continue;
    EMAIL_RE.lastIndex = 0;
    people.push(...extractPeopleFromDocumentText(text, doc, ctx, filters, Math.max(limit - people.length, 0)));
    if (people.length >= limit) break;
  }
  return people;
}

function dedupePeople(rows: any[], limit: number): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = String(row.email || row.full_name || row.id || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

async function queryEventPeople(ctx: AuthContext, env: Env, filters: StructuredFilters, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const [attendees, recipients, documentPeople] = await Promise.all([
    queryEventAttendees(ctx, env, { ...filters, has_email: filters.has_email ?? true }, limit),
    queryCampaignRecipients(ctx, env, { ...filters, has_email: filters.has_email ?? true }, limit),
    queryDocumentPeople(ctx, env, { ...filters, has_email: filters.has_email ?? true }, limit),
  ]);
  const rows = dedupePeople([...recipients, ...attendees, ...documentPeople], limit);
  return { rows, semanticUsed: false };
}

async function queryDocuments(env: Env, orgId: string, filters: StructuredFilters, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const where = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [orgId];
  let semanticUsed = false;
  addInFilter(where, binds, 'd.document_type', asArray(filters.document_types));
  addLikeAny(where, binds, ['d.title', 'd.file_name', 'd.extracted_text_preview'], [filters.keyword || '', ...asArray(filters.keywords)]);
  semanticUsed = addSemanticTermFilters(where, binds, 'd', 'document', asArray(filters.semantic_terms), undefined) || semanticUsed;
  semanticUsed = addSemanticPredicateFilters(where, binds, 'd', 'document', filters.semantic_predicates) || semanticUsed;
  const rows = await env.D1.prepare(
    `SELECT d.id, d.title, d.file_name, d.document_type, d.mime_type,
            d.created_at, d.extracted_text_preview,
            r.tags_json AS semantic_tags,
            r.evidence_count AS semantic_evidence_count
       FROM documents d
       LEFT JOIN semantic_subjects ss
         ON ss.org_id = d.org_id AND ss.linked_entity_type = 'document' AND ss.linked_entity_id = d.id
       LEFT JOIN semantic_tag_rollups r
         ON r.org_id = ss.org_id AND r.subject_id = ss.id
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  const out = (rows.results || []) as any[];
  await attachSemanticFacts(env, orgId, 'document', out);
  return { rows: out, semanticUsed };
}

async function runTargetQuery(ctx: AuthContext, input: StructuredDataQueryInput, env: Env, limit: number): Promise<{ rows: any[]; semanticUsed: boolean }> {
  const filters = input.filters || {};
  switch (input.target) {
    case 'companies': return queryCompanies(env, ctx.orgId, filters, limit);
    case 'company_contacts': return queryCompanyContacts(env, ctx.orgId, filters, limit);
    case 'contacts': return queryContacts(env, ctx.orgId, filters, limit);
    case 'deals': return queryDeals(env, ctx.orgId, filters, limit);
    case 'document_people': return { rows: await queryDocumentPeople(ctx, env, { ...filters, has_email: filters.has_email ?? true }, limit), semanticUsed: false };
    case 'events': return queryEvents(env, ctx.orgId, filters, limit);
    case 'event_people': return queryEventPeople(ctx, env, filters, limit);
    case 'campaign_recipients': return { rows: await queryCampaignRecipients(ctx, env, filters, limit), semanticUsed: false };
    case 'documents': return queryDocuments(env, ctx.orgId, filters, limit);
    default: return { rows: [], semanticUsed: false };
  }
}

function rowsToSheetRows(rows: Record<string, unknown>[], columns: string[]): unknown[][] {
  return [
    columns,
    ...rows.map(row => columns.map(col => {
      const value = row[col];
      if (value === null || typeof value === 'undefined') return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
    })),
  ];
}

function defaultTitle(target: StructuredTarget, filters: StructuredFilters): string {
  const base = target.replace(/_/g, ' ');
  const qualifier = filters.event_title || filters.keyword || asArray(filters.semantic_terms)[0] || asArray(filters.sectors)[0];
  return qualifier ? `${base} - ${qualifier}` : `${base} export`;
}

export async function structuredDataQueryTool(
  ctx: AuthContext,
  input: StructuredDataQueryInput,
  env: Env
): Promise<StructuredQueryResult> {
  const operation = input.operation || 'list';
  const limit = clampLimit(input.limit, operation);
  const filters = input.filters || {};
  const { rows, semanticUsed } = await runTargetQuery(ctx, input, env, limit);
  const fields = requestedColumns(rows, input.fields);
  const shapedRows = operation === 'count'
    ? []
    : rows.map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
  const caveats: string[] = [];
  if (input.target === 'event_people') {
    const documentRows = rows.filter(row => String(row.source_type || '').startsWith('document')).length;
    caveats.push('event_people combines campaign recipients, calendar/event attendees, and matching document/spreadsheet rows, deduped by email when available.');
    if (documentRows > 0) {
      caveats.push(`Included ${documentRows} document-derived row${documentRows === 1 ? '' : 's'} from matching attendee/contact files.`);
    }
    if (asArray(filters.invited_by_users).length > 0) {
      caveats.push('invited_by filters use campaign sender/creator, event organizer data, and row/document-scope inviter clues when spreadsheets encode them.');
    }
  }
  if (input.target === 'company_contacts') {
    caveats.push('company_contacts filters companies/funds first, then returns linked CRM contacts for outreach/export workflows.');
  }
  if (input.target === 'document_people') {
    caveats.push('document_people extracts mail-merge-style people rows from matching spreadsheets/documents and dedupes by email.');
  }
  if (semanticUsed) caveats.push('semantic filters use evidence-backed semantic assertions when present, with CRM text fields as supporting filters.');
  if (operation !== 'count' && rows.length >= limit) caveats.push(`Result set hit the limit of ${limit}; increase limit for a broader export.`);

  const result: StructuredQueryResult = {
    ok: true,
    target: input.target,
    operation,
    count: rows.length,
    returned: shapedRows.length,
    rows: shapedRows,
    columns: fields,
    semantic_filter_used: semanticUsed,
    caveats,
  };

  if (operation === 'export_xlsx') {
    const title = String(input.export_title || defaultTitle(input.target, filters)).slice(0, 140);
    const artifact = await createDocumentArtifactTool(ctx, {
      kind: 'xlsx',
      title,
      structured_content: {
        sheets: [
          {
            name: 'Results',
            rows: rowsToSheetRows(shapedRows, fields),
          },
          {
            name: 'Query Notes',
            rows: [
              ['Field', 'Value'],
              ['Target', input.target],
              ['Rows exported', shapedRows.length],
              ['Semantic filter used', semanticUsed ? 'yes' : 'no'],
              ['Generated by', 'MARTy structured query'],
              ['Caveats', caveats.join(' ')],
            ],
          },
        ],
      },
    }, env);
    result.document = artifact.document;
    result.document_cards = artifact.document_cards;
    result.message = `Created ${title}.xlsx with ${shapedRows.length} row${shapedRows.length === 1 ? '' : 's'}.`;
  }

  return result;
}
