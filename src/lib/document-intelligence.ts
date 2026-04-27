import type { Env } from '../types/env';
import type { ChunkMetadata } from '../types/interfaces';
import { callClaude } from './claude';
import { jaroWinkler, scoreSimilarity } from './dedup';
import { proposeMultipleUpdates, type SourceType } from './progressive-enrichment';
import { findOrCreateCompanyByDomain } from './discovery';
import { chunkEmbedAndPersistAll } from './embedding';
import { extractTextFromFile } from './file-extraction';
import { emitAudit } from './audit';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type DocumentCategory =
  | 'contact_list'
  | 'pitch_deck'
  | 'financial_report'
  | 'meeting_notes'
  | 'deal_memo'
  | 'email_thread'
  | 'news_article'
  | 'legal_document'
  | 'investor_update'
  | 'market_research'
  | 'portfolio_report'
  | 'resume_cv'
  | 'other';

export interface ExtractedContact {
  full_name: string;
  email?: string;
  phone?: string;
  job_title?: string;
  linkedin_url?: string;
  company_name?: string;
  location?: string;
  confidence: number;
}

export interface ExtractedCompany {
  name: string;
  domain?: string;
  website?: string;
  sector?: string;
  company_type?: string;
  location?: string;
  description?: string;
  stage?: string;
  valuation?: number;
  confidence: number;
}

export interface ExtractedDeal {
  name: string;
  company_name?: string;
  stage?: string;
  amount?: number;
  description?: string;
  confidence: number;
}

export interface ExtractedRelationship {
  from_name: string;
  to_name: string;
  relationship_type: string;
  context?: string;
}

export interface ExtractedSignal {
  entity_name: string;
  signal_type: 'funding' | 'hiring' | 'product_launch' | 'partnership' | 'leadership_change' | 'other';
  summary: string;
  date?: string;
}

export interface ExtractionResult {
  category: DocumentCategory;
  contacts: ExtractedContact[];
  companies: ExtractedCompany[];
  deals: ExtractedDeal[];
  relationships: ExtractedRelationship[];
  signals: ExtractedSignal[];
  summary: string;
}

interface MatchedEntity {
  extracted_name: string;
  matched_id: string | null;
  match_type: 'exact' | 'fuzzy' | 'new';
  confidence: number;
}

export interface ImportResult {
  document_id: string;
  category: DocumentCategory;
  summary: string;
  contacts_created: number;
  contacts_updated: number;
  companies_created: number;
  companies_updated: number;
  deals_created: number;
  relationships_found: number;
  signals_found: number;
  entities_routed: number;
  errors: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Document Classifier
// ────────────────────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a document classifier for a venture capital CRM.
Given the first portion of a document, classify it into exactly one category.

Categories:
- contact_list: spreadsheet/list of people with names, emails, phones, titles
- pitch_deck: startup pitch deck or investor presentation
- financial_report: financial statements, balance sheets, P&L
- meeting_notes: notes from meetings, calls, or conversations
- deal_memo: investment memo, deal analysis, due diligence
- email_thread: email correspondence
- news_article: news, press release, blog post
- legal_document: contracts, terms, NDAs, agreements
- investor_update: portfolio company updates, quarterly letters
- market_research: industry analysis, market reports
- portfolio_report: fund performance, portfolio summary
- resume_cv: resume, CV, professional profile
- other: doesn't fit the above categories

Respond with ONLY a JSON object: {"category": "<category>", "confidence": <0.0-1.0>}`;

export async function classifyDocument(
  text: string,
  fileName: string,
  env: Env,
  orgId: string
): Promise<{ category: DocumentCategory; confidence: number }> {
  const preview = text.slice(0, 3000);
  const userPrompt = `File name: ${fileName}\n\nContent preview:\n${preview}`;

  try {
    const response = await callClaude(
      { system: CLASSIFIER_SYSTEM, user: userPrompt, max_tokens: 100, orgId, model: 'claude-haiku-4-5-20251001' },
      'low',
      env
    );
    const cleaned = response.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      category: parsed.category as DocumentCategory,
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
    };
  } catch (e) {
    console.error('[doc-intel] classification failed:', e);
    return { category: 'other', confidence: 0.3 };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Entity Extractor
// ────────────────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_TABULAR = `You are an entity extractor for a venture capital CRM.
The document is a tabular/list format (CSV, spreadsheet, contact list).
Extract ALL people, companies, and deals mentioned.

Respond with ONLY a JSON object matching this schema:
{
  "contacts": [{"full_name":"...","email":"...","phone":"...","job_title":"...","company_name":"...","location":"...","linkedin_url":"...","confidence":0.9}],
  "companies": [{"name":"...","domain":"...","website":"...","sector":"...","company_type":"...","location":"...","description":"...","confidence":0.8}],
  "deals": [],
  "relationships": [],
  "signals": [],
  "summary": "Brief 1-2 sentence summary of what this document contains"
}

Rules:
- Extract every person you can find. Include partial data — a name alone is valid.
- Infer company names from email domains when no explicit company is listed.
- Confidence 0.9+ for explicitly stated data, 0.7-0.9 for inferred data.
- Do NOT invent data. If a field is missing, omit it from the object.
- For phone numbers, preserve the original format.`;

const EXTRACTION_SYSTEM_COMPLEX = `You are an entity extractor for a venture capital CRM.
The document is a complex document (pitch deck, memo, meeting notes, report, etc.).
Extract ALL people, companies, deals, relationships, and investment signals.

Respond with ONLY a JSON object matching this schema:
{
  "contacts": [{"full_name":"...","email":"...","phone":"...","job_title":"...","company_name":"...","location":"...","confidence":0.8}],
  "companies": [{"name":"...","domain":"...","website":"...","sector":"...","company_type":"...","location":"...","description":"...","stage":"...","valuation":null,"confidence":0.8}],
  "deals": [{"name":"...","company_name":"...","stage":"...","amount":null,"description":"...","confidence":0.7}],
  "relationships": [{"from_name":"...","to_name":"...","relationship_type":"investor|advisor|board_member|employee|partner","context":"..."}],
  "signals": [{"entity_name":"...","signal_type":"funding|hiring|product_launch|partnership|leadership_change|other","summary":"...","date":"..."}],
  "summary": "Brief 2-3 sentence summary of the document's key intelligence"
}

Rules:
- Extract every entity mentioned, even if only partially described.
- For deals, extract funding rounds, investment amounts, and valuations.
- For relationships, capture who is connected to whom and how.
- For signals, capture any notable business events or changes.
- Confidence: 0.9+ for explicitly stated, 0.7-0.9 for strongly inferred, 0.5-0.7 for weakly inferred.
- Do NOT invent data. Omit fields you cannot determine.
- Valuation and amount should be numbers (in USD) or null.`;

const TABULAR_CATEGORIES = new Set<DocumentCategory>(['contact_list', 'portfolio_report']);

export async function extractEntities(
  text: string,
  category: DocumentCategory,
  env: Env,
  orgId: string
): Promise<ExtractionResult> {
  const isTabular = TABULAR_CATEGORIES.has(category);
  const system = isTabular ? EXTRACTION_SYSTEM_TABULAR : EXTRACTION_SYSTEM_COMPLEX;
  const model = isTabular ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';

  const maxChars = isTabular ? 30000 : 20000;
  const truncated = text.length > maxChars ? text.slice(0, maxChars) + '\n[... truncated]' : text;

  try {
    const response = await callClaude(
      { system, user: truncated, max_tokens: 4000, orgId, model },
      'high',
      env
    );
    const cleaned = response.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      category,
      contacts: (parsed.contacts || []).filter((c: any) => c.full_name),
      companies: (parsed.companies || []).filter((c: any) => c.name),
      deals: parsed.deals || [],
      relationships: parsed.relationships || [],
      signals: parsed.signals || [],
      summary: parsed.summary || '',
    };
  } catch (e) {
    console.error('[doc-intel] extraction failed:', e);
    return { category, contacts: [], companies: [], deals: [], relationships: [], signals: [], summary: '' };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Entity Matcher
// ────────────────────────────────────────────────────────────────────────────

async function matchContact(
  extracted: ExtractedContact,
  orgId: string,
  env: Env
): Promise<MatchedEntity> {
  if (extracted.email) {
    const byEmail = await env.D1.prepare(
      'SELECT id, full_name FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, extracted.email.toLowerCase()).first<{ id: string; full_name: string }>();
    if (byEmail) {
      return { extracted_name: extracted.full_name, matched_id: byEmail.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  if (extracted.full_name) {
    const candidates = await env.D1.prepare(
      'SELECT id, full_name, email, phone, company_id FROM contacts WHERE org_id = ? AND deleted_at IS NULL LIMIT 500'
    ).bind(orgId).all<{ id: string; full_name: string; email: string | null; phone: string | null; company_id: string | null }>();

    let bestId: string | null = null;
    let bestScore = 0;

    for (const c of candidates.results) {
      const sim = scoreSimilarity(
        { full_name: extracted.full_name, email: extracted.email || undefined, phone: extracted.phone || undefined } as any,
        { full_name: c.full_name, email: c.email || undefined, phone: c.phone || undefined, company_id: c.company_id || undefined } as any
      );
      if (sim > bestScore) {
        bestScore = sim;
        bestId = c.id;
      }
    }

    if (bestScore >= 0.6 && bestId) {
      return { extracted_name: extracted.full_name, matched_id: bestId, match_type: 'fuzzy', confidence: bestScore };
    }
  }

  return { extracted_name: extracted.full_name, matched_id: null, match_type: 'new', confidence: 0 };
}

async function matchCompany(
  extracted: ExtractedCompany,
  orgId: string,
  env: Env
): Promise<MatchedEntity> {
  if (extracted.domain) {
    const domainLower = extracted.domain.toLowerCase().replace(/^www\./, '');
    const byDomain = await env.D1.prepare(
      'SELECT id, name FROM companies WHERE org_id = ? AND LOWER(domain) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, domainLower).first<{ id: string; name: string }>();
    if (byDomain) {
      return { extracted_name: extracted.name, matched_id: byDomain.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  const candidates = await env.D1.prepare(
    'SELECT id, name, domain FROM companies WHERE org_id = ? AND deleted_at IS NULL LIMIT 500'
  ).bind(orgId).all<{ id: string; name: string; domain: string | null }>();

  for (const c of candidates.results) {
    const nameA = extracted.name.toLowerCase().trim();
    const nameB = c.name.toLowerCase().trim();
    if (nameA === nameB) {
      return { extracted_name: extracted.name, matched_id: c.id, match_type: 'exact', confidence: 1.0 };
    }
    if (jaroWinkler(nameA, nameB) >= 0.85) {
      return { extracted_name: extracted.name, matched_id: c.id, match_type: 'fuzzy', confidence: jaroWinkler(nameA, nameB) };
    }
  }

  return { extracted_name: extracted.name, matched_id: null, match_type: 'new', confidence: 0 };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Entity Router
// ────────────────────────────────────────────────────────────────────────────

async function routeContact(
  extracted: ExtractedContact,
  match: MatchedEntity,
  orgId: string,
  documentId: string,
  env: Env
): Promise<{ created: boolean; updated: boolean; id: string }> {
  if (match.matched_id && match.match_type !== 'new') {
    const updates: { field: string; value: string; source: string; confidence: number; source_description: string }[] = [];

    if (extracted.job_title) updates.push({ field: 'job_title', value: extracted.job_title, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.phone) updates.push({ field: 'phone', value: extracted.phone, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.linkedin_url) updates.push({ field: 'linkedin_url', value: extracted.linkedin_url, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.location) updates.push({ field: 'location', value: extracted.location, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });

    if (updates.length > 0) {
      await proposeMultipleUpdates(orgId, 'contact', match.matched_id, updates, env, { policy: 'auto_if_confident' });
    }
    return { created: false, updated: updates.length > 0, id: match.matched_id };
  }

  const contactId = crypto.randomUUID();
  const now = new Date().toISOString();

  let companyId: string | null = null;
  if (extracted.email) {
    const domain = extracted.email.split('@')[1];
    if (domain) {
      companyId = await findOrCreateCompanyByDomain(domain, orgId, env);
    }
  }

  await env.D1.prepare(
    `INSERT INTO contacts
       (id, org_id, full_name, email, phone, job_title, linkedin_url, location, company_id,
        source, source_confidence, contact_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, 'individual', ?, ?)`
  ).bind(
    contactId, orgId,
    extracted.full_name,
    extracted.email || null,
    extracted.phone || null,
    extracted.job_title || null,
    extracted.linkedin_url || null,
    extracted.location || null,
    companyId,
    extracted.confidence,
    now, now
  ).run();

  return { created: true, updated: false, id: contactId };
}

async function routeCompany(
  extracted: ExtractedCompany,
  match: MatchedEntity,
  orgId: string,
  documentId: string,
  env: Env
): Promise<{ created: boolean; updated: boolean; id: string }> {
  if (match.matched_id && match.match_type !== 'new') {
    const updates: { field: string; value: string; source: string; confidence: number; source_description: string }[] = [];

    if (extracted.sector) updates.push({ field: 'sector', value: extracted.sector, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.website) updates.push({ field: 'website', value: extracted.website, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.description) updates.push({ field: 'description', value: extracted.description, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.location) updates.push({ field: 'hq_location', value: extracted.location, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.stage) updates.push({ field: 'stage', value: extracted.stage, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.valuation) updates.push({ field: 'current_valuation', value: String(extracted.valuation), source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });

    if (updates.length > 0) {
      await proposeMultipleUpdates(orgId, 'company', match.matched_id, updates, env, { policy: 'auto_if_confident' });
    }
    return { created: false, updated: updates.length > 0, id: match.matched_id };
  }

  if (extracted.domain) {
    const companyId = await findOrCreateCompanyByDomain(extracted.domain, orgId, env);
    if (companyId) return { created: true, updated: false, id: companyId };
  }

  const companyId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO companies
       (id, org_id, name, domain, website, sector, company_type, hq_location, description,
        stage, investment_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracking', ?, ?)`
  ).bind(
    companyId, orgId,
    extracted.name,
    extracted.domain || null,
    extracted.website || null,
    extracted.sector || null,
    extracted.company_type || 'other',
    extracted.location || null,
    extracted.description || null,
    extracted.stage || null,
    now, now
  ).run();

  return { created: true, updated: false, id: companyId };
}

async function routeDeal(
  extracted: ExtractedDeal,
  companyLookup: Map<string, string>,
  orgId: string,
  env: Env
): Promise<{ created: boolean; id: string }> {
  let companyId: string | null = null;
  if (extracted.company_name) {
    companyId = companyLookup.get(extracted.company_name.toLowerCase()) || null;
  }

  const dealId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO deals
       (id, org_id, name, company_id, stage, amount, description, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`
  ).bind(
    dealId, orgId,
    extracted.name,
    companyId,
    extracted.stage || 'prospect',
    extracted.amount || null,
    extracted.description || null,
    now, now
  ).run();

  return { created: true, id: dealId };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Main Pipeline Orchestrator
// ────────────────────────────────────────────────────────────────────────────

export async function processIntelligentImport(
  file: File,
  orgId: string,
  userId: string,
  env: Env
): Promise<ImportResult> {
  const errors: string[] = [];
  const documentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `${orgId}/document/${now.slice(0, 7)}/${documentId}_${file.name}`;

  // Store file in R2
  const buffer = await file.arrayBuffer();
  await env.R2.put(r2Key, buffer);

  // Extract text
  const text = await extractTextFromFile(file);
  if (!text || text.trim().length < 20) {
    return {
      document_id: documentId,
      category: 'other',
      summary: 'Could not extract meaningful text from file',
      contacts_created: 0, contacts_updated: 0,
      companies_created: 0, companies_updated: 0,
      deals_created: 0, relationships_found: 0, signals_found: 0,
      entities_routed: 0, errors: ['Text extraction returned insufficient content'],
    };
  }

  // Classify
  const { category, confidence: classConfidence } = await classifyDocument(text, file.name, env, orgId);
  console.log(`[doc-intel] classified "${file.name}" as ${category} (confidence: ${classConfidence})`);

  // Extract entities
  const extraction = await extractEntities(text, category, env, orgId);
  console.log(`[doc-intel] extracted: ${extraction.contacts.length} contacts, ${extraction.companies.length} companies, ${extraction.deals.length} deals`);

  // Store document record in D1
  await env.D1.prepare(
    `INSERT INTO documents
       (id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
        uploaded_by, processing_status, extracted_text_preview, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'intelligent_import', ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`
  ).bind(
    documentId, orgId,
    file.name,
    category,
    r2Key,
    file.name,
    file.size,
    file.type || null,
    userId,
    text.slice(0, 500),
    now, now
  ).run();

  // Match + Route companies first (contacts may reference them)
  const companyLookup = new Map<string, string>();
  let companiesCreated = 0;
  let companiesUpdated = 0;

  for (const company of extraction.companies) {
    try {
      const match = await matchCompany(company, orgId, env);
      const result = await routeCompany(company, match, orgId, documentId, env);
      companyLookup.set(company.name.toLowerCase(), result.id);
      if (result.created) companiesCreated++;
      if (result.updated) companiesUpdated++;
    } catch (e: any) {
      errors.push(`Company "${company.name}": ${e.message}`);
    }
  }

  // Match + Route contacts
  let contactsCreated = 0;
  let contactsUpdated = 0;

  for (const contact of extraction.contacts) {
    try {
      const match = await matchContact(contact, orgId, env);
      const result = await routeContact(contact, match, orgId, documentId, env);
      if (result.created) contactsCreated++;
      if (result.updated) contactsUpdated++;

      if (contact.company_name && result.id) {
        const companyId = companyLookup.get(contact.company_name.toLowerCase());
        if (companyId) {
          await env.D1.prepare(
            'UPDATE contacts SET company_id = ? WHERE id = ? AND company_id IS NULL'
          ).bind(companyId, result.id).run();
        }
      }
    } catch (e: any) {
      errors.push(`Contact "${contact.full_name}": ${e.message}`);
    }
  }

  // Route deals
  let dealsCreated = 0;
  for (const deal of extraction.deals) {
    try {
      const result = await routeDeal(deal, companyLookup, orgId, env);
      if (result.created) dealsCreated++;
    } catch (e: any) {
      errors.push(`Deal "${deal.name}": ${e.message}`);
    }
  }

  // Embed document text for RAG
  try {
    const meta: ChunkMetadata = {
      org_id: orgId,
      document_type: category,
      source_table: 'documents',
      source_id: documentId,
      r2_key: r2Key,
      visibility: 'org_wide',
      primary_entity_id: documentId,
      created_at: now,
      entity_name: file.name,
    };

    const entries = await chunkEmbedAndPersistAll(text, meta, env);
    if (entries.length > 0) {
      await env.D1.batch(
        entries.map(e =>
          env.D1.prepare(
            'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
          ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
        )
      );
    }
  } catch (e: any) {
    errors.push(`Embedding: ${e.message}`);
  }

  // Update document status
  await env.D1.prepare(
    `UPDATE documents SET processing_status = 'completed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(documentId).run();

  // Audit
  await emitAudit(env, {
    org_id: orgId,
    user_id: userId,
    action: 'intelligent_import',
    entity_type: 'document',
    entity_id: documentId,
    metadata: {
      category,
      file_name: file.name,
      contacts_created: contactsCreated,
      contacts_updated: contactsUpdated,
      companies_created: companiesCreated,
      companies_updated: companiesUpdated,
      deals_created: dealsCreated,
      relationships: extraction.relationships.length,
      signals: extraction.signals.length,
    },
    created_at: now,
  });

  const totalRouted = contactsCreated + contactsUpdated + companiesCreated + companiesUpdated + dealsCreated;

  return {
    document_id: documentId,
    category,
    summary: extraction.summary,
    contacts_created: contactsCreated,
    contacts_updated: contactsUpdated,
    companies_created: companiesCreated,
    companies_updated: companiesUpdated,
    deals_created: dealsCreated,
    relationships_found: extraction.relationships.length,
    signals_found: extraction.signals.length,
    entities_routed: totalRouted,
    errors,
  };
}
