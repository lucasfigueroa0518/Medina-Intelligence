// TRD §8.2-8.5 — preprocessQuery, retrieveContext, crossEncoderRerank
// (context assembly with citation sources lives in lib/citations.ts)
import type { Env } from '../types/env';
import type {
  AgentSession,
  HydratedChunk,
  ProcessedQuery,
  VectorMatch,
} from '../types/interfaces';
import { hydrateChunks } from './hydration';
import { runEmbedding } from './embedding';
import { truncateToTokens } from './tokens';
import { getOrgSettings, getSharingFlags, parseParticipantUserIds } from './helpers';
import { getEntityIndex } from './entity-index';

export interface RetrievalOptions {
  deepDive?: boolean;
  // When set, forces the doc-type-targeted secondary Vectorize query to fire
  // for these document_type values regardless of detectDocTypes's keyword
  // match on the query string. Used by the recall() agent tool: Claude can
  // pass source_types=['slack'] with query="recent activity" — without this,
  // detectDocTypes wouldn't match 'slack' in the query and the targeted
  // query wouldn't run, defeating the whole point of the source_types arg.
  // Values are document_type strings: 'email', 'conversation' (slack),
  // 'transcript' (meetings), 'document'. (Audit 2026-05-05 root cause.)
  forceDocTypes?: string[];
}

function isAggregationQuery(query: string): boolean {
  return /\b(how many|count|total|tally|all the|every|list all|summarize all|aggregate|across all|compile|gather all)\b/i.test(query);
}

const DOC_TYPE_KEYWORDS: Record<string, string[]> = {
  pitch_deck: ['pitch deck', 'pitch decks', 'deck', 'decks', 'presentation'],
  email: ['email', 'emails', 'message', 'thread'],
  transcript: ['meeting', 'meetings', 'call', 'calls', 'transcript', 'discussion'],
  document: ['document', 'file', 'attachment', 'pdf', 'doc'],
  // Slack messages get document_type='conversation' at ingestion (see
  // daily-cron.ts:562-564). When the user explicitly asks about Slack we
  // run a targeted Vectorize query filtered to document_type='conversation'
  // so actual Slack chunks rank ahead of semantic-neighbor emails. Without
  // this, recent Slack content lost to older topical emails (audit
  // 2026-05-05). Keep this list TIGHT — adding 'message' here would over-
  // trigger because most queries about emails also use that word.
  conversation: ['slack', 'channel'],
};

function detectDocTypes(query: string): string[] {
  const lower = query.toLowerCase();
  const matched: string[] = [];
  for (const [docType, keywords] of Object.entries(DOC_TYPE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) matched.push(docType);
  }
  return matched;
}

function hashFirstFiveDims(embedding: number[]): string {
  const firstFive = embedding
    .slice(0, 5)
    .map(v => (Number.isFinite(v) ? v.toFixed(6) : String(v)))
    .join('|');

  let hash = 2166136261;
  for (let i = 0; i < firstFive.length; i++) {
    hash ^= firstFive.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function retrievalLog(stage: string, payload: Record<string, unknown>): void {
  try {
    console.log(`[retrieve:${stage}] ${JSON.stringify(payload)}`);
  } catch {
    console.log(`[retrieve:${stage}] {"telemetry_error":"json_stringify_failed"}`);
  }
}

function countByDocType(chunks: Array<{ metadata?: Record<string, any> }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chunk of chunks) {
    const docType = String(chunk.metadata?.document_type || 'unknown');
    counts[docType] = (counts[docType] || 0) + 1;
  }
  return counts;
}

function countTargetedIds(
  chunks: Array<{ id?: unknown }>,
  targetedIds?: Set<string>
): number {
  if (!targetedIds || targetedIds.size === 0) return 0;
  return chunks.filter(chunk => targetedIds.has(chunk.id as string)).length;
}

function selectHydrationCandidates(
  chunks: VectorMatch[],
  limit: number,
  targetedIds: Set<string>
): VectorMatch[] {
  if (targetedIds.size === 0) return chunks.slice(0, limit);

  const targeted = chunks.filter(chunk => targetedIds.has(chunk.id));
  const broad = chunks.filter(chunk => !targetedIds.has(chunk.id));
  return [...targeted, ...broad].slice(0, limit);
}

function targetedMembershipSample(
  chunks: Array<{ id?: unknown }>,
  targetedIds?: Set<string>
): Record<string, unknown> {
  const targetedIdSample = targetedIds && targetedIds.size > 0
    ? [...targetedIds][0]
    : undefined;
  const hydratedTargetSample = targetedIdSample === undefined
    ? undefined
    : chunks.find(chunk =>
        [...targetedIds!].some(targetedId => String(targetedId) === String(chunk.id))
      );

  return {
    targeted_id_type: typeof targetedIdSample,
    hydrated_target_id_type: typeof hydratedTargetSample?.id,
    targeted_id_sample: targetedIdSample || null,
    hydrated_target_id_sample: hydratedTargetSample?.id || null,
    targeted_string_match_found: !!hydratedTargetSample,
    sample_set_has: hydratedTargetSample ? targetedIds!.has(hydratedTargetSample.id as string) : null,
  };
}

function summarizeMatches(
  matches: VectorMatch[],
  duplicateSet?: Set<string>,
  limit = 5
): Array<Record<string, unknown>> {
  return matches.slice(0, limit).map(m => ({
    id: m.id,
    id_type: typeof m.id,
    score: m.score,
    document_type: m.metadata.document_type,
    source_table: m.metadata.source_table,
    source_id: m.metadata.source_id,
    duplicate: duplicateSet ? duplicateSet.has(m.id) : undefined,
  }));
}

type EvidenceAnchor = {
  id: string;
  type: 'contact' | 'company' | 'deal';
  name: string;
  company_id?: string | null;
  stage?: string | null;
};

type EvidenceIntent =
  | 'pitch_opportunity'
  | 'person_stance'
  | 'project_status'
  | 'meeting_summary'
  | 'recent_activity'
  | 'relationship_history'
  | 'diligence_risk'
  | 'document_artifact'
  | 'generic_recall';

type EvidencePlan = {
  query: string;
  anchor_ids: string[];
  anchors: EvidenceAnchor[];
  anchor_counts: Record<string, number>;
  primary_intent: EvidenceIntent;
  intents: EvidenceIntent[];
  time_intent: 'latest' | 'recent' | 'historical' | 'specific_date' | 'unspecified';
  evidence_strategy: {
    primary_families: string[];
    supporting_families: string[];
    context_families: string[];
    subtype_hints: string[];
    subtype_hints_are_boosts_only: boolean;
  };
  source_balance_goal: Record<string, number>;
  signal_terms: string[];
  expansion_strategy: string[];
  risk_flags: string[];
  detected_doc_types: string[];
  forced_doc_types: string[] | null;
};

async function resolveEvidenceAnchors(pq: ProcessedQuery, env: Env): Promise<EvidenceAnchor[]> {
  if (pq.entityIds.length === 0) return [];
  const ids = pq.entityIds;
  const placeholders = ids.map(() => '?').join(',');
  const [contacts, companies, deals] = await Promise.all([
    env.D1.prepare(
      `SELECT id, full_name, company_id
       FROM contacts
       WHERE org_id = ? AND id IN (${placeholders})`
    ).bind(pq.orgId, ...ids).all<{ id: string; full_name: string; company_id: string | null }>(),
    env.D1.prepare(
      `SELECT id, name
       FROM companies
       WHERE org_id = ? AND id IN (${placeholders})`
    ).bind(pq.orgId, ...ids).all<{ id: string; name: string }>(),
    env.D1.prepare(
      `SELECT id, title, company_id, stage
       FROM deals
       WHERE org_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`
    ).bind(pq.orgId, ...ids).all<{ id: string; title: string; company_id: string | null; stage: string | null }>(),
  ]);

  const anchors = new Map<string, EvidenceAnchor>();
  for (const row of contacts.results) {
    anchors.set(row.id, { id: row.id, type: 'contact', name: row.full_name, company_id: row.company_id });
  }
  for (const row of companies.results) {
    anchors.set(row.id, { id: row.id, type: 'company', name: row.name });
  }
  for (const row of deals.results) {
    anchors.set(row.id, { id: row.id, type: 'deal', name: row.title, company_id: row.company_id, stage: row.stage });
  }
  return ids.map(id => anchors.get(id)).filter((a): a is EvidenceAnchor => Boolean(a));
}

function hasAny(lower: string, terms: string[]): boolean {
  return terms.some(term => lower.includes(term));
}

function inferEvidenceIntents(query: string): EvidenceIntent[] {
  const lower = query.toLowerCase();
  const intents: EvidenceIntent[] = [];

  if (hasAny(lower, ['pitch', 'fundraising', 'fundraise', 'raise', 'valuation', 'investment opportunity', 'terms', 'ask'])) {
    intents.push('pitch_opportunity');
  }
  if (/\b(feel|feels|think|thinks|thoughts|view|views|opinion|stance|concern|concerns|worried|skeptical|bullish|bearish)\b/.test(lower)) {
    intents.push('person_stance');
  }
  if (/\b(status|update|progress|blocker|blocked|owner|next step|next steps|timeline|where are we|where is|what's going on|whats going on)\b/.test(lower)) {
    intents.push('project_status');
  }
  if (/\b(meeting|meetings|call|calls|transcript|discussion|readout)\b/.test(lower)) {
    intents.push('meeting_summary');
  }
  if (/\b(latest|recent|recently|today|yesterday|this week|last week|current|currently|newest|last)\b/.test(lower)) {
    intents.push('recent_activity');
  }
  if (/\b(history|relationship|interactions|touchpoints|last contact|met|know)\b/.test(lower)) {
    intents.push('relationship_history');
  }
  if (/\b(risk|risks|diligence|concern|concerns|red flag|red flags|moat|defensibility|competition|competitive)\b/.test(lower)) {
    intents.push('diligence_risk');
  }
  if (/\b(document|documents|doc|docs|pdf|attachment|file|deck|presentation|memo|model|term sheet)\b/.test(lower)) {
    intents.push('document_artifact');
  }

  return intents.length > 0 ? intents : ['generic_recall'];
}

function inferTimeIntent(query: string): EvidencePlan['time_intent'] {
  const lower = query.toLowerCase();
  if (/\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bq[1-4]\b/i.test(query)) {
    return 'specific_date';
  }
  if (/\b(latest|newest|most recent|last call|last meeting|current|currently)\b/.test(lower)) return 'latest';
  if (/\b(recent|recently|today|yesterday|this week|last week|past)\b/.test(lower)) return 'recent';
  if (/\b(history|historical|previous|earlier|old|older)\b/.test(lower)) return 'historical';
  return 'unspecified';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

const ENTITY_MATCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'about', 'this', 'that', 'these', 'those', 'what',
  'whats', "what's", 'who', 'where', 'when', 'how', 'is', 'are', 'was', 'were',
  'tell', 'me', 'status', 'update', 'call', 'meeting', 'pitch', 'deal',
]);

function normalizeEntityText(text: string | null | undefined): string {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactEntityText(text: string | null | undefined): string {
  return normalizeEntityText(text).replace(/\s+/g, '');
}

function tokenizeEntityText(text: string | null | undefined): string[] {
  return normalizeEntityText(text)
    .split(/\s+/)
    .filter(token => token.length > 1 && !ENTITY_MATCH_STOP_WORDS.has(token));
}

function countNameTokens<T>(items: T[], getName: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const token of new Set(tokenizeEntityText(getName(item)))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

function entityNameMatchesQuery(
  name: string,
  queryNormalized: string,
  queryCompact: string
): boolean {
  const tokens = tokenizeEntityText(name);
  if (tokens.length === 0) return false;
  const normalized = normalizeEntityText(name);
  const compact = compactEntityText(name);
  if (!normalized || !compact) return false;
  return queryNormalized.includes(normalized) || queryCompact.includes(compact);
}

function buildEvidencePlan(
  query: string,
  anchors: EvidenceAnchor[],
  detectedDocTypes: string[],
  forcedDocTypes?: string[]
): EvidencePlan {
  const intents = inferEvidenceIntents(query);
  const primaryIntent = intents[0] || 'generic_recall';
  const lower = query.toLowerCase();

  const primaryFamilies: string[] = [];
  const supportingFamilies: string[] = [];
  const contextFamilies: string[] = ['entity_context'];
  const subtypeHints: string[] = [];
  const signalTerms: string[] = [];
  const expansionStrategy: string[] = [];
  const balanceGoal: Record<string, number> = {};

  const addPrimary = (...families: string[]) => primaryFamilies.push(...families);
  const addSupporting = (...families: string[]) => supportingFamilies.push(...families);
  const addSignals = (...signals: string[]) => signalTerms.push(...signals.filter(s => lower.includes(s)));
  const addExpansion = (...targets: string[]) => expansionStrategy.push(...targets);

  if (intents.includes('pitch_opportunity')) {
    addPrimary('transcripts', 'documents');
    addSupporting('emails', 'slack', 'deal_records');
    subtypeHints.push('deal_pitch', 'deal_terms', 'deal_financials');
    addSignals('pitch', 'raise', 'fundraising', 'valuation', 'ask', 'terms', 'deck', 'investment opportunity');
    addExpansion('same_meeting', 'same_document', 'email_thread');
    balanceGoal.transcripts = 6;
    balanceGoal.documents = 4;
    balanceGoal.emails = 4;
    balanceGoal.slack = 3;
    balanceGoal.entity_context = 3;
  }

  if (intents.includes('person_stance')) {
    addPrimary('transcripts', 'emails', 'slack');
    addSupporting('entity_context', 'documents');
    addSignals('feel', 'think', 'thoughts', 'view', 'opinion', 'stance', 'concern', 'skeptical', 'bullish');
    addExpansion('speaker_or_author_context', 'same_meeting', 'email_thread', 'slack_thread');
    balanceGoal.transcripts = Math.max(balanceGoal.transcripts || 0, 6);
    balanceGoal.emails = Math.max(balanceGoal.emails || 0, 5);
    balanceGoal.slack = Math.max(balanceGoal.slack || 0, 5);
  }

  if (intents.includes('project_status')) {
    addPrimary('slack', 'emails', 'transcripts');
    addSupporting('documents', 'entity_context');
    addSignals('status', 'update', 'progress', 'blocker', 'blocked', 'next step', 'owner', 'timeline');
    addExpansion('slack_thread', 'email_thread', 'same_meeting');
    balanceGoal.slack = Math.max(balanceGoal.slack || 0, 6);
    balanceGoal.emails = Math.max(balanceGoal.emails || 0, 5);
    balanceGoal.transcripts = Math.max(balanceGoal.transcripts || 0, 4);
  }

  if (intents.includes('meeting_summary')) {
    addPrimary('transcripts');
    addSupporting('emails', 'documents', 'entity_context');
    addSignals('meeting', 'call', 'transcript', 'discussion', 'readout');
    addExpansion('same_meeting');
    balanceGoal.transcripts = Math.max(balanceGoal.transcripts || 0, 10);
    balanceGoal.emails = Math.max(balanceGoal.emails || 0, 3);
  }

  if (intents.includes('recent_activity')) {
    addPrimary('slack', 'emails', 'transcripts');
    addSupporting('entity_context', 'documents');
    addExpansion('slack_thread', 'email_thread', 'same_meeting');
  }

  if (intents.includes('relationship_history')) {
    addPrimary('emails', 'transcripts', 'slack');
    addSupporting('entity_context', 'documents');
    addExpansion('email_thread', 'same_meeting', 'slack_thread');
  }

  if (intents.includes('diligence_risk')) {
    addPrimary('transcripts', 'documents', 'emails');
    addSupporting('slack', 'entity_context');
    subtypeHints.push('deal_diligence', 'deal_financials', 'deal_terms');
    addSignals('risk', 'concern', 'red flag', 'diligence', 'moat', 'defensibility', 'competition');
    addExpansion('same_meeting', 'same_document', 'email_thread');
  }

  if (intents.includes('document_artifact')) {
    addPrimary('documents');
    addSupporting('emails', 'transcripts', 'entity_context');
    addExpansion('same_document', 'email_thread');
  }

  if (primaryIntent === 'generic_recall') {
    addPrimary('emails', 'transcripts', 'slack', 'documents');
    addSupporting('entity_context');
    balanceGoal.emails = 5;
    balanceGoal.transcripts = 5;
    balanceGoal.slack = 5;
    balanceGoal.documents = 5;
  }

  const anchorCounts: Record<string, number> = {};
  for (const anchor of anchors) anchorCounts[anchor.type] = (anchorCounts[anchor.type] || 0) + 1;

  const riskFlags: string[] = [];
  if (anchors.length === 0) riskFlags.push('no_entity_anchors');
  if (intents.includes('person_stance') && !anchors.some(a => a.type === 'contact')) riskFlags.push('stance_query_without_person_anchor');
  if (intents.includes('project_status') && anchors.length === 0) riskFlags.push('status_query_without_anchor');
  if (intents.includes('pitch_opportunity') && anchors.length === 0) riskFlags.push('pitch_query_without_person_or_company_anchor');
  if (intents.includes('pitch_opportunity')) riskFlags.push('document_subtypes_are_incomplete_do_not_filter_only_boost');

  return {
    query: query.slice(0, 120),
    anchor_ids: anchors.map(a => a.id),
    anchors,
    anchor_counts: anchorCounts,
    primary_intent: primaryIntent,
    intents,
    time_intent: inferTimeIntent(query),
    evidence_strategy: {
      primary_families: uniqueStrings(primaryFamilies),
      supporting_families: uniqueStrings(supportingFamilies),
      context_families: uniqueStrings(contextFamilies),
      subtype_hints: uniqueStrings(subtypeHints),
      subtype_hints_are_boosts_only: true,
    },
    source_balance_goal: balanceGoal,
    signal_terms: uniqueStrings(signalTerms),
    expansion_strategy: uniqueStrings(expansionStrategy),
    risk_flags: uniqueStrings(riskFlags),
    detected_doc_types: detectedDocTypes,
    forced_doc_types: forcedDocTypes && forcedDocTypes.length > 0 ? forcedDocTypes : null,
  };
}

export async function preprocessQuery(
  query: string,
  session: AgentSession,
  env: Env,
  options: RetrievalOptions = {}
): Promise<ProcessedQuery> {
  const queryLower = query.toLowerCase();
  const entityIds: string[] = [];
  const maxEntities = options.deepDive ? 20 : 5;

  if (options.deepDive) {
    const [contacts, companies] = await Promise.all([
      env.D1.prepare(
        `SELECT id, full_name, email, job_title, bio_summary, topics_of_interest,
                investment_focus, company_id
         FROM contacts WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
      ).bind(session.org_id).all<{
        id: string; full_name: string; email: string | null; job_title: string | null;
        bio_summary: string | null; topics_of_interest: string | null;
        investment_focus: string | null; company_id: string | null;
      }>(),
      env.D1.prepare(
        `SELECT id, name, domain, description, sector
         FROM companies WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
      ).bind(session.org_id).all<{
        id: string; name: string; domain: string | null; description: string | null; sector: string | null;
      }>(),
    ]);

    for (const c of contacts.results) {
      const searchable = [c.full_name, c.email, c.job_title, c.bio_summary, c.topics_of_interest, c.investment_focus]
        .filter(Boolean).join(' ').toLowerCase();
      if (queryLower.includes(c.full_name.toLowerCase()) || searchable.includes(queryLower)) {
        entityIds.push(c.id);
      }
    }
    for (const c of companies.results) {
      const searchable = [c.name, c.domain, c.description, c.sector]
        .filter(Boolean).join(' ').toLowerCase();
      if (queryLower.includes(c.name.toLowerCase()) || searchable.includes(queryLower)) {
        entityIds.push(c.id);
      }
    }

    if (options.deepDive && entityIds.length > 0) {
      const companyIds = new Set<string>();
      const contactCompanyIds = new Set<string>();
      for (const id of entityIds) {
        const company = companies.results.find(c => c.id === id);
        if (company) companyIds.add(company.id);
        const contact = contacts.results.find(c => c.id === id);
        if (contact?.company_id) contactCompanyIds.add(contact.company_id);
      }
      for (const cid of [...companyIds, ...contactCompanyIds]) {
        for (const contact of contacts.results) {
          if (contact.company_id === cid && !entityIds.includes(contact.id)) {
            entityIds.push(contact.id);
          }
        }
        if (!entityIds.includes(cid)) entityIds.push(cid);
      }
    }
  } else {
    try {
      const index = await getEntityIndex(session.org_id, env);
      type ScoredEntity = {
        id: string;
        type: 'contact' | 'company';
        name: string;
        score: number;
        interactions: number;
        recency: number;
        companyId?: string | null;
        reasons: string[];
      };
      const scored: ScoredEntity[] = [];
      const queryNormalized = normalizeEntityText(query);
      const queryCompact = compactEntityText(query);
      const queryTokens = new Set(tokenizeEntityText(query));
      const contactTokenCounts = countNameTokens(index.contacts, c => c.full_name);
      const companyTokenCounts = countNameTokens(index.companies, c => c.name);
      const hasExactContactNameMatch = index.contacts.some(c =>
        entityNameMatchesQuery(c.full_name, queryNormalized, queryCompact)
      );

      for (const c of index.contacts) {
        let score = 0;
        const reasons: string[] = [];
        const nameTokens = tokenizeEntityText(c.full_name);
        const matchedNameTokens = nameTokens.filter(token => queryTokens.has(token));
        if (entityNameMatchesQuery(c.full_name, queryNormalized, queryCompact)) {
          score += 1.2;
          reasons.push('exact_or_normalized_name');
        } else if (matchedNameTokens.length >= 2) {
          score += 0.75;
          reasons.push('multi_token_name_match');
        } else if (matchedNameTokens.length === 1 && !hasExactContactNameMatch) {
          const token = matchedNameTokens[0];
          const tokenCount = contactTokenCounts.get(token) || 0;
          if (tokenCount === 1) {
            score += 0.55;
            reasons.push('unique_single_name_token');
          } else if (nameTokens[0] === token && tokenCount <= 4) {
            score += 0.35;
            reasons.push('ambiguous_first_name_token');
          }
        }
        if (c.email && queryLower.includes(c.email.toLowerCase())) score += 0.8;
        if (c.email && queryLower.includes(c.email.toLowerCase())) reasons.push('email');
        if (c.company_name && entityNameMatchesQuery(c.company_name, queryNormalized, queryCompact)) {
          score += 0.3;
          reasons.push('company_name');
        }
        if (c.job_title && queryLower.includes(c.job_title.toLowerCase())) score += 0.2;
        if (c.job_title && queryLower.includes(c.job_title.toLowerCase())) reasons.push('job_title');
        if (c.bio_keywords) {
          const kws = c.bio_keywords.split(',');
          const matched = kws.filter(kw => queryLower.includes(kw)).length;
          if (matched > 0) {
            score += 0.15 * matched;
            reasons.push('bio_keywords');
          }
        }
        if (score > 0) {
          scored.push({
            id: c.id,
            type: 'contact',
            name: c.full_name,
            score,
            interactions: c.total_interactions || 0,
            recency: c.last_contact_date ? new Date(c.last_contact_date).getTime() : 0,
            companyId: c.company_id,
            reasons,
          });
        }
      }

      for (const c of index.companies) {
        let score = 0;
        const reasons: string[] = [];
        const nameTokens = tokenizeEntityText(c.name);
        const matchedNameTokens = nameTokens.filter(token => queryTokens.has(token));
        if (entityNameMatchesQuery(c.name, queryNormalized, queryCompact)) {
          score += 1.2;
          reasons.push('exact_or_normalized_name');
        } else if (matchedNameTokens.length >= 2) {
          score += 0.75;
          reasons.push('multi_token_name_match');
        } else if (matchedNameTokens.length === 1) {
          const token = matchedNameTokens[0];
          if ((companyTokenCounts.get(token) || 0) === 1) {
            score += 0.45;
            reasons.push('unique_single_name_token');
          }
        }
        if (c.domain && queryLower.includes(c.domain.toLowerCase())) score += 0.5;
        if (c.domain && queryLower.includes(c.domain.toLowerCase())) reasons.push('domain');
        if (c.sector && queryLower.includes(c.sector.toLowerCase())) score += 0.2;
        if (c.sector && queryLower.includes(c.sector.toLowerCase())) reasons.push('sector');
        if (c.description_keywords) {
          const kws = c.description_keywords.split(',');
          const matched = kws.filter(kw => queryLower.includes(kw)).length;
          if (matched > 0) {
            score += 0.15 * matched;
            reasons.push('description_keywords');
          }
        }
        if (score > 0) {
          scored.push({
            id: c.id,
            type: 'company',
            name: c.name,
            score,
            interactions: c.contact_count || 0,
            recency: 0,
            reasons,
          });
        }
      }

      scored.sort((a, b) => {
        if (Math.abs(a.score - b.score) > a.score * 0.1) return b.score - a.score;
        if (a.recency !== b.recency) return b.recency - a.recency;
        return b.interactions - a.interactions;
      });

      const selected: string[] = [];
      for (const s of scored) {
        if (selected.length >= maxEntities) break;
        if (!selected.includes(s.id)) selected.push(s.id);
        if (
          s.type === 'contact' &&
          s.companyId &&
          s.score >= 1.0 &&
          selected.length < maxEntities &&
          !selected.includes(s.companyId)
        ) {
          selected.push(s.companyId);
        }
      }
      entityIds.push(...selected.slice(0, maxEntities));
      retrievalLog('anchors', {
        query: query.slice(0, 80),
        selected_entity_ids: entityIds,
        top_candidates: scored.slice(0, 8).map(s => ({
          id: s.id,
          type: s.type,
          name: s.name,
          score: Number(s.score.toFixed(3)),
          reasons: s.reasons,
        })),
      });
    } catch (e) {
      console.error('[retrieval] entity index failed, falling back to D1:', e);
      const [contacts, companies] = await Promise.all([
        env.D1.prepare('SELECT id, full_name FROM contacts WHERE org_id = ? AND deleted_at IS NULL')
          .bind(session.org_id).all<{ id: string; full_name: string }>(),
        env.D1.prepare('SELECT id, name FROM companies WHERE org_id = ? AND deleted_at IS NULL')
          .bind(session.org_id).all<{ id: string; name: string }>(),
      ]);
      for (const c of contacts.results) {
        if (queryLower.includes(c.full_name.toLowerCase())) entityIds.push(c.id);
      }
      for (const c of companies.results) {
        if (queryLower.includes(c.name.toLowerCase())) entityIds.push(c.id);
      }
    }
  }

  const [values, sharingFlags] = await Promise.all([
    runEmbedding(env, query, session.org_id),
    getSharingFlags(session.org_id, env),
  ]);

  const userId = session.user_id;
  const userRole = session.user_role || 'member';
  const sharingSet = new Set(Object.keys(sharingFlags));

  // Post-retrieval ACL filter. Default-DENY on undefined / unknown visibility:
  // earlier versions fell open (no `visibility` field → treated as accessible),
  // which means a vector missing that metadata could leak. Owners always pass.
  // Audit hook: every denial that's not the obvious 'private-and-not-a-participant'
  // case gets a structured warn, so we can spot legitimate content being denied
  // due to data-integrity gaps and backfill the missing visibility.
  const postRetrievalFilter = (chunk: VectorMatch): boolean => {
    if (userRole === 'owner') return true;

    // The interface narrows visibility to a fixed union, but Vectorize stores
    // `unknown` per-field — treat it as a string at runtime in case a vector
    // was upserted with a stale or unrecognized value.
    const visibility = chunk.metadata.visibility as unknown as string | undefined | null;

    if (!visibility) {
      console.warn('[acl] denying chunk with missing visibility', {
        vector_id: (chunk as any).id,
        source_table: chunk.metadata.source_table,
        primary_entity_id: chunk.metadata.primary_entity_id,
      });
      return false;
    }

    if (visibility === 'private') {
      const participants = parseParticipantUserIds(chunk.metadata.participant_user_ids as any);
      if (participants.includes(userId)) return true;
      if (participants.some(pid => sharingSet.has(pid))) return true;
      // Legacy fallback: chunks stamped with a single user_id rather than a
      // participant list. Honor only if it matches the requester.
      if (chunk.metadata.user_id && chunk.metadata.user_id === userId) return true;
      return false;
    }

    if (visibility === 'confidential') {
      return userRole === 'admin';
    }

    if (visibility === 'org_wide' || visibility === 'public' || visibility === 'org') {
      if (chunk.metadata.reconciliation_status === 'orphaned') return false;
      return true;
    }

    // Unknown visibility value — deny and log so we can find it.
    console.warn('[acl] denying chunk with unknown visibility', {
      visibility,
      vector_id: (chunk as any).id,
      source_table: chunk.metadata.source_table,
    });
    return false;
  };

  return {
    originalQuery: query,
    embeddedQuery: values,
    entityIds: [...new Set(entityIds)].slice(0, maxEntities),
    filters: {},
    orgId: session.org_id,
    postRetrievalFilter,
  };
}

export async function retrieveContext(
  pq: ProcessedQuery,
  env: Env,
  options: RetrievalOptions = {}
): Promise<{ internal: HydratedChunk[]; news: HydratedChunk[]; stats?: { emails: number; meetings: number; documents: number; contacts: number; companies: number } }> {
  const filter: any = {
    org_id: pq.orgId,
    document_type: { $nin: ['news'] },
  };

  const aggregation = isAggregationQuery(pq.originalQuery);
  // Vectorize hard limit: topK > 50 requires returnMetadata='indexed' + returnValues=false.
  // We use returnMetadata='all' here for ACL filtering (visibility, participant_user_ids,
  // user_id, reconciliation_status — none of which are indexed) and for chunk hydration
  // (r2_key, chunk_index, text_preview — also not indexed). So 50 is our ceiling.
  // Deep Dive's real value comes from per-entity boosts (×20), document-type queries, and
  // cross-entity bridging — not raw broad topK. (See: VECTOR_QUERY_ERROR 40025)
  // TODO: to raise broad topK above 50, declare metadata indexes for the four ACL fields,
  // re-upsert all existing vectors (Vectorize indexes are not retroactive), refactor
  // hydration.ts to read r2_key/chunk_index/text_preview from D1, and move ACL filtering
  // from post-retrieval JS to a D1 join. Multi-day project, not a hotfix.
  const broadTopK = options.deepDive ? 50 : (aggregation ? 50 : 30);
  const hydrateLimit = options.deepDive ? 50 : (aggregation ? 30 : 20);

  let internalMatches: VectorMatch[];
  let broadRawMatches: VectorMatch[] = [];
  let entityRawMatches: VectorMatch[] = [];

  if (pq.entityIds.length > 0) {
    const [entityResults, broadResults] = await Promise.all([
      Promise.all(
        pq.entityIds.map(id =>
          env.VECTORIZE.query(pq.embeddedQuery, {
            topK: 15,
            filter: { ...filter, primary_entity_id: id },
            returnValues: false,
            returnMetadata: 'all',
          })
        )
      ),
      env.VECTORIZE.query(pq.embeddedQuery, {
        topK: broadTopK,
        filter,
        returnValues: false,
        returnMetadata: 'all',
      }),
    ]);
    entityRawMatches = entityResults.flatMap(r => (r.matches || []) as VectorMatch[]);
    broadRawMatches = (broadResults.matches || []) as VectorMatch[];

    const seen = new Set<string>();
    internalMatches = [];
    for (const r of entityResults) {
      for (const m of (r.matches || []) as VectorMatch[]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          internalMatches.push(m);
        }
      }
    }
    for (const m of ((broadResults.matches || []) as VectorMatch[])) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        internalMatches.push(m);
      }
    }
  } else {
    const result = await env.VECTORIZE.query(pq.embeddedQuery, {
      topK: broadTopK,
      filter,
      returnValues: false,
      returnMetadata: 'all',
    });
    internalMatches = (result.matches || []) as VectorMatch[];
    broadRawMatches = internalMatches;
  }

  retrievalLog('broad', {
    query: pq.originalQuery.slice(0, 80),
    query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
    entity_ids: pq.entityIds,
    deep_dive: !!options.deepDive,
    aggregation,
    broad_top_k: broadTopK,
    hydrate_limit: hydrateLimit,
    entity_raw_count: entityRawMatches.length,
    entity_raw_doc_type_counts: countByDocType(entityRawMatches),
    broad_raw_count: broadRawMatches.length,
    broad_raw_doc_type_counts: countByDocType(broadRawMatches),
    internal_after_broad_count: internalMatches.length,
    internal_after_broad_doc_type_counts: countByDocType(internalMatches),
    broad_top: summarizeMatches(broadRawMatches),
  });

  // Doc-type-aware secondary queries: if the query mentions specific
  // document types, run targeted filtered queries and merge results.
  // Track which chunks came from targeted queries — downstream rerank
  // bypasses the 0.20 recency floor for them and reserves dedicated
  // slots so they're not crowded out by the broad query's higher-
  // scoring semantic neighbors. Audit 2026-05-05 (post-chunk-1):
  // Tony's "summarize recent slack conversations" query lost its 96
  // Slack chunks because the broad-query email matches dominated the
  // top-10 rerank window even when the targeted secondary query did
  // surface real Slack content.
  const targetedIds = new Set<string>();
  // Caller-forced doc types take precedence over detectDocTypes's keyword
  // inspection. recall(query, source_types=['slack']) maps source_types to
  // document_type values and passes via forceDocTypes — guarantees the
  // targeted secondary query fires even when the query string doesn't
  // contain a doc-type keyword. Falls back to detectDocTypes when caller
  // didn't specify (the existing path for direct user queries).
  const docTypes = options.forceDocTypes && options.forceDocTypes.length > 0
    ? options.forceDocTypes
    : detectDocTypes(pq.originalQuery);
  try {
    const anchors = await resolveEvidenceAnchors(pq, env);
    retrievalLog('plan', {
      query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
      ...buildEvidencePlan(pq.originalQuery, anchors, docTypes, options.forceDocTypes),
    });
  } catch (e) {
    retrievalLog('plan', {
      query: pq.originalQuery.slice(0, 120),
      query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
      planner_error: e instanceof Error ? e.message : String(e),
      anchor_ids: pq.entityIds,
      detected_doc_types: docTypes,
      forced_doc_types: options.forceDocTypes || null,
    });
  }
  if (docTypes.length > 0) {
    const seen = new Set(internalMatches.map(m => m.id));
    const seenBeforeTargeted = new Set(seen);
    const docResults = await Promise.all(
      docTypes.map(dt =>
        env.VECTORIZE.query(pq.embeddedQuery, {
          topK: 20,
          filter: { org_id: pq.orgId, document_type: dt },
          returnValues: false,
          returnMetadata: 'all',
        })
      )
    );
    const targetedRawMatches: VectorMatch[] = [];
    const targetedByDocType = docTypes.map((dt, idx) => {
      const matches = (docResults[idx]?.matches || []) as VectorMatch[];
      targetedRawMatches.push(...matches);
      return {
        doc_type: dt,
        raw_count: matches.length,
        duplicate_count: matches.filter(m => seenBeforeTargeted.has(m.id)).length,
        top: summarizeMatches(matches, seenBeforeTargeted),
      };
    });
    let targetedAddedCount = 0;
    for (const matches of docResults.map(r => (r.matches || []) as VectorMatch[])) {
      for (const m of matches) {
        targetedIds.add(m.id);
        if (!seen.has(m.id)) {
          seen.add(m.id);
          internalMatches.push(m);
          targetedAddedCount++;
        }
      }
    }
    retrievalLog('targeted', {
      query: pq.originalQuery.slice(0, 80),
      query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
      doc_types: docTypes,
      force_doc_types: options.forceDocTypes || null,
      pre_targeted_internal_count: seenBeforeTargeted.size,
      targeted_raw_count: targetedRawMatches.length,
      targeted_raw_doc_type_counts: countByDocType(targetedRawMatches),
      targeted_duplicate_count: targetedRawMatches.filter(m => seenBeforeTargeted.has(m.id)).length,
      targeted_added_count: targetedAddedCount,
      targeted_ids_count: targetedIds.size,
      internal_after_targeted_count: internalMatches.length,
      internal_after_targeted_doc_type_counts: countByDocType(internalMatches),
      targeted_by_doc_type: targetedByDocType,
    });
  } else {
    retrievalLog('targeted', {
      query: pq.originalQuery.slice(0, 80),
      query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
      doc_types: [],
      force_doc_types: options.forceDocTypes || null,
      targeted_raw_count: 0,
      targeted_duplicate_count: 0,
      targeted_added_count: 0,
      targeted_ids_count: 0,
    });
  }

  if (options.deepDive && pq.entityIds.length > 0) {
    const seen = new Set(internalMatches.map(m => m.id));
    const entityQueries = pq.entityIds.slice(0, 20).map(id =>
      env.VECTORIZE.query(pq.embeddedQuery, {
        topK: 10,
        filter: { ...filter, primary_entity_id: id },
        returnValues: false,
        returnMetadata: 'all',
      })
    );
    const entityResults = await Promise.all(entityQueries);
    for (const r of entityResults) {
      for (const m of (r.matches || []) as VectorMatch[]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          internalMatches.push(m);
        }
      }
    }
  }

  // Cosine cutoff is a noise gate for the broad query. Doc-type-targeted
  // secondary matches have already been filtered by document_type at the
  // Vectorize layer — the targeting itself is the discipline, so applying
  // the global gate to them double-counts and silently drops legitimate
  // chunks that score 0.40–0.55 (long transcripts, terse Slack messages).
  // Same architectural shape as the recency-floor exemption in rerank:
  // discipline applies to broad queries, exempts caller-targeted ones.
  const filtered = internalMatches
    .filter(pq.postRetrievalFilter)
    .filter(m => m.score >= 0.55 || targetedIds.has(m.id));

  const hydrateCandidates = selectHydrationCandidates(filtered, hydrateLimit, targetedIds);
  retrievalLog('filter', {
    query: pq.originalQuery.slice(0, 80),
    query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
    internal_count: internalMatches.length,
    internal_doc_type_counts: countByDocType(internalMatches),
    targeted_ids_count: targetedIds.size,
    filtered_count: filtered.length,
    filtered_doc_type_counts: countByDocType(filtered),
    targeted_survived_filter_count: countTargetedIds(filtered, targetedIds),
    hydrate_limit: hydrateLimit,
    hydrate_candidate_count: hydrateCandidates.length,
    hydrate_candidate_doc_type_counts: countByDocType(hydrateCandidates),
    targeted_in_hydrate_slice_count: countTargetedIds(hydrateCandidates, targetedIds),
  });

  const { chunks: hydrated, summary: hydrationSummary } = await hydrateChunks(hydrateCandidates, env);
  const targetedIdSample = [...targetedIds][0];
  const hydratedTargetSample = hydrated.find(c => targetedIds.has(c.id));
  retrievalLog('hydration', {
    query: pq.originalQuery.slice(0, 80),
    query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
    hydration_summary: hydrationSummary,
    hydrated_count: hydrated.length,
    hydrated_doc_type_counts: countByDocType(hydrated),
    hydrated_targeted_count: countTargetedIds(hydrated, targetedIds),
    targeted_id_type: typeof targetedIdSample,
    hydrated_target_id_type: typeof hydratedTargetSample?.id,
    sample_set_has: hydratedTargetSample ? targetedIds.has(hydratedTargetSample.id) : null,
  });
  let reranked = await crossEncoderRerank(hydrated, pq.originalQuery, pq.orgId, env, targetedIds);

  const rerankedLimit = options.deepDive ? 20 : 10;
  if (pq.entityIds.length > 0) {
    const entitySet = new Set(pq.entityIds);
    const scoped = reranked.filter(c => {
      const primary = c.metadata.primary_entity_id as string | undefined;
      const secondary = (c.metadata.secondary_entity_ids as string | undefined) || '';
      return (
        (primary && entitySet.has(primary)) ||
        secondary.split(',').some(id => entitySet.has(id))
      );
    });
    const other = reranked.filter(c => !scoped.includes(c));
    reranked = [...scoped, ...other].slice(0, rerankedLimit);
  } else {
    reranked = reranked.slice(0, rerankedLimit);
  }

  retrievalLog('post-rerank', {
    query: pq.originalQuery.slice(0, 80),
    query_emb_hash: hashFirstFiveDims(pq.embeddedQuery),
    reranked_limit: rerankedLimit,
    reranked_count: reranked.length,
    reranked_doc_type_counts: countByDocType(reranked),
    reranked_targeted_count: countTargetedIds(reranked, targetedIds),
  });

  const newsResult = await env.VECTORIZE.query(pq.embeddedQuery, {
    topK: 10,
    filter: { org_id: pq.orgId, document_type: 'news' },
    returnValues: false,
    returnMetadata: 'all',
  });
  const newsMatches = ((newsResult.matches || []) as VectorMatch[])
    .filter(m => m.score >= 0.55)
    .slice(0, 5);
  const { chunks: newsChunks } = await hydrateChunks(newsMatches, env);

  if (options.deepDive) {
    const allChunks = [...reranked, ...newsChunks];
    const entitySet = new Set<string>();
    let emails = 0, meetings = 0, documents = 0;
    for (const c of allChunks) {
      const dt = c.metadata.document_type as string;
      if (dt === 'email') emails++;
      else if (dt === 'transcript') meetings++;
      else if (dt !== 'news') documents++;
      if (c.metadata.primary_entity_id) entitySet.add(c.metadata.primary_entity_id as string);
    }
    return {
      internal: reranked,
      news: newsChunks,
      stats: { emails, meetings, documents, contacts: entitySet.size, companies: 0 },
    };
  }

  return { internal: reranked, news: newsChunks };
}

// Recency boost — applied to rerank scores when the query contains temporal
// cues. Half-life of 90 days: today=1.0, 90d ago=0.5, 365d ago≈0.06. Only
// activates for explicitly time-sensitive queries so neutral questions like
// "what does this contract say about IP rights" stay age-agnostic.
//
// Detection uses regex-or-substring patterns so "last 2 days", "past 48
// hours", "last week" all fire (audit 2026-05-05: literal keyword list
// missed "last 2 days" and stale content dominated the response).
const RECENCY_REGEXES: RegExp[] = [
  /\b(latest|recent|recently|today|yesterday|tonight|now|currently|newest|just|happening|lately|past few)\b/,
  /\b(this|last|past|previous)\s+(day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes)\b/,
  /\b(last|past|previous)\s+\d+\s+(day|days|week|weeks|month|months|hour|hours|minute|minutes)\b/,
  /\b(going on|so far this)\b/,
];

function detectsRecencyIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_REGEXES.some(re => re.test(lower));
}

function recencyMultiplier(ageInDays: number): number {
  if (!Number.isFinite(ageInDays) || ageInDays < 0) return 1;
  return Math.exp(-ageInDays / 90);
}

function chunkAgeInDays(chunk: HydratedChunk): number {
  const dateStr = (chunk.metadata.date as string | undefined)
    || (chunk.metadata.created_at as string | undefined);
  if (!dateStr) return Infinity; // unknown age → fully decayed (won't surface for "recent" queries)
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

// Cross-encoder rerank using @cf/baai/bge-reranker-base via Workers AI.
// Replaces the prior Claude-based reordering (was slow ~1s p50, expensive,
// non-deterministic). BGE reranker scores (query, chunk-text) pairs directly;
// purpose-built for this and ~10× faster.
//
// Flow:
//   1. Early-return on tiny candidate sets (<= 3 chunks).
//   2. Honor org settings.reranker_enabled — when false, pass through capped.
//   3. Send query + chunk previews to bge-reranker-base, get per-chunk scores.
//   4. Optionally apply recency multiplier when the query is temporal.
//   5. Sort by combined score, return topK.
//   6. Any failure path falls back to the input order capped at 10 — never
//      throws, retrieval must keep working.
export async function crossEncoderRerank(
  chunks: HydratedChunk[],
  query: string,
  orgId: string,
  env: Env,
  // Vector ids of chunks that came from the doc-type-targeted secondary
  // query in retrieveContext (or from a recall() tool call with explicit
  // source_types). Targeted chunks bypass the recency floor and get
  // dedicated reserved slots in the final top-10. Without this, short
  // Slack messages and the like get cut by the floor or crowded out by
  // higher-scoring semantic-neighbor email matches in the broad query
  // — the audit-2026-05-05 regression after chunk 1 shipped the floor.
  // Pass undefined / empty Set when caller wants pre-2026-05-05 behavior.
  targetedIds?: Set<string>
): Promise<HydratedChunk[]> {
  if (chunks.length <= 3) {
    retrievalLog('rerank', {
      query: query.slice(0, 80),
      reason: 'small_candidate_set',
      input_count: chunks.length,
      input_doc_type_counts: countByDocType(chunks),
      targeted_ids_count: targetedIds?.size || 0,
      final_count: chunks.length,
      final_doc_type_counts: countByDocType(chunks),
      final_targeted_count: countTargetedIds(chunks, targetedIds),
      ...targetedMembershipSample(chunks, targetedIds),
    });
    return chunks;
  }

  const settings = await getOrgSettings(orgId, env);
  if (!settings.reranker_enabled) {
    const finalChunks = chunks.slice(0, 10);
    retrievalLog('rerank', {
      query: query.slice(0, 80),
      reason: 'disabled',
      reranker_enabled: false,
      input_count: chunks.length,
      input_doc_type_counts: countByDocType(chunks),
      targeted_ids_count: targetedIds?.size || 0,
      final_count: finalChunks.length,
      final_doc_type_counts: countByDocType(finalChunks),
      final_targeted_count: countTargetedIds(finalChunks, targetedIds),
      ...targetedMembershipSample(chunks, targetedIds),
    });
    return finalChunks;
  }

  try {
    // BGE reranker accepts up to ~16K tokens of context combined; cap each
    // chunk at ~500 tokens so 30+ chunks fit comfortably.
    const contexts = chunks.map(c => ({
      text: truncateToTokens(c.hydrated_text, 500),
    }));

    const response = await env.AI.run('@cf/baai/bge-reranker-base' as any, {
      query,
      contexts,
    } as any);

    // Workers AI shape: { response: [{ id: number, score: number }, ...] }
    // where id is the index into our `contexts` array.
    const scoresArr: Array<{ id: number; score: number }> =
      Array.isArray((response as any)?.response) ? (response as any).response : [];

    if (scoresArr.length === 0) {
      // Defensive: model returned nothing usable. Fall back.
      const finalChunks = chunks.slice(0, 10);
      retrievalLog('rerank', {
        query: query.slice(0, 80),
        reason: 'empty_scores',
        reranker_enabled: true,
        input_count: chunks.length,
        input_doc_type_counts: countByDocType(chunks),
        targeted_ids_count: targetedIds?.size || 0,
        final_count: finalChunks.length,
        final_doc_type_counts: countByDocType(finalChunks),
        final_targeted_count: countTargetedIds(finalChunks, targetedIds),
        ...targetedMembershipSample(chunks, targetedIds),
      });
      return finalChunks;
    }

    const scoreById = new Map<number, number>();
    for (const s of scoresArr) {
      if (typeof s.id === 'number' && typeof s.score === 'number') {
        scoreById.set(s.id, s.score);
      }
    }

    const recencyOn = detectsRecencyIntent(query);
    const scored = chunks.map((c, i) => {
      const baseScore = scoreById.get(i) ?? 0;
      const adjusted = recencyOn ? baseScore * recencyMultiplier(chunkAgeInDays(c)) : baseScore;
      return { chunk: c, score: adjusted };
    });

    scored.sort((a, b) => b.score - a.score);

    // Recency-aware floor — when the user asked about a time-bounded window
    // ("last 2 days", "this week"), a chunk with strong topical match but
    // 90+ days of age decay shouldn't surface. The 0.55 absolute floor at
    // line 362 catches no-match content; this floor catches stale-match
    // content that's only winning because there's nothing newer.
    //
    // Threshold 0.20: a chunk needs to combine some topical relevance AND
    // reasonable recency to clear it. e.g. base=0.7 (strong match) + age=
    // 110d (e^(-110/90)≈0.30) → adjusted=0.21 → barely passes. base=0.7 +
    // age=180d (e^(-2)=0.135) → 0.094 → cut. base=0.4 + age=30d (e^(-0.33)=
    // 0.72) → 0.288 → passes. Only fires when recency was detected.
    //
    // Audit 2026-05-05: Tony asked "Slack last 2 days," 10 emails (ages
    // 30–180 days) returned, model fabricated Slack content. With this
    // floor, most/all of those emails would have been cut and SOURCES
    // would be empty or near-empty — driving the model to the honest
    // "no Slack messages found" answer.
    //
    // Audit 2026-05-05 (post-chunk-1): the 0.20 floor over-cut short-text
    // sources (Slack messages). When the user explicitly asked for a
    // source type, the targeted secondary query DID surface real Slack
    // chunks but they scored low in cross-encoder rerank (short text vs
    // verbose query) AND got cut by the floor. The fix splits scoring:
    //   - Targeted chunks (came from a doc-type-filtered secondary query)
    //     bypass the recency floor — the user asked for them by type;
    //     they passed the cosine 0.55 cutoff already; that's enough.
    //   - Broad chunks still hit the floor — anti-fabrication preserved
    //     for queries where source-type wasn't explicit.
    //   - Targeted chunks get dedicated reserved slots so they're not
    //     crowded out by broad's higher-scoring semantic neighbors.
    const TOTAL_SLOTS = 10;
    const TARGETED_RESERVE = 5;
    const targeted = targetedIds && targetedIds.size > 0
      ? scored.filter(s => targetedIds.has((s.chunk as any).id))
      : [];
    const broad = targeted.length > 0
      ? scored.filter(s => !targetedIds!.has((s.chunk as any).id))
      : scored;
    const broadFloored = recencyOn
      ? broad.filter(s => s.score >= 0.20)
      : broad;

    let finalChunks: HydratedChunk[];
    if (targeted.length > 0) {
      const targetedTake = Math.min(targeted.length, TARGETED_RESERVE);
      const broadTake = TOTAL_SLOTS - targetedTake;
      finalChunks = [
        ...targeted.slice(0, targetedTake).map(x => x.chunk),
        ...broadFloored.slice(0, broadTake).map(x => x.chunk),
      ];
    } else {
      finalChunks = broadFloored.slice(0, TOTAL_SLOTS).map(x => x.chunk);
    }

    retrievalLog('rerank', {
      query: query.slice(0, 80),
      reason: 'scored',
      reranker_enabled: true,
      recency_on: recencyOn,
      input_count: chunks.length,
      input_doc_type_counts: countByDocType(chunks),
      scores_count: scoresArr.length,
      targeted_ids_count: targetedIds?.size || 0,
      targeted_scored_count: targeted.length,
      broad_scored_count: broad.length,
      broad_floored_count: broadFloored.length,
      final_count: finalChunks.length,
      final_doc_type_counts: countByDocType(finalChunks),
      final_targeted_count: countTargetedIds(finalChunks, targetedIds),
      hydrated_id_type_sample: typeof chunks[0]?.id,
      ...targetedMembershipSample(chunks, targetedIds),
    });
    return finalChunks;
  } catch (e) {
    console.error('[rerank] BGE reranker fallback:', e);
    const finalChunks = chunks.slice(0, 10);
    retrievalLog('rerank', {
      query: query.slice(0, 80),
      reason: 'fallback',
      error: e instanceof Error ? e.message : String(e),
      input_count: chunks.length,
      input_doc_type_counts: countByDocType(chunks),
      targeted_ids_count: targetedIds?.size || 0,
      final_count: finalChunks.length,
      final_doc_type_counts: countByDocType(finalChunks),
      final_targeted_count: countTargetedIds(finalChunks, targetedIds),
      ...targetedMembershipSample(chunks, targetedIds),
    });
    return finalChunks;
  }
}

// --- §8.5: dynamic token budget ---

export const TOKEN_BUDGET = {
  system_prompt: 2000,
  session_history: 8000,
  max_retrieved: 63000,
  max_upload: 20000,
  news: 2000,
  query: 1000,
  buffer: 4000,
};
