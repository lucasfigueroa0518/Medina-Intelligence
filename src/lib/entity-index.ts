import type { Env } from '../types/env';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'has', 'had', 'have',
  'this', 'that', 'it', 'as', 'from', 'not', 'they', 'their', 'he', 'she',
  'his', 'her', 'we', 'our', 'can', 'will', 'would', 'could', 'should', 'also',
  'more', 'about', 'than', 'into', 'over', 'very', 'just', 'new', 'one', 'two',
  'been', 'being', 'who', 'which', 'what', 'where', 'when', 'how', 'all', 'each',
  'every', 'both', 'few', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
  'then', 'now', 'here', 'there', 'them', 'these', 'those', 'its',
]);

function extractKeywords(text: string | null | undefined, count: number): string {
  if (!text) return '';
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(e => e[0])
    .join(',');
}

export interface ContactIndexEntry {
  id: string;
  full_name: string;
  email: string | null;
  job_title: string | null;
  company_id: string | null;
  company_name: string | null;
  bio_keywords: string;
  last_contact_date: string | null;
  total_interactions: number;
}

export interface CompanyIndexEntry {
  id: string;
  name: string;
  domain: string | null;
  sector: string | null;
  description_keywords: string;
  contact_count: number;
}

export interface EntityIndex {
  contacts: ContactIndexEntry[];
  companies: CompanyIndexEntry[];
  built_at: string;
}

export async function rebuildEntityIndex(orgId: string, env: Env): Promise<EntityIndex> {
  const [contactRows, companyRows] = await Promise.all([
    env.D1.prepare(
      `SELECT c.id, c.full_name, c.email, c.job_title, c.company_id,
              c.bio_summary, c.last_contact_date, c.total_interactions,
              co.name AS company_name
       FROM contacts c
       LEFT JOIN companies co ON c.company_id = co.id
       WHERE c.org_id = ? AND c.deleted_at IS NULL AND c.merged_into IS NULL`
    ).bind(orgId).all<{
      id: string;
      full_name: string;
      email: string | null;
      job_title: string | null;
      company_id: string | null;
      bio_summary: string | null;
      last_contact_date: string | null;
      total_interactions: number;
      company_name: string | null;
    }>(),
    env.D1.prepare(
      `SELECT co.id, co.name, co.domain, co.sector, co.description,
              (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id AND c.deleted_at IS NULL) AS contact_count
       FROM companies co
       WHERE co.org_id = ? AND co.deleted_at IS NULL AND co.merged_into IS NULL`
    ).bind(orgId).all<{
      id: string;
      name: string;
      domain: string | null;
      sector: string | null;
      description: string | null;
      contact_count: number;
    }>(),
  ]);

  const contacts: ContactIndexEntry[] = contactRows.results.map(r => ({
    id: r.id,
    full_name: r.full_name,
    email: r.email,
    job_title: r.job_title,
    company_id: r.company_id,
    company_name: r.company_name,
    bio_keywords: extractKeywords(r.bio_summary, 10),
    last_contact_date: r.last_contact_date,
    total_interactions: r.total_interactions,
  }));

  const companies: CompanyIndexEntry[] = companyRows.results.map(r => ({
    id: r.id,
    name: r.name,
    domain: r.domain,
    sector: r.sector,
    description_keywords: extractKeywords(r.description, 10),
    contact_count: r.contact_count,
  }));

  const index: EntityIndex = { contacts, companies, built_at: new Date().toISOString() };

  const payload = JSON.stringify(index);
  await env.KV.put(`entity_index:${orgId}`, payload, { expirationTtl: 90000 });

  return index;
}

export async function updateEntityInIndex(
  orgId: string,
  entityType: 'contact' | 'company',
  entityId: string,
  env: Env
): Promise<void> {
  try {
    const raw = await env.KV.get(`entity_index:${orgId}`);
    if (!raw) return;
    const index: EntityIndex = JSON.parse(raw);

    if (entityType === 'contact') {
      const row = await env.D1.prepare(
        `SELECT c.id, c.full_name, c.email, c.job_title, c.company_id,
                c.bio_summary, c.last_contact_date, c.total_interactions,
                co.name AS company_name
         FROM contacts c
         LEFT JOIN companies co ON c.company_id = co.id
         WHERE c.id = ? AND c.deleted_at IS NULL AND c.merged_into IS NULL`
      ).bind(entityId).first<{
        id: string;
        full_name: string;
        email: string | null;
        job_title: string | null;
        company_id: string | null;
        bio_summary: string | null;
        last_contact_date: string | null;
        total_interactions: number;
        company_name: string | null;
      }>();

      if (!row) {
        index.contacts = index.contacts.filter(c => c.id !== entityId);
      } else {
        const entry: ContactIndexEntry = {
          id: row.id,
          full_name: row.full_name,
          email: row.email,
          job_title: row.job_title,
          company_id: row.company_id,
          company_name: row.company_name,
          bio_keywords: extractKeywords(row.bio_summary, 10),
          last_contact_date: row.last_contact_date,
          total_interactions: row.total_interactions,
        };
        const idx = index.contacts.findIndex(c => c.id === entityId);
        if (idx >= 0) index.contacts[idx] = entry;
        else index.contacts.push(entry);
      }
    } else {
      const row = await env.D1.prepare(
        `SELECT co.id, co.name, co.domain, co.sector, co.description,
                (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id AND c.deleted_at IS NULL) AS contact_count
         FROM companies co
         WHERE co.id = ? AND co.deleted_at IS NULL AND co.merged_into IS NULL`
      ).bind(entityId).first<{
        id: string;
        name: string;
        domain: string | null;
        sector: string | null;
        description: string | null;
        contact_count: number;
      }>();

      if (!row) {
        index.companies = index.companies.filter(c => c.id !== entityId);
      } else {
        const entry: CompanyIndexEntry = {
          id: row.id,
          name: row.name,
          domain: row.domain,
          sector: row.sector,
          description_keywords: extractKeywords(row.description, 10),
          contact_count: row.contact_count,
        };
        const idx = index.companies.findIndex(c => c.id === entityId);
        if (idx >= 0) index.companies[idx] = entry;
        else index.companies.push(entry);
      }
    }

    await env.KV.put(`entity_index:${orgId}`, JSON.stringify(index), { expirationTtl: 90000 });
  } catch (e) {
    console.error('[entity-index] incremental update failed:', e);
  }
}

export async function getEntityIndex(orgId: string, env: Env): Promise<EntityIndex> {
  const raw = await env.KV.get(`entity_index:${orgId}`);
  if (raw) return JSON.parse(raw);
  return rebuildEntityIndex(orgId, env);
}
