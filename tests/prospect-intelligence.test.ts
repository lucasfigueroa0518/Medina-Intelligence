import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const { callClaudeWithUsageMock, prewarmClaudePromptCacheMock } = vi.hoisted(() => ({
  callClaudeWithUsageMock: vi.fn(),
  prewarmClaudePromptCacheMock: vi.fn(),
}));

vi.mock('../src/lib/claude', () => ({
  callClaudeWithUsage: callClaudeWithUsageMock,
  prewarmClaudePromptCache: prewarmClaudePromptCacheMock,
  isClaudeHardQuotaErrorMessage: (message: string) => /monthly|usage limit|credit limit|spend limit/i.test(String(message || '')),
}));

function isReasoningJudgeRequest(request: any): boolean {
  if (request?.max_tokens === 160) return true;
  const systemText = Array.isArray(request?.system)
    ? request.system.map((block: any) => String(block?.text || '')).join('\n')
    : String(request?.system || '');
  return /reasoning validation judge/i.test(systemText);
}

function isFinalQualityGateRequest(request: any): boolean {
  const systemText = Array.isArray(request?.system)
    ? request.system.map((block: any) => String(block?.text || '')).join('\n')
    : String(request?.system || '');
  return /final quality gate for a venture prospect pipeline/i.test(systemText);
}

function reasoningJudgeResponse(
  action: 'allow_create' | 'block_create' | 'needs_review' = 'allow_create',
  reason = 'Reasoning cites target-specific investment evidence present in the source.'
) {
  return {
    text: JSON.stringify({
      reasoning_valid: action === 'allow_create',
      action,
      confidence: 0.93,
      reason,
    }),
    usage: { input_tokens: 45, output_tokens: 18 },
    model: 'claude-haiku-4-5-20251001',
  };
}

function finalQualityGateResponse(
  decisions: Array<{
    record_ordinal: number;
    decision?: 'allow_create' | 'rename_and_allow' | 'merge_into_record' | 'block_create';
    canonical_name?: string | null;
    merge_target_ordinal?: number | null;
    merge_target_prospect_id?: string | null;
    reason?: string;
  }> | null = null
) {
  return {
    text: JSON.stringify({
      decisions: decisions || [{
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Warmup Company',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The row names a clean company with target-specific investment evidence.',
      }],
    }),
    usage: { input_tokens: 80, output_tokens: 24 },
    model: 'claude-haiku-4-5-20251001',
  };
}

function defaultFinalQualityGateResponseForRequest(request: any) {
  const user = JSON.parse(String(request.user || '{}'));
  return finalQualityGateResponse((user.records || []).map((record: any) => ({
    record_ordinal: record.record_ordinal,
    decision: 'allow_create',
    canonical_name: record.prospect_company_name || record.proposed_name,
    merge_target_ordinal: null,
    merge_target_prospect_id: null,
    reason: 'The row names a clean company with target-specific investment evidence.',
  })));
}

function resetClaudeMock(): void {
  callClaudeWithUsageMock.mockReset();
  prewarmClaudePromptCacheMock.mockReset();
  prewarmClaudePromptCacheMock.mockResolvedValue({
    usage: { input_tokens: 10, output_tokens: 1 },
    model: 'claude-haiku-4-5-20251001',
  });
  callClaudeWithUsageMock.mockImplementation(async (request: any) => {
    if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
    if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
    return undefined;
  });
}

import {
  __prospectIntelligenceTestHooks,
  buildEntityIdentityAliasValues,
  callProspectClassifier,
  classifyProspectSignalsDryRun,
  computeSignalStrength,
  detectAndRecordProspectSignals,
  ensureProspectForDeal,
  extractMentionCandidatesFromText,
  extractOrganizationMentionsFromSource,
  loadProspectClassifierKnownContext,
  mergeProspects,
  normalizeProspectName,
  applyProspectEnrichmentCandidate,
  recordProspectBackfillCoverage,
  reverseProspectMerge,
  runProspectBackfillWindow,
  runProspectEnrichmentCycle,
  runProspectReconciliation,
} from '../src/lib/prospect-intelligence';

class FakeStatement {
  private binds: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): FakeStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.binds) as T[] };
  }

  async first<T = any>(): Promise<T | null> {
    return this.db.first(this.sql, this.binds) as T | null;
  }

  async run(): Promise<void> {
    this.db.run(this.sql, this.binds);
  }
}

class FakeD1 {
  companies: any[] = [];
  deals: any[] = [];
  relationships: any[] = [];
  contacts: any[] = [];
  dealmakers: any[] = [];
  sourceConversations: any[] = [];
  sourceEvents: any[] = [];
  sourceDocuments: any[] = [];
  prospects: any[] = [];
  prospectSignals: any[] = [];
  softLinks: any[] = [];
  classificationHistory: any[] = [];
  classifierSamples: any[] = [];
  mergeAudit: any[] = [];
  entityFieldState: any[] = [];
  coverage: any[] = [];
  backfillRuns: any[] = [];
  tags: any[] = [];
  companyTags: any[] = [];
  identityAliases: any[] = [];
  prospectClassifierCache: any[] = [];
  prospectLlmCache: any[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<void[]> {
    return Promise.all(statements.map(statement => statement.run()));
  }

  all(sql: string, binds: unknown[]): any[] {
    if (/FROM entity_identity_aliases/i.test(sql)) {
      const [orgId, ...aliasValues] = binds;
      const allowed = new Set(aliasValues.map(value => String(value)));
      return this.identityAliases
        .filter(row => row.org_id === orgId && allowed.has(String(row.alias_value)))
        .slice(0, 50)
        .map(row => ({ ...row }));
    }
    if (/FROM companies/i.test(sql) && /id IN/i.test(sql)) {
      const [orgId, ...ids] = binds;
      const allowed = new Set(ids.map(String));
      return this.companies
        .filter(company => company.org_id === orgId && allowed.has(String(company.id)) && !company.deleted_at)
        .map(company => ({ ...company }));
    }
    if (/FROM prospects/i.test(sql) && /id IN/i.test(sql)) {
      const [orgId, ...ids] = binds;
      const allowed = new Set(ids.map(String));
      return this.prospects
        .filter(row => row.org_id === orgId && allowed.has(String(row.id)) && !row.deleted_at)
        .map(row => ({ ...row }));
    }
    if (/FROM dealmakers/i.test(sql) && /GROUP BY dealmaker_type/i.test(sql)) {
      const [orgId, ...criteria] = binds;
      const normalized = new Set(criteria.filter(value => typeof value === 'string' && !String(value).includes('.')).map(String));
      const domains = new Set(criteria.filter(value => typeof value === 'string' && String(value).includes('.')).map(value => String(value).toLowerCase()));
      const grouped = new Map<string, number>();
      for (const row of this.dealmakers) {
        if (row.org_id !== orgId) continue;
        const matches = normalized.has(String(row.normalized_name || '')) || domains.has(String(row.domain || '').toLowerCase());
        if (!matches) continue;
        const key = row.dealmaker_type || 'unknown';
        grouped.set(key, (grouped.get(key) || 0) + 1);
      }
      return Array.from(grouped.entries()).map(([dealmaker_type, n]) => ({ dealmaker_type, n }));
    }
    if (/FROM dealmakers/i.test(sql)) {
      return this.dealmakers
        .filter(row => row.org_id === binds[0])
        .map(row => ({ name: row.name, domain: row.domain || null }));
    }
    if (/FROM contacts/i.test(sql)) {
      const [orgId, companyId] = binds;
      return this.contacts
        .filter(row => row.org_id === orgId && row.company_id === companyId && !row.deleted_at && !row.merged_into)
        .map(row => ({ ...row }));
    }
    if (/FROM companies c/i.test(sql)) {
      return this.companies
        .filter(company => company.org_id === binds[0] && this.deals.some(deal => deal.org_id === company.org_id && deal.company_id === company.id && deal.stage !== 'closed' && !deal.deleted_at))
        .map(company => ({ name: company.name, domain: company.domain || null }));
    }
    if (/FROM companies/i.test(sql) && /lower\(domain\) = lower\(\?\)/i.test(sql)) {
      const [orgId, domain] = binds;
      return this.companies
        .filter(company =>
          company.org_id === orgId &&
          !company.deleted_at &&
          String(company.domain || '').toLowerCase() === String(domain || '').toLowerCase()
        )
        .map(company => ({ ...company }));
    }
    if (/FROM companies\s+WHERE/i.test(sql)) {
      const [orgId, pattern] = binds;
      const token = String(pattern || '').replace(/%/g, '').toLowerCase();
      return this.companies.filter(company =>
        company.org_id === orgId &&
        !company.deleted_at &&
        String(company.name || '').toLowerCase().includes(token)
      );
    }
    if (/FROM firm_company_relationships/i.test(sql)) {
      const [orgId, companyId] = binds;
      return this.relationships.filter(row => row.org_id === orgId && row.company_id === companyId && !row.ended_at);
    }
    if (/FROM prospect_signals/i.test(sql) && /SELECT signal_kind/i.test(sql)) {
      const [prospectId, orgId] = binds;
      return this.prospectSignals
        .filter(row => row.prospect_id === prospectId && row.org_id === orgId && row.mention_type === 'inbound_prospect')
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
    }
    if (/FROM prospect_signals/i.test(sql) && /normalized_mention = \?/i.test(sql)) {
      const [orgId, normalizedMention] = binds;
      return this.prospectSignals
        .filter(row => row.org_id === orgId && row.normalized_mention === normalizedMention)
        .map(row => ({ ...row, metadata_json: row.metadata_json || '{}' }));
    }
    if (/SELECT id, deal_id\s+FROM prospects/i.test(sql)) {
      const [orgId] = binds;
      return this.prospects
        .filter(row =>
          row.org_id === orgId &&
          !row.deleted_at &&
          row.deal_id &&
          ['active', 'provisional', 'converted'].includes(row.status)
        )
        .map(row => ({ id: row.id, deal_id: row.deal_id }));
    }
    if (/SELECT id FROM prospect_signals/i.test(sql)) {
      const [orgId, prospectId] = binds;
      return this.prospectSignals
        .filter(row => row.org_id === orgId && row.prospect_id === prospectId)
        .map(row => ({ id: row.id }));
    }
    if (/FROM prospects/i.test(sql) && /ORDER BY signal_strength DESC/i.test(sql)) {
      const [orgId, limit] = binds;
      return this.prospects
        .filter(row =>
          row.org_id === orgId &&
          !row.deleted_at &&
          row.status === 'active' &&
          Number(row.provisional || 0) === 0 &&
          Number(row.direction_uncertain || 0) === 0 &&
          ['not_started', 'candidate', 'failed'].includes(row.enrichment_status || 'not_started')
        )
        .sort((a, b) => Number(b.signal_strength || 0) - Number(a.signal_strength || 0))
        .slice(0, Number(limit))
        .map(row => ({ ...row }));
    }
    if (/FROM conversations/i.test(sql)) {
      if (/body_r2_key/i.test(sql)) {
        expect(sql).toContain("'private' AS visibility");
        expect(sql).not.toMatch(/direction,\s*visibility\b/i);
      }
      const [orgId, start, end] = binds;
      const limit = binds[binds.length - 1];
      return this.sourceConversations
        .filter(row => row.org_id === orgId && row.sent_at >= start && row.sent_at < end)
        .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))
        .slice(0, Number(limit));
    }
    if (/FROM events/i.test(sql)) {
      const [orgId, start, end] = binds;
      const createdStart = binds[3] || start;
      const createdEnd = binds[4] || end;
      const futureStart = binds[5] || start;
      const limit = binds[binds.length - 1];
      return this.sourceEvents
        .filter(row => row.org_id === orgId && !row.deleted_at && (
          (row.start_time >= start && row.start_time < end) ||
          (row.created_at >= createdStart && row.created_at < createdEnd && row.start_time >= futureStart)
        ))
        .sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)))
        .slice(0, Number(limit));
    }
    if (/FROM documents/i.test(sql)) {
      const [orgId, start, end] = binds;
      const limit = binds[binds.length - 1];
      return this.sourceDocuments
        .filter(row => row.org_id === orgId && !row.deleted_at && row.created_at >= start && row.created_at < end)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(limit));
    }
    if (/FROM prospects/i.test(sql) && /ORDER BY updated_at ASC/i.test(sql)) {
      const [orgId] = binds;
      return this.prospects
        .filter(row => row.org_id === orgId && !row.deleted_at && ['active', 'provisional'].includes(row.status))
        .slice(0, 100);
    }
    if (/FROM prospects/i.test(sql) && /ORDER BY signal_count DESC, evidence_count DESC/i.test(sql)) {
      const [orgId, ...criteria] = binds;
      const normalizedCriteria = new Set(
        criteria
          .filter(value => typeof value === 'string' && !String(value).includes('%') && !String(value).includes('.'))
          .map(value => String(value))
      );
      const domainCriteria = criteria
        .filter(value => typeof value === 'string' && String(value).includes('.'))
        .map(value => String(value).replace(/%/g, '').toLowerCase());
      return this.prospects
        .filter(row => {
          if (row.org_id !== orgId || row.deleted_at || !['active', 'provisional', 'converted'].includes(row.status)) return false;
          if (normalizedCriteria.has(String(row.normalized_name || ''))) return true;
          const domain = String(row.domain || '').toLowerCase();
          const website = String(row.website || '').toLowerCase();
          return domainCriteria.some(criteria => domain === criteria || website.includes(criteria));
        })
        .sort((a, b) => Number(b.signal_count || 0) - Number(a.signal_count || 0))
        .slice(0, 25)
        .map(row => ({ ...row }));
    }
    return [];
  }

  first(sql: string, binds: unknown[]): any | null {
    if (/FROM prospect_classifier_cache/i.test(sql)) {
      const [cacheKey] = binds;
      const row = this.prospectClassifierCache.find(entry => entry.cache_key === cacheKey);
      return row ? { value_json: row.value_json } : null;
    }
    if (/FROM prospect_llm_cache/i.test(sql)) {
      const [cacheKey] = binds;
      const row = this.prospectLlmCache.find(entry => entry.cache_key === cacheKey);
      return row ? { value_json: row.value_json, usage_json: row.usage_json || null } : null;
    }
    if (/COUNT\(\*\) AS n/i.test(sql) && /FROM prospect_signals/i.test(sql)) {
      const [orgId] = binds;
      return {
        n: this.prospectSignals.filter(row =>
          row.org_id === orgId &&
          (row.classification_status !== 'classified' || row.resolution_status === 'pending')
        ).length,
      };
    }
    if (/SUM\(CASE WHEN classification_status/i.test(sql)) {
      const [orgId, prospectId] = binds;
      const rows = this.prospectSignals.filter(row => row.org_id === orgId && row.prospect_id === prospectId);
      return {
        pending_classifications: rows.filter(row => row.classification_status !== 'classified').length,
        pending_resolution: rows.filter(row => row.resolution_status === 'pending').length,
        direction_uncertain: rows.filter(row => row.direction_uncertain === 1).length,
        uncategorized: rows.filter(row => row.sector_key === 'uncategorized').length,
        second_look_pending: rows.filter(row => {
          try {
            return JSON.parse(String(row.metadata_json || '{}')).prospect_second_look?.required === true;
          } catch {
            return false;
          }
        }).length,
        avg_confidence: rows.length ? rows.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / rows.length : null,
      };
    }
    if (/FROM companies/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.companies.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/FROM tags/i.test(sql) && /lower\(name\)/i.test(sql)) {
      const [orgId] = binds;
      const name = sql.match(/lower\(name\) = lower\('([^']+)'\)/i)?.[1] || binds[1] || 'Investment Prospect';
      const row = this.tags.find(entry =>
        entry.org_id === orgId &&
        String(entry.name || '').toLowerCase() === String(name || '').toLowerCase()
      );
      return row ? { ...row } : null;
    }
    if (/FROM companies/i.test(sql) && /lower\(domain\) = lower\(\?\)/i.test(sql)) {
      const [orgId, domain] = binds;
      const row = this.companies.find(entry =>
        entry.org_id === orgId &&
        !entry.deleted_at &&
        String(entry.domain || '').toLowerCase() === String(domain || '').toLowerCase()
      );
      return row ? { ...row } : null;
    }
    if (/FROM deals/i.test(sql) && /company_id = \?/i.test(sql)) {
      const [orgId, companyId] = binds;
      const row = this.deals.find(entry =>
        entry.org_id === orgId &&
        entry.company_id === companyId &&
        !entry.deleted_at &&
        entry.stage !== 'closed'
      );
      return row ? { ...row } : null;
    }
    if (/FROM deals d\s+JOIN companies c/i.test(sql)) {
      const [orgId, dealId] = binds;
      const deal = this.deals.find(entry =>
        entry.org_id === orgId &&
        entry.id === dealId &&
        !entry.deleted_at &&
        entry.stage !== 'closed'
      );
      if (!deal) return null;
      const company = this.companies.find(entry =>
        entry.id === deal.company_id &&
        entry.org_id === orgId &&
        !entry.deleted_at
      );
      if (!company) return null;
      return {
        deal_id: deal.id,
        company_id: deal.company_id,
        created_at: deal.created_at || null,
        updated_at: deal.updated_at || null,
        company_name: company.name,
        company_domain: company.domain || null,
        company_website: company.website || null,
        company_sector: company.sector || null,
      };
    }
    if (/FROM prospect_signals/i.test(sql)) {
      const [orgId, sourceType, sourceId, mentionOrdinal] = binds;
      const row = this.prospectSignals.find(entry =>
        entry.org_id === orgId &&
        entry.source_type === sourceType &&
        entry.source_id === sourceId &&
        entry.mention_ordinal === mentionOrdinal
      );
      return row ? { ...row } : null;
    }
    if (/SELECT id\s+FROM prospects/i.test(sql) && /deal_id = \?/i.test(sql)) {
      const [orgId, dealId] = binds;
      const row = this.prospects.find(entry => entry.org_id === orgId && entry.deal_id === dealId && !entry.deleted_at);
      return row ? { id: row.id } : null;
    }
    if (/SELECT id\s+FROM prospects/i.test(sql)) {
      const [orgId, normalizedName] = binds;
      const row = this.prospects.find(entry => entry.org_id === orgId && entry.normalized_name === normalizedName && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/SELECT \* FROM prospects/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/FROM prospects/i.test(sql) && /canonical_name/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/SELECT\s+\w+\s+AS value FROM prospects/i.test(sql)) {
      const [id, orgId] = binds;
      const field = sql.match(/SELECT\s+(\w+)\s+AS value FROM prospects/i)?.[1] || '';
      const row = this.prospects.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { value: row[field] ?? null } : null;
    }
    if (/FROM prospect_merge_audit/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.mergeAudit.find(entry => entry.id === id && entry.org_id === orgId && entry.action === 'merge');
      return row ? { ...row } : null;
    }
    return null;
  }

  private storedSignalFor(orgId: unknown, sourceType: unknown, sourceId: unknown, mentionOrdinal: unknown): any | undefined {
    return this.prospectSignals.find(row =>
        row.org_id === orgId &&
        row.source_type === sourceType &&
        row.source_id === sourceId &&
        row.mention_ordinal === mentionOrdinal
      );
  }

  private jsonPatch(base: unknown, patch: unknown): string {
    try {
      return JSON.stringify({
        ...(base ? JSON.parse(String(base)) : {}),
        ...(patch ? JSON.parse(String(patch)) : {}),
      });
    } catch {
      return String(patch || base || '{}');
    }
  }

  run(sql: string, binds: unknown[]): void {
    if (/INSERT INTO prospect_classifier_cache/i.test(sql)) {
      const row = {
        cache_key: binds[0],
        org_id: binds[1],
        source_type: binds[2],
        source_id: binds[3],
        classifier_version: binds[4],
        model: binds[5],
        source_hash: binds[6],
        candidate_hash: binds[7],
        context_hash: binds[8],
        value_json: binds[9],
        usage_json: binds[10],
      };
      const existing = this.prospectClassifierCache.find(entry => entry.cache_key === row.cache_key);
      if (existing) Object.assign(existing, row);
      else this.prospectClassifierCache.push(row);
      return;
    }

    if (/INSERT INTO prospect_llm_cache/i.test(sql)) {
      const row = {
        cache_key: binds[0],
        org_id: binds[1],
        stage: binds[2],
        prompt_version: binds[3],
        model: binds[4],
        source_hash: binds[5],
        candidate_hash: binds[6],
        context_hash: binds[7],
        decision_hash: binds[8],
        value_json: binds[9],
        usage_json: binds[10],
      };
      const existing = this.prospectLlmCache.find(entry => entry.cache_key === row.cache_key);
      if (existing) Object.assign(existing, row);
      else this.prospectLlmCache.push(row);
      return;
    }

    if (/INSERT INTO entity_identity_aliases/i.test(sql)) {
      const hasExplicitId = binds[1] !== 'company' && binds[1] !== 'prospect';
      const offset = hasExplicitId ? 1 : 0;
      this.identityAliases.push({
        id: hasExplicitId ? binds[0] : `alias-${this.identityAliases.length + 1}`,
        org_id: binds[offset],
        entity_type: binds[offset + 1],
        entity_id: binds[offset + 2],
        alias_kind: binds[offset + 3],
        alias_value: binds[offset + 4],
        confidence: binds[offset + 5],
        source_kind: binds[offset + 6],
        evidence_json: binds[offset + 7],
      });
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /status = 'converted'/i.test(sql) && /metadata_json = json_patch/i.test(sql)) {
      const prospectId = binds[13];
      const orgId = binds[14];
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row) {
        const previousSignalStrength = Number(row.signal_strength || 0);
        row.canonical_name = String(binds[0]).length > String(row.canonical_name || '').length ? binds[0] : row.canonical_name;
        row.domain = row.domain || binds[2];
        row.company_id = row.company_id || binds[3];
        row.status = 'converted';
        if (row.sector_key === 'uncategorized' || Number(row.sector_confidence || 0) < Number(binds[4] || 0)) {
          row.sector_key = binds[5];
        }
        row.sector_confidence = Math.max(Number(row.sector_confidence || 0), Number(binds[6] || 0));
        row.last_seen_at = binds[7];
        row.last_signal_at = binds[9];
        row.signal_strength = Math.max(previousSignalStrength, 85);
        row.signal_strength_reasons = previousSignalStrength < 85 ? binds[11] : row.signal_strength_reasons;
        row.enrichment_priority = 'eager';
        row.confidence = Math.max(Number(row.confidence || 0), 1);
        row.provisional = 0;
        row.direction_uncertain = 0;
        row.possible_deal_id = null;
        row.metadata_json = binds[12];
      }
      return;
    }

    if (/INSERT INTO prospects/i.test(sql) && /company_id, deal_id/i.test(sql)) {
      const normalizedName = binds[3];
      const existing = this.prospects.find(row => row.org_id === binds[1] && row.normalized_name === normalizedName);
      if (existing) {
        const previousSignalStrength = Number(existing.signal_strength || 0);
        existing.canonical_name = String(binds[2]).length > String(existing.canonical_name || '').length ? binds[2] : existing.canonical_name;
        existing.domain = existing.domain || binds[4];
        existing.company_id = existing.company_id || binds[5];
        existing.deal_id = existing.deal_id || binds[6];
        existing.status = 'converted';
        if (existing.sector_key === 'uncategorized' || Number(existing.sector_confidence || 0) < Number(binds[8] || 0)) {
          existing.sector_key = binds[7];
        }
        existing.sector_confidence = Math.max(Number(existing.sector_confidence || 0), Number(binds[8] || 0));
        existing.last_seen_at = binds[10];
        existing.last_signal_at = binds[11];
        existing.signal_strength = Math.max(previousSignalStrength, 85);
        existing.signal_strength_reasons = previousSignalStrength < 85 ? binds[12] : existing.signal_strength_reasons;
        existing.enrichment_priority = 'eager';
        existing.confidence = Math.max(Number(existing.confidence || 0), 1);
        existing.provisional = 0;
        existing.direction_uncertain = 0;
        existing.possible_deal_id = null;
        existing.metadata_json = binds[13];
        return;
      }
      this.prospects.push({
        id: binds[0],
        org_id: binds[1],
        canonical_name: binds[2],
        normalized_name: normalizedName,
        domain: binds[4],
        company_id: binds[5],
        deal_id: binds[6],
        status: 'converted',
        visibility: 'firm',
        sector_key: binds[7],
        sector_confidence: binds[8],
        first_seen_at: binds[9],
        last_seen_at: binds[10],
        last_signal_at: binds[11],
        signal_count: 0,
        evidence_count: 0,
        signal_strength: 85,
        signal_strength_reasons: binds[12],
        enrichment_priority: 'eager',
        confidence: 1,
        provisional: 0,
        direction_uncertain: 0,
        metadata_json: binds[13],
      });
      return;
    }

    if (/INSERT INTO prospects/i.test(sql)) {
      const normalizedName = binds[3];
      const existing = this.prospects.find(row => row.org_id === binds[1] && row.normalized_name === normalizedName);
      if (existing) {
        const incomingProvisional = binds[11] === 1;
        existing.canonical_name = binds[2];
        existing.status = existing.status === 'active' || existing.status === 'converted'
          ? existing.status
          : incomingProvisional ? 'provisional' : 'active';
        existing.sector_key = binds[5];
        existing.sector_confidence = binds[6];
        existing.confidence = binds[10];
        existing.provisional = existing.status === 'active' || existing.status === 'converted'
          ? 0
          : incomingProvisional ? 1 : 0;
        existing.direction_uncertain = binds[12];
        existing.possible_company_id = binds[13];
        existing.possible_deal_id = binds[14];
        return;
      }
      this.prospects.push({
        id: binds[0],
        org_id: binds[1],
        canonical_name: binds[2],
        normalized_name: normalizedName,
        status: binds[4],
        visibility: 'firm',
        sector_key: binds[5],
        sector_confidence: binds[6],
        first_seen_at: binds[7],
        last_seen_at: binds[8],
        last_signal_at: binds[9],
        confidence: binds[10],
        provisional: binds[11],
        direction_uncertain: binds[12],
        possible_company_id: binds[13],
        possible_deal_id: binds[14],
        signal_count: 0,
        signal_strength: 0,
        signal_strength_reasons: '[]',
      });
      return;
    }

    if (/INSERT INTO companies/i.test(sql)) {
      this.companies.push({
        id: binds[0],
        org_id: binds[1],
        name: binds[2],
        domain: binds[3],
        website: binds[4],
        description: binds[5],
        company_type: 'startup',
        investment_status: 'prospect',
        custom_fields: binds[6],
        created_at: binds[7],
        updated_at: binds[8],
      });
      return;
    }

    if (/UPDATE companies/i.test(sql) && /investment_status = CASE/i.test(sql)) {
      const [customFields, companyId, orgId] = binds;
      const row = this.companies.find(entry => entry.id === companyId && entry.org_id === orgId);
      if (row) {
        if (!row.investment_status || row.investment_status === 'tracking') row.investment_status = 'prospect';
        row.custom_fields = customFields;
      }
      return;
    }

    if (/INSERT INTO tags/i.test(sql)) {
      const name = sql.match(/VALUES \(\?, \?, '([^']+)'/i)?.[1] || binds[2] || 'Investment Prospect';
      const color = sql.match(/VALUES \(\?, \?, '[^']+', '([^']+)'/i)?.[1] || binds[3] || '#D946A8';
      const existing = this.tags.find(row => row.id === binds[0] || (row.org_id === binds[1] && row.name === name));
      if (!existing) {
        this.tags.push({
          id: binds[0],
          org_id: binds[1],
          name,
          color,
          created_at: binds[4],
        });
      }
      return;
    }

    if (/INSERT(?: OR IGNORE)? INTO company_tags/i.test(sql)) {
      const existing = this.companyTags.find(row => row.company_id === binds[0] && row.tag_id === binds[1]);
      if (!existing) {
        this.companyTags.push({
          company_id: binds[0],
          tag_id: binds[1],
          created_at: binds[2],
        });
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /domain = COALESCE\(domain/i.test(sql)) {
      const prospectId = binds[8];
      const orgId = binds[9];
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row) {
        row.domain = row.domain || binds[0];
        row.website = row.website || binds[1];
        row.last_seen_at = binds[2];
        row.last_signal_at = binds[4];
        row.confidence = Math.max(Number(row.confidence || 0), Number(binds[6] || 0));
        row.metadata_json = binds[7];
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /SET company_id = \?/i.test(sql) && /possible_company_id/i.test(sql)) {
      const [companyId, metadataJson, prospectId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row) {
        row.company_id = companyId;
        row.possible_company_id = null;
        row.metadata_json = this.jsonPatch(row.metadata_json, metadataJson);
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /sector_confidence = MAX\(sector_confidence/i.test(sql)) {
      const prospectId = binds[9];
      const orgId = binds[10];
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row) {
        row.canonical_name = binds[0];
        row.status = row.status === 'active' || row.status === 'converted'
          ? row.status
          : binds[1] === 0 ? 'active' : 'provisional';
        if (row.sector_key === 'uncategorized' || Number(binds[2] || 0) > Number(row.sector_confidence || 0)) {
          row.sector_key = binds[3];
        }
        row.sector_confidence = Math.max(Number(row.sector_confidence || 0), Number(binds[4] || 0));
        row.provisional = row.status === 'active' || row.status === 'converted'
          ? 0
          : binds[5] === 1 ? 1 : row.provisional;
        row.direction_uncertain = binds[6] === 1 ? 1 : row.direction_uncertain;
        row.possible_company_id = row.possible_company_id || binds[7];
        row.possible_deal_id = row.possible_deal_id || binds[8];
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /SET possible_duplicate_of = \?/i.test(sql)) {
      const [winnerId, loserId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === loserId && entry.org_id === orgId);
      if (row) row.possible_duplicate_of = winnerId;
      return;
    }

    if (/INSERT INTO prospect_signals/i.test(sql)) {
      if (/dealmaker_id/i.test(sql)) {
        this.upsertSuccessfulSignal(binds);
      } else {
        this.upsertFailedSignal(binds);
      }
      return;
    }

    if (/INSERT(?: OR IGNORE)? INTO prospect_soft_links/i.test(sql)) {
      this.softLinks.push({
        id: binds[0],
        org_id: binds[1],
        prospect_id: binds[2],
        link_type: /possible_duplicate/.test(sql) ? 'possible_duplicate' : binds[3],
        target_type: /'prospect'/.test(sql) ? 'prospect' : binds[4],
        target_id: /'prospect'/.test(sql) ? binds[3] : binds[5],
        score: /'prospect'/.test(sql) ? binds[4] : binds[6],
      });
      return;
    }

    if (/INSERT INTO prospect_classification_history/i.test(sql)) {
      this.classificationHistory.push({
        id: binds[0],
        org_id: binds[1],
        prospect_signal_id: binds[2],
        classifier_version: binds[3],
        previous_classification_json: binds[4],
        new_classification_json: binds[5],
      });
      return;
    }

    if (/INSERT INTO prospect_classifier_samples/i.test(sql)) {
      const existing = this.classifierSamples.find(row =>
        row.org_id === binds[1] &&
        row.source_type === binds[3] &&
        row.source_id === binds[4] &&
        row.mention_ordinal === binds[5]
      );
      const row = existing || {};
      Object.assign(row, {
        id: binds[0],
        org_id: binds[1],
        prospect_signal_id: binds[2],
        source_type: binds[3],
        source_id: binds[4],
        mention_ordinal: binds[5],
        sample_reason: binds[6],
        confidence_tier: binds[7],
        predicted_mention_type: binds[8],
        predicted_direction: binds[9],
        predicted_sector_key: binds[10],
        label_status: 'unlabeled',
      });
      if (!existing) this.classifierSamples.push(row);
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /signal_strength/i.test(sql)) {
      const prospect = this.prospects.find(row => row.id === binds[10] && row.org_id === binds[11]);
      if (prospect) {
        prospect.signal_count = binds[0];
        prospect.evidence_count = binds[1];
        prospect.first_seen_at = binds[2];
        prospect.last_seen_at = binds[3];
        prospect.last_signal_at = binds[4];
        prospect.signal_strength = binds[5];
        prospect.signal_strength_reasons = binds[6];
        prospect.enrichment_priority = binds[7];
        prospect.confidence = binds[8];
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /enrichment_status = 'enriched'/i.test(sql)) {
      const field = sql.match(/SET\s+(\w+)\s+= \?/i)?.[1] || '';
      const [value, prospectId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row && field) {
        row[field] = value;
        row.enrichment_status = 'enriched';
      }
      return;
    }

    if (/INSERT INTO entity_field_state/i.test(sql)) {
      const apply = /current_value = excluded.current_value/i.test(sql);
      if (apply) {
        const [entityId, fieldName, currentValue, sources] = binds;
        const existing = this.entityFieldState.find(row => row.entity_type === 'prospect' && row.entity_id === entityId && row.field_name === fieldName);
        const row = existing || { entity_type: 'prospect', entity_id: entityId, field_name: fieldName };
        Object.assign(row, {
          current_value: currentValue,
          current_value_sources: sources,
          pending_proposals: '{}',
        });
        if (!existing) this.entityFieldState.push(row);
      } else {
        const [entityId, fieldName, proposalValue, sourceKey] = binds;
        const existing = this.entityFieldState.find(row => row.entity_type === 'prospect' && row.entity_id === entityId && row.field_name === fieldName);
        const row = existing || { entity_type: 'prospect', entity_id: entityId, field_name: fieldName, current_value: null, current_value_sources: '[]' };
        row.pending_proposals = JSON.stringify({ [String(proposalValue)]: [String(sourceKey)] });
        if (!existing) this.entityFieldState.push(row);
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /enrichment_status = CASE/i.test(sql)) {
      const [prospectId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row && (!row.enrichment_status || row.enrichment_status === 'not_started')) row.enrichment_status = 'candidate';
      return;
    }

    if (/UPDATE prospect_signals/i.test(sql) && /SET prospect_id/i.test(sql)) {
      if (/id IN/i.test(sql)) {
        const [prospectId, orgId, ...signalIds] = binds;
        for (const row of this.prospectSignals) {
          if (row.org_id === orgId && signalIds.includes(row.id)) row.prospect_id = prospectId;
        }
        return;
      }
      const [winnerId, orgId, loserId] = binds;
      for (const row of this.prospectSignals) {
        if (row.org_id === orgId && row.prospect_id === loserId) row.prospect_id = winnerId;
      }
      return;
    }

    if (/UPDATE prospect_signals/i.test(sql) && /SET company_id = \?/i.test(sql)) {
      const [companyId, metadataJson, signalId, orgId] = binds;
      const row = this.prospectSignals.find(entry => entry.id === signalId && entry.org_id === orgId);
      if (row) {
        row.company_id = companyId;
        row.metadata_json = this.jsonPatch(row.metadata_json, metadataJson);
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /status = 'merged'/i.test(sql)) {
      const [winnerId, loserId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === loserId && entry.org_id === orgId);
      if (row) {
        row.status = 'merged';
        row.possible_duplicate_of = winnerId;
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /possible_duplicate_of = NULL/i.test(sql)) {
      const [status, loserId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === loserId && entry.org_id === orgId);
      if (row) {
        row.status = status || 'active';
        row.possible_duplicate_of = null;
      }
      return;
    }

    if (/INSERT INTO prospect_merge_audit/i.test(sql)) {
      this.mergeAudit.push({
        id: binds[0],
        org_id: binds[1],
        action: /'unmerge'/.test(sql) ? 'unmerge' : 'merge',
        winner_prospect_id: binds[2],
        loser_prospect_id: binds[3],
        method: binds[4],
        score: binds[5],
        moved_signal_ids: binds[6],
        previous_loser_status: binds[8] || null,
      });
      return;
    }

    if (/INSERT INTO prospect_backfill_coverage/i.test(sql)) {
      this.coverage.push({
        id: binds[0],
        org_id: binds[1],
        run_id: binds[2],
        source_family: binds[3],
        window_start: binds[4],
        window_end: binds[5],
        status: binds[6],
        items_scanned: binds[7],
        signals_recorded: binds[8],
        prospects_upserted: binds[9],
        classifications_pending: binds[10],
        error_message: binds[11],
      });
      return;
    }

    if (/INSERT INTO prospect_backfill_runs/i.test(sql)) {
      this.backfillRuns.push({
        id: binds[0],
        org_id: binds[1],
        window_start: binds[2],
        window_end: binds[3],
        cursor: binds[4],
        status: 'in_progress',
        source_families: binds[5],
        measured_cost_per_item: binds[6],
      });
      return;
    }

    if (/UPDATE prospect_backfill_runs/i.test(sql)) {
      const [status, cursor, itemsFound, itemsProcessed, signalsRecorded, estimatedCost, lastError, runId, orgId] = binds;
      const row = this.backfillRuns.find(entry => entry.id === runId && entry.org_id === orgId);
      if (row) {
        row.status = status;
        row.cursor = cursor;
        row.items_found = itemsFound;
        row.items_processed = itemsProcessed;
        row.signals_recorded = signalsRecorded;
        row.estimated_total_cost = estimatedCost;
        row.last_error = lastError;
      }
    }
  }

  private upsertSuccessfulSignal(binds: unknown[]): void {
    const existing = this.storedSignalFor(binds[1], binds[5], binds[6], binds[7]);
    const row = existing || {};
    Object.assign(row, {
      id: binds[0],
      org_id: binds[1],
      prospect_id: binds[2],
      deal_id: binds[3],
      company_id: binds[4],
      source_type: binds[5],
      source_id: binds[6],
      mention_ordinal: binds[7],
      span_start: binds[8],
      span_end: binds[9],
      raw_mention_text: binds[10],
      normalized_mention: binds[11],
      source_title: binds[12],
      occurred_at: binds[13],
      direction: binds[14],
      direction_source: binds[15],
      direction_uncertain: binds[16],
      mention_type: binds[17],
      classifier_version: binds[18],
      confidence: binds[19],
      confidence_tier: binds[20],
      classification_status: binds[21],
      resolution_status: binds[22],
      error_message: binds[23],
      classification_attempts: binds[24],
      sector_key: binds[25],
      sector_confidence: binds[26],
      signal_kind: binds[27],
      dealmaker_id: binds[28],
      dealmaker_name: binds[29],
      has_deck: binds[30],
      has_meeting: binds[31],
      ingestion_mode: binds[32],
      metadata_json: binds[33],
    });
    if (!existing) this.prospectSignals.push(row);
  }

  private upsertFailedSignal(binds: unknown[]): void {
    const existing = this.storedSignalFor(binds[1], binds[2], binds[3], binds[4]);
    const row = existing || {};
    Object.assign(row, {
      id: binds[0],
      org_id: binds[1],
      prospect_id: existing?.prospect_id || null,
      source_type: binds[2],
      source_id: binds[3],
      mention_ordinal: binds[4],
      span_start: binds[5],
      span_end: binds[6],
      raw_mention_text: binds[7],
      normalized_mention: binds[8],
      source_title: binds[9],
      occurred_at: binds[10],
      mention_type: existing?.mention_type || 'noise',
      classifier_version: binds[11],
      classification_status: 'failed',
      resolution_status: 'pending',
      error_message: binds[12],
      classification_attempts: binds[13],
      sector_key: existing?.sector_key || 'uncategorized',
      sector_confidence: existing?.sector_confidence || 0,
      ingestion_mode: binds[14],
      metadata_json: binds[15],
    });
    if (!existing) this.prospectSignals.push(row);
  }

}

describe('prospect intelligence deterministic signals', () => {
  it('normalizes prospect identity without thesis inputs', () => {
    expect(normalizeProspectName('NeuralSeek AI Inc.')).toBe('neuralseek');
    expect(normalizeProspectName('Qunnect Technologies, LLC')).toBe('qunnect');
  });

  it('builds durable identity aliases from names and domains', () => {
    const aliases = buildEntityIdentityAliasValues({
      name: 'Acme Robotics, PBC',
      normalizedName: 'acmerobotics',
      domain: 'www.acme-robotics.ai',
      website: 'https://acme-robotics.ai/deck',
    });

    expect(aliases).toEqual(expect.arrayContaining([
      { aliasKind: 'normalized_name', aliasValue: 'acmerobotics', confidence: 1 },
      { aliasKind: 'domain', aliasValue: 'acme-robotics.ai', confidence: 1 },
      { aliasKind: 'domain_brand', aliasValue: 'acmerobotics', confidence: 0.92 },
    ]));
  });

  it('keeps ObjectSecurity as one company and stores slash products as metadata', () => {
    const [candidate] = extractMentionCandidatesFromText(
      '- ObjectSecurity / FortiLayer AI / FortiLayer OT - data security products'
    );

    expect(candidate.canonicalName).toBe('ObjectSecurity');
    expect(candidate.normalizedName).toBe('objectsecurity');
    expect(candidate.products).toEqual(['FortiLayer AI', 'FortiLayer OT']);
  });

  it('generalizes attachment filename suffix canonicalization without stripping domain TLDs', () => {
    const { canonicalizeMention } = __prospectIntelligenceTestHooks;
    for (const suffix of ['zip', 'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'csv']) {
      expect(canonicalizeMention(`Fidux.${suffix}`).canonicalName).toBe('Fidux');
    }

    for (const domainLikeName of ['Auguria.ai', 'Qunnect.io', 'Rendair.co', 'Vulcan.com', 'Nodi.dev', 'FortiLayer.tech']) {
      expect(canonicalizeMention(domainLikeName).canonicalName).toBe(domainLikeName);
    }
  });

  it('strips pitch-material filename wrappers before classification', () => {
    const { canonicalizeMention } = __prospectIntelligenceTestHooks;

    expect(canonicalizeMention('Tectonic_One Pager.pdf').canonicalName).toBe('Tectonic');
    expect(canonicalizeMention('Tectonic Investor Deck.pdf').canonicalName).toBe('Tectonic');
    expect(canonicalizeMention('Tectonic-Company Overview.pptx').canonicalName).toBe('Tectonic');
  });

  it('parses founder/person wrapper phrases into the company name', () => {
    const { canonicalizeMention } = __prospectIntelligenceTestHooks;

    expect(canonicalizeMention('Mike founder of Tetonic').canonicalName).toBe('Tetonic');
    expect(canonicalizeMention('Founder Mike of Tetonic').canonicalName).toBe('Tetonic');
    expect(canonicalizeMention('CEO of Arc Compute').canonicalName).toBe('Arc Compute');
  });

  it('strips safe document-heading prefixes from real company names', () => {
    const { canonicalizeMention } = __prospectIntelligenceTestHooks;

    expect(canonicalizeMention('Company Overview Chain Reaction').canonicalName).toBe('Chain Reaction');
    expect(canonicalizeMention('Executive Summary Qunnect').canonicalName).toBe('Qunnect');
    expect(canonicalizeMention('Investment Memo Zero Third').canonicalName).toBe('Zero Third');
  });

  it('strips leading person-title prefixes from source-title company mentions', () => {
    const { canonicalizeMention } = __prospectIntelligenceTestHooks;

    expect(canonicalizeMention('JP CEO Arc Compute').canonicalName).toBe('Arc Compute');
    expect(canonicalizeMention('Maya Founder/CEO Northstar Grid').canonicalName).toBe('Northstar Grid');
  });

  it('does not strip leading digits from company names anchored by domains', () => {
    const [candidate] = extractMentionCandidatesFromText('Please coordinate with 8k-capital.com on closing items.');
    expect(candidate.canonicalName).toBe('8k Capital');
    expect(candidate.normalizedName).toBe('8kcapital');
  });

  it('suppresses meeting scaffolding and canonicalizes repeated adjacent names before classification', async () => {
    const { extractOrganizationMentionsFromSource } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-scaffold',
      subject: 'Intro to Auguria',
      bodyText: [
        'Join with Google Meet: meet.google.com/cya-yrux-nbm',
        'Meeting link meet.google.com/cya-yrux-nbm Join by phone.',
        'DocReq: please upload diligence files.',
        'Warm intro to Auguria and NeuralSeek for the diligence call.',
        'Qunnect Qunnect appears in the copied calendar title.',
        'Greenberg Traurig will handle counsel questions.',
        'Quantum Machines is a separate real organization in the same thread.',
      ].join('\n'),
      fromEmail: 'alice@example.com',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      forceLlm: true,
      llmExtractor: async () => [
        { name: 'Join with Google Meet', raw: 'Join with Google Meet', context: null },
        { name: 'Meeting link meet.google.com/cya-yrux-nbm Join by phone', raw: 'Meeting link meet.google.com/cya-yrux-nbm Join by phone', context: null },
        { name: 'DocReq', raw: 'DocReq', context: null },
        { name: 'Auguria', raw: 'Auguria', context: null },
        { name: 'NeuralSeek', raw: 'NeuralSeek', context: null },
        { name: 'Qunnect Qunnect', raw: 'Qunnect Qunnect', context: null },
        { name: 'Greenberg Traurig', raw: 'Greenberg Traurig', context: null },
        { name: 'Craig Abod', raw: 'Craig Abod', context: null },
        { name: 'Manny', raw: 'Manny', context: null },
        { name: 'Hi Tony', raw: 'Hi Tony', context: null },
        { name: 'Thursday after', raw: 'Thursday after', context: null },
        { name: 'Employee Search Endpoint', raw: 'Employee Search Endpoint', context: null },
        { name: 'Prospector Spreadsheets', raw: 'Prospector Spreadsheets', context: null },
        { name: 'Cyber Presentation', raw: 'Cyber Presentation', context: null },
        { name: 'Quantum', raw: 'Quantum', context: null },
        { name: 'Quantum Machines', raw: 'Quantum Machines', context: null },
      ],
    });

    const names = mentions.map(mention => mention.canonicalName);
    expect(names).toEqual(expect.arrayContaining(['Auguria', 'NeuralSeek', 'Qunnect', 'Greenberg Traurig', 'Quantum Machines']));
    expect(names).not.toContain('Join with Google Meet');
    expect(names).not.toContain('Meeting link meet.google.com/cya-yrux-nbm Join by phone');
    expect(names).not.toContain('DocReq');
    expect(names).not.toEqual(expect.arrayContaining(['Craig Abod', 'Manny', 'Hi Tony', 'Thursday after', 'Employee Search Endpoint', 'Prospector Spreadsheets', 'Cyber Presentation', 'Quantum']));
    expect(mentions.find(mention => mention.canonicalName === 'Qunnect')?.raw).toBe('Qunnect Qunnect');
  });

  it('uses deterministic source evidence to fix close company-name typos before classification', async () => {
    const { extractOrganizationMentionsFromSource } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-tectonic-intro',
      subject: 'Intro Tony-Mike',
      bodyText: 'Tony meet Mike founder of Tetonic.',
      bodyPreview: 'Tony meet Mike founder of Tetonic.',
      fromEmail: 'jim@pathfinderventures.com',
      toEmails: ['tony@medinavc.com', 'mike@tectonic.xyz'],
      ccEmails: ['jim@americanreconventures.com'],
      sentAt: '2026-06-11T15:10:00.000Z',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      allowLlm: false,
    });

    expect(mentions.map(mention => mention.canonicalName)).toContain('Tectonic');
    expect(mentions.map(mention => mention.canonicalName)).not.toContain('Mike founder of Tetonic');
    expect(mentions.map(mention => mention.canonicalName)).not.toContain('Tetonic');
  });

  it('repairs LLM organization fragments that were anchored inside a longer company token', async () => {
    const { extractOrganizationMentionsFromSource } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'document',
      entityType: 'document',
      entityId: 'doc-army-fuse-fragment',
      subject: 'Army FUSE companies',
      bodyText: [
        'Company Name EngeniusMicro Website engeniusmicro.com Contact ceo@engeniusmicro.com Round Stage Seed Amount $2M.',
        "EngeniusMicro's sensors are being reviewed in the fundraising packet.",
      ].join('\n'),
      bodyPreview: 'EngeniusMicro fundraising packet',
      fromEmail: 'sender@example.com',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      forceLlm: true,
      llmExtractor: async () => [
        { name: 'Usmicro', raw: 'usMicro', context: null },
      ],
    });

    const names = mentions.map(mention => mention.canonicalName);
    expect(names).toContain('EngeniusMicro');
    expect(names).not.toContain('Usmicro');
  });

  it('extracts one-pager document titles as the target company instead of the wrapper', async () => {
    const { extractOrganizationMentionsFromSource } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'document',
      entityType: 'document',
      entityId: 'doc-tectonic-one-pager',
      source: 'outlook',
      subject: 'Tectonic_One Pager.pdf',
      bodyText: [
        'Tectonic_One Pager.pdf',
        'Securing the world’s migration to post-quantum cryptography.',
        'Tectonic is building post-quantum infrastructure for regulated industries.',
        'Navy SBIR, NIST, DARPA, and AWS are mentioned as context and credentials.',
      ].join('\n'),
      bodyPreview: 'Tectonic is building post-quantum infrastructure.',
      metadata: {
        entity_name: 'Tectonic_One Pager.pdf',
        document_type: 'deal_pitch',
      },
      sentAt: '2026-06-11T15:18:47.609Z',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      allowLlm: false,
    });

    expect(mentions.map(mention => mention.canonicalName)).toContain('Tectonic');
    expect(mentions.map(mention => mention.canonicalName)).not.toContain('Tectonic One Pager');
    expect(mentions.map(mention => mention.canonicalName)).not.toEqual(expect.arrayContaining(['Navy SBIR', 'NIST', 'DARPA', 'AWS']));
  });

  it('extracts company-led investor report titles only when the source supports the title', async () => {
    const { extractOrganizationMentionsFromSource, sourceInvestorUpdateTitleTargetName } = __prospectIntelligenceTestHooks;
    const supported: any = {
      type: 'document',
      entityType: 'document',
      entityId: 'doc-investor-report-supported',
      source: 'outlook',
      subject: 'Northstar Grid Investor Report #2 - May 2026',
      bodyText: [
        'Investor Update #2',
        'Northstar Grid is sharing traction, revenue progress, runway, and customer pipeline updates with investors.',
        'The report includes capital planning notes for Medina review.',
      ].join('\n'),
      bodyPreview: 'Investor update with traction and capital planning.',
      sentAt: '2026-06-11T15:18:47.609Z',
    };
    const supportedMentions = await extractOrganizationMentionsFromSource(supported, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      allowLlm: false,
    });

    expect(supportedMentions.map(mention => mention.canonicalName)).toContain('Northstar Grid');
    expect(sourceInvestorUpdateTitleTargetName(
      'Blue Harbor Investor Report #2 - May 2026',
      'Attached title only. No company details are available in the extracted source text.'
    )).toBeNull();
  });

  it('suppresses headings, markup artifacts, and generic fragments from LLM org extraction', async () => {
    const { extractOrganizationMentionsFromSource } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'document',
      entityId: 'doc-outline',
      subject: 'Zero Third analysis',
      bodyText: [
        'Company Overview Chain Reaction',
        'What They Do',
        'Why Now',
        'Schema schema.org body-container column-per',
        'Go-to market notes',
        'Chain Reaction builds privacy infrastructure.',
      ].join('\n'),
      fromEmail: 'analyst@medinavc.com',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      forceLlm: true,
      llmExtractor: async () => [
        { name: 'Company Overview Chain Reaction', raw: 'Company Overview Chain Reaction', context: null },
        { name: 'What They Do', raw: 'What They Do', context: null },
        { name: 'Why Now', raw: 'Why Now', context: null },
        { name: 'Schema', raw: 'Schema', context: null },
        { name: 'Go-to', raw: 'Go-to', context: null },
        { name: 'Chain Reaction', raw: 'Chain Reaction', context: null },
      ],
    });

    const names = mentions.map(mention => mention.canonicalName);
    expect(names).toEqual(expect.arrayContaining(['Chain Reaction']));
    expect(names).not.toEqual(expect.arrayContaining(['Company Overview Chain Reaction', 'What They Do', 'Why Now', 'Schema', 'Go-to']));
  });

  it('filters person and participant bundles while preserving real connector-company names', async () => {
    const { extractOrganizationMentionsFromSource } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-participants',
      subject: 'Participant and company extraction',
      bodyText: [
        'Participants: Tony/Melissa; Melissa + Tony; Wes Cowan/Tony Jimenez; Tony Jimenez & Wes Cowan; Yesha / Khizroev; William Real of Civic Construction.',
        'Companies: Johnson & Johnson, Procter & Gamble, Booz Allen Hamilton, Vector Capital, RHEON Labs, Mully AI.',
      ].join('\n'),
      fromEmail: 'external@example.com',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      forceLlm: true,
      llmExtractor: async () => [
        { name: 'Tony/Melissa', raw: 'Tony/Melissa', context: null },
        { name: 'Melissa + Tony', raw: 'Melissa + Tony', context: null },
        { name: 'Wes Cowan/Tony Jimenez', raw: 'Wes Cowan/Tony Jimenez', context: null },
        { name: 'Tony Jimenez & Wes Cowan', raw: 'Tony Jimenez & Wes Cowan', context: null },
        { name: 'Yesha / Khizroev', raw: 'Yesha / Khizroev', context: null },
        { name: 'William Real of Civic Construction', raw: 'William Real of Civic Construction', context: null },
        { name: 'Johnson & Johnson', raw: 'Johnson & Johnson', context: null },
        { name: 'Procter & Gamble', raw: 'Procter & Gamble', context: null },
        { name: 'Booz Allen Hamilton', raw: 'Booz Allen Hamilton', context: null },
        { name: 'Vector Capital', raw: 'Vector Capital', context: null },
        { name: 'RHEON Labs', raw: 'RHEON Labs', context: null },
        { name: 'Mully AI', raw: 'Mully AI', context: null },
      ],
    });

    const names = mentions.map(mention => mention.canonicalName);
    expect(names).toEqual(expect.arrayContaining(['Johnson & Johnson', 'Procter & Gamble', 'Booz Allen Hamilton', 'Vector Capital', 'RHEON Labs', 'Mully AI']));
    expect(names).not.toEqual(expect.arrayContaining([
      'Tony/Melissa',
      'Melissa + Tony',
      'Wes Cowan/Tony Jimenez',
      'Tony Jimenez & Wes Cowan',
      'Yesha / Khizroev',
      'William Real of Civic Construction',
    ]));
  });

  it('keeps keyword sectoring as a prefilter hint only', () => {
    const { sectorHintForText } = __prospectIntelligenceTestHooks;

    expect(sectorHintForText('Auguria security data platform for threat teams').key).toBe('cybersecurity');
    expect(sectorHintForText('ArmyFUZE rugged hardware for Army field teams').key).toBe('aerospace_defense');
    expect(sectorHintForText('Sativa hempcrete materials for construction').key).toBe('materials_manufacturing');
    expect(sectorHintForText('A single uncategorized cold mention').key).toBe('uncategorized');
  });

  it('materializes an open deal as one converted linked prospect idempotently', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-qunnect',
      org_id: 'org-1',
      name: 'Qunnect',
      domain: 'qunnect.io',
      sector: 'quantum',
    });
    db.deals.push({
      id: 'deal-qunnect',
      org_id: 'org-1',
      company_id: 'company-qunnect',
      stage: 'talking',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const first = await ensureProspectForDeal('org-1', 'deal-qunnect', env);
    const second = await ensureProspectForDeal('org-1', 'deal-qunnect', env);

    expect(first.action).toBe('created');
    expect(second).toMatchObject({ action: 'already_linked', prospectId: first.prospectId });
    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({
      canonical_name: 'Qunnect',
      normalized_name: 'qunnect',
      domain: 'qunnect.io',
      company_id: 'company-qunnect',
      deal_id: 'deal-qunnect',
      status: 'converted',
      visibility: 'firm',
      sector_key: 'quantum',
      signal_strength: 85,
      enrichment_priority: 'eager',
      confidence: 1,
      provisional: 0,
      direction_uncertain: 0,
    });
    expect(JSON.parse(db.prospects[0].metadata_json)).toMatchObject({
      source: 'known_deal_backlink',
      deal_id: 'deal-qunnect',
      company_id: 'company-qunnect',
    });
  });

  it('links an existing prospect to an open deal instead of creating a duplicate', async () => {
    const db = new FakeD1();
    db.companies.push({ id: 'company-auguria', org_id: 'org-1', name: 'Auguria', domain: 'auguria.io', sector: 'cybersecurity' });
    db.deals.push({ id: 'deal-auguria', org_id: 'org-1', company_id: 'company-auguria', stage: 'talking' });
    db.prospects.push({
      id: 'prospect-auguria',
      org_id: 'org-1',
      canonical_name: 'Auguria',
      normalized_name: 'auguria',
      status: 'active',
      sector_key: 'uncategorized',
      sector_confidence: 0,
      signal_strength: 30,
      signal_strength_reasons: '[]',
      confidence: 0.75,
      provisional: 1,
      direction_uncertain: 1,
      metadata_json: '{}',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const result = await ensureProspectForDeal('org-1', 'deal-auguria', env);

    expect(result).toMatchObject({ action: 'updated', prospectId: 'prospect-auguria' });
    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({
      id: 'prospect-auguria',
      deal_id: 'deal-auguria',
      company_id: 'company-auguria',
      status: 'converted',
      sector_key: 'cybersecurity',
      signal_strength: 85,
      provisional: 0,
      direction_uncertain: 0,
      possible_deal_id: null,
    });
  });

  it('builds an LLM classifier prompt where the model decides prospect verdict, direction, and sector', () => {
    const { buildClassifierPrefilter, buildProspectClassifierPrompt, classifierInputForRuntime } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      subject: 'Intro to Auguria',
      bodyText: 'Warm intro to Auguria; deck attached for their security data product.',
      bodyPreview: 'Warm intro to Auguria',
      fromEmail: 'alicia@example.com',
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = buildClassifierPrefilter(item, mention, existing, {} as any);
    const input = classifierInputForRuntime(item, mention, existing, prefilter, {
      knownDeals: [{ name: 'Qunnect', domain: 'qunnect.io' }],
      knownDealmakers: [{ name: 'DIU', domain: 'diu.mil' }],
    }, 'org-1');
    const prompt = buildProspectClassifierPrompt(input);

    expect(prompt.system).toContain('Your only job is to decide whether the candidate is the company actually being put in');
    expect(prompt.system).toContain('Answer is_prospect=true only when');
    expect(prompt.system).toContain('Thesis fit does not determine prospect status');
    expect(prompt.system).toContain('KNOWN open deals / true portfolio companies (names + domains): Qunnect <qunnect.io>');
    expect(prompt.system).toContain('matched_company_id/domain in the JSON are for identity and deduplication');
    expect(prompt.system).toContain('ai_data, cybersecurity, quantum');
    expect(prompt.system).toContain('"is_prospect":true');
    expect(prompt.system).not.toContain('"prospect_action"');
    expect(prompt.system).not.toContain('attach_existing_deal');
    expect(prompt.system).not.toContain('record_context');
    expect(prompt.system).not.toContain('ignore"');
    expect(prompt.system).toContain('The candidate name is the object being judged');
    expect(prompt.system).toContain('False-positive traps');
    expect(prompt.system).toContain('participant list');
    expect(prompt.system).toContain('listed with a funding ask/stage/contact');
    expect(prompt.system).toContain('multiple listed company rows in the same source are true prospects');
    expect(prompt.system).toContain('Known Dealmaker forwarding Target AI Company');
    expect(prompt.system).toContain('In meeting summaries or transcripts');
    expect(prompt.user).toContain('SOURCE_TYPE: email');
    expect(prompt.user).toContain('MENTION (the company in question): Auguria');
  });

  it('deterministically vetoes obvious non-investable create-prospect mentions', () => {
    const { prospectCreateVetoForMention } = __prospectIntelligenceTestHooks;
    const blocked: Array<{
      company: string;
      action?: 'create_prospect' | 'attach_existing_deal';
      excerpt: string;
      reasoning: string;
      prospectCompanyName?: string;
      senderAndContext?: string;
    }> = [
      ['Join with Google Meet', 'Calendar invite with Join with Google Meet details.'],
      ['Meeting link meet.google.com/cya-yrux-nbm Join by phone', 'Calendar meeting link text.'],
      ['Vimeo', 'Video link for WavePoint Solutions hosted on Vimeo.'],
      ['US Army', 'US Army is a customer and deployment context for WavePoint.'],
      ['Gillette Stadium', 'Gillette Stadium is a customer deployment location.'],
      ['Finalis Securities LLC', 'Finalis Securities LLC is the exclusive financial advisor for WavePoint.'],
      ['Sheehanfinance', 'sheehanfinance.com is the advisor domain facilitating the raise.'],
      ['CJW Quantum', 'CJW Quantum Consulting LLC is a consulting firm advising the conversation.'],
      ['eMerge Americas', 'eMerge Americas is a sourcing/channel partner around the deal.'],
      ['Tony’s Florida Quantum', 'Tony’s Florida Quantum note is a generated meeting-summary title, not a company.'],
      ['Cedar Pine', 'Cedar Pine is just relationship context; WavePoint Solutions is the actual company being pitched.'],
      ['Front Porch', 'Front Porch is a hybrid venture vehicle investing in funds.'],
      ['What They Do', 'What They Do is a document section heading in the company memo.'],
      ['Schema', 'Schema appears to be schema.org markup in the email HTML.'],
      ['Tony/Melissa', 'Tony/Melissa are meeting participants, not the company being pitched.'],
      ['Digitalera Group', 'OnID was introduced by Digitalera Group as the intro source.'],
      ['8k Capital', '8k Capital is mentioned as a meeting participant at the fundraising meeting.'],
    ];

    for (const [companyName, rawExcerpt] of blocked) {
      expect(prospectCreateVetoForMention({
        prospectAction: 'create_prospect',
        companyName,
        rawMention: companyName,
        rawExcerpt,
        senderAndContext: 'from advisor@example.com',
        llmReasoning: `${companyName} is mentioned around the investment opportunity.`,
      })).toMatchObject({ applied: true });
    }
  });

  it('does not veto valid investment-target create-prospect mentions', () => {
    const { prospectCreateVetoForMention } = __prospectIntelligenceTestHooks;
    const valid = [
      ['Auguria', 'Warm intro to Auguria; Auguria is being presented as an investment opportunity with security data product materials.'],
      ['RHEON Labs', 'RHEON Labs is raising with a deck and call request from an advisor.'],
      ['Rheonlabs', 'Rheonlabs is an EIS funding opportunity with allocation available.'],
      ['WavePoint Solutions', 'WavePoint Solutions is conducting a $10M raise with customer traction.'],
      ['WavePoint Solutions', 'WavePoint Solutions is the actual company being pitched.'],
      ['Wavepointsolution', 'Wavepointsolution is the company being pitched as an investment opportunity.'],
      ['Nova Finance', 'Nova Finance is raising with support from an exclusive financial advisor.'],
      ['Qusecure', 'Qusecure is introduced as a quantum security investment opportunity.'],
      ['Vulcan', 'Vulcan is being sent as a prospect for review.'],
      ['Rendair', 'Rendair is a company being presented for investment consideration.'],
      ['Classiq', 'Intro to Classiq founders for an investment opportunity; Classiq introduced their quantum software platform and deck.'],
      ['Universal Quantum', 'Lazard is presenting Universal Quantum as an investment opportunity with a deck.'],
      ['Johnson & Johnson', 'Johnson & Johnson is being evaluated as a strategic investment opportunity.'],
      ['Vector Capital', 'Vector Capital is being presented as the investment target with a deck.'],
    ];

    for (const [companyName, rawExcerpt] of valid) {
      expect(prospectCreateVetoForMention({
        prospectAction: 'create_prospect',
        companyName,
        rawMention: companyName,
        rawExcerpt,
        senderAndContext: 'from external dealmaker',
        llmReasoning: `${companyName} is the company being pitched as an investment opportunity.`,
      })).toMatchObject({ applied: false });
    }
  });

  it('trusts classifier reasoning when the action says create but the mention is clearly not the target', () => {
    const { prospectValuableActionVetoForMention } = __prospectIntelligenceTestHooks;
    const blocked = [
      {
        companyName: 'Example Growth Fund',
        rawExcerpt: 'Example Growth Fund backed TargetCo, which is being pitched as the investment opportunity.',
        reasoning: 'Example Growth Fund is a backer/investor, not the company being pitched; the actual target company is TargetCo.',
      },
      {
        companyName: 'Regional Bank',
        rawExcerpt: 'Regional Bank introduced TargetCo to Medina Ventures for diligence.',
        reasoning: 'Regional Bank is the intro source, not itself an investment prospect; TargetCo is the actual company being pitched.',
      },
      {
        companyName: 'Enterprise Buyer',
        rawExcerpt: 'Pipeline review lists Enterprise Buyer as a customer of TargetCo.',
        reasoning: 'Enterprise Buyer is a customer/partner of TargetCo and not the investment target.',
      },
      {
        companyName: 'Senior Executive',
        rawExcerpt: 'Senior Executive attended the meeting about TargetCo.',
        reasoning: 'The mention Senior Executive is a person/meeting participant, not the company being pitched.',
      },
    ];

    for (const row of blocked) {
      expect(prospectValuableActionVetoForMention({
        prospectAction: 'create_prospect',
        companyName: row.companyName,
        rawMention: row.companyName,
        rawExcerpt: row.rawExcerpt,
        senderAndContext: 'from dealmaker@example.com',
        llmReasoning: row.reasoning,
      })).toMatchObject({
        applied: true,
        nonValuableAction: 'record_context',
      });
    }
  });

  it('vetoes create actions when classifier reasoning explicitly says there is no investment signal', () => {
    const { prospectValuableActionVetoForMention } = __prospectIntelligenceTestHooks;
    const blocked = [
      'Meeting scheduling follow-up from an advisory board member; no investment opportunity or company pitch presented.',
      'Calendar meeting between fund team member and company contact; relationship maintenance, no investment opportunity signal.',
      'Known CRM entry on an internal radar report, not a fresh inbound pitch or investment opportunity.',
      'Product update email, not a new investment pitch or fundraise signal.',
      'Internal pipeline status report listing a CRM entry. No active pitch, diligence, or investment ask evident.',
      'Internal pipeline status report listing existing CRM entry; no fresh investment pitch or diligence signal.',
      'Acquisition sponsor/operator participant in internal meeting, not the investment opportunity itself.',
      'Company is discussed internally; no evidence it is being pitched as a fund investment opportunity.',
    ];

    for (const reasoning of blocked) {
      expect(prospectValuableActionVetoForMention({
        prospectAction: 'create_prospect',
        companyName: 'Example Company',
        rawMention: 'Example Company',
        rawExcerpt: 'Example Company appears in the source.',
        senderAndContext: 'from external@example.com',
        prospectCompanyName: 'Example Company',
        llmReasoning: reasoning,
      })).toMatchObject({
        applied: true,
        reason: 'classifier_reasoning_explicitly_rejects_prospect',
        nonValuableAction: 'record_context',
      });
    }
  });

  it('blocks hard-negative classifier reasoning without blocking clear investment targets', () => {
    const { classifierReasoningHasHardNegativeRole, prospectValuableActionVetoForMention } = __prospectIntelligenceTestHooks;
    const blocked = [
      {
        companyName: 'KnownCo',
        rawExcerpt: 'KnownCo sent an investor update and diligence follow-up.',
        reasoning: 'KnownCo is a known open deal already in CRM; attach to existing deal rather than create a new prospect.',
      },
      {
        companyName: 'Advisory LLP',
        rawExcerpt: 'Advisory LLP invoice and legal advisory note for a portfolio matter.',
        reasoning: 'Advisory LLP is a legal/advisory vendor and this is administrative billing context, not a startup investment prospect.',
      },
      {
        companyName: 'Exampledomain',
        rawExcerpt: 'exampledomain.com appeared in a link scanner/footer around the message.',
        reasoning: 'Exampledomain is a generic domain fragment from a source URL, not a distinct company being pitched.',
      },
      {
        companyName: 'Regional Investment Bank',
        rawExcerpt: 'Regional Investment Bank is sharing TargetCo as an acquisition opportunity.',
        reasoning: 'Regional Investment Bank is the investment banker/source firm presenting TargetCo, not itself the investment target.',
      },
      {
        companyName: 'Public MegaCorp',
        rawExcerpt: 'Public MegaCorp announced a partnership in a newsletter.',
        reasoning: 'Public MegaCorp is public-market/news context only and not a private dealflow or investment target.',
      },
      {
        companyName: 'KnownCo',
        rawExcerpt: 'KnownCo founder is scheduling a call with an existing customer.',
        reasoning: 'Known CRM company KnownCo being pitched outbound by fund to a customer/partner; scheduling call with founder.',
      },
      {
        companyName: 'ProtocolLayer',
        rawExcerpt: 'ProtocolLayer is used in TargetCo infrastructure.',
        reasoning: 'Technology/protocol underlying TargetCo infrastructure, not an independent investment target.',
      },
      {
        companyName: 'Resort Asset',
        rawExcerpt: 'Resort Asset acquisition catch-up and site visit.',
        reasoning: 'Resort Asset is a real-estate/hospitality asset being evaluated, not a software or tech prospect.',
      },
    ];

    for (const row of blocked) {
      expect(classifierReasoningHasHardNegativeRole(row.reasoning)).toBe(true);
      expect(prospectValuableActionVetoForMention({
        prospectAction: 'create_prospect',
        companyName: row.companyName,
        rawMention: row.companyName,
        rawExcerpt: row.rawExcerpt,
        senderAndContext: 'from external@example.com',
        prospectCompanyName: row.companyName,
        llmReasoning: row.reasoning,
      })).toMatchObject({
        applied: true,
      });
    }

    const positiveReasoning = 'TargetBio is the company being pitched as an investment opportunity; the founder shared a deck and is raising a seed round with diligence materials.';
    expect(classifierReasoningHasHardNegativeRole(positiveReasoning)).toBe(false);
    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'TargetBio',
      rawMention: 'TargetBio',
      rawExcerpt: 'TargetBio founder shared a deck and seed round diligence materials.',
      senderAndContext: 'from founder@targetbio.example',
      prospectCompanyName: 'TargetBio',
      llmReasoning: positiveReasoning,
    })).toMatchObject({ applied: false });
  });

  it('does not let hard-negative wording override target-specific prospect evidence', () => {
    const { prospectValuableActionVetoForMention } = __prospectIntelligenceTestHooks;

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Tesorai',
      rawMention: 'Tesorai',
      rawExcerpt: 'Subject: Stacking Wins: Tesorai Closing $5m Seed at an Implied 2.9x + Co-Invest Opportunity. Tesorai is closing a $5M Seed round with co-invest allocation for Medina.',
      senderAndContext: 'from investor@example.com | to: tony@medinavc.com',
      prospectCompanyName: 'Tesorai',
      llmReasoning: 'Tesorai is explicitly presented as a portfolio company closing a $5M Seed round with co-invest opportunity for Medina.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Nodi',
      rawMention: 'Nodi',
      rawExcerpt: 'Nodi Investor Report #2 - May, 2026. Nodi sent Medina an investor update with SaaS product traction, active investor communication, and fundraising context.',
      senderAndContext: 'from founder@nodi.example | to: raul@medinavc.com',
      prospectCompanyName: 'Nodi',
      llmReasoning: 'Nodi sends an investor update directly to Medina describing SaaS product traction and operational progress, indicating active investor communication and fundraising context.',
    })).toMatchObject({ applied: false });
  });

  it('flags accepted prospects for second look when the create was rescued from a non-create verdict', () => {
    const { buildProspectSecondLookPacket } = __prospectIntelligenceTestHooks;
    const packet = buildProspectSecondLookPacket({
      item: {
        entityType: 'conversation',
        entityId: 'conv-endiatx',
        subject: 'PillBot Micro-Robotics',
      },
      mention: {
        raw: 'Endiatx',
        canonicalName: 'Endiatx',
        normalizedName: 'endiatx',
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'I am a major investor and board member of Endiatx. They invented PillBot.',
        contextText: 'I am a major investor and board member of Endiatx. They invented PillBot.',
        isListEntry: false,
        products: [],
      },
      classifierInput: {
        sourceType: 'conversation',
        companyName: 'Endiatx',
        senderAndContext: 'subject: PillBot Micro-Robotics | to: Tony, Raul, Manny',
        rawExcerpt: 'I am a major investor and board member of Endiatx. They invented PillBot, a micro-robot that is disrupting health. Watch their 4 min TED live demo.',
        prefilterHints: {},
        sectorHints: { key: 'healthcare', confidence: 0.8 },
        knownContext: { knownDeals: [], knownDealmakers: [], companies: [] },
        orgId: 'org-1',
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityScore: 0,
        identityStrength: 'none',
        identityAmbiguous: false,
        identityMethod: null,
        identityCandidates: [],
      },
      llm: {
        isProspect: false,
        mentionType: 'noise',
        prospectAction: 'ignore',
        prospectCompanyName: null,
        direction: 'inbound',
        sectorKey: 'healthcare',
        sectorConfidence: 0.8,
        confidence: 0.9,
        reasoning: 'Endiatx is the parent/inventor company; PillBot is the product being pitched.',
        model: 'claude-haiku-4-5-20251001',
      },
      prospectAction: 'create_prospect',
      shouldCreateProspect: true,
      finalProspectCompanyName: 'Endiatx',
      effectiveConfidence: 0.9,
      confidenceTier: 'high',
      provisional: false,
      directionUncertain: false,
      hasCreateEvidence: true,
      targetEvidenceReasons: ['product_pitch_parent_company'],
      createProspectVetoReason: null,
      valuableActionVetoReason: null,
      finalizationBlocked: false,
      finalizationBlockReasons: [],
      reasoningJudge: {
        reasoning_valid: true,
        action: 'allow_create',
        confidence: 0.9,
        reason: 'Source names the candidate as the parent/inventor company behind the product being pitched to Medina.',
        model: 'claude-haiku-4-5-20251001',
      },
      contextTargetRepairApplied: true,
      lowConfidenceVerification: {
        checked: false,
        eligible: false,
        verdict: 'not_applicable',
        action_override: null,
        reason: 'not_evaluated',
        scores: { identity: 0, intent: 0, source_quality: 0, d1_support: 0, extraction_risk: 0, total: 0 },
        identity_signals: [],
        intent_signals: [],
        source_quality_signals: [],
        d1_signals: [],
        extraction_flags: [],
      },
      crossD1RoleCheck: {
        checked: false,
        eligible: false,
        role: 'unknown',
        confidence: 'low',
        evidence: [],
        action_override: null,
        matched_company_id: null,
        matched_deal_id: null,
        reason: 'not_evaluated',
      },
    } as any);

    expect(packet).toMatchObject({
      required: true,
      lane: 'accepted_but_suspicious',
      recommended_action: 'keep_create_pending_recheck',
    });
    expect(packet.reasons).toContain('original_model_said_not_prospect');
    expect(packet.reasons).toContain('context_target_repair_promoted_create');
  });

  it('flags rejected rows for second look only when company-specific prospect evidence survived', () => {
    const { buildProspectSecondLookPacket } = __prospectIntelligenceTestHooks;
    const base = {
      item: {
        entityType: 'document',
        entityId: 'doc-pipeline',
        subject: 'Pipeline Status Update',
      },
      mention: {
        raw: 'Ccegrp',
        canonicalName: 'Ccegrp',
        normalizedName: 'ccegrp',
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'CCE LOW Radar AI Website ccegrp.com Description AI emissions reduction platform.',
        contextText: 'CCE LOW Radar AI Website ccegrp.com Description AI emissions reduction platform.',
        isListEntry: true,
        products: [],
        listFields: { website: 'ccegrp.com', stage: 'Seed', amount: '$2M', problem: 'emissions reduction' },
      },
      classifierInput: {
        sourceType: 'document',
        companyName: 'Ccegrp',
        senderAndContext: 'source: internal pipeline report',
        rawExcerpt: 'Pipeline Status Update. CCE LOW Radar AI Website ccegrp.com Stage Seed Amount $2M Description AI emissions reduction platform.',
        prefilterHints: {},
        sectorHints: { key: 'ai_data', confidence: 0.8 },
        knownContext: { knownDeals: [], knownDealmakers: [], companies: [] },
        orgId: 'org-1',
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityScore: 0,
        identityStrength: 'none',
        identityAmbiguous: false,
        identityMethod: null,
        identityCandidates: [],
      },
      llm: {
        isProspect: true,
        mentionType: 'inbound_prospect',
        prospectAction: 'create_prospect',
        prospectCompanyName: 'Ccegrp',
        direction: 'internal',
        sectorKey: 'ai_data',
        sectorConfidence: 0.8,
        confidence: 0.97,
        reasoning: 'CCE appears as pipeline row with company name, website, and product description; tracked in Medina internal pipeline.',
        model: 'claude-haiku-4-5-20251001',
      },
      prospectAction: 'record_context',
      shouldCreateProspect: false,
      finalProspectCompanyName: null,
      effectiveConfidence: 0.97,
      confidenceTier: 'high',
      provisional: false,
      directionUncertain: false,
      hasCreateEvidence: false,
      targetEvidenceReasons: ['fundraising_list_row'],
      createProspectVetoReason: 'collaboration_fundraising_activation_without_investment_target',
      valuableActionVetoReason: 'collaboration_fundraising_activation_without_investment_target',
      finalizationBlocked: false,
      finalizationBlockReasons: [],
      reasoningJudge: null,
      contextTargetRepairApplied: false,
      lowConfidenceVerification: {
        checked: false,
        eligible: false,
        verdict: 'not_applicable',
        action_override: null,
        reason: 'not_evaluated',
        scores: { identity: 0, intent: 0, source_quality: 0, d1_support: 0, extraction_risk: 0, total: 0 },
        identity_signals: [],
        intent_signals: [],
        source_quality_signals: [],
        d1_signals: [],
        extraction_flags: [],
      },
      crossD1RoleCheck: {
        checked: false,
        eligible: false,
        role: 'unknown',
        confidence: 'low',
        evidence: [],
        action_override: null,
        matched_company_id: null,
        matched_deal_id: null,
        reason: 'not_evaluated',
      },
    } as any;

    const promising = buildProspectSecondLookPacket(base);
    expect(promising).toMatchObject({
      required: true,
      lane: 'rejected_but_promising',
      recommended_action: 'rerun_original_pipeline',
    });
    expect(promising.evidence).toContain('fundraising_list_row');

    const wrongEntity = buildProspectSecondLookPacket({
      ...base,
      mention: {
        ...base.mention,
        raw: 'ABP Capital II, LLC',
        canonicalName: 'ABP Capital II, LLC',
        normalizedName: 'abpcapitalii',
        isListEntry: false,
        listFields: undefined,
      },
      llm: {
        ...base.llm,
        isProspect: false,
        prospectCompanyName: null,
        reasoning: 'ABP Capital II is the lender/financing source, not the investment prospect being presented to Medina.',
      },
      targetEvidenceReasons: ['current_company_investment_target_evidence'],
      createProspectVetoReason: 'reasoning_judge_block_create',
      valuableActionVetoReason: 'reasoning_judge_block_create',
      reasoningJudge: {
        reasoning_valid: false,
        action: 'block_create',
        confidence: 0.95,
        reason: 'ABP Capital II is the lender/financing source in this LOI, not the investment prospect.',
        model: 'claude-haiku-4-5-20251001',
      },
    } as any);

    expect(wrongEntity).toMatchObject({
      required: false,
      lane: null,
      recommended_action: 'none',
    });

    const participantNonTarget = buildProspectSecondLookPacket({
      ...base,
      mention: {
        ...base.mention,
        raw: 'Harbor 8 Capital',
        canonicalName: 'Harbor 8 Capital',
        normalizedName: 'harbor8capital',
        isListEntry: false,
        listFields: undefined,
      },
      llm: {
        ...base.llm,
        isProspect: false,
        prospectCompanyName: null,
        reasoning: 'Harbor 8 Capital is a meeting participant investor, not the company being pitched as an investment opportunity.',
      },
      targetEvidenceReasons: [],
      createProspectVetoReason: 'classifier_reasoning_explicitly_rejects_prospect',
      valuableActionVetoReason: 'classifier_reasoning_explicitly_rejects_prospect',
      reasoningJudge: null,
    } as any);

    expect(participantNonTarget).toMatchObject({
      required: false,
      lane: null,
      recommended_action: 'none',
    });

    const productAlias = buildProspectSecondLookPacket({
      ...base,
      mention: {
        ...base.mention,
        raw: 'CapsuleOne',
        canonicalName: 'CapsuleOne',
        normalizedName: 'capsuleone',
        isListEntry: false,
        listFields: undefined,
      },
      classifierInput: {
        ...base.classifierInput,
        companyName: 'CapsuleOne',
        rawExcerpt: 'I am a major investor and board member of HelioBio Systems. They invented CapsuleOne, a device platform for remote diagnostics. Watch their 4 min demo.',
      },
      llm: {
        ...base.llm,
        isProspect: true,
        prospectCompanyName: 'CapsuleOne',
        reasoning: 'CapsuleOne is introduced by a known dealmaker to Medina partners with demo reference, signaling investment opportunity.',
      },
      targetEvidenceReasons: [
        'current_company_investment_target_evidence',
        'product_pitch_parent_company',
        'warm_intro_target',
        'meeting_or_diligence_target',
        'classifier_reasoning_affirms_target_investment',
      ],
      createProspectVetoReason: 'nearby_company_hallucination_or_non_target_role',
      valuableActionVetoReason: 'nearby_company_hallucination_or_non_target_role',
      reasoningJudge: null,
    } as any);

    expect(productAlias).toMatchObject({
      required: true,
      lane: 'rejected_but_promising',
      recommended_action: 'rerun_original_pipeline',
    });
    expect(productAlias.reasons).toContain('discarded_row_has_company_specific_prospect_signal');

    const weakProductAlias = buildProspectSecondLookPacket({
      ...base,
      mention: {
        ...base.mention,
        raw: 'CapsuleOne',
        canonicalName: 'CapsuleOne',
        normalizedName: 'capsuleone',
        isListEntry: false,
        listFields: undefined,
      },
      classifierInput: {
        ...base.classifierInput,
        companyName: 'CapsuleOne',
        rawExcerpt: 'CapsuleOne appears as a generic product demo reference in a status note.',
      },
      llm: {
        ...base.llm,
        isProspect: false,
        prospectCompanyName: null,
        reasoning: 'CapsuleOne is only mentioned as a product demo reference, not as a company being put forward for investment.',
      },
      targetEvidenceReasons: [],
      createProspectVetoReason: 'nearby_company_hallucination_or_non_target_role',
      valuableActionVetoReason: 'nearby_company_hallucination_or_non_target_role',
      reasoningJudge: null,
    } as any);

    expect(weakProductAlias).toMatchObject({
      required: false,
      lane: null,
      recommended_action: 'none',
    });

    const acronymOpportunity = buildProspectSecondLookPacket({
      ...base,
      mention: {
        ...base.mention,
        raw: 'QRC',
        canonicalName: 'QRC',
        normalizedName: 'qrc',
        isListEntry: false,
        listFields: undefined,
      },
      classifierInput: {
        ...base.classifierInput,
        companyName: 'QRC',
        rawExcerpt: 'QRC acquisition opportunity full package was forwarded to Medina for diligence review.',
      },
      llm: {
        ...base.llm,
        isProspect: false,
        prospectCompanyName: null,
        reasoning: 'QRC acquisition opportunity full package was shared with Medina for diligence review.',
      },
      targetEvidenceReasons: [],
      createProspectVetoReason: 'thin_acronym_intro_or_scheduling_without_investment_intent',
      valuableActionVetoReason: 'thin_acronym_intro_or_scheduling_without_investment_intent',
      reasoningJudge: null,
    } as any);

    expect(acronymOpportunity).toMatchObject({
      required: true,
      lane: 'rejected_but_promising',
      recommended_action: 'rerun_original_pipeline',
    });
    expect(acronymOpportunity.evidence).toContain('reasoning_directly_supports_rejected_opportunity');

    const schedulingAcronym = buildProspectSecondLookPacket({
      ...base,
      mention: {
        ...base.mention,
        raw: 'QRC',
        canonicalName: 'QRC',
        normalizedName: 'qrc',
        isListEntry: false,
        listFields: undefined,
      },
      classifierInput: {
        ...base.classifierInput,
        companyName: 'QRC',
        rawExcerpt: 'QRC appears in a scheduling-only calendar note.',
      },
      llm: {
        ...base.llm,
        isProspect: false,
        prospectCompanyName: null,
        reasoning: 'QRC is only mentioned in a scheduling note with no investment evidence.',
      },
      targetEvidenceReasons: [],
      createProspectVetoReason: 'thin_acronym_intro_or_scheduling_without_investment_intent',
      valuableActionVetoReason: 'thin_acronym_intro_or_scheduling_without_investment_intent',
      reasoningJudge: null,
    } as any);

    expect(schedulingAcronym).toMatchObject({
      required: false,
      lane: null,
      recommended_action: 'none',
    });
  });

  it('blocks accepted second-look creates unless candidate-specific target proof is present', () => {
    const { acceptedSecondLookCreateBlockReason } = __prospectIntelligenceTestHooks;
    const secondLook: any = {
      required: true,
      lane: 'accepted_but_suspicious',
      recommended_action: 'keep_create_pending_recheck',
      reasons: ['accepted_reasoning_contains_non_prospect_language'],
      evidence: [],
      warnings: ['reasoning_contradiction'],
      packet: {},
    };
    const promotedSecondLook: any = {
      ...secondLook,
      reasons: ['original_model_said_not_prospect', 'promoted_from_non_create_action', 'allowed_after_reasoning_judge_exception'],
      warnings: ['model_pipeline_disagreement', 'original_action_ignore', 'judge_exception_allowed_create'],
    };

    expect(acceptedSecondLookCreateBlockReason({
      secondLook,
      mention: { canonicalName: 'Bridgepoint Advisors' } as any,
      llm: {
        reasoning: 'Bridgepoint Advisors is the advisor introducing Nova Grid, not the investment target or prospect.',
      } as any,
      reasoningJudge: null,
    })).toBe('accepted_second_look_non_target_reasoning');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook,
      mention: { canonicalName: 'Tierstone AI' } as any,
      llm: {
        reasoning: 'Tierstone AI is an existing portfolio company with ongoing operational updates, not a new investment prospect.',
      } as any,
      reasoningJudge: null,
    })).toBe('accepted_second_look_existing_context_only');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...secondLook,
        evidence: ['final_create_evidence'],
        packet: {
          target_evidence_reasons: ['fundraising_list_row'],
          source_title: 'Synthetic SBIR Companies Fund Raising.pdf',
          excerpt: 'Foundry Atlas | Seed | $4M ask | founder contact | website foundryatlas.ai | autonomous infrastructure planning platform.',
          original_reasoning: 'Foundry Atlas is listed as a company row with Seed stage, $4M ask, founder contact, and website.',
        },
      } as any,
      mention: { canonicalName: 'Foundry Atlas' } as any,
      llm: {
        reasoning: 'Vector Partners is an investor/advisor entity, not the investment prospect itself.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.94,
        reason: 'Foundry Atlas is a named row entry in a private pipeline status update with concrete company details and fundraising-list evidence.',
      } as any,
    })).toBeNull();

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...promotedSecondLook,
        evidence: ['final_create_evidence'],
        packet: {
          target_evidence_reasons: ['fundraising_list_row'],
          source_title: 'Pipeline Status Update',
          excerpt: 'Beacon.tech LOW Radar AI Unknown Los Angeles beacon.tech AI no-code platform for healthcare teams with seed pipeline status.',
          original_reasoning: 'Beacon.tech is a company row in a private pipeline report with website, product description, and seed pipeline signal.',
        },
      } as any,
      mention: { canonicalName: 'Beacon.tech' } as any,
      llm: {
        reasoning: 'Beacon.tech is the company row, not a text fragment.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.94,
        reason: 'Beacon.tech is a named row entry with concrete company details and pipeline evidence.',
      } as any,
    })).toBeNull();

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...promotedSecondLook,
        packet: {
          source_title: 'Synthetic VC List.xlsx',
          excerpt: 'Northstar Capital | VC firm | partner contact | investor notes for outreach.',
          original_reasoning: 'Northstar Capital is a VC firm listed in an investor directory, not the target company.',
          target_evidence_reasons: ['fundraising_list_row'],
        },
      } as any,
      mention: { canonicalName: 'Northstar Capital' } as any,
      llm: {
        reasoning: 'Northstar Capital is a VC firm listed in an investor directory, not the target company.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.86,
        reason: 'Structured list-row evidence names the candidate with fundraising details; neighboring rows in the excerpt should not block the row.',
      } as any,
    })).toBe('accepted_second_look_investor_or_fund_directory_context');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...promotedSecondLook,
        packet: {
          source_title: 'Founder Resume.pdf',
          excerpt: 'Prior experience: Heritage Brewery, regional manager.',
          original_reasoning: 'Heritage Brewery is a past employer on a resume, not an investment prospect.',
          target_evidence_reasons: [],
        },
      } as any,
      mention: { canonicalName: 'Heritage Brewery' } as any,
      llm: {
        reasoning: 'Heritage Brewery is a past employer on a resume, not an investment prospect.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.86,
        reason: 'Structured list-row evidence names the candidate with fundraising details; neighboring rows in the excerpt should not block the row.',
      } as any,
    })).toBe('accepted_second_look_resume_or_personal_background_context');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...promotedSecondLook,
        packet: {
          source_title: 'Atlas AI Executive Summary.pdf',
          excerpt: 'Go-to-market Atlas AI: enterprise sales plan, pricing, and partner channels.',
          original_reasoning: 'Atlas AI is the actual company; Go-to-market Atlas AI is a section heading.',
          target_evidence_reasons: ['pitch_or_investment_document_target'],
        },
      } as any,
      mention: { canonicalName: 'Go-to-market Atlas AI' } as any,
      llm: {
        reasoning: 'Atlas AI is the actual company; Go-to-market Atlas AI is a section heading.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.86,
        reason: 'Private financing document names the candidate as the central company being financed or reviewed.',
      } as any,
    })).toBe('accepted_second_look_bad_identity_document_heading');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: promotedSecondLook,
      mention: { canonicalName: 'our initial investment. We expect' } as any,
      llm: {
        reasoning: 'This is a fragment from a co-investment email body, not a company candidate.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.86,
        reason: 'Direct investor-forwarded round evidence names the candidate and includes concrete financing terms.',
      } as any,
    })).toBe('accepted_second_look_bad_identity_text_fragment');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: promotedSecondLook,
      mention: { canonicalName: 'Bridgeview Partners' } as any,
      llm: {
        reasoning: 'Bridgeview Partners appears near a financing discussion, but no row-level company proof is present.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.86,
        reason: 'Direct investor-forwarded round evidence names the candidate and includes concrete financing terms.',
      } as any,
    })).toBe('accepted_second_look_generic_judge_without_target_proof');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...promotedSecondLook,
        packet: {
          source_title: 'TargetCo intro call',
          excerpt: 'Bridgeview Advisors introduced TargetCo to Medina and helped route diligence materials.',
          original_reasoning: 'Bridgeview Advisors is the intro source and advisor beside TargetCo, not the company being pitched.',
          target_evidence_reasons: [],
        },
      } as any,
      mention: { canonicalName: 'Bridgeview Advisors' } as any,
      llm: {
        reasoning: 'Bridgeview Advisors is the intro source and advisor beside TargetCo, not the company being pitched.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.86,
        reason: 'Direct investor-forwarded round evidence names the candidate and includes concrete financing terms.',
      } as any,
    })).toBe('accepted_second_look_non_target_reasoning');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...promotedSecondLook,
        packet: {
          source_title: 'MegaAI bests competitor in valuation race with Series H',
          excerpt: 'Public news article about MegaAI valuation, not a private Medina investment opportunity.',
          original_reasoning: 'MegaAI is public news context, not a private opportunity being put in front of Medina.',
          target_evidence_reasons: [],
        },
      } as any,
      mention: { canonicalName: 'MegaAI' } as any,
      llm: {
        reasoning: 'MegaAI is public news context, not a private opportunity being put in front of Medina.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.86,
        reason: 'Direct investor-forwarded round evidence names the candidate and includes concrete financing terms.',
      } as any,
    })).toBe('accepted_second_look_public_news_or_digest_context');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...secondLook,
        evidence: ['final_create_evidence'],
        packet: {
          target_evidence_reasons: ['fundraising_list_row'],
        },
      } as any,
      mention: { canonicalName: 'Orion Capital' } as any,
      llm: {
        reasoning: 'Orion Capital is a meeting participant investor, not the investment target.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.82,
        reason: 'Direct investor-forwarded round evidence names the candidate and includes concrete financing terms.',
      } as any,
    })).toBe('accepted_second_look_non_target_reasoning');

    expect(acceptedSecondLookCreateBlockReason({
      secondLook: {
        ...secondLook,
        evidence: ['final_create_evidence'],
        packet: {
          target_evidence_reasons: ['subject_line_target_opportunity'],
          source_title: 'QubitMesh Series A Co-Investment Opportunity',
          excerpt: 'QubitMesh Series A co-investment opportunity with fresh round terms, valuation, and data room shared with Medina.',
          original_reasoning: 'QubitMesh is an existing company, but this source is a new co-investment opportunity with fresh round terms.',
        },
      } as any,
      mention: { canonicalName: 'QubitMesh' } as any,
      llm: {
        reasoning: 'QubitMesh is an existing company, but this source is a new co-investment opportunity with fresh round terms.',
      } as any,
      reasoningJudge: {
        action: 'allow_create',
        reasoning_valid: true,
        confidence: 0.91,
        reason: 'QubitMesh is the candidate itself and the source describes a new investment opportunity with round terms.',
      } as any,
    })).toBeNull();

    expect(acceptedSecondLookCreateBlockReason({
      secondLook,
      mention: { canonicalName: 'Nova Grid' } as any,
      llm: {
        reasoning: 'Nova Grid is raising a seed round, shared a deck with Medina, and is the investment target.',
      } as any,
      reasoningJudge: null,
    })).toBeNull();
  });

  it('treats a pitched product as parent-company evidence only when the parent is named in-source', () => {
    const { hasClassifierContradictoryTargetIntent } = __prospectIntelligenceTestHooks;
    const mention: any = {
      raw: 'Endiatx',
      canonicalName: 'Endiatx',
      normalizedName: 'endiatx',
      mentionOrdinal: 1,
      spanStart: 112,
      spanEnd: 119,
      lineText: 'I am a major investor and board member of Endiatx. They invented PillBot, a micro-robot that is disrupting health.',
      contextText: 'I am a major investor and board member of Endiatx. They invented PillBot, a micro-robot that is disrupting health.',
      isListEntry: false,
      products: [],
    };
    const classifierInput: any = {
      sourceType: 'conversation',
      companyName: 'Endiatx',
      senderAndContext: 'subject: PillBot Micro-Robotics | to: Tony, Raul, Manny',
      rawExcerpt: 'I am a major investor and board member of Endiatx. They invented PillBot, a micro-robot that is disrupting health. Watch their 4 min TED live demo.',
      prefilterHints: {},
      sectorHints: { key: 'healthcare', confidence: 0.8 },
      knownContext: { knownDeals: [], knownDealmakers: [], companies: [] },
      orgId: 'org-1',
    };

    expect(hasClassifierContradictoryTargetIntent({
      isProspect: false,
      mentionType: 'noise',
      prospectAction: 'ignore',
      prospectCompanyName: null,
      direction: 'inbound',
      sectorKey: 'healthcare',
      sectorConfidence: 0.8,
      confidence: 0.96,
      reasoning: 'Endiatx is the parent/inventor company; the sender is a board member and investor in Endiatx, making the sender a context entity, not the prospect target. PillBot is the product being pitched.',
      model: 'claude-haiku-4-5-20251001',
    } as any, classifierInput, mention)).toBe(true);
  });

  it('repairs generic wrapper names to the actual target company when evidence is unambiguous', () => {
    const { correctedProspectCompanyNameFromEvidence } = __prospectIntelligenceTestHooks;
    const baseInput = {
      sourceType: 'document',
      companyName: 'Mobile',
      senderAndContext: 'document: Primio_Investor_Deck_v1_2026-04-20.pdf',
      rawExcerpt: 'Investor deck for Primio, an AI-first mobile platform with traction and product roadmap.',
      prefilterHints: {},
      sectorHints: { key: 'ai_data', confidence: 0.7 },
      knownContext: { knownDeals: [], knownDealmakers: [], companies: [] },
      orgId: 'medina-ventures',
    } as any;

    expect(correctedProspectCompanyNameFromEvidence(
      'Mobile',
      null,
      baseInput,
      'Investor deck for Primio, an AI-first mobile platform with traction.'
    )).toBe('Primio');

    expect(correctedProspectCompanyNameFromEvidence(
      '1200vc: Co Investment Opportunity | Vital Lyfe',
      null,
      {
        ...baseInput,
        companyName: '1200vc: Co Investment Opportunity | Vital Lyfe',
        senderAndContext: 'subject: 1200vc: Co-Investment Opportunity | Vital-Lyfe',
        rawExcerpt: '1200vc is the source. Target company is Vital-Lyfe, not the sender.',
      },
      'Target company is Vital-Lyfe, not the sender.'
    )).toBe('Vital-Lyfe');

    expect(correctedProspectCompanyNameFromEvidence(
      'energy infrastructure company',
      null,
      {
        ...baseInput,
        companyName: 'energy infrastructure company',
        senderAndContext: 'document: Resolute Grid - Q1 2026- SEED.pdf',
        rawExcerpt: 'Resolute Grid is a seed-stage energy infrastructure company being reviewed from the deck.',
      },
      'The energy infrastructure company is being pitched from the Resolute Grid seed deck.'
    )).toBe('Resolute Grid');
  });

  it('cleans learned aliases, date prefixes, and URL mentions into canonical prospect names', () => {
    const { canonicalizeMention } = __prospectIntelligenceTestHooks;

    expect(canonicalizeMention('BTW').canonicalName).toBe('Breaktheweb');
    expect(canonicalizeMention('2025 Cipher Tech Solutions').canonicalName).toBe('Cipher Tech Solutions');
    expect(canonicalizeMention('<http://servescale.ai|servescale.ai>').canonicalName).toBe('Servescale');
    expect(canonicalizeMention('IndustrialMind.ai').canonicalName).toBe('IndustrialMind');
  });

  it('keeps mocked classifier flow on valid taxonomy boundaries for common hard cases', async () => {
    resetClaudeMock();
    const outputs = [
      { is_prospect: false, prospect_company_name: null, direction: 'outbound', sector_key: 'uncategorized', sector_confidence: 0.2, confidence: 0.9, reasoning: 'Mastercard is the customer context, not the investment target.' },
      { is_prospect: false, prospect_company_name: null, direction: 'news', sector_key: 'uncategorized', sector_confidence: 0.2, confidence: 0.88, reasoning: 'Quantonation is named in public news, not pitched to Medina.' },
      { is_prospect: false, prospect_company_name: null, direction: 'outbound', sector_key: 'uncategorized', sector_confidence: 0.2, confidence: 0.95, reasoning: 'Qunnect is existing portfolio context, not newly pitched.' },
      { is_prospect: false, prospect_company_name: null, direction: 'inbound', sector_key: 'uncategorized', sector_confidence: 0.2, confidence: 0.9, reasoning: 'DIU is the forwarding channel, not the investment target.' },
    ];
    callClaudeWithUsageMock.mockImplementation(async () => ({
      text: JSON.stringify(outputs.shift()),
      usage: { input_tokens: 80, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    }));

    const baseInput = {
      sourceType: 'email',
      senderAndContext: 'from partner@example.com',
      prefilterHints: { should_classify: true, reasons: [], deterministic_direction: 'unknown' },
      sectorHints: { key: 'uncategorized', confidence: 0.2 },
      knownContext: { knownDeals: [{ name: 'Qunnect', domain: 'qunnect.io' }], knownDealmakers: [{ name: 'DIU', domain: 'diu.mil' }] },
      orgId: 'org-1',
    } as any;

    const customer = await callProspectClassifier({ ...baseInput, companyName: 'Mastercard', rawExcerpt: 'Qunnect is being pitched to Mastercard as a customer.' }, {} as any);
    const investorNews = await callProspectClassifier({ ...baseInput, companyName: 'Quantonation', rawExcerpt: 'Quantonation was named as an investor in a reported round.' }, {} as any);
    const knownDeal = await callProspectClassifier({ ...baseInput, companyName: 'Qunnect', rawExcerpt: 'Portfolio company Qunnect is being pitched outbound.' }, {} as any);
    const introSource = await callProspectClassifier({ ...baseInput, companyName: 'DIU', rawExcerpt: 'DIU is forwarding ArmyFUZE deal flow to the fund.' }, {} as any);

    expect(customer).toMatchObject({ mentionType: 'noise', prospectAction: 'ignore', direction: 'outbound' });
    expect(investorNews).toMatchObject({ mentionType: 'noise', prospectAction: 'ignore', direction: 'news' });
    expect(knownDeal).toMatchObject({ mentionType: 'noise', prospectAction: 'ignore', direction: 'outbound' });
    expect(introSource).toMatchObject({ mentionType: 'noise', prospectAction: 'ignore', direction: 'inbound' });
    expect(callClaudeWithUsageMock.mock.calls.every(([request]) => request.assistantPrefill === '{')).toBe(true);
    expect(callClaudeWithUsageMock.mock.calls.every(([request]) => request.dryRunNoBudgetWrites !== true)).toBe(true);
  });

  it('builds broad mention-centered context without changing deterministic ordinals', () => {
    const text = [
      'DIU sent this as an introduction channel after ArmyFUZE demo day.',
      'Auguria is raising a seed round for its security data platform.',
      'The follow-up asks Medina to review the deck and schedule diligence with the founder.',
    ].join('\n');

    const [mention] = extractMentionCandidatesFromText(text);

    expect(mention.canonicalName).toBe('Auguria');
    expect(mention.mentionOrdinal).toBe(1);
    expect(mention.lineText).toContain('Auguria is raising');
    expect(mention.contextText).toContain('DIU sent this as an introduction channel');
    expect(mention.contextText).toContain('schedule diligence with the founder');
    expect(mention.contextText.length).toBeGreaterThan(mention.lineText.length);
  });

  it('feeds the classifier nearby pre/post source context instead of only the mention line', () => {
    const { buildClassifierPrefilter, classifierInputForRuntime } = __prospectIntelligenceTestHooks;
    const filler = Array.from({ length: 70 }, (_, index) => `Archive note ${index}: routine portfolio update with no new deal signal.`).join('\n');
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      subject: 'Forwarded ArmyFUZE follow-up',
      bodyText: [
        filler,
        'DIU sent this as an introduction channel after ArmyFUZE demo day.',
        'Auguria is raising a seed round for its security data platform.',
        'The follow-up asks Medina to review the deck and schedule diligence with the founder.',
      ].join('\n'),
      bodyPreview: 'Archive note 0',
      fromEmail: 'partner@diu.mil',
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = buildClassifierPrefilter(item, mention, existing, {} as any);
    const input = classifierInputForRuntime(item, mention, existing, prefilter, {
      knownDeals: [],
      knownDealmakers: [{ name: 'DIU', domain: 'diu.mil' }],
    }, 'org-1');

    expect(input.rawExcerpt).toContain('Mention context:');
    expect(input.rawExcerpt).toContain('DIU sent this as an introduction channel');
    expect(input.rawExcerpt).toContain('schedule diligence with the founder');
  });

  it('parses the prospect-verdict LLM JSON contract and legacy action payloads safely', () => {
    const {
      parseProspectClassifierResponse,
      parseProspectSourceClassifierResponse,
      parseProspectFinalQualityGateResponse,
      parseMentionType,
      parseDirection,
      parseSectorKey,
      parseProspectAction,
    } = __prospectIntelligenceTestHooks;

    const parsed = parseProspectClassifierResponse(
      '{"is_prospect":true,"prospect_company_name":"Auguria","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Auguria sent a deck for Medina review."}',
      'claude-haiku-4-5-20251001'
    );

    expect(parsed.isProspect).toBe(true);
    expect(parsed.mentionType).toBe('inbound_prospect');
    expect(parsed.prospectAction).toBe('create_prospect');
    expect(parsed.prospectCompanyName).toBe('Auguria');
    expect(parsed.direction).toBe('inbound');
    expect(parsed.sectorKey).toBe('cybersecurity');
    expect(parseMentionType('news')).toBe('news');
    expect(parseProspectAction('record_context', 'noise')).toBe('record_context');
    expect(parseProspectAction('', 'intro_source')).toBe('record_context');
    expect(parseDirection('news')).toBe('news');
    expect(parseSectorKey('aerospace defense')).toBe('aerospace_defense');
    expect(() => parseMentionType('news_only')).toThrow(/INVALID_LLM_MENTION_TYPE/);
    expect(() => parseDirection('unknown')).toThrow(/INVALID_LLM_DIRECTION/);
    expect(() => parseProspectAction('needs_review', 'noise')).toThrow(/INVALID_LLM_PROSPECT_ACTION/);

    const fenced = parseProspectClassifierResponse(
      '```json\n{"is_prospect":false,"prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.8,"reasoning":"Admin email, not an investment pitch."}\n```',
      'claude-haiku-4-5-20251001'
    );
    expect(fenced.isProspect).toBe(false);
    expect(fenced.mentionType).toBe('noise');
    expect(fenced.prospectAction).toBe('ignore');
    expect(fenced.direction).toBe('internal');

    const sourceDecisions = parseProspectSourceClassifierResponse(
      '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"TargetCo","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.92,"reasoning":"TargetCo is introduced with a seed deck."},{"mention_ordinal":2,"is_prospect":false,"prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"AdvisorCo is the advisor, not the target."}]}',
      'claude-haiku-4-5-20251001'
    );
    expect(sourceDecisions.get(1)).toMatchObject({
      isProspect: true,
      prospectAction: 'create_prospect',
      prospectCompanyName: 'TargetCo',
    });
    expect(sourceDecisions.get(2)).toMatchObject({
      isProspect: false,
      prospectAction: 'ignore',
      prospectCompanyName: null,
    });
    const partialSourceDecisions = parseProspectSourceClassifierResponse(
      '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"TargetCo","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.92,"reasoning":"TargetCo is introduced with a seed deck."},{"mention_ordinal":2,"is_prospect":true,"prospect_company_name":"BadCo","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":1.4,"reasoning":"Malformed confidence should be retried, not crash the whole source."}]}',
      'claude-haiku-4-5-20251001'
    );
    expect(partialSourceDecisions.has(1)).toBe(true);
    expect(partialSourceDecisions.has(2)).toBe(false);
    expect(() => parseProspectSourceClassifierResponse(
      '{"decisions":[{"is_prospect":true,"prospect_company_name":"TargetCo","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.92,"reasoning":"Missing ordinal."}]}',
      'claude-haiku-4-5-20251001'
    )).toThrow(/INVALID_PROSPECT_SOURCE_CLASSIFIER_ORDINAL/);
    expect(() => parseProspectClassifierResponse(
      '{"is_prospect":"yes","prospect_company_name":"TargetCo","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.92,"reasoning":"Bad boolean."}',
      'claude-haiku-4-5-20251001'
    )).toThrow(/INVALID_LLM_IS_PROSPECT/);
    expect(() => parseProspectClassifierResponse(
      '{"is_prospect":true,"prospect_company_name":"TargetCo","direction":"unknown","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.92,"reasoning":"Bad direction."}',
      'claude-haiku-4-5-20251001'
    )).toThrow(/INVALID_LLM_DIRECTION/);
    expect(() => parseProspectClassifierResponse(
      '{"is_prospect":true,"prospect_company_name":"TargetCo","direction":"inbound","sector_key":"definitely_not_allowed","sector_confidence":0.8,"confidence":0.92,"reasoning":"Bad sector."}',
      'claude-haiku-4-5-20251001'
    )).toThrow(/INVALID_LLM_SECTOR_KEY/);
    expect(() => parseProspectClassifierResponse(
      '{"is_prospect":true,"prospect_company_name":"TargetCo","direction":"inbound","sector_key":"ai_data","sector_confidence":1.4,"confidence":0.92,"reasoning":"Bad confidence."}',
      'claude-haiku-4-5-20251001'
    )).toThrow(/INVALID_LLM_SECTOR_CONFIDENCE/);

    const legacyWrapped = parseProspectClassifierResponse(
      'Here is the JSON:\n{"prospect_action":"attach_existing_deal","prospect_company_name":null,"direction":"outbound","sector_key":"quantum","sector_confidence":0.7,"confidence":0.88,"reasoning":"Existing deal."}\nDone.',
      'claude-haiku-4-5-20251001'
    );
    expect(legacyWrapped.isProspect).toBe(false);
    expect(legacyWrapped.mentionType).toBe('noise');
    expect(legacyWrapped.prospectAction).toBe('record_context');
    expect(legacyWrapped.direction).toBe('outbound');

    const finalQuality = parseProspectFinalQualityGateResponse(
      '{"decisions":[{"record_ordinal":1,"decision":"rename_and_allow","canonical_name":"TargetCo","merge_target_ordinal":null,"merge_target_prospect_id":null,"reason":"Clean company name."}]}',
      'claude-haiku-4-5-20251001'
    );
    expect(finalQuality[0]).toMatchObject({
      record_ordinal: 1,
      decision: 'rename_and_allow',
      canonical_name: 'TargetCo',
    });
    expect(() => parseProspectFinalQualityGateResponse(
      '{"decisions":[{"record_ordinal":1,"decision":"needs_review","canonical_name":null,"merge_target_ordinal":null,"merge_target_prospect_id":null,"reason":"Fuzzy state."}]}',
      'claude-haiku-4-5-20251001'
    )).toThrow(/INVALID_FINAL_QUALITY_GATE_ACTION/);
  });

  it('passes promotion and target evidence into the lightweight reasoning judge prompt', () => {
    const { buildProspectReasoningJudgePrompt } = __prospectIntelligenceTestHooks;
    const prompt = buildProspectReasoningJudgePrompt({
      item: {
        type: 'document',
        source: 'outlook',
        entityType: 'document',
        entityId: 'doc-promoted',
        subject: 'Sovereign AI seed round',
        bodyText: 'Sovereign AI is raising a seed round. Deck attached for Medina review.',
      } as any,
      mention: {
        raw: 'Sovereign AI',
        canonicalName: 'Sovereign AI',
        normalizedName: 'sovereignai',
        mentionOrdinal: 1,
        spanStart: 0,
        spanEnd: 12,
        lineText: 'Company Name Sovereign AI Website sovereign.ai Round Stage Seed Amount $3M.',
        contextText: 'Company Name Sovereign AI Website sovereign.ai Round Stage Seed Amount $3M. Investor deck attached.',
        isListEntry: true,
        listFields: {
          website: 'sovereign.ai',
          stage: 'Seed',
          amount: '$3M',
        },
        products: [],
      },
      classifierInput: {
        sourceType: 'document',
        senderAndContext: 'Source: document',
        companyName: 'Sovereign AI',
        rawExcerpt: 'Company Name Sovereign AI Website sovereign.ai Round Stage Seed Amount $3M. Sovereign AI is raising a seed round. Investor deck attached for Medina review.',
        prefilterHints: { has_deck: true, signal_kind_hint: 'deck', mention: { parse_dealflow_list: true } },
        sectorHints: { key: 'ai_data', confidence: 0.8 },
        knownContext: { knownDeals: [], knownDealmakers: [] },
        orgId: 'org-1',
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityScore: 0,
        identityStrength: 'none',
        identityAmbiguous: false,
        identityMethod: null,
      },
      llm: {
        isProspect: false,
        mentionType: 'noise',
        direction: 'inbound',
        sectorKey: 'ai_data',
        sectorConfidence: 0.8,
        confidence: 0.91,
        prospectAction: 'ignore',
        prospectCompanyName: null,
        reasoning: 'Sovereign AI is raising a seed round and has a deck attached for Medina review.',
        model: 'claude-haiku-4-5-20251001',
      },
      hasCreateEvidence: true,
      confidenceTier: 'high',
      finalProspectCompanyName: 'Sovereign AI',
      promotedToCreate: true,
      targetEvidenceReasons: ['classifier_reasoning_affirms_target_investment', 'pitch_or_investment_document_target'],
    });

    const systemText = (prompt.system as any[]).map(block => String(block.text || '')).join('\n');
    const payload = JSON.parse(prompt.user);
    expect(systemText).toContain('Do not block merely because original_verdict.is_prospect is false');
    expect(systemText).toContain('judge the candidate row independently');
    expect(systemText).toContain('private investment, financing, acquisition');
    expect(payload.pipeline_decision).toMatchObject({
      intended_action: 'create_prospect',
      promoted_from_action: 'ignore',
      promoted_to_create: true,
      target_evidence_reasons: ['classifier_reasoning_affirms_target_investment', 'pitch_or_investment_document_target'],
    });
    expect(payload.original_verdict).toMatchObject({
      is_prospect: false,
      reasoning: 'Sovereign AI is raising a seed round and has a deck attached for Medina review.',
    });
    expect(payload.candidate_row_evidence).toMatchObject({
      is_list_entry: true,
      parse_dealflow_list: true,
      website: 'sovereign.ai',
      stage: 'Seed',
      amount: '$3M',
    });
    expect(payload.source_evidence_context).toMatchObject({
      source_is_pipeline_evidence: true,
      central_candidate_named: true,
      has_private_investment_or_financing_document_language: true,
    });
  });

  it('recovers clipped reasoning judge JSON when all required fields are present', () => {
    const { parseProspectReasoningJudgeResponse } = __prospectIntelligenceTestHooks;
    const parsed = parseProspectReasoningJudgeResponse(
      '{"reasoning_valid":true,"action":"allow_create","confidence":0.93,"reason":"Reasoning cites target-specific fundraise evidence present in the source.',
      'claude-haiku-4-5-20251001'
    );

    expect(parsed).toMatchObject({
      reasoning_valid: true,
      action: 'allow_create',
      confidence: 0.93,
      reason: 'Reasoning cites target-specific fundraise evidence present in the source.',
    });
  });

  it('ranks meeting/deck/warm-intro signals above single cold or list mentions', () => {
    const strong = computeSignalStrength({
      signalCount: 3,
      hasMeeting: true,
      hasDeck: true,
      hasWarmIntro: true,
      hasOnlyListEntries: false,
      hasOnlyColdMentions: false,
    });
    const listOnly = computeSignalStrength({
      signalCount: 1,
      hasMeeting: false,
      hasDeck: false,
      hasWarmIntro: false,
      hasOnlyListEntries: true,
      hasOnlyColdMentions: false,
    });
    const coldOnly = computeSignalStrength({
      signalCount: 1,
      hasMeeting: false,
      hasDeck: false,
      hasWarmIntro: false,
      hasOnlyListEntries: false,
      hasOnlyColdMentions: true,
    });

    expect(strong.priority).toBe('eager');
    expect(strong.score).toBeGreaterThan(listOnly.score);
    expect(strong.score).toBeGreaterThan(coldOnly.score);
    expect(listOnly.priority).toBe('lazy');
    expect(coldOnly.priority).toBe('lazy');
  });

  it('extracts intro subjects as prospect mentions', () => {
    const [candidate] = extractMentionCandidatesFromText('Intro to Auguria\nWarm intro from Alicia.');
    expect(candidate.canonicalName).toBe('Auguria');
  });

  it('extracts ampersand Medina meeting titles as target company mentions', () => {
    const [candidate] = extractMentionCandidatesFromText('NeuralSeek & Medina Ventures\nScheduled Zoom details.');
    expect(candidate.canonicalName).toBe('NeuralSeek');
  });

  it('extracts likely target companies from high-signal subjects and about blocks', () => {
    const names = extractMentionCandidatesFromText([
      'Overkast update and demo video',
      'HI Tony, we now have a demo video to share.',
      'Platform turning energy rebates into instant revenue for contractors backed by Fifth Wall and Keyframe',
      '--- About Sealed Sealed helps contractors monetize rebates.',
      'Company Name artlabs Company URL https://artlabs.ai Founder(s) Ben Smith Short Description AI art tooling',
      'Re: Intro Bea (Suma Wealth) / Medina Ventures',
    ].join('\n')).map(candidate => candidate.canonicalName);

    expect(names).toEqual(expect.arrayContaining(['Overkast', 'Sealed', 'Artlabs', 'Suma Wealth']));
    expect(names).not.toContain('April. We');
  });

  it('extracts the target company from meeting transcript structure even when advisors and customers are nearby', () => {
    const item: any = {
      type: 'calendar_event',
      entityType: 'event',
      entityId: 'event-transcript-pitch',
      subject: 'Startup pitch discussion',
      bodyText: [
        'Tony: Thanks everyone for joining.',
        'Dr. Lee: I am the founder and CEO of Acme Robotics.',
        'Dr. Lee: Acme Robotics is raising a seed round and demoing autonomous inspection software for utilities.',
        'Advisor: Lockton joined to discuss insurance support and BofA made the introduction.',
        'Customer: Duke Energy is a pilot customer.',
      ].join('\n'),
    };
    const { cleanedText } = __prospectIntelligenceTestHooks.cleanProspectSourceText(`${item.subject}\n${item.bodyText}`);

    const names = __prospectIntelligenceTestHooks
      .extractStructuredTargetMentionsFromSource(item, cleanedText, { env: { INTERNAL_DOMAINS: 'medinavc.com' } as any })
      .map(mention => mention.canonicalName);

    expect(names).toContain('Acme Robotics');
    expect(names).not.toEqual(expect.arrayContaining(['Lockton', 'BofA', 'Duke Energy']));
  });

  it('finds a startup pitch in a generic meeting title from transcript body content', () => {
    const item: any = {
      type: 'calendar_event',
      entityType: 'event',
      entityId: 'event-generic-title',
      subject: 'Introductory Zoom',
      bodyText: [
        'Founder: We are from Kestrel Labs.',
        'Kestrel Labs has traction with two defense pilots and is seeking a SAFE round.',
        'Action items: send the deck, data room, and financial model after the call.',
      ].join('\n'),
    };
    const { cleanedText } = __prospectIntelligenceTestHooks.cleanProspectSourceText(`${item.subject}\n${item.bodyText}`);

    const names = __prospectIntelligenceTestHooks
      .extractStructuredTargetMentionsFromSource(item, cleanedText, { env: { INTERNAL_DOMAINS: 'medinavc.com' } as any })
      .map(mention => mention.canonicalName);

    expect(names).toContain('Kestrel Labs');
  });

  it('does not treat an internal customer or partner discussion transcript as a target-company extraction', () => {
    const item: any = {
      type: 'calendar_event',
      entityType: 'event',
      entityId: 'event-internal-partner',
      subject: 'Standing team meeting',
      bodyText: [
        'Tony and Adam reviewed internal follow-ups.',
        'Cisco is a possible customer intro for an existing portfolio company.',
        'No pitch, financing, diligence, deck, or company being presented to Medina.',
      ].join('\n'),
    };
    const { cleanedText } = __prospectIntelligenceTestHooks.cleanProspectSourceText(`${item.subject}\n${item.bodyText}`);

    const names = __prospectIntelligenceTestHooks
      .extractStructuredTargetMentionsFromSource(item, cleanedText, { env: { INTERNAL_DOMAINS: 'medinavc.com' } as any })
      .map(mention => mention.canonicalName);

    expect(names).not.toContain('Cisco');
  });

  it('extracts document target companies from title, company fields, and domain fields', () => {
    const item: any = {
      type: 'document',
      entityType: 'document',
      entityId: 'doc-deck',
      subject: 'Acme Robotics.pdf',
      bodyText: [
        'Company Name: Acme Robotics',
        'Website: https://acmerobotics.ai',
        'About Acme Robotics is building autonomous inspection software for utility teams.',
        'Qatalyst Partners prepared the index page.',
      ].join('\n'),
    };
    const { cleanedText } = __prospectIntelligenceTestHooks.cleanProspectSourceText(`${item.subject}\n${item.bodyText}`);

    const names = __prospectIntelligenceTestHooks
      .extractStructuredTargetMentionsFromSource(item, cleanedText, { env: { INTERNAL_DOMAINS: 'medinavc.com' } as any })
      .map(mention => mention.canonicalName);

    expect(names).toContain('Acme Robotics');
    expect(names).not.toContain('Company Name');
    expect(names).not.toContain('Qatalyst Partners');
  });

  it('runs source-level target recovery after context, known-deal, or multi-company create outcomes', () => {
    const transcriptItem: any = {
      type: 'calendar_event',
      entityType: 'event',
      entityId: 'event-recovery',
      subject: 'Founder demo and diligence call',
      bodyText: 'The founder shared a product demo, data room, and seed round plan.',
    };
    const multiCompanyDocument: any = {
      type: 'document',
      entityType: 'document',
      entityId: 'doc-recovery-list',
      subject: 'Army FUZE SBIR Companies Fund Raising.pdf',
      bodyText: [
        'ArmyFUZE cohort companies fund raising packet.',
        'Llume llume.io Series A $10 million',
        'Deltachase deltachase.ai Series A $10 million',
        'Fortilayer fortilayer.com Series A $10 million',
      ].join('\n'),
    };
    const recordContextOutcome: any = {
      mention: { canonicalName: 'Bank of America', normalizedName: 'bankofamerica' },
      cls: { prospectAction: 'record_context', mentionType: 'intro_source', shouldCreateProspect: false },
    };
    const knownDealOutcome: any = {
      mention: { canonicalName: 'KnownCo', normalizedName: 'knownco' },
      cls: { prospectAction: 'attach_existing_deal', mentionType: 'known_deal', shouldCreateProspect: false },
    };
    const createOutcome: any = {
      mention: { canonicalName: 'Acme Robotics', normalizedName: 'acmerobotics' },
      cls: { prospectAction: 'create_prospect', mentionType: 'inbound_prospect', shouldCreateProspect: true },
    };

    expect(__prospectIntelligenceTestHooks.hasSourceLevelTargetRecoveryIntent(transcriptItem)).toBe(true);
    expect(__prospectIntelligenceTestHooks.shouldRunSourceTargetRecovery(transcriptItem, [recordContextOutcome])).toBe(true);
    expect(__prospectIntelligenceTestHooks.shouldRunSourceTargetRecovery(transcriptItem, [knownDealOutcome])).toBe(true);
    expect(__prospectIntelligenceTestHooks.shouldRunSourceTargetRecovery(transcriptItem, [createOutcome])).toBe(false);
    expect(__prospectIntelligenceTestHooks.shouldRunSourceTargetRecovery(multiCompanyDocument, [createOutcome])).toBe(true);
    expect(__prospectIntelligenceTestHooks.shouldRunSourceTargetRecovery({
      type: 'email',
      entityType: 'conversation',
      entityId: 'email-no-recovery',
      subject: 'Founder demo and diligence call',
      bodyText: 'The founder shared a product demo, data room, and seed round plan.',
    } as any, [recordContextOutcome])).toBe(true);
  });

  it('treats observed short/expanded brand aliases as the same prospect identity', () => {
    const { canonicalizeMention, correctedProspectCompanyNameFromEvidence, prospectIdentityAliasesForName, scoreProspectRowDuplicate } = __prospectIntelligenceTestHooks;
    expect(Array.from(prospectIdentityAliasesForName('SubQ'))).toEqual(expect.arrayContaining(['subq', 'subquadratic']));
    expect(Array.from(prospectIdentityAliasesForName('Subquadratic'))).toEqual(expect.arrayContaining(['subq', 'subquadratic']));
    expect(Array.from(prospectIdentityAliasesForName('RVR'))).toEqual(expect.arrayContaining(['rvr', 'rivervalleyranch']));
    expect(Array.from(prospectIdentityAliasesForName('River Valley Ranch'))).toEqual(expect.arrayContaining(['rvr', 'rivervalleyranch']));
    expect(Array.from(prospectIdentityAliasesForName('Aleroder Quantum Technologies'))).toEqual(expect.arrayContaining(['aliro', 'aliroquantum', 'aleroderquantum']));
    expect(Array.from(prospectIdentityAliasesForName('Diapin Therapeutics'))).toEqual(expect.arrayContaining(['diapin', 'diapintherapeutics']));
    expect(canonicalizeMention('Aleroder Quantum Technologies').canonicalName).toBe('Aliro Quantum Technologies');
    expect(canonicalizeMention('RVR River Valley Ranch').canonicalName).toBe('River Valley Ranch');
    expect(canonicalizeMention('SubQ Subquadratic').canonicalName).toBe('Subquadratic');
    expect(correctedProspectCompanyNameFromEvidence(
      '500K',
      null,
      {
        senderAndContext: 'EnQuanta_Investor_Overview_v1_5_May_2026.pdf',
        rawExcerpt: 'Investor overview deck for EnQuanta, a post-quantum cryptography company raising Series A.',
      } as any,
      'Investor overview deck for EnQuanta, a post-quantum cryptography company raising Series A.'
    )).toBe('EnQuanta');

    const score = scoreProspectRowDuplicate(
      {
        id: 'prospect-subq',
        canonical_name: 'SubQ',
        normalized_name: 'subq',
        domain: 'subq.ai',
        website: 'https://subq.ai',
        status: 'active',
        signal_count: 3,
        evidence_count: 3,
        created_at: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'prospect-subquadratic',
        canonical_name: 'Subquadratic',
        normalized_name: 'subquadratic',
        domain: 'subquadratic.ai',
        website: 'https://subquadratic.ai',
        status: 'active',
        signal_count: 1,
        evidence_count: 1,
        created_at: '2026-05-02T00:00:00.000Z',
      }
    );
    expect(score).toMatchObject({ score: 0.94, method: 'domain_brand_alias' });

    const rvrScore = scoreProspectRowDuplicate(
      {
        id: 'prospect-rvr',
        canonical_name: 'RVR',
        normalized_name: 'rvr',
        domain: null,
        website: null,
        status: 'active',
        signal_count: 2,
        evidence_count: 2,
        created_at: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'prospect-river-valley-ranch',
        canonical_name: 'River Valley Ranch',
        normalized_name: 'rivervalleyranch',
        domain: null,
        website: null,
        status: 'active',
        signal_count: 1,
        evidence_count: 1,
        created_at: '2026-05-02T00:00:00.000Z',
      }
    );
    expect(rvrScore).toMatchObject({ score: 0.92, method: 'aggressive_name_alias' });
  });

  it('keeps source-level acronym duplicates as context when the full company create exists', () => {
    const { suppressSourceAliasDuplicateCreates } = __prospectIntelligenceTestHooks;
    const baseCls: any = {
      direction: 'inbound',
      directionUncertain: false,
      mentionType: 'inbound_prospect',
      prospectAction: 'create_prospect',
      shouldCreateProspect: true,
      prospectCompanyName: null,
      confidence: 0.92,
      confidenceTier: 'high',
      sectorKey: 'aerospace_defense',
      sectorConfidence: 0.8,
      signalKind: 'list_entry',
      hasDeck: false,
      hasMeeting: false,
      hasWarmIntro: false,
      dealmakerName: null,
      possibleCompanyId: 'company-portal',
      possibleDealId: null,
      linkedDealId: null,
      provisional: false,
      sampledForProduction: false,
      samplingReason: null,
      metadata: {},
    };
    const rows = suppressSourceAliasDuplicateCreates([
      {
        mention: {
          raw: 'Portal Aircraft Company',
          canonicalName: 'Portal Aircraft Company',
          normalizedName: 'portalaircraft',
          mentionOrdinal: 1,
          spanStart: 0,
          spanEnd: 23,
          lineText: 'Portal Aircraft Company Seed/Series A $6.5M ask.',
          contextText: 'Portal Aircraft Company Seed/Series A $6.5M ask.',
          isListEntry: true,
          products: [],
        },
        existing: {} as any,
        cls: { ...baseCls, prospectCompanyName: 'Portal Aircraft Company' },
        cacheHit: false,
        paidCall: true,
      },
      {
        mention: {
          raw: 'PAC',
          canonicalName: 'PAC',
          normalizedName: 'pac',
          mentionOrdinal: 2,
          spanStart: 25,
          spanEnd: 28,
          lineText: 'PAC Seed/Series A $6.5M ask.',
          contextText: 'PAC Seed/Series A $6.5M ask.',
          isListEntry: true,
          products: [],
        },
        existing: {} as any,
        cls: { ...baseCls, prospectCompanyName: 'PAC' },
        cacheHit: false,
        paidCall: true,
      },
    ] as any);

    expect(rows[0].cls).toMatchObject({
      prospectAction: 'create_prospect',
      shouldCreateProspect: true,
    });
    expect(rows[1].cls).toMatchObject({
      prospectAction: 'record_context',
      mentionType: 'noise',
      shouldCreateProspect: false,
    });
    expect(rows[1].cls?.metadata).toMatchObject({
      create_prospect_veto_reason: 'source_alias_duplicate_of_full_company_create',
    });
  });

  it('treats founder follow-up promises to send a brief as final create evidence', () => {
    const { hasFounderBriefFollowupCreateEvidence } = __prospectIntelligenceTestHooks;
    expect(hasFounderBriefFollowupCreateEvidence(
      'Yes... ratio exchange. It is a supply and demand platform. I will get us a brief up. Brad Chedister CEO Founder brad@wiyctech.com to tony@medinavc.com.',
      'Wiyctech'
    )).toBe(true);
    expect(hasFounderBriefFollowupCreateEvidence(
      'A customer mentions Wiyctech in a generic market update with no founder and no materials.',
      'Wiyctech'
    )).toBe(false);
  });

  it('treats central borrowers in private LOI financing documents as target evidence', () => {
    const { hasPrivatePitchDocumentTargetEvidence } = __prospectIntelligenceTestHooks;
    expect(hasPrivatePitchDocumentTargetEvidence(
      'LOI - PTC National V3 ABP.docx. PTC GOLF is the Borrower and financing recipient in a private letter of intent with principal, maturity, and interest-rate terms.',
      'PTC GOLF',
      'PTC GOLF'
    )).toBe(true);
    expect(hasPrivatePitchDocumentTargetEvidence(
      'LETTER OF INTEREST PTC GOLF This proposal is not a commitment to lend. This letter of interest represents a non-binding expression of interest on behalf of ABP Capital II, LLC to provide financing subject to satisfactory review of all customary and required due diligence.',
      'PTC GOLF',
      'PTC GOLF'
    )).toBe(true);
    expect(hasPrivatePitchDocumentTargetEvidence(
      'ABP Capital II is the lender under an LOI for PTC GOLF as Borrower.',
      'ABP Capital II',
      'ABP Capital II'
    )).toBe(false);
  });

  it('treats direct investor-forwarded round emails as prospect evidence without opening public-news floodgates', () => {
    const { hasDirectInvestorForwardedRoundEvidence } = __prospectIntelligenceTestHooks;
    const mention: any = {
      canonicalName: 'Kestrel Labs',
      normalizedName: 'kestrel',
      mentionOrdinal: 1,
      raw: 'Kestrel Labs',
      spanStart: 0,
      spanEnd: 12,
      lineText: 'Kestrel Labs',
      contextText: 'Kestrel Labs',
      isListEntry: false,
      products: [],
    };
    const classifierInput: any = {
      senderAndContext: 'from nick@newstack.com | to: raul@medinavc.com | subject: New Stack investment update',
      rawExcerpt: 'We are pleased to announce our latest investment in Kestrel Labs, co-leading the round with $800k on an $8m post-money SAFE.',
    };
    expect(hasDirectInvestorForwardedRoundEvidence({
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-kestrel',
      toEmails: ['raul@medinavc.com'],
    } as any, mention, classifierInput)).toBe(true);
    expect(hasDirectInvestorForwardedRoundEvidence({
      type: 'news',
      entityType: 'conversation',
      entityId: 'news-kestrel',
      toEmails: [],
    } as any, mention, {
      ...classifierInput,
      senderAndContext: 'from digest@example.com | subject: Weekly public fundraise news digest',
    })).toBe(false);
  });

  it('vetoes wrong target-role entities while preserving the actual pitched company', () => {
    const { prospectValuableActionVetoForMention } = __prospectIntelligenceTestHooks;
    const blocked = [
      {
        company: 'Ligo Partners',
        excerpt: 'About Sealed Sealed helps contractors monetize rebates.',
        reasoning: 'Sealed is being introduced as an investment opportunity by Ligo Partners with traction metrics.',
      },
      {
        company: 'Fifth Wall',
        excerpt: 'Platform backed by Fifth Wall and Keyframe. About Sealed Sealed helps contractors.',
        reasoning: 'Fifth Wall is an investor/backer context; Sealed is the company being pitched.',
      },
      {
        company: 'Lazard',
        excerpt: 'Universal Quantum has executed a co-lead agreement and is raising.',
        reasoning: 'Universal Quantum is being presented as an investment opportunity by Lazard.',
      },
      {
        company: 'Ascendo Venture Capital',
        excerpt: 'Re: Intro Bea (Suma Wealth) / Medina Ventures. Suma Wealth is raising a priced seed.',
        reasoning: 'SUMA Wealth is being actively pitched by Ascendo VC as an investment opportunity.',
      },
      {
        company: 'JP Morgan Chase',
        action: 'attach_existing_deal',
        excerpt: 'Qunnect established development initiatives with design partners including JP Morgan Chase.',
        reasoning: 'JP Morgan Chase is mentioned as a design partner of Qunnect, not the deal company.',
      },
      {
        company: 'KSDT',
        action: 'attach_existing_deal',
        excerpt: 'Meeting Summary: Medina Ventures x KSDT. KSDT is the accounting and advisory firm reviewing another company.',
        reasoning: 'KSDT is an advisory participant, not the deal company.',
      },
      {
        company: 'BLD Holdings',
        excerpt: 'Re: Medina LP Reference Intro. BLD Holdings is a prospective LP conversation.',
        reasoning: 'BLD Holdings is being introduced as a prospective LP for the fund.',
      },
      {
        company: 'Quantonation',
        excerpt: 'Quantonation shared memQ as the investment opportunity.',
        reasoning: 'memQ is the actual company being pitched; Quantonation is the investor/source context.',
        prospectCompanyName: 'memQ',
      },
      {
        company: 'Helix Earth',
        excerpt: 'NVCA SmartBrief digest reported Helix Earth fundraise news.',
        reasoning: 'Helix Earth appears in informational fundraise news only.',
      },
      {
        company: 'Foundationallm',
        excerpt: 'Re: Fwd: Meeting SubQ <> Medina & eMerge. Great meeting you and excited to learn more about SubQ.',
        senderAndContext: 'from ZoinerTejada@foundationaLLM.ai; subject Re: Fwd: Meeting SubQ <> Medina & eMerge',
        reasoning: 'FoundationaLLM is reaching out, but SubQ is the company being discussed.',
      },
      {
        company: 'Kriptos',
        excerpt: 'Weekly meeting recap from 4Degrees network. Here are people you met with that you may want to add to 4Degrees.',
        senderAndContext: 'from mail@4degrees.ai; subject Weekly meeting recap',
        reasoning: 'Meeting recap shows Medina met with the CEO of Kriptos.',
      },
    ];

    for (const row of blocked) {
      expect(prospectValuableActionVetoForMention({
        prospectAction: row.action || 'create_prospect',
        companyName: row.company,
        rawMention: row.company,
        rawExcerpt: row.excerpt,
        senderAndContext: row.senderAndContext || 'from external@example.com',
        prospectCompanyName: row.prospectCompanyName,
        llmReasoning: row.reasoning,
      })).toMatchObject({ applied: true });
    }

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'KSDT',
      rawMention: 'KSDT',
      rawExcerpt: 'Meeting Summary: Medina Ventures x KSDT. KSDT financial review covered ARR, MRR, gross margin, valuation, diligence next steps, and an investment review with Medina.',
      senderAndContext: 'subject: KSDT & Medina Quick Call',
      prospectCompanyName: 'KSDT',
      llmReasoning: 'KSDT is the company under Medina diligence and investment review.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'and Investment Opport',
      rawMention: 'and Investment Opport',
      rawExcerpt: 'An email has just been received and is suspected to be a "Phishing" email. The email message is safely quarantined. The email subject is: Potential Business and Investment Opportunity.',
      senderAndContext: 'from no-reply@medinavc.com; subject: Quarantined [Potential Business and Investment Opportunity]',
      llmReasoning: 'Security quarantine notice for suspected phishing email; no company prospect signal.',
    })).toMatchObject({
      applied: true,
      reason: 'security_quarantine_or_sender_warning_artifact',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Regional Recon Ventures',
      rawMention: 'Regional Recon Ventures',
      rawExcerpt: 'Caution: The sender details look similar to jim@regionalreconventures.com, yet they are not. Verify the sender identity. Secured by Check Point. Tony -',
      senderAndContext: 'from jim@pathfinderventures.com; subject: Fwd: Intro',
      llmReasoning: 'Warm intro from an external dealmaker.',
    })).toMatchObject({
      applied: true,
      reason: 'security_quarantine_or_sender_warning_artifact',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Presentation Team',
      rawMention: 'Presentation Team',
      rawExcerpt: 'Presentation Team asked me to send something. I wanted to share candid thoughts regarding River Valley Ranch as we continue working through the capital raise and refining the business plan.',
      senderAndContext: 'from advisor@example.com; subject: Capital raise notes',
      llmReasoning: 'Presentation Team is the intermediary/advisor asked to send something; River Valley Ranch is the actual capital-raise target being discussed.',
    })).toMatchObject({
      applied: true,
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Regional Factory',
      rawMention: 'Regional Factory',
      rawExcerpt: 'Regional Factory Business Model. Dual-use ecosystem pathway with government partnerships, demo days, hackathons, memberships, co-location, office space, and phased program buildout.',
      senderAndContext: 'document_type=deal_pitch; document: Regional Factory Business Model -- Phases.pptx',
      llmReasoning: 'Business model deck for an ecosystem initiative around government partnerships and dual-use programming.',
    })).toMatchObject({
      applied: true,
      reason: 'program_or_ecosystem_business_model_not_company_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: '2026 SovereignAI. All Rights Reserved What',
      rawMention: '2026 SovereignAI. All Rights Reserved What',
      rawExcerpt: 'SovereignAI investor presentation with Seed round details and copyright footer fragment: 2026 SovereignAI. All Rights Reserved What.',
      senderAndContext: 'document_type=deal_pitch; document: S-AI Investor Presentation.pdf',
      llmReasoning: "Extracted text fragment '2026 SovereignAI. All Rights Reserved What' is document scaffolding, not a company.",
    })).toMatchObject({
      applied: true,
      reason: 'classifier_reasoning_explicitly_rejects_prospect',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Demo Robotics',
      rawMention: 'Demo Robotics',
      rawExcerpt: 'Subject: Demo Robotics (DEMO). You have been invited to a scheduled demo. When: Thursday 3 PM. Where: Zoom meeting. I will explain more when I see you.',
      senderAndContext: 'calendar invite from founder@demorobotics.example',
      llmReasoning: 'Internal meeting with founder/team for demo; possible investment opportunity signal.',
    })).toMatchObject({
      applied: true,
      reason: 'demo_scheduling_only_without_investment_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Demo Robotics',
      rawMention: 'Demo Robotics',
      rawExcerpt: 'Subject: FW: Demo Robotics (DEMO)\nMention context:\n<html><div id="mail-editor-reference-message-container"><style>.appointment-buttons th{display:block}</style><span class="google-material-icons">event</span></div></html>',
      senderAndContext: 'source entity name: FW: Demo Robotics (DEMO) | subject: FW: Demo Robotics (DEMO)',
      llmReasoning: 'Internal meeting with Demo Robotics founder/team for demo; investment opportunity signal despite internal routing.',
    })).toMatchObject({
      applied: true,
      reason: 'demo_scheduling_only_without_investment_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'MarketCraft',
      rawMention: 'MarketCraft',
      rawExcerpt: 'Bringing the ecosystem team, Medina Ventures, XXV, and MarketCraft onto the same thread. Given the overlap between fundraising and market activation, let us hop on a call to explore how we might work together.',
      senderAndContext: 'from adam@marketcraft.example; subject: MarketCraft / Medina / ecosystem team',
      llmReasoning: 'MarketCraft appears in a warm collaboration thread.',
    })).toMatchObject({
      applied: true,
      reason: 'collaboration_fundraising_activation_without_investment_target',
      nonValuableAction: 'record_context',
    });

    for (const reasoning of [
      'The named founders are team members of the target being introduced, not a separate company prospect.',
      'The command is a government military command, not a commercial company being pitched as an investment opportunity.',
      'The platform is underlying infrastructure for another offering, not a fund investment opportunity.',
    ]) {
      expect(prospectValuableActionVetoForMention({
        prospectAction: 'create_prospect',
        companyName: 'Example Entity',
        rawMention: 'Example Entity',
        rawExcerpt: 'Example Entity appears in the surrounding materials.',
        senderAndContext: 'from external@example.com',
        llmReasoning: reasoning,
      })).toMatchObject({
        applied: true,
        reason: 'classifier_reasoning_explicitly_rejects_prospect',
        nonValuableAction: 'record_context',
      });
    }

    for (const reasoning of [
      'SMB is a market segment definition in a known deal deck, not a separate company.',
      'This is a curated list of companies from a government program/channel, not an investment target.',
    ]) {
      expect(prospectValuableActionVetoForMention({
        prospectAction: 'create_prospect',
        companyName: 'Example Entity',
        rawMention: 'Example Entity',
        rawExcerpt: 'Example Entity appears in the surrounding materials.',
        senderAndContext: 'from external@example.com',
        llmReasoning: reasoning,
      })).toMatchObject({
        applied: true,
        nonValuableAction: 'record_context',
      });
    }

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Defense Innovation Program',
      rawMention: 'Defense Innovation Program',
      rawExcerpt: 'Defense Innovation Program SBIR companies fund raising packet listed several startups seeking Series A capital.',
      senderAndContext: 'document: SBIR Companies Fund Raising.pdf',
      llmReasoning: 'SBIR company actively seeking Series A capital via warm intro.',
    })).toMatchObject({
      applied: true,
      reason: 'government_program_or_list_wrapper_not_target_company',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Benefit Foundation',
      rawMention: 'Benefit Foundation',
      rawExcerpt: 'Meeting postmortem reviewed the charity event budget, sponsor pipeline, artist fees, donations raised, and deficit for next year planning.',
      senderAndContext: 'internal meeting summary with foundation organizers',
      llmReasoning: 'The financials were reviewed by Medina and follow-up was scheduled.',
    })).toMatchObject({
      applied: true,
      reason: 'non_investment_event_fundraising_or_postmortem_context',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'attach_existing_deal',
      companyName: 'SMB',
      rawMention: 'SMB',
      rawExcerpt: 'Investor deck describes SMB as a target customer segment.',
      senderAndContext: 'from deck@example.com',
      llmReasoning: 'SMB is a market segment definition in the known deal deck, not a separate company.',
    })).toMatchObject({
      applied: true,
      reason: 'classifier_reasoning_says_mention_is_not_company_or_list_channel',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Summit Quantum',
      rawMention: 'Summit Quantum',
      rawExcerpt: 'Subject: Summit Quantum ecosystem follow-up. The regional summit program discussed next steps and community programming.',
      senderAndContext: 'from organizer@summit.example; subject: Summit Quantum ecosystem follow-up',
      llmReasoning: 'Summit Quantum appears to be presented as a possible opportunity.',
    })).toMatchObject({
      applied: true,
      reason: 'event_or_program_channel_without_investment_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Atlas Convene',
      rawMention: 'Atlas Convene',
      rawExcerpt: 'Subject: Fwd: Congratulations and Thank You! Atlas Convene is a mature enterprise company exploring a strategic partnership around a commercial relationship.',
      senderAndContext: 'from partner@example.com',
      llmReasoning: 'Atlas Convene was mentioned in forwarded materials.',
    })).toMatchObject({
      applied: true,
      reason: 'partnership_or_mature_company_without_investment_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Inbox Pilot',
      rawMention: 'Inbox Pilot',
      rawExcerpt: 'Subject: Add Profiles to Gmail. Inbox Pilot is a browser extension for adding profiles to Gmail and email workflows.',
      senderAndContext: 'from alice@nubela.co; subject: Add Profiles to Gmail',
      llmReasoning: 'Inbox Pilot may be a warm intro.',
    })).toMatchObject({
      applied: true,
      reason: 'productivity_tooling_context_without_investment_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Civic Forward',
      rawMention: 'Civic Forward',
      rawExcerpt: 'Civic Forward was discussed in a political relationship meeting and campaign conversation with no company pitch.',
      senderAndContext: 'from ally@example.com; subject: Civic Forward meeting',
      llmReasoning: 'Civic Forward appears in a meeting thread.',
    })).toMatchObject({
      applied: true,
      reason: 'relationship_only_context_without_investment_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Northstar Analytics',
      rawMention: 'Northstar Analytics',
      rawExcerpt: 'Mutual introduction to Northstar Analytics. We will circulate a calendar invite shortly and coordinate a call.',
      senderAndContext: 'from intro@example.com; subject: Mutual introduction',
      llmReasoning: 'Northstar Analytics was introduced.',
    })).toMatchObject({
      applied: true,
      reason: 'calendar_only_context_without_investment_target',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Helio Grid',
      rawMention: 'Helio Grid',
      rawExcerpt: 'Helio Grid sent a deck and company 2-pager before the introductory meeting.',
      senderAndContext: 'from founder@heliogrid.example; subject: Helio Grid pre-read',
      llmReasoning: 'Helio Grid sent company materials.',
    })).toMatchObject({
      applied: true,
      reason: 'materials_without_investment_intent',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'ABC',
      rawMention: 'ABC',
      rawExcerpt: 'Thank you for the warm intro. We will circulate a calendar invite shortly and reconnect next week.',
      senderAndContext: 'from intro@example.com; subject: Intro ABC & investor',
      llmReasoning: 'Warm intro language suggests ABC may be the opportunity.',
    })).toMatchObject({
      applied: true,
      reason: 'thin_acronym_intro_or_scheduling_without_investment_intent',
      nonValuableAction: 'record_context',
    });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'ABC',
      rawMention: 'ABC',
      rawExcerpt: 'ABC is raising a $3M SAFE and shared a financial model for diligence.',
      senderAndContext: 'from ceo@abc.example; subject: ABC diligence',
      llmReasoning: 'ABC is the company being pitched as an investment opportunity.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Sealed',
      rawMention: 'Sealed',
      rawExcerpt: 'About Sealed Sealed helps contractors monetize rebates and is raising growth capital.',
      senderAndContext: 'from alec@ligopartners.com',
      llmReasoning: 'Sealed is the company being pitched as an investment opportunity.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Vector Forge',
      rawMention: 'Vector Forge',
      rawExcerpt: 'Vector Forge CEO is raising a $2M SAFE, sharing an updated P&L and financial model, and adding Medina to the data room.',
      senderAndContext: 'from ceo@vectorforge.example; subject: Vector Forge diligence follow-up',
      llmReasoning: 'Vector Forge is the company in active diligence with financing materials.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Tectonic',
      rawMention: 'Tectonic_One Pager.pdf',
      rawExcerpt: 'Tectonic_One Pager.pdf. Tectonic is building post-quantum infrastructure for regulated industries with Navy SBIR, NIST, DARPA, and AWS credentials.',
      senderAndContext: 'document_type=deal_pitch; document: Tectonic_One Pager.pdf',
      llmReasoning: 'Tectonic one-pager pitches post-quantum infrastructure as an investment opportunity.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'River Valley Ranch',
      rawMention: 'RVR',
      rawExcerpt: 'River Valley Ranch is the company being presented for a capital raise with business plan refinement and investor materials.',
      senderAndContext: 'from advisor@example.com; subject: RVR capital raise',
      llmReasoning: 'River Valley Ranch is the actual company being pitched as the capital-raise target.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Minette.ai',
      rawMention: 'Minette.ai',
      rawExcerpt: 'Minette.ai is a founder reply sharing what they are building and asking for time with Medina.',
      senderAndContext: 'from founder@minette.ai; subject Re: Intro Minette.ai <> Medina',
      llmReasoning: 'Minette.ai is being introduced to Medina Ventures as an investment opportunity.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Somewearlabs',
      rawMention: 'Somewearlabs',
      rawExcerpt: 'Somewear Labs is a Seattle-based space-tech company introduced to Medina by a warm intro.',
      senderAndContext: 'from james@somewearlabs.com; subject Re: An introduction for Tony and James',
      llmReasoning: 'Somewear Labs is being introduced to Medina Ventures as an investment opportunity.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Somewear Labs',
      rawMention: 'Somewear Labs',
      rawExcerpt: 'Somewear Labs is a Seattle-based space-tech company introduced to Medina by a warm intro.',
      senderAndContext: 'from james@somewearlabs.com; subject Re: An introduction for Tony and James',
      llmReasoning: 'Somewear Labs is being introduced to Medina Ventures as an investment opportunity.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'attach_existing_deal',
      companyName: 'Alvaro Gonzalez-Rico',
      rawMention: 'Alvaro Gonzalez-Rico',
      rawExcerpt: 'Meeting summary includes Alvaro Gonzalez-Rico as an internal participant while the team discusses a known deal.',
      senderAndContext: 'from meeting-summary@firefly',
      llmReasoning: 'The surrounding meeting discusses a known deal, but Alvaro Gonzalez-Rico is a person/participant.',
    })).toMatchObject({ applied: true, reason: 'person_or_participant_bundle' });

    for (const companyName of ['Mergeit', 'Spookstock', 'TerraMarc']) {
      expect(prospectValuableActionVetoForMention({
        prospectAction: 'attach_existing_deal',
        companyName,
        rawMention: companyName,
        rawExcerpt: `${companyName} appears in an internal generated meeting summary as stale portfolio context with no current deal evidence.`,
        senderAndContext: 'from meeting-summary@firefly',
        llmReasoning: `${companyName} is only an existing portfolio/company context mention, not a current deal signal.`,
      })).toMatchObject({
        applied: true,
        reason: 'weak_known_deal_context_without_target_signal',
        nonValuableAction: 'record_context',
      });
    }

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'attach_existing_deal',
      companyName: 'NeuralSeek',
      rawMention: 'NeuralSeek',
      rawExcerpt: 'NeuralSeek is the known deal company being pitched outbound to Mastercard as a potential customer.',
      senderAndContext: 'from lucas@medinavc.com',
      llmReasoning: 'Known portfolio/deal company being pitched outbound.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'attach_existing_deal',
      companyName: 'Tech D',
      rawMention: 'Tech D',
      rawExcerpt: 'Tech D is a known operating entity inside the NeuralSeek deal structure.',
      senderAndContext: 'from meeting-summary@firefly',
      llmReasoning: 'Tech D is a known operating entity within the existing portfolio investment structure.',
    })).toMatchObject({ applied: false });
  });

  it('does not let broad role words block a candidate-specific investor deck or roadshow', () => {
    const { prospectValuableActionVetoForMention } = __prospectIntelligenceTestHooks;

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Humanetics',
      rawMention: 'Humanetics',
      rawExcerpt: 'Humanetics Investor Roadshow deck. Humanetics is raising a Series B round with diligence materials, customer traction, and a Medina review request.',
      senderAndContext: 'document_type=deal_pitch; document: Humanetics Investor Roadshow.pdf',
      llmReasoning: 'Humanetics is the company being pitched through an investor roadshow deck.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'Tier4 Maverick',
      rawMention: 'Tier4 Maverick',
      rawExcerpt: 'Tier4 Maverick Investor Deck. Tier4 Maverick is raising seed capital; collaboration and market activation are mentioned as go-to-market support.',
      senderAndContext: 'document_type=deal_pitch; document: Tier4 Maverick Investor Deck.pdf',
      llmReasoning: 'Tier4 Maverick is the company being pitched with an investor deck and raise.',
    })).toMatchObject({ applied: false });

    expect(prospectValuableActionVetoForMention({
      prospectAction: 'create_prospect',
      companyName: 'MarketCraft',
      rawMention: 'MarketCraft',
      rawExcerpt: 'Bringing Medina, XXV, and MarketCraft onto the same thread. Given the overlap between fundraising and market activation, let us hop on a call to explore how we might work together.',
      senderAndContext: 'from adam@marketcraft.example; subject: MarketCraft / Medina / ecosystem team',
      llmReasoning: 'MarketCraft appears in a warm collaboration thread.',
    })).toMatchObject({
      applied: true,
      reason: 'collaboration_fundraising_activation_without_investment_target',
    });
  });

  it('uses the shared organization extractor without email scaffolding or fund people', async () => {
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-org-extract',
      source: 'email',
      subject: 'Fwd: Intro thread',
      bodyText: [
        'Sent: Wednesday, May 27, 2026 9:14 AM',
        'On Thu, Tony wrote:',
        'Hi Tony,',
        'I’m sorry if I missed the earlier calendar invite.',
        'About Auguria',
        'Auguria is raising a seed round for its security data platform.',
        'NeuralSeek is evaluating a partnership with Qunnect.',
        '#neuralseek We should sync on where we are with neural before asking more diligence questions.',
        'Greenberg Traurig is counsel on the matter.',
        'Lucas',
        'Medina Ventures',
      ].join('\n'),
      bodyPreview: 'Auguria is raising',
      fromEmail: 'alice@example.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-27T09:14:00.000Z',
    };

    const mentions = await __prospectIntelligenceTestHooks.extractOrganizationMentionsFromSource(item, 'org-1', env, {
      forceLlm: true,
      llmExtractor: async () => [
        { name: 'Auguria', raw: 'Auguria' },
        { name: 'NeuralSeek', raw: 'NeuralSeek' },
        { name: 'Qunnect', raw: 'Qunnect' },
        { name: 'Greenberg Traurig', raw: 'Greenberg Traurig' },
        { name: 'About Auguria', raw: 'About Auguria' },
        { name: 'I’m sorry if', raw: 'I’m sorry if' },
        { name: 'Neural', raw: 'neural' },
        { name: 'Sent', raw: 'Sent' },
        { name: 'Tony', raw: 'Tony' },
        { name: 'Medina Ventures', raw: 'Medina Ventures' },
      ],
    });
    const names = mentions.map(mention => mention.canonicalName);

    expect(names).toEqual(expect.arrayContaining(['Auguria', 'NeuralSeek', 'Qunnect', 'Greenberg Traurig']));
    expect(names).not.toEqual(expect.arrayContaining(['Sent', 'Fwd', 'On Thu', 'Tony', 'Lucas', 'Medina Ventures', 'About Auguria', 'I’m sorry if', 'Neural']));
    expect(mentions.every(mention => typeof mention.spanStart === 'number')).toBe(true);
    expect(mentions.map(mention => mention.mentionOrdinal)).toEqual([1, 2, 3, 4]);
  });

  it('parses curated dealflow lists beyond the generic extractor cap and preserves per-company fields', () => {
    const { parseDealflowList, dedupeMentionIdentityCandidates } = __prospectIntelligenceTestHooks;
    const lines = Array.from({ length: 15 }, (_, index) =>
      `- ArmyCo${index + 1} - Seed - $${index + 1}M - website armyco${index + 1}.com - POC founder${index + 1}@armyco${index + 1}.com - Problem: rugged sensors - Approach: autonomy stack`
    );

    const candidates = parseDealflowList(`ArmyFUZE cohort shortlist\n${lines.join('\n')}`);

    expect(candidates).toHaveLength(15);
    expect(candidates[0]).toMatchObject({
      canonicalName: 'ArmyCo1',
      mentionOrdinal: 1,
      isListEntry: true,
      listFields: {
        stage: 'Seed',
        amount: '$1M',
        website: 'founder1@armyco1.com'.split('@')[1],
      },
    });
    expect(candidates[14].mentionOrdinal).toBe(15);
  });

  it('extracts non-bulleted dealflow packet rows with domains and financing fields', () => {
    const { parseDealflowList } = __prospectIntelligenceTestHooks;
    const text = [
      'Army FUZE SBIR Companies Fund Raising',
      'Person of Contact Company URL Round Stage Amount Description of problem aiming to solve',
      'Llume llume.io Series A $5 MILLION Description of technical approach',
      'Deltachase deltachase.ai Series A $10 million Description of technical approach',
      'Fortilayer fortilayer.com Series A $10 million Description of technical approach',
      'Govly govly.com Series A $10 million Description of technical approach',
      'Kipo kipo.ai Seed $3 million Description of technical approach',
    ].join('\n');

    const names = parseDealflowList(text).map(mention => mention.canonicalName);

    expect(names).toEqual(expect.arrayContaining(['Llume', 'Deltachase', 'Fortilayer', 'Govly', 'Kipo']));
  });

  it('keeps list classifier excerpts centered on the candidate row instead of neighboring rows', () => {
    const { prospectContextWindow, rawExcerptForPrompt } = __prospectIntelligenceTestHooks;
    const bodyText = [
      'Army FUZE SBIR Companies Fund Raising',
      'James Thomas CEO jamest@portal-aircraft.com www.portal-aircraft.com Portal Aircraft Company Series A $6.5 million aircraft modernization.',
      'PAUL KIM, VP OF BUSINESS paul.kim@soelect.com https://www.soelect.com Yes Yes Series B $20 million Solid-state battery anodes for defense drones.',
      'Aroutin Khachaturian, CEO aroutin@heptlab.com https://www.heptlab.com Yes Yes Series A $12 million microfluidic chip manufacturing.',
    ].join(' ');
    const spanStart = bodyText.indexOf('soelect.com');
    const mention: any = {
      raw: 'soelect.com',
      canonicalName: 'Soelect',
      normalizedName: 'soelect',
      mentionOrdinal: 2,
      spanStart,
      spanEnd: spanStart + 'soelect.com'.length,
      lineText: bodyText.slice(0, 500),
      contextText: prospectContextWindow(bodyText, spanStart, spanStart + 'soelect.com'.length, 3000),
      isListEntry: true,
      products: [],
      listFields: {
        website: 'soelect.com',
        stage: 'Series B',
        amount: '$20 million',
        poc: 'paul.kim@soelect.com',
      },
    };

    const excerpt = rawExcerptForPrompt({
      type: 'document',
      entityType: 'document',
      subject: 'Army FUZE SBIR Companies Fund Raising.pdf',
      bodyText,
    } as any, mention);

    expect(excerpt).toContain('Candidate row context');
    expect(excerpt).toContain('Series B $20 million');
    expect(excerpt).toContain('soelect.com');
    expect(excerpt).not.toContain('Portal Aircraft Company Series A');
  });

  it('recovers company names before split domain rows in fund-raising packets', () => {
    const { parseDealflowList } = __prospectIntelligenceTestHooks;
    const text = [
      'Army FUZE SBIR Companies Fund Raising',
      'Person of Contact Company URL Round Stage Amount Description of problem aiming to solve',
      'Portal Aircraft Company CEO jamest@portal-aircraft.com www.portal-aircraft.com Yes Yes Series A $6.5 million Autonomous aircraft modernization.',
    ].join('\n');

    const names = parseDealflowList(text).map(mention => mention.canonicalName);

    expect(names).toContain('Portal Aircraft');
    expect(names).not.toContain('Aircraft');
  });

  it('repairs Army FUZE split domains and keeps each flattened row isolated', () => {
    const { parseDealflowList, rawExcerptForPrompt } = __prospectIntelligenceTestHooks;
    const text = [
      'Army FUZE SBIR Companies Fund Raising',
      'Ilayda Kaygusuz ilayda@llume.io https://www.llume.io Yes Yes $7MM Light-based AI system for inspections.',
      'Sanjeev Kalyanaraman sanjeev@solarmantle.c om www.solarmantle.com Yes Yes $7 MM Heat Mitigation and Thermal Management Passive Cooling.',
      "Benoit R. Hamelin, CTO benoit.hamelin@engeni usmicro.com www.engeniusmicro.co m Yes Yes Series A $20 million EngeniusMicro's air gun solution for drone defense.",
    ].join(' ');

    const candidates = parseDealflowList(text);
    const names = candidates.map(mention => mention.canonicalName);
    const solarmantle = candidates.find(mention => mention.normalizedName === 'solarmantle');
    const engenius = candidates.find(mention => mention.normalizedName === 'engeniusmicro');

    expect(names).toEqual(expect.arrayContaining(['Solarmantle', 'EngeniusMicro']));
    expect(solarmantle?.listFields?.website).toBe('solarmantle.com');
    expect(engenius?.listFields?.website).toBe('engeniusmicro.com');
    expect(solarmantle?.lineText).toContain('Passive Cooling');
    expect(solarmantle?.lineText).not.toContain('Light-based AI system');
    expect(engenius?.lineText).toContain('Series A $20 million');
    expect(engenius?.lineText).not.toContain('Passive Cooling');

    const solarmantleExcerpt = rawExcerptForPrompt({
      type: 'document',
      entityType: 'document',
      subject: 'Army FUZE SBIR Companies Fund Raising.pdf',
      bodyText: text,
    } as any, solarmantle as any);
    expect(solarmantleExcerpt).toContain('Candidate row context');
    expect(solarmantleExcerpt).toContain('Solarmantle');
    expect(solarmantleExcerpt).not.toContain('llume.io');
  });

  it('extracts internal pipeline report rows instead of only the report title', () => {
    const { parseDealflowList } = __prospectIntelligenceTestHooks;
    const text = [
      'automatic_report - Pipeline Status Update -1780401709.pdf',
      'Pipeline Status Update',
      'Blaze blaze.tech LOW Radar AI Unknown Los Angeles blaze.tech AI no-code platform for healthcare organizations launch software and apps in days seed pipeline',
      'Breaktheweb breaktheweb.co Seed GTM raise, 10,000+ users, trending online with machine intelligence',
      'Corestory corestory.ai Deep pipeline, codebases into clean specifications, AI tool for engineering teams',
    ].join('\n');

    const names = parseDealflowList(text).map(mention => mention.canonicalName);

    expect(names).toEqual(expect.arrayContaining(['Blaze', 'Breaktheweb', 'Corestory']));
    expect(names).not.toContain('Pipeline Status Update');
  });

  it('extracts flattened internal pipeline rows with aliases, websites, and exact row context', () => {
    const { parseDealflowList, dedupeMentionIdentityCandidates } = __prospectIntelligenceTestHooks;
    const text = [
      'automatic_report - Pipeline Industry Pie -1778328224.pdf',
      'Pipeline Industry Pie Grouping records by industry',
      'Company Priority Status Industry Investment Round Investment Round Details Revenue (2025) Revenue Details Location Website Date Added Description Source Internal Source External Founder/Team',
      'So In AI Abra LOW Radar AI Unknown Mountain View, United States helloabra.com Dec 10, 2025 Abra builds an AI-driven system of action for vendor relationships.',
      'AgileView LOW Radar AI Unknown New York City, United States agileview.ai Jul 16, 2024 AgileView creates synthetic satellite and aerial imagery.',
      'Healthcare teams use Blaze to accelerate care delivery, reduce operational burden, and unlock new revenue faster. BTW LOW Radar AI Seed GTM seed raise of $1.5M breaktheweb.co Jan 19, 2026 A live scoreboard of what is trending online.',
      'Tony Jimenez BundleIQ LOW Radar AI Unknown West Palm Beach, FL bundleiq.com Dec 12, 2025 bundleIQ weaves documents and conversations into living knowledge systems.',
      'Company Priority Status Industry Investment Round Investment Round Details Revenue (2025) Revenue Details Location Website Date Added Description So In Certus Core MEDIUM Initial Meeting AI Unknown $10M $2M (2024); $55M+ pipeline and $9.25M in bookings Tampa, United States certuscore.com Nov 25, 2025 Certus Core provides agentic AI for the digital battlefield.',
      'CubeNexus MEDIUM Preliminary IC / Term Sheet AI Seed $2M Seed $20M Pre-Money Columbus, United States cubenexus.xyz Oct 15, 2025 CubeNexus is an AI-native spatial analytics platform.',
      'EVQLV LOW Radar AI Seed New York City, United States evqlv.com Jul 17, 2024 AI powered antibody discovery platform.',
      'To Jim IndustrialMind.ai LOW Radar AI Unknown Mountain View, United States industrialmind.ai Dec 10, 2025 IndustrialMind brings AI-driven manufacturing intelligence to factories.',
    ].join(' ');

    const candidates = parseDealflowList(text);
    const names = candidates.map(mention => mention.canonicalName);
    const certus = candidates.find(mention => mention.canonicalName === 'Certus Core');
    const breaktheweb = candidates.find(mention => mention.canonicalName === 'Breaktheweb');

    expect(names).toEqual(expect.arrayContaining([
      'Abra',
      'AgileView',
      'Breaktheweb',
      'BundleIQ',
      'Certus Core',
      'CubeNexus',
      'EVQLV',
      'IndustrialMind',
    ]));
    expect(names).not.toEqual(expect.arrayContaining(['Helloabra', 'faster. BTW', 'Description So In Certus Core']));
    expect(certus?.listFields?.website).toBe('certuscore.com');
    expect(certus?.lineText).toContain('$55M+ pipeline');
    expect(breaktheweb?.raw).toBe('BTW');
    expect(breaktheweb?.lineText).toContain('seed raise of $1.5M');
    expect(breaktheweb?.lineText).not.toContain('Blaze');

    const dedupedNames = dedupeMentionIdentityCandidates(candidates).map(mention => mention.canonicalName);
    expect(dedupedNames).toEqual(expect.arrayContaining(['Abra', 'BundleIQ', 'CubeNexus']));
    expect(dedupedNames).not.toEqual(expect.arrayContaining(['Airwayz', 'TechCrunch']));
  });

  it('extracts no-domain multi-word company names from field-anchored internal pipeline rows', () => {
    const { parseDealflowList } = __prospectIntelligenceTestHooks;
    const text = [
      'automatic_report - Pipeline Status Update -1800000000.pdf',
      'Pipeline Status Update Company fields owner assignment product prospect status description',
      'Vector Relay Systems owner Tony assigned to Tony prospect pipeline investment opportunity product wireless power transmission platform description long-range energy infrastructure for defense installations',
      'Quantum Signal Corp (QSC) LOW Radar Quantum Series A Unknown Unknown Unknown US / South Korea Dec 11, 2025 Quantum Signal builds quantum-enabled sensing systems for autonomous platforms.',
      'Northstar Capital owner Raul investor relationship update for fund outreach',
    ].join(' ');

    const names = parseDealflowList(text).map(mention => mention.canonicalName);

    expect(names).toContain('Vector Relay Systems');
    expect(names).toContain('Quantum Signal Corp');
    expect(names).not.toContain('Northstar Capital');
    expect(names).not.toContain('Pipeline Status Update');
  });

  it('prioritizes subject target extraction before security footer noise', () => {
    const names = __prospectIntelligenceTestHooks.extractMentionCandidatesFromText([
      'Investment Opportunity: Project Prometheus',
      'This message includes a Check Point security footer and link scanner warning.',
      'Project Prometheus is a physical AI lab being presented as an investment opportunity.',
    ].join('\n')).map(mention => mention.canonicalName);

    expect(names[0]).toBe('Project Prometheus');
  });

  it('prefilter drops obvious non-dealflow sources before an LLM call', async () => {
    resetClaudeMock();
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-ramp',
      source: 'email',
      subject: 'Ramp receipt',
      bodyText: 'Ramp bill and payment receipt for May.',
      bodyPreview: 'Ramp bill',
      fromEmail: 'receipts@ramp.com',
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.prefilter_dropped).toBe(1);
    expect(stats.signals_recorded).toBe(0);
    expect(callClaudeWithUsageMock).not.toHaveBeenCalled();
  });

  it('prefilter scans generated automatic pipeline reports when they contain private company rows', () => {
    const gate = __prospectIntelligenceTestHooks.sourcePrefilter({
      type: 'document',
      entityType: 'document',
      entityId: 'doc-generated-pipeline-report',
      source: 'outlook',
      subject: 'automatic_report - Pipeline Status Update -12345.pdf',
      bodyText: 'Pipeline Status Update Company Priority Status Industry Investment Round Website Description ExampleAI Seed $2M example.ai AI platform.',
      bodyPreview: 'Pipeline Status Update Company Priority Status Industry',
      sentAt: '2026-05-01T00:00:00.000Z',
      text: 'automatic_report - Pipeline Status Update -12345.pdf Pipeline Status Update Company Priority Status Industry Investment Round Website Description ExampleAI Seed $2M example.ai AI platform.',
    } as any, {} as any);

    expect(gate).toMatchObject({
      shouldScan: true,
      reasons: ['generated_pipeline_report_dealflow_allow_signal'],
    });
  });

  it('records prospect signals from document source items with the same durable keying', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Artlabs","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.94,"reasoning":"Artlabs is raising with a company profile and deck."}]}',
      usage: { input_tokens: 100, output_tokens: 24 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      externalId: 'doc-1',
      subject: 'Artlabs investment memo',
      bodyText: 'Company Name Artlabs Company URL https://artlabs.ai Founder(s) Ben Smith Short Description AI art infrastructure. Artlabs is raising a seed round and attached a pitch deck.',
      bodyPreview: 'Artlabs is raising a seed round.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      entityType: 'document',
      entityId: 'doc-1',
      contactIds: [],
      participantUserIds: [],
      metadata: {
        org_id: 'org-1',
        visibility: 'private',
        document_type: 'pitch_deck',
        source_table: 'documents',
        source_id: 'doc-1',
        r2_key: 'org-1/document/doc-1.pdf',
        created_at: '2026-05-01T00:00:00.000Z',
        primary_entity_id: 'doc-1',
      },
      text: 'Company Name Artlabs Company URL https://artlabs.ai Founder(s) Ben Smith Short Description AI art infrastructure. Artlabs is raising a seed round and attached a pitch deck.',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'live' });

    expect(stats.signals_recorded).toBe(1);
    expect(stats.prospects_upserted).toBe(1);
    expect(db.prospectSignals[0]).toMatchObject({
      source_type: 'document',
      source_id: 'doc-1',
      mention_ordinal: 1,
      mention_type: 'inbound_prospect',
      ingestion_mode: 'live',
      prospect_id: db.prospects[0].id,
      company_id: db.prospects[0].company_id,
    });
    expect(db.companies).toHaveLength(1);
    expect(db.companies[0]).toMatchObject({
      name: 'Artlabs',
      domain: 'artlabs.ai',
      website: 'https://artlabs.ai',
      company_type: 'startup',
      investment_status: 'prospect',
    });
    expect(db.prospects[0].company_id).toBe(db.companies[0].id);
    expect(db.tags[0]).toMatchObject({ name: 'Investment Prospect' });
    expect(db.companyTags[0]).toMatchObject({ company_id: db.companies[0].id, tag_id: db.tags[0].id });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.company_resolution).toMatchObject({
      action: 'created',
      company_id: db.companies[0].id,
      match_method: 'created_new_company',
    });
  });

  it('runs the final quality gate immediately for a single production source and blocks bad final rows', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        const user = JSON.parse(String(request.user || '{}'));
        expect(user.records).toHaveLength(1);
        return finalQualityGateResponse([{
          record_ordinal: 1,
          decision: 'block_create',
          canonical_name: null,
          merge_target_ordinal: null,
          merge_target_prospect_id: null,
          reason: 'The proposed row is not a clean final prospect record.',
        }]);
      }
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"ArchiveCo","direction":"inbound","sector_key":"enterprise_software","sector_confidence":0.8,"confidence":0.94,"reasoning":"ArchiveCo is presented with a pitch deck for Medina review."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-final-gate-block',
      source: 'email',
      subject: 'ArchiveCo pitch deck',
      bodyText: 'Company Name ArchiveCo Company URL https://archiveco.ai Short Description enterprise data tooling. ArchiveCo is raising a seed round with a pitch deck.',
      bodyPreview: 'ArchiveCo is raising a seed round.',
      fromEmail: 'founder@archiveco.ai',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.final_quality_gate_reviewed).toBe(1);
    expect(stats.final_quality_gate_blocked).toBe(1);
    expect(stats.prospects_upserted).toBe(0);
    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'noise',
      prospect_id: null,
      resolution_status: 'resolved',
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.prospect_final_quality_gate).toMatchObject({
      applied: true,
      decision: 'block_create',
      blocked: true,
      reason: 'The proposed row is not a clean final prospect record.',
    });
  });

  it('renames messy final prospect rows before prospect creation', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        return finalQualityGateResponse([{
          record_ordinal: 1,
          decision: 'rename_and_allow',
          canonical_name: 'Northstar Data',
          merge_target_ordinal: null,
          merge_target_prospect_id: null,
          reason: 'The source evidence points to Northstar Data as the clean company name.',
        }]);
      }
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Northstar Data Platform","direction":"inbound","sector_key":"ai_data","sector_confidence":0.84,"confidence":0.94,"reasoning":"Northstar Data Platform is presented with a seed deck."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-final-gate-rename',
      source: 'email',
      subject: 'Northstar Data Platform seed deck',
      bodyText: 'Company Name Northstar Data Platform Company URL https://northstardata.ai Short Description data infrastructure. Northstar Data Platform is raising a seed round with a deck.',
      bodyPreview: 'Northstar Data Platform seed deck.',
      fromEmail: 'founder@northstardata.ai',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.final_quality_gate_renamed).toBe(1);
    expect(stats.prospects_upserted).toBe(1);
    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({
      canonical_name: 'Northstar Data',
      normalized_name: 'northstardata',
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.prospect_final_quality_gate).toMatchObject({
      applied: true,
      decision: 'rename_and_allow',
      canonical_name: 'Northstar Data',
      renamed: true,
    });
  });

  it('merges same-source alias rows into one clean prospect identity', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        const user = JSON.parse(String(request.user || '{}'));
        const target = user.records.find((record: any) => record.proposed_name === 'Sovereign AI') || user.records[0];
        return finalQualityGateResponse(user.records.map((record: any) => record.proposed_name === 'Sovereign Secure'
          ? {
              record_ordinal: record.record_ordinal,
              decision: 'merge_into_record',
              canonical_name: 'Sovereign AI',
              merge_target_ordinal: target.record_ordinal,
              merge_target_prospect_id: null,
              reason: 'Sovereign Secure is an alias for the same Sovereign AI opportunity.',
            }
          : {
              record_ordinal: record.record_ordinal,
              decision: 'allow_create',
              canonical_name: record.proposed_name,
              merge_target_ordinal: null,
              merge_target_prospect_id: null,
              reason: 'The row names a clean company with fundraising evidence.',
            }));
      }
      const user = JSON.parse(String(request.user || '{}'));
      return {
        text: JSON.stringify({
          decisions: user.candidates.map((row: any) => ({
            mention_ordinal: row.mention_ordinal,
            is_prospect: true,
            prospect_company_name: row.company_name,
            direction: 'inbound',
            sector_key: 'ai_data',
            sector_confidence: 0.86,
            confidence: 0.94,
            reasoning: `${row.company_name} appears as a company row raising a seed round.`,
          })),
        }),
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const items: any[] = [{
      type: 'document',
      source: 'outlook',
      entityType: 'document',
      entityId: 'doc-final-gate-merge-a',
      subject: 'Sovereign AI fundraising row',
      bodyText: 'Company Name Sovereign AI Website sovereign.ai Short Description secure AI infrastructure. Sovereign AI is raising a seed round.',
      bodyPreview: 'Sovereign AI fundraising row.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {},
      text: 'Company Name Sovereign AI Website sovereign.ai Short Description secure AI infrastructure. Sovereign AI is raising a seed round.',
    }, {
      type: 'document',
      source: 'outlook',
      entityType: 'document',
      entityId: 'doc-final-gate-merge-b',
      subject: 'Sovereign Secure fundraising row',
      bodyText: 'Company Name Sovereign Secure Website sovereign.ai Short Description secure AI infrastructure alias. Sovereign Secure is raising the same seed round.',
      bodyPreview: 'Sovereign Secure fundraising row.',
      sentAt: '2026-05-01T00:01:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {},
      text: 'Company Name Sovereign Secure Website sovereign.ai Short Description secure AI infrastructure alias. Sovereign Secure is raising the same seed round.',
    }];

    const stats = await detectAndRecordProspectSignals(items, 'org-1', env);

    expect(stats.final_quality_gate_reviewed).toBeGreaterThanOrEqual(2);
    expect(stats.final_quality_gate_merged).toBe(1);
    expect(db.prospects.filter(row => row.normalized_name === 'sovereign').length).toBe(1);
    const mergedSignal = db.prospectSignals.find(signal => {
      const metadata = JSON.parse(signal.metadata_json);
      return metadata.prospect_final_quality_gate?.decision === 'merge_into_record';
    });
    expect(mergedSignal).toBeTruthy();
    expect(JSON.parse(mergedSignal.metadata_json).prospect_final_quality_gate).toMatchObject({
      decision: 'merge_into_record',
      canonical_name: 'Sovereign AI',
      merged: true,
      attach_only: true,
      merge_target_resolved: true,
    });
    expect(mergedSignal.prospect_id).toBe(db.prospects[0].id);
    expect(stats.prospects_upserted).toBe(1);
  });

  it('merge_into_record with an existing prospect id attaches to that exact prospect without a new upsert', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        const user = JSON.parse(String(request.user || '{}'));
        expect(user.records[0].neighborhood.existing_prospect?.id).toBe('prospect-existing-merge');
        return finalQualityGateResponse([{
          record_ordinal: 1,
          decision: 'merge_into_record',
          canonical_name: 'Beacon Robotics',
          merge_target_ordinal: null,
          merge_target_prospect_id: 'prospect-existing-merge',
          reason: 'Beacon Robotics Alias is the same opportunity as the existing Beacon Robotics prospect.',
        }]);
      }
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Beacon Robotics Alias","direction":"inbound","sector_key":"robotics","sector_confidence":0.82,"confidence":0.93,"reasoning":"Beacon Robotics Alias is being shared with a seed deck."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    db.prospects.push({
      id: 'prospect-existing-merge',
      org_id: 'org-1',
      canonical_name: 'Beacon Robotics',
      normalized_name: normalizeProspectName('Beacon Robotics Alias'),
      domain: 'beaconrobotics.ai',
      status: 'active',
      signal_count: 2,
      evidence_count: 2,
      signal_strength: 85,
      enrichment_status: 'candidate',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-final-gate-existing-merge',
      source: 'email',
      subject: 'Beacon Robotics Alias seed deck',
      bodyText: 'Beacon Robotics Alias is raising a seed round with a deck for Medina review.',
      bodyPreview: 'Beacon Robotics Alias seed deck.',
      fromEmail: 'founder@beaconrobotics.ai',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.final_quality_gate_merged).toBe(1);
    expect(stats.final_quality_gate_merge_resolved).toBe(1);
    expect(stats.prospects_upserted).toBe(0);
    expect(db.prospects).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      prospect_id: 'prospect-existing-merge',
      mention_type: 'inbound_prospect',
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'merge_into_record',
      attach_only: true,
      resolved_merge_target_prospect_id: 'prospect-existing-merge',
      merge_target_resolved: true,
    });
  });

  it('blocks unresolved final-gate merge targets instead of creating a duplicate', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        return finalQualityGateResponse([{
          record_ordinal: 1,
          decision: 'merge_into_record',
          canonical_name: 'No Target Systems',
          merge_target_ordinal: null,
          merge_target_prospect_id: null,
          reason: 'The row looks duplicate-like but no target was supplied.',
        }]);
      }
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"No Target Systems","direction":"inbound","sector_key":"enterprise_software","sector_confidence":0.82,"confidence":0.93,"reasoning":"No Target Systems is being shared with a seed deck."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-final-gate-unresolved-merge',
      source: 'email',
      subject: 'No Target Systems seed deck',
      bodyText: 'No Target Systems is raising a seed round with a pitch deck.',
      bodyPreview: 'No Target Systems seed deck.',
      fromEmail: 'founder@notargetsystems.ai',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    console.log('descriptor debug', stats, db.prospectSignals.map(signal => JSON.parse(signal.metadata_json || '{}')));
    expect(stats.final_quality_gate_blocked).toBe(1);
    expect(stats.final_quality_gate_merge_unresolved).toBe(1);
    expect(stats.prospects_upserted).toBe(0);
    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'noise',
      prospect_id: null,
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'block_create',
      reason: 'unresolved_merge_target',
      blocked: true,
      merge_target_resolved: false,
    });
  });

  it('includes production neighborhood context in the final quality packet for a single source', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        const user = JSON.parse(String(request.user || '{}'));
        const record = user.records[0];
        expect(record.neighborhood.known_company).toMatchObject({
          id: 'company-neighborhood',
          name: 'Orbit Grid',
          domain: 'orbitgrid.ai',
        });
        expect(record.neighborhood.known_deal).toMatchObject({
          id: 'deal-neighborhood',
          company_id: 'company-neighborhood',
          company_name: 'Orbit Grid',
          company_domain: 'orbitgrid.ai',
        });
        expect(record.neighborhood.existing_prospect).toMatchObject({
          id: 'prospect-neighborhood',
          name: 'Orbit Grid',
        });
        expect(record.neighborhood.identity_candidates[0]).toMatchObject({
          entity_type: 'company',
          entity_id: 'company-neighborhood',
          score: 100,
        });
        expect(record.neighborhood.recent_signals[0]).toMatchObject({
          prospect_id: 'prospect-neighborhood',
          final_quality_decision: 'allow_create',
        });
        expect(record.neighborhood.historical_context_count).toBeGreaterThanOrEqual(1);
        return defaultFinalQualityGateResponseForRequest(request);
      }
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Orbit Grid","direction":"inbound","sector_key":"energy_climate","sector_confidence":0.82,"confidence":0.93,"reasoning":"Orbit Grid is newly shared with a seed deck."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    db.companies.push({
      id: 'company-neighborhood',
      org_id: 'org-1',
      name: 'Orbit Grid',
      domain: 'orbitgrid.ai',
      website: 'https://orbitgrid.ai',
      company_type: 'startup',
    });
    db.deals.push({
      id: 'deal-neighborhood',
      org_id: 'org-1',
      company_id: 'company-neighborhood',
      stage: 'active',
    });
    db.prospects.push({
      id: 'prospect-neighborhood',
      org_id: 'org-1',
      canonical_name: 'Orbit Grid',
      normalized_name: normalizeProspectName('Orbit Grid'),
      domain: 'orbitgrid.ai',
      company_id: 'company-neighborhood',
      deal_id: 'deal-neighborhood',
      status: 'active',
      signal_count: 1,
      evidence_count: 1,
      signal_strength: 80,
      enrichment_status: 'candidate',
    });
    db.prospectSignals.push({
      id: 'signal-neighborhood-old',
      org_id: 'org-1',
      prospect_id: 'prospect-neighborhood',
      company_id: 'company-neighborhood',
      deal_id: 'deal-neighborhood',
      source_type: 'conversation',
      source_id: 'conv-old-neighborhood',
      source_title: 'Orbit Grid older deck',
      occurred_at: '2026-04-01T00:00:00.000Z',
      mention_ordinal: 1,
      normalized_mention: normalizeProspectName('Orbit Grid'),
      mention_type: 'inbound_prospect',
      metadata_json: JSON.stringify({
        prospect_action: 'create_prospect',
        prospect_final_quality_gate: { decision: 'allow_create' },
      }),
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-final-gate-neighborhood',
      source: 'email',
      companyId: 'company-neighborhood',
      subject: 'Orbit Grid seed deck',
      bodyText: 'Orbit Grid is raising a seed round with a pitch deck for Medina review.',
      bodyPreview: 'Orbit Grid seed deck.',
      fromEmail: 'founder@orbitgrid.ai',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);
  });

  it('keeps duplicate-like aliases together when building final quality batches', () => {
    const makeOutcome = (name: string, sourceId: string, domain: string | null = null): any => ({
      item: {
        entityId: sourceId,
        subject: `${name} fundraising update`,
      },
      sourceType: 'document',
      mention: {
        raw: domain ? `${name} ${domain}` : name,
        canonicalName: name,
        normalizedName: normalizeProspectName(name),
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: domain ? `${name} website ${domain}` : name,
        contextText: `${name} is raising a seed round.${domain ? ` Website ${domain}.` : ''}`,
        isListEntry: true,
        products: [],
      },
      cls: {
        shouldCreateProspect: true,
        prospectCompanyName: name,
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: domain,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityCandidates: [],
      },
      occurredAt: '2026-05-01T00:00:00.000Z',
    });
    const rows = [
      makeOutcome('Alpha Alias', 'doc-a', 'sharedalias.ai'),
      ...Array.from({ length: 31 }, (_, index) => makeOutcome(`Middle Company ${index}`, `doc-middle-${index}`)),
      makeOutcome('Zulu Alias', 'doc-z', 'sharedalias.ai'),
    ];

    const batches = __prospectIntelligenceTestHooks.finalQualityBatchRows(rows);
    const aliasBatch = batches.find((batch: any[]) =>
      batch.some(row => row.mention.canonicalName === 'Alpha Alias') &&
      batch.some(row => row.mention.canonicalName === 'Zulu Alias')
    );

    expect(aliasBatch).toBeTruthy();
    expect(batches.every((batch: any[]) => batch.length <= 8)).toBe(true);
  });

  it('retries invalid final quality gate JSON with smaller chunks before fallback', async () => {
    resetClaudeMock();
    let finalGateCalls = 0;
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        finalGateCalls++;
        const user = JSON.parse(String(request.user || '{}'));
        expect(user.records.length).toBeLessThanOrEqual(finalGateCalls === 1 ? 8 : 4);
        if (finalGateCalls === 1) {
          return { text: '{"decisions":[', usage: { input_tokens: 80, output_tokens: 4 }, model: 'claude-haiku-4-5-20251001' };
        }
        return finalQualityGateResponse(user.records.map((record: any) => ({
          record_ordinal: record.record_ordinal,
          decision: 'allow_create',
          canonical_name: record.prospect_company_name || record.proposed_name,
          merge_target_ordinal: null,
          merge_target_prospect_id: null,
          reason: 'Retry produced a valid clean final prospect decision.',
        })));
      }
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"RetryCo","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.94,"reasoning":"RetryCo is raising a seed round with a pitch deck."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-final-gate-retry',
      source: 'email',
      subject: 'RetryCo seed deck',
      bodyText: 'Company Name RetryCo Company URL https://retryco.ai Short Description AI workflow tooling. RetryCo is raising a seed round with a pitch deck.',
      bodyPreview: 'RetryCo is raising a seed round.',
      fromEmail: 'founder@retryco.ai',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(finalGateCalls).toBe(2);
    expect(stats.final_quality_gate_fallback_used).toBe(0);
    expect(stats.final_quality_gate_failed_open).toBe(0);
    expect(stats.prospects_upserted).toBe(1);
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'allow_create',
      parse_failed: true,
      retry_used: true,
      fallback_used: false,
      failed_open: false,
      batch_size: 1,
    });
  });

  it('allows strong list-row prospects through evidence-aware fallback after retry failure', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) {
        return { text: '{"decisions":[', usage: { input_tokens: 80, output_tokens: 4 }, model: 'claude-haiku-4-5-20251001' };
      }
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"RescueGrid","direction":"inbound","sector_key":"dev_cloud_infra","sector_confidence":0.78,"confidence":0.91,"reasoning":"RescueGrid appears as a fundraising list row with stage, ask, website, problem, and approach."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      entityType: 'document',
      entityId: 'doc-final-gate-fallback-allow',
      subject: 'Dual-use fundraising list',
      bodyText: 'Company Name RescueGrid Website https://rescuegrid.ai Stage Seed Amount $3M Problem emergency response coordination Approach AI dispatch platform Contact founder@rescuegrid.ai',
      bodyPreview: 'RescueGrid fundraising row.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {},
      text: 'Company Name RescueGrid Website https://rescuegrid.ai Stage Seed Amount $3M Problem emergency response coordination Approach AI dispatch platform Contact founder@rescuegrid.ai',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.final_quality_gate_fallback_used).toBe(1);
    expect(stats.final_quality_gate_failed_open).toBe(0);
    expect(stats.prospects_upserted).toBe(1);
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'allow_create',
      fallback_used: true,
      retry_used: true,
      parse_failed: true,
      fallback_basis: 'strong_target_proof',
      failed_open: false,
    });
    expect(metadata.prospect_final_quality_gate.target_proof.length).toBeGreaterThan(0);
  });

  it('blocks unresolved generic descriptors in evidence-aware fallback', () => {
    const decision = __prospectIntelligenceTestHooks.fallbackProspectFinalQualityDecision(
      {
        item: {
          entityId: 'conv-final-gate-generic-descriptor',
          subject: 'US Data Center Company financing opportunity',
          bodyPreview: 'US Data Center Company financing opportunity.',
        },
        sourceType: 'conversation',
        mention: {
          raw: 'US Data Center Company',
          canonicalName: 'US Data Center Company',
          normalizedName: normalizeProspectName('US Data Center Company'),
          mentionOrdinal: 1,
          spanStart: null,
          spanEnd: null,
          lineText: 'US Data Center Company is seeking financing for expansion.',
          contextText: 'US Data Center Company is seeking financing for expansion. No clean company name is provided.',
          isListEntry: false,
          products: [],
        },
        cls: {
          prospectCompanyName: 'US Data Center Company',
          metadata: {
            llm_reasoning: 'US Data Center Company is described as a financing opportunity, but no clean company name is present.',
          },
        },
        existing: {
          companyId: null,
          dealId: null,
          companyDomain: null,
          relationshipStates: [],
          isInternal: false,
          matchStrength: 'none',
          identityCandidates: [],
        },
      } as any,
      1,
      'final_quality_gate_retry_error:INVALID_FINAL_QUALITY_GATE_JSON',
      true,
      {
        model: 'claude-haiku-4-5-20251001',
        parseFailed: true,
        retryUsed: true,
        batchSize: 1,
      }
    );

    expect(decision).toMatchObject({
      decision: 'block_create',
      fallback_used: true,
      fallback_basis: 'generic_descriptor_without_clean_company',
      hard_block_reason: 'generic_descriptor_without_clean_company',
      retry_used: true,
      parse_failed: true,
    });
  });

  it('blocks unresolved generic descriptors even when the final quality model allows them', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'US Data Center Company',
            normalizedName: normalizeProspectName('US Data Center Company'),
          },
          cls: { prospectCompanyName: 'US Data Center Company', metadata: {} },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: { subject: 'US Data Center Company financing opportunity' },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: null,
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:usdatacentercompany',
          aliasKeys: [],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'US Data Center Company',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The row has concrete financing evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'block_create',
      canonical_name: null,
      hard_block_reason: 'generic_descriptor_without_clean_company',
    });
  });

  it('renames source-like final rows to the clearly named reasoning target', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Source Capital Partners',
            normalizedName: normalizeProspectName('Source Capital Partners'),
          },
          cls: {
            prospectCompanyName: 'Source Capital Partners',
            metadata: {
              llm_reasoning: 'OrbitalGrid is explicitly introduced by Source Capital Partners as a Series A investment opportunity for Medina.',
              reasoning_judge: {
                reason: 'OrbitalGrid is the central investment target and Source Capital Partners is the intro source.',
              },
            },
          },
          existing: {
            companyId: 'company-source-capital',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Intro & OrbitalGrid Series A',
            bodyText: 'Source Capital Partners introduced OrbitalGrid. OrbitalGrid is raising a Series A round and shared a deck with Medina.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-source-capital',
            name: 'Source Capital Partners',
            domain: 'sourcecapital.example',
            website: 'https://sourcecapital.example',
            type: 'investor',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:sourcecapitalpartners',
          aliasKeys: ['sourcecapitalpartners'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Source Capital Partners',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The row appears to have intro evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'OrbitalGrid',
      hard_block_reason: null,
    });
    expect(decision.reason).toContain('reasoning target OrbitalGrid');
  });

  it('renames slash-like dirty final rows when reasoning names a company possessive round target', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Media / Hardware',
            normalizedName: normalizeProspectName('Media / Hardware'),
          },
          cls: {
            prospectCompanyName: 'Media / Hardware',
            metadata: {
              llm_reasoning: "Partner explicitly pitches VectorNet's Series B to Medina as an investment opportunity with a deck.",
              reasoning_judge: {
                reason: "The email names VectorNet's Series B as the investment opportunity and Media / Hardware is only a dirty identity label.",
              },
            },
          },
          existing: {
            companyId: 'company-dirty-label',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 97,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Re: VectorNet Series B',
            bodyText: "Partner forwarded VectorNet's Series B deck to Medina. VectorNet is raising a Series B round.",
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-dirty-label',
            name: 'Media / Hardware',
            domain: 'dirty-label.example',
            website: 'https://dirty-label.example',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:dirtylabel',
          aliasKeys: ['mediaslashhardware'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Media / Hardware',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: "Identity candidates confirm VectorNet is the real target; rename from proposed dirty label.",
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'VectorNet',
      hard_block_reason: null,
    });
  });

  it('renames sentence-fragment final rows when reasoning names the actual target', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Lakeside Ranch so you can review it thoroughly',
            normalizedName: normalizeProspectName('Lakeside Ranch so you can review it thoroughly'),
          },
          cls: {
            prospectCompanyName: 'Lakeside Ranch so you can review it thoroughly',
            metadata: {
              llm_reasoning: 'Lakeside Ranch is being shared as a golf-club acquisition opportunity with a data room.',
              reasoning_judge: {
                reason: 'The actual target is Lakeside Ranch; the proposed name is a sentence fragment from the email.',
              },
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'Lakeside Ranch acquisition opportunity',
            bodyText: 'The sender shared the Lakeside Ranch data room and acquisition materials for Medina review.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Lakeside Ranch so you can review it thoroughly',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The proposed name is a sentence fragment; the actual target is Lakeside Ranch.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Lakeside Ranch',
      hard_block_reason: null,
    });
  });

  it('renames generic known-company-match labels when final reasoning gives the canonical target', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Known company match',
            normalizedName: normalizeProspectName('Known company match'),
          },
          cls: {
            prospectCompanyName: 'Known company match',
            metadata: {
              llm_reasoning: 'Northstar Industries is being pitched through a pre-seed deck.',
              reasoning_judge: {
                reason: 'The canonical name is Northstar Industries and the PDF is a company financing deck.',
              },
            },
          },
          existing: {
            companyId: 'company-known-match',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 96,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Northstar Industries - Pre-Seed.pdf',
            bodyText: 'Northstar Industries shared a Pre-Seed deck and financing materials.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-known-match',
            name: 'Known company match',
            domain: 'northstar.example',
            website: 'https://northstar.example',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:knownmatch',
          aliasKeys: ['knowncompanymatch'],
          deterministicHint: { suggested_action: 'rename_candidate', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Known company match',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The canonical name is "Northstar Industries"; Known company match is only an identity label.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Northstar Industries',
      hard_block_reason: null,
    });
  });

  it('renames generic investor-role labels when reasoning names the financing document subject', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'PIPE investor',
            normalizedName: normalizeProspectName('PIPE investor'),
          },
          cls: {
            prospectCompanyName: 'PIPE investor',
            metadata: {
              llm_reasoning: 'Signal Quantum is the central subject of a private PIPE financing deck.',
              reasoning_judge: {
                reason: 'Signal Quantum is the central subject of the private investment deck; PIPE investor is a role label.',
              },
            },
          },
          existing: {
            companyId: 'company-signal-quantum',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Signal Quantum PIPE financing.pdf',
            bodyText: 'Signal Quantum is raising through a PIPE financing deck for investor review.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'PIPE investor',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Signal Quantum is the central subject of the private financing document and investment opportunity.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Signal Quantum',
      hard_block_reason: null,
    });
  });

  it('renames dirty round-wrapper final rows even when known identity has the dirty display name', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Acorn Series',
            normalizedName: normalizeProspectName('Acorn Series'),
          },
          cls: {
            prospectCompanyName: 'Acorn Series',
            metadata: {
              llm_reasoning: 'Acorn is the subject of a private seed extension investment memo.',
              reasoning_judge: {
                reason: 'Acorn is the central investment target being reviewed for a seed extension round.',
              },
            },
          },
          existing: {
            companyId: 'company-acorn',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Acorn Series Seed Extension Investment Memo Draft',
            bodyText: 'Acorn is under review for a Series Seed extension round. The investment memo names Acorn as the target.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-acorn',
            name: 'Acorn Series',
            domain: 'acorn.example',
            website: 'https://acorn.example',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:acornseries',
          aliasKeys: ['acornseries'],
          deterministicHint: { suggested_action: 'rename_candidate', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Acorn Series',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Private investment memo evidence names the company but the proposed name includes the round wrapper.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Acorn',
      hard_block_reason: null,
    });
  });

  it('strips dirty CRM-style prefixes from hard identity final names', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'VC.. Northstar Materials Group',
            normalizedName: normalizeProspectName('VC.. Northstar Materials Group'),
          },
          cls: {
            prospectCompanyName: 'VC.. Northstar Materials Group',
            metadata: {
              llm_reasoning: 'Northstar Materials Group is introduced as an investment opportunity with a deck.',
              reasoning_judge: {
                reason: 'Northstar Materials Group is the central investment target; VC.. is a dirty prefix.',
              },
            },
          },
          existing: {
            companyId: 'company-northstar-materials',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Intro: Northstar Materials Group',
            bodyText: 'Northstar Materials Group shared a deck and meeting request with Medina.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-northstar-materials',
            name: 'VC.. Northstar Materials Group',
            domain: 'northstarmat.example',
            website: 'https://northstarmat.example',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:northstarmaterials',
          aliasKeys: ['northstarmaterialsgroup'],
          deterministicHint: { suggested_action: 'rename_candidate', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'VC.. Northstar Materials Group',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Known company identity confirmed from exact domain.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Northstar Materials Group',
      hard_block_reason: null,
    });
  });

  it('renames repeated one-word brand fragments to the full ampersand brand from the source', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Nova',
            normalizedName: normalizeProspectName('Nova'),
          },
          cls: {
            prospectCompanyName: 'Nova',
            metadata: {
              llm_reasoning: 'Nova is introduced with a warm intro, traction, SAFE details, and a deck.',
              reasoning_judge: {
                reason: 'Nova is the central investment target with direct fundraising evidence.',
              },
            },
          },
          existing: {
            companyId: 'company-source-office',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Vitamin platform backed by strategic investors',
            bodyText: [
              'Happy to intro.',
              'About Nova & Nova',
              'Nova & Nova is a consumer health company with $2M ARR and 3x month-over-month growth.',
              '$1.5M is left in a $3M SAFE.',
              'Nova & Nova Deck Here.',
            ].join(' '),
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-source-office',
            name: 'Source Office Partners',
            domain: 'sourceoffice.example',
            website: 'https://sourceoffice.example',
            type: 'family_office',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'domain:sourceoffice.example',
          aliasKeys: ['nova', 'sourceofficepartners'],
          deterministicHint: { suggested_action: 'rename_candidate', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Nova',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Known identity resolves to the source, not the investment target. Nova is the actual company being pitched.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Nova & Nova',
      hard_block_reason: null,
    });
  });

  it('renames portco-style role wrappers to the named company in the source body', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Portco',
            normalizedName: normalizeProspectName('Portco'),
          },
          cls: {
            prospectCompanyName: 'Portco',
            metadata: {
              llm_reasoning: 'Portco is introduced with warm intro language, customer traction, pipeline, and founder details.',
              reasoning_judge: {
                reason: 'The source contains concrete prospect evidence but the proposed name is a portfolio-company role label.',
              },
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: null,
            identityScore: 0,
            identityStrength: null,
            identityCandidates: [],
          },
          item: {
            subject: 'Portco',
            bodyText: 'Lmk if you want intro. Atlas Lab is currently building the safety layer for enterprise AI. Active lighthouse customers, $20M qualified pipeline, and a deck are available.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: null,
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'alias:portco',
          aliasKeys: ['portco'],
          deterministicHint: { suggested_action: 'rename_candidate', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Warm intro with traction evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Atlas Lab',
      hard_block_reason: null,
    });
  });

  it('renames compliance descriptor final rows to the company named in the pitch deck title', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'NDAA-compliant development',
            normalizedName: normalizeProspectName('NDAA-compliant development'),
          },
          cls: {
            prospectCompanyName: 'NDAA-compliant development',
            metadata: {
              llm_reasoning: 'Falcon Drones is presented with an investor pitch deck dated March 11.',
              reasoning_judge: {
                reason: 'Falcon Drones is the central subject of the private pitch deck.',
              },
              target_evidence_reasons: ['pitch_or_investment_document_target'],
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: null,
            identityScore: 0,
            identityStrength: null,
            identityCandidates: [],
          },
          item: {
            subject: 'Falcon Drones Pitch Deck March 11 2026.pdf',
            bodyText: '',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: null,
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'alias:falcondrones',
          aliasKeys: ['falcondrones'],
          deterministicHint: { suggested_action: 'rename_candidate', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'NDAA-compliant development',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Pitch deck names the company but proposed name is a descriptor.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Falcon Drones',
      hard_block_reason: null,
    });
  });

  it('renames generic short final rows from subject-line round evidence', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Direct',
            normalizedName: normalizeProspectName('Direct'),
          },
          cls: {
            prospectCompanyName: 'Direct',
            metadata: {
              llm_reasoning: 'PhotonLink is explicitly being pitched for Series B funding via warm intro.',
              reasoning_judge: {
                reason: "Subject line explicitly references 'PhotonLink Series B' and PhotonLink is the investment target.",
              },
            },
          },
          existing: {
            companyId: 'company-source-identity',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Re: Intro & PhotonLink Series B - Medina Ventures portco',
            bodyText: 'PhotonLink is raising a Series B round and shared a deck with Medina.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Direct',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Direct Series B pitch with deck evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'PhotonLink',
      hard_block_reason: null,
    });
  });

  it('renames private investment document wrappers from potential-investment title evidence', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Apex Confidentiality',
            normalizedName: normalizeProspectName('Apex Confidentiality'),
          },
          cls: {
            prospectCompanyName: 'Apex Confidentiality',
            metadata: {
              llm_reasoning: 'Apex Minerals Group is the company in an NDA document explicitly titled for potential investment review by an investor.',
              reasoning_judge: {
                reason: "The document title says 'Potential Investment in Apex Minerals Group, Inc.' and names the company as issuer.",
              },
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'Apex Confidentiality and NDA - Investor.docx',
            bodyText: 'Confidentiality Agreement regarding Potential Investment in Apex Minerals Group, Inc. Company proposes to furnish investment information.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Apex Confidentiality',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: "Direct investment target evidence: private NDA document titled 'Potential Investment in Apex Minerals Group, Inc.'",
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Apex Minerals Group',
      hard_block_reason: null,
    });
  });

  it('renames analysis-document title fragments when reasoning names the clean canonical target', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'VectorAI AI Analysis',
            normalizedName: normalizeProspectName('VectorAI AI Analysis'),
          },
          cls: {
            prospectCompanyName: 'VectorAI AI Analysis',
            metadata: {
              llm_reasoning: 'Document is a diligence memo analyzing Vector AI with financial statements and use-of-proceeds.',
              reasoning_judge: {
                reason: "Prospect company name 'Vector AI' is the clean canonical target for the diligence document.",
              },
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'VectorAI AI Analysis.docx',
            bodyText: 'Vector AI diligence memo includes financial statements, use-of-proceeds, cap table, and investment review notes.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'VectorAI AI Analysis',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: "Proposed name is a document title fragment; prospect company name 'Vector AI' is the clean canonical target.",
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Vector AI',
      hard_block_reason: null,
    });
  });

  it('renames generic strength labels from pitch-deck title evidence', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Strong',
            normalizedName: normalizeProspectName('Strong'),
          },
          cls: {
            prospectCompanyName: 'Strong',
            metadata: {
              llm_reasoning: 'Falcon Robotics is presented with an investor pitch deck dated March 11.',
              reasoning_judge: {
                reason: 'Falcon Robotics is the central subject of the private pitch deck.',
              },
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'Falcon Robotics Pitch Deck March 11 2026.pdf',
            bodyText: 'Falcon Robotics investor pitch deck for Medina review.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Strong',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Strong deck-based signal for a known manufacturer.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Falcon Robotics',
      hard_block_reason: null,
    });
  });

  it('renames explanatory heading fragments when reasoning names the issuer', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'What Atlas Is AtlasID',
            normalizedName: normalizeProspectName('What Atlas Is AtlasID'),
          },
          cls: {
            prospectCompanyName: 'What Atlas Is AtlasID',
            metadata: {
              llm_reasoning: 'AtlasID is presented with explicit bridge fundraise details: $250k SAFE at an $8M cap.',
              reasoning_judge: {
                reason: 'AtlasID is the central issuer in a private bridge financing document with explicit SAFE terms.',
              },
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'AtlasID Bridge Summary.pdf',
            bodyText: 'AtlasID bridge summary. AtlasID is raising $250k-$500k SAFE at an $8M cap.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'What Atlas Is AtlasID',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'AtlasID is the central issuer in the bridge financing document.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'AtlasID',
      hard_block_reason: null,
    });
  });

  it('renames weekday-meeting fragments when reasoning gives the canonical company form', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Wednesday meeting. The candidate',
            normalizedName: normalizeProspectName('Wednesday meeting. The candidate'),
          },
          cls: {
            prospectCompanyName: 'Wednesday meeting. The candidate',
            metadata: {
              llm_reasoning: 'The CEO confirmed a diligence meeting with Medina for Orchard Data.',
              reasoning_judge: {
                reason: 'The canonical form is Orchard Data and Orchard Data is the central investment prospect with a scheduled diligence meeting.',
              },
            },
          },
          existing: {
            companyId: 'company-orchard-data',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Re: Time to Meet',
            bodyText: 'James at OrchardData confirmed a Wednesday diligence meeting with Medina partners.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-orchard-data',
            name: 'Wednesday meeting. The candidate',
            domain: 'orcharddata.example',
            website: 'https://orcharddata.example',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:orcharddata',
          aliasKeys: ['orcharddata'],
          deterministicHint: { suggested_action: 'rename_candidate', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Wednesday meeting. The candidate',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Direct CEO meeting confirmation. The canonical form is Orchard Data.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Orchard Data',
      hard_block_reason: null,
    });
  });

  it('restores the original target when final quality tries to rename it to a wrong identity match', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'TargetCo',
            normalizedName: normalizeProspectName('TargetCo'),
          },
          cls: {
            prospectCompanyName: 'TargetCo',
            metadata: {
              llm_reasoning: 'TargetCo is explicitly being pitched for a Series A round through a warm intro.',
              reasoning_judge: {
                reason: 'TargetCo is the direct investment target in the source.',
              },
            },
          },
          existing: {
            companyId: 'company-known-source',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Intro & TargetCo Series A',
            bodyText: 'Known Source Office introduced TargetCo. TargetCo is raising a Series A round with a deck.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-known-source',
            name: 'Known Source Office',
            domain: 'knownsource.example',
            website: 'https://knownsource.example',
            type: 'family_office',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:targetco',
          aliasKeys: ['targetco', 'knownsourceoffice'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Known Source Office',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Direct Series A investment target via warm intro. Identity candidates show TargetCo (score 90, exact normalized name match) is the true investment target, distinct from Known Source Office (score 98 domain match).',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'TargetCo',
      hard_block_reason: null,
    });
  });

  it('preserves a strong target row when final quality blocks only because identity context conflicts', () => {
    const row: any = {
      item: {
        entityId: 'conv-final-gate-identity-conflict',
        subject: 'TargetCo Series A opportunity',
        bodyText: 'Source Office introduced TargetCo. TargetCo has $12mm revenue and is raising a $5mm Series A round with a deck.',
        bodyPreview: 'TargetCo Series A opportunity.',
      },
      sourceType: 'conversation',
      mention: {
        raw: 'TargetCo',
        canonicalName: 'TargetCo',
        normalizedName: normalizeProspectName('TargetCo'),
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'TargetCo has $12mm revenue and is raising a $5mm Series A round.',
        contextText: 'Source Office introduced TargetCo. TargetCo has $12mm revenue and is raising a $5mm Series A round with a deck.',
        isListEntry: false,
        products: [],
      },
      cls: {
        prospectCompanyName: 'TargetCo',
        prospectAction: 'create_prospect',
        mentionType: 'inbound_prospect',
        shouldCreateProspect: true,
        possibleCompanyId: null,
        possibleDealId: null,
        linkedDealId: null,
        provisional: false,
        directionUncertain: false,
        metadata: {
          llm_reasoning: 'TargetCo is explicitly introduced with revenue, Series A ask, and deck reference.',
          has_create_evidence: true,
          target_evidence_reasons: ['subject_line_target_opportunity'],
        },
      },
      existing: {
        companyId: 'company-source-office',
        dealId: null,
        companyDomain: 'sourceoffice.example',
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'domain',
        identityScore: 98,
        identityStrength: 'hard',
        identityCandidates: [],
      },
    };

    const applied = __prospectIntelligenceTestHooks.applyFinalQualityDecisionToOutcome(
      row,
      {
        record_ordinal: 1,
        decision: 'block_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Identity conflict: neighborhood shows TargetCo matches a known source company, but the source evidence describes TargetCo as the investment target.',
        model: 'claude-haiku-4-5-20251001',
      },
      'fqg_test_identity_conflict',
      new Map([[1, row]])
    );

    expect(applied.cls.shouldCreateProspect).toBe(true);
    expect(applied.cls.prospectAction).toBe('create_prospect');
    expect(applied.cls.prospectCompanyName).toBe('TargetCo');
    expect(applied.cls.metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'TargetCo',
      blocked: false,
    });
  });

  it('preserves a private investment document target when final quality blocks only because the row is suspicious', () => {
    const row: any = {
      item: {
        entityId: 'doc-final-gate-suspicious-private-investment',
        subject: 'Apex Confidentiality and NDA - Investor.docx',
        bodyText: 'Confidentiality Agreement regarding Potential Investment in Apex Minerals Group, Inc. Apex Minerals Group proposes to furnish investment information to investor.',
        bodyPreview: 'Potential Investment in Apex Minerals Group, Inc.',
      },
      sourceType: 'document',
      mention: {
        raw: 'Apex Confidentiality',
        canonicalName: 'Apex Confidentiality',
        normalizedName: normalizeProspectName('Apex Confidentiality'),
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'Potential Investment in Apex Minerals Group, Inc.',
        contextText: 'Confidentiality Agreement regarding Potential Investment in Apex Minerals Group, Inc.',
        isListEntry: false,
        products: [],
      },
      cls: {
        prospectCompanyName: 'Apex Minerals Group',
        prospectAction: 'create_prospect',
        mentionType: 'inbound_prospect',
        shouldCreateProspect: true,
        possibleCompanyId: null,
        possibleDealId: null,
        linkedDealId: null,
        provisional: false,
        directionUncertain: false,
        metadata: {
          llm_reasoning: 'Apex Minerals Group is the company in an NDA document explicitly titled for potential investment review by an investor.',
          has_create_evidence: true,
          target_evidence_reasons: ['private_pitch_document_target'],
        },
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityScore: 0,
        identityStrength: 'none',
        identityCandidates: [],
      },
    };

    const applied = __prospectIntelligenceTestHooks.applyFinalQualityDecisionToOutcome(
      row,
      {
        record_ordinal: 1,
        decision: 'block_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'accepted_but_suspicious row with second_look_required and deterministic hint suggested block_candidate despite private investment document evidence.',
        model: 'claude-haiku-4-5-20251001',
      },
      'fqg_test_private_doc_preserve',
      new Map([[1, row]])
    );

    expect(applied.cls.shouldCreateProspect).toBe(true);
    expect(applied.cls.prospectAction).toBe('create_prospect');
    expect(applied.cls.prospectCompanyName).toBe('Apex Minerals Group');
    expect(applied.cls.metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Apex Minerals Group',
      blocked: false,
    });
  });

  it('preserves structured private pipeline rows when final quality blocks only because the row is suspicious', () => {
    const row: any = {
      item: {
        entityId: 'doc-final-gate-structured-pipeline-preserve',
        subject: 'Pipeline Status Update',
        bodyText: 'Pipeline Status Update Company Priority Status Industry Website Description. HelioGrid Systems LOW Radar Energy Unknown heliogrid.ai HelioGrid Systems builds grid resilience software and is in the seed pipeline.',
        bodyPreview: 'HelioGrid Systems LOW Radar seed pipeline.',
      },
      sourceType: 'document',
      mention: {
        raw: 'HelioGrid Systems',
        canonicalName: 'HelioGrid Systems',
        normalizedName: normalizeProspectName('HelioGrid Systems'),
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'HelioGrid Systems LOW Radar Energy Unknown heliogrid.ai HelioGrid Systems builds grid resilience software and is in the seed pipeline.',
        contextText: 'Pipeline Status Update HelioGrid Systems LOW Radar Energy Unknown heliogrid.ai HelioGrid Systems builds grid resilience software and is in the seed pipeline.',
        isListEntry: true,
        products: [],
      },
      cls: {
        prospectCompanyName: 'HelioGrid Systems',
        prospectAction: 'create_prospect',
        mentionType: 'inbound_prospect',
        shouldCreateProspect: true,
        possibleCompanyId: null,
        possibleDealId: null,
        linkedDealId: null,
        provisional: false,
        directionUncertain: false,
        metadata: {
          llm_reasoning: 'HelioGrid Systems is a company row in a private pipeline status report with website, product description, and seed pipeline signal.',
          has_create_evidence: true,
          target_evidence_reasons: ['fundraising_list_row'],
        },
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityScore: 0,
        identityStrength: 'none',
        identityCandidates: [],
      },
    };

    const applied = __prospectIntelligenceTestHooks.applyFinalQualityDecisionToOutcome(
      row,
      {
        record_ordinal: 1,
        decision: 'block_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'accepted_but_suspicious row with recent mixed signal history and no known company identity match.',
        model: 'claude-haiku-4-5-20251001',
      },
      'fqg_test_structured_pipeline_preserve',
      new Map([[1, row]])
    );

    expect(applied.cls.shouldCreateProspect).toBe(true);
    expect(applied.cls.prospectAction).toBe('create_prospect');
    expect(applied.cls.prospectCompanyName).toBe('HelioGrid Systems');
    expect(applied.cls.metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'HelioGrid Systems',
      blocked: false,
    });
    expect(applied.cls.metadata.prospect_final_quality_gate.target_proof).toEqual(expect.arrayContaining(['structured_pipeline_row_details']));
  });

  it('does not replace a source-backed structured row with a reasoning artifact canonical name', () => {
    const row: any = {
      item: {
        entityId: 'doc-final-gate-structured-row-artifact-name',
        subject: 'Pipeline Status Update',
        bodyText: 'Pipeline Status Update Company Priority Status Industry Website Description. QuantumGrid LOW Radar Quantum Unknown quantumgrid.ai QuantumGrid builds quantum orchestration software for enterprise workloads.',
        bodyPreview: 'QuantumGrid LOW Radar quantumgrid.ai.',
      },
      sourceType: 'document',
      mention: {
        raw: 'QuantumGrid',
        canonicalName: 'QuantumGrid',
        normalizedName: normalizeProspectName('QuantumGrid'),
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'QuantumGrid LOW Radar Quantum Unknown quantumgrid.ai QuantumGrid builds quantum orchestration software.',
        contextText: 'Pipeline Status Update QuantumGrid LOW Radar Quantum Unknown quantumgrid.ai QuantumGrid builds quantum orchestration software.',
        isListEntry: true,
        products: [],
      },
      cls: {
        prospectCompanyName: 'QuantumGrid',
        prospectAction: 'create_prospect',
        mentionType: 'inbound_prospect',
        shouldCreateProspect: true,
        possibleCompanyId: null,
        possibleDealId: null,
        linkedDealId: null,
        provisional: false,
        directionUncertain: false,
        metadata: {
          llm_reasoning: 'QuantumGrid is listed as a company row in the private pipeline status report.',
          has_create_evidence: true,
          target_evidence_reasons: ['fundraising_list_row'],
        },
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityScore: 0,
        identityStrength: 'none',
        identityCandidates: [],
      },
    };

    const applied = __prospectIntelligenceTestHooks.applyFinalQualityDecisionToOutcome(
      row,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'No existing company match',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'QuantumGrid is a named row entry with company-specific details. No existing company match. Fundraising list evidence supports creation.',
        model: 'claude-haiku-4-5-20251001',
      },
      'fqg_test_structured_row_artifact_name',
      new Map([[1, row]])
    );

    expect(applied.cls.shouldCreateProspect).toBe(true);
    expect(applied.cls.prospectCompanyName).toBe('QuantumGrid');
    expect(applied.cls.metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'QuantumGrid',
      blocked: false,
    });
  });

  it('preserves warm intro targets without requiring a verified website when private anchors are present', () => {
    const row: any = {
      item: {
        entityId: 'conv-final-gate-warm-intro-preserve',
        subject: 'FW: Orbit Loom intro',
        bodyText: 'Forwarding a warm intro to Medina. Orbit Loom CEO Maya Chen is copied at maya@orbitloom.example and the deal-flow note says Orbit Loom is a suborbital logistics company for Medina review.',
        bodyPreview: 'Orbit Loom warm intro for Medina review.',
      },
      sourceType: 'conversation',
      mention: {
        raw: 'Orbit Loom',
        canonicalName: 'Orbit Loom',
        normalizedName: normalizeProspectName('Orbit Loom'),
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'Orbit Loom CEO Maya Chen is copied at maya@orbitloom.example.',
        contextText: 'Forwarding a warm intro to Medina. Orbit Loom CEO Maya Chen is copied at maya@orbitloom.example and the deal-flow note says Orbit Loom is a suborbital logistics company for Medina review.',
        isListEntry: false,
        products: [],
      },
      cls: {
        prospectCompanyName: 'Orbit Loom',
        prospectAction: 'create_prospect',
        mentionType: 'inbound_prospect',
        shouldCreateProspect: true,
        possibleCompanyId: null,
        possibleDealId: null,
        linkedDealId: null,
        provisional: false,
        directionUncertain: false,
        metadata: {
          llm_reasoning: 'Orbit Loom is being introduced to Medina through a private deal-flow email with CEO contact evidence.',
          has_create_evidence: true,
          target_evidence_reasons: ['warm_intro_target'],
        },
      },
      existing: {
        companyId: null,
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'none',
        identityScore: 0,
        identityStrength: 'none',
        identityCandidates: [],
      },
    };

    const applied = __prospectIntelligenceTestHooks.applyFinalQualityDecisionToOutcome(
      row,
      {
        record_ordinal: 1,
        decision: 'block_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'accepted_but_suspicious row lacks verified website/domain despite intro context.',
        model: 'claude-haiku-4-5-20251001',
      },
      'fqg_test_warm_intro_preserve',
      new Map([[1, row]])
    );

    expect(applied.cls.shouldCreateProspect).toBe(true);
    expect(applied.cls.prospectAction).toBe('create_prospect');
    expect(applied.cls.prospectCompanyName).toBe('Orbit Loom');
    expect(applied.cls.metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Orbit Loom',
      blocked: false,
    });
    expect(applied.cls.metadata.prospect_final_quality_gate.target_proof).toEqual(expect.arrayContaining(['warm_intro_target']));
  });

  it('preserves the full source-backed brand during identity-conflict final apply', () => {
    const row: any = {
      item: {
        entityId: 'conv-final-gate-ampersand-conflict',
        subject: 'Consumer wellness opportunity',
        bodyText: [
          'Happy to intro.',
          'About Nova & Nova',
          'Nova & Nova has $2M ARR, 3x month-over-month growth, and a $3M SAFE round with $1.5M remaining.',
          'Nova & Nova Deck Here.',
        ].join(' '),
        bodyPreview: 'About Nova & Nova. Nova & Nova has $2M ARR and a SAFE round.',
      },
      sourceType: 'conversation',
      mention: {
        raw: 'Nova',
        canonicalName: 'Nova',
        normalizedName: normalizeProspectName('Nova'),
        mentionOrdinal: 1,
        spanStart: null,
        spanEnd: null,
        lineText: 'Nova & Nova has $2M ARR and a SAFE round.',
        contextText: 'Happy to intro. About Nova & Nova. Nova & Nova has $2M ARR and a SAFE round.',
        isListEntry: false,
        products: [],
      },
      cls: {
        prospectCompanyName: 'Nova',
        prospectAction: 'create_prospect',
        mentionType: 'inbound_prospect',
        shouldCreateProspect: true,
        possibleCompanyId: null,
        possibleDealId: null,
        linkedDealId: null,
        provisional: false,
        directionUncertain: false,
        metadata: {
          llm_reasoning: 'Nova is explicitly introduced with traction, SAFE details, and a deck.',
          has_create_evidence: true,
          target_evidence_reasons: ['subject_line_target_opportunity'],
        },
      },
      existing: {
        companyId: 'company-source-office',
        dealId: null,
        companyDomain: 'sourceoffice.example',
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'domain',
        identityScore: 98,
        identityStrength: 'hard',
        identityCandidates: [],
      },
    };

    const applied = __prospectIntelligenceTestHooks.applyFinalQualityDecisionToOutcome(
      row,
      {
        record_ordinal: 1,
        decision: 'block_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Identity conflict: known company match resolves to the source, but the source evidence describes Nova as the investment target.',
        model: 'claude-haiku-4-5-20251001',
      },
      'fqg_test_ampersand_conflict',
      new Map([[1, row]])
    );

    expect(applied.cls.shouldCreateProspect).toBe(true);
    expect(applied.cls.prospectAction).toBe('create_prospect');
    expect(applied.cls.prospectCompanyName).toBe('Nova & Nova');
    expect(applied.cls.metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Nova & Nova',
      blocked: false,
    });
  });

  it('uses reasoning target repair during fallback instead of creating the source entity', () => {
    const decision = __prospectIntelligenceTestHooks.fallbackProspectFinalQualityDecision(
      {
        item: {
          entityId: 'conv-final-gate-source-repair',
          subject: 'Intro & Field Systems seed round',
          bodyText: 'Advisor Group forwarded Field Systems to Medina. Field Systems is raising a seed round with a pitch deck.',
          bodyPreview: 'Field Systems seed round.',
        },
        sourceType: 'conversation',
        mention: {
          raw: 'Advisor Group',
          canonicalName: 'Advisor Group',
          normalizedName: normalizeProspectName('Advisor Group'),
          mentionOrdinal: 1,
          spanStart: null,
          spanEnd: null,
          lineText: 'Advisor Group forwarded Field Systems to Medina.',
          contextText: 'Advisor Group forwarded Field Systems to Medina. Field Systems is raising a seed round.',
          isListEntry: false,
          products: [],
        },
        cls: {
          prospectCompanyName: 'Advisor Group',
          metadata: {
            llm_reasoning: 'Field Systems is explicitly shared by Advisor Group as a seed investment opportunity for Medina.',
            reasoning_judge: {
              reason: 'Field Systems is the target; Advisor Group is only the source.',
            },
          },
        },
        existing: {
          companyId: 'company-advisor-group',
          dealId: null,
          matchStrength: 'domain',
          identityScore: 98,
          identityStrength: 'hard',
          identityCandidates: [],
        },
      } as any,
      1,
      'final_quality_gate_retry_error:INVALID_FINAL_QUALITY_GATE_JSON',
      true,
      {
        model: 'claude-haiku-4-5-20251001',
        parseFailed: true,
        retryUsed: true,
        batchSize: 1,
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-advisor-group',
            name: 'Advisor Group',
            domain: 'advisorgroup.example',
            website: 'https://advisorgroup.example',
            type: 'advisor',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:advisorgroup',
          aliasKeys: ['advisorgroup'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Field Systems',
      fallback_used: true,
      failed_open: false,
      fallback_basis: 'reasoning_target_repair',
    });
  });

  it('uses hard known-company identity to canonicalize final quality allows', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Fallom Labs',
            normalizedName: normalizeProspectName('Fallom Labs'),
          },
          cls: { prospectCompanyName: 'Fallom Labs', metadata: {} },
          existing: {
            companyId: 'company-fallom',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: { subject: 'Fallom Labs seed deck' },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-fallom',
            name: 'Fallom',
            domain: 'fallom.com',
            website: 'https://fallom.com',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:fallom',
          aliasKeys: ['fallom'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Fallom Labs',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The row names a clean company with target-specific evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Fallom',
    });
  });

  it('cleans tagline-style known company display names before final create', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Training Employees Against Cyber Risk | Acme Security',
            normalizedName: normalizeProspectName('Training Employees Against Cyber Risk | Acme Security'),
          },
          cls: {
            prospectCompanyName: 'Training Employees Against Cyber Risk | Acme Security',
            metadata: {
              llm_reasoning: 'Acme Security is the central company in a warm intro to Medina.',
              reasoning_judge: {
                reason: 'Acme Security is named as the investment target in the source.',
              },
            },
          },
          existing: {
            companyId: 'company-acme',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: { subject: 'Intro: Acme Security x Medina VC' },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-acme',
            name: 'Training Employees Against Cyber Risk | Acme Security',
            domain: 'acmesecurity.com',
            website: 'https://acmesecurity.com',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:acmesecurity',
          aliasKeys: ['acmesecurity'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Training Employees Against Cyber Risk | Acme Security',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The row has target-specific intro evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Acme Security',
    });
  });

  it('cleans trailing round and memo wrappers before final create', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          item: {
            subject: 'Acme Series Seed Extension Investment Memo Draft',
            bodyText: 'Acme Series Seed Extension Investment Memo Draft. Acme is raising a seed extension with a deck and diligence materials for Medina review.',
            bodyPreview: 'Acme seed extension memo.',
          },
          mention: {
            canonicalName: 'Acme Series',
            normalizedName: normalizeProspectName('Acme Series'),
            contextText: 'Acme Series Seed Extension Investment Memo Draft. Acme is raising a seed extension with a deck.',
            lineText: 'Acme Series Seed Extension Investment Memo Draft',
            isListEntry: false,
            products: [],
          },
          cls: {
            prospectCompanyName: 'Acme Series',
            metadata: {
              llm_reasoning: 'Acme is being reviewed as a seed extension investment opportunity with deck and diligence materials.',
              has_create_evidence: true,
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: null,
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:acme',
          aliasKeys: ['acme'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Acme Series',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The row is a private financing memo with target-specific evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'Acme',
    });
  });

  it('prefers source-title target over a dirty mismatched known-company display name', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Reinvent The Category Of Luxury Living - descriptor',
            normalizedName: normalizeProspectName('Reinvent The Category Of Luxury Living - descriptor'),
          },
          cls: {
            prospectCompanyName: 'Reinvent The Category Of Luxury Living - descriptor',
            metadata: {
              llm_reasoning: 'TargetCo is explicitly named in the co-investment opportunity.',
              reasoning_judge: {
                reason: 'The source title names TargetCo Series B as the investment target.',
              },
            },
          },
          existing: {
            companyId: 'company-dirty',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: { subject: 'Re: Medina Co-investment Opportunity: TargetCo Series B (Confidential)' },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-dirty',
            name: 'Reinvent The Category Of Luxury Living - descriptor',
            domain: 'descriptor.example',
            website: 'https://descriptor.example',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:targetco',
          aliasKeys: ['targetco'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Luxury Living Descriptor',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The source is a co-investment opportunity.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'TargetCo',
    });
  });

  it('removes meeting wrappers from hard known-company identity names', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Meeting QuantumCo',
            normalizedName: normalizeProspectName('Meeting QuantumCo'),
          },
          cls: {
            prospectCompanyName: 'Meeting QuantumCo',
            metadata: {
              llm_reasoning: 'QuantumCo is the central company in an active diligence meeting with Medina.',
              reasoning_judge: {
                reason: 'QuantumCo is the investment target and the meeting title is only a wrapper.',
              },
            },
          },
          existing: {
            companyId: 'company-quantumco',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: { subject: 'Fwd: Meeting QuantumCo <> Medina & Partner' },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-quantumco',
            name: 'Meeting QuantumCo',
            domain: 'quantumco.ai',
            website: 'https://quantumco.ai',
            type: 'startup',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:quantumco',
          aliasKeys: ['quantumco'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Meeting QuantumCo',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The meeting has target-specific diligence evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'QuantumCo',
    });
  });

  it('blocks foundation variants with only meeting and financial-review evidence', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Benefit',
            normalizedName: normalizeProspectName('Benefit'),
          },
          cls: {
            prospectCompanyName: 'Benefit',
            metadata: {
              llm_reasoning: 'Benefit is the central subject of a diligence meeting with founders, financials, and follow-up investment discussion.',
              reasoning_judge: {
                reason: 'Benefit is central to a private financial review meeting with Medina leadership.',
              },
              target_evidence_reasons: ['meeting_or_diligence_target', 'classifier_reasoning_affirms_target_investment'],
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: 'none',
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'Benefit financial review',
            bodyText: 'Meeting summary: Benefit founders reviewed financials with Medina and discussed follow-up diligence.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-benefit-foundation',
            name: 'The Benefit Foundation',
            domain: 'benefit.org',
            website: 'https://benefit.org',
            type: 'other',
            description: '501(c)(3) non-profit foundation that hosts charity events and sponsorship programs.',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:benefit',
          aliasKeys: ['benefit'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Benefit',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The meeting appears to show active diligence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'block_create',
      canonical_name: null,
      hard_block_reason: 'nonprofit_foundation_financial_review_without_for_profit_investment_terms',
    });
  });

  it('blocks consulting firms when financial review is the only prospect evidence', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Northline',
            normalizedName: normalizeProspectName('Northline'),
          },
          cls: {
            prospectCompanyName: 'Northline',
            metadata: {
              llm_reasoning: 'Northline is the subject of a financial review kickoff with Medina leadership.',
              reasoning_judge: {
                reason: 'Northline is central to a financial review kickoff and diligence discussion.',
              },
              target_evidence_reasons: ['meeting_or_diligence_target'],
            },
          },
          existing: {
            companyId: 'company-northline',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Meeting Summary: financial review kickoff',
            bodyText: 'Northline financial review kickoff. Financials were shared and next steps were discussed.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-northline',
            name: 'Northline',
            domain: 'northline.example',
            website: 'https://northline.example',
            type: 'other',
            description: 'Northline is a consulting firm providing finance operations and advisory services.',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:northline',
          aliasKeys: ['northline'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Northline',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Known identity match and financial review evidence support the row.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'block_create',
      canonical_name: null,
      hard_block_reason: 'service_provider_financial_review_without_investment_terms',
    });
  });

  it('blocks accounting and advisory firms when diligence language has no explicit investment terms', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Metro Accountants & Advisors',
            normalizedName: normalizeProspectName('Metro Accountants & Advisors'),
          },
          cls: {
            prospectCompanyName: 'Metro Accountants & Advisors',
            metadata: {
              llm_reasoning: 'Metro Accountants & Advisors is the central subject of a financial diligence meeting with Medina reviewing ARR, MRR, pipeline, and projections.',
              reasoning_judge: {
                reason: 'Metro Accountants & Advisors is central to a financial diligence meeting with Medina.',
              },
              target_evidence_reasons: ['meeting_or_diligence_target'],
            },
          },
          existing: {
            companyId: 'company-metro-advisors',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'Meeting Summary: Metro & Medina Quick Call',
            bodyText: 'Metro Accountants & Advisors financial review covered ARR, MRR, pipeline, founder forecasts, and next diligence questions.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-metro-advisors',
            name: 'Metro Accountants & Advisors',
            domain: 'metroadvisors.example',
            website: 'https://metroadvisors.example',
            type: 'other',
            description: 'Metro Accountants & Advisors is an accounting and advisory firm providing finance operations and tax services.',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:metro',
          aliasKeys: ['metro'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Metro Accountants & Advisors',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Known company context confirms identity and the meeting has diligence evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'block_create',
      canonical_name: null,
      hard_block_reason: 'service_provider_financial_review_without_investment_terms',
    });
  });

  it('blocks meeting participants when the source names a different target company', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Review Advisors',
            normalizedName: normalizeProspectName('Review Advisors'),
          },
          cls: {
            prospectCompanyName: 'Review Advisors',
            metadata: {
              llm_reasoning: 'Review Advisors joined a financial diligence call with Medina and discussed ARR, pipeline, and investment conditions.',
              reasoning_judge: {
                reason: 'Review Advisors appears central to a diligence meeting.',
              },
              target_evidence_reasons: ['meeting_or_diligence_target'],
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: null,
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'Meeting Summary: Review Advisors & Medina Quick Call',
            bodyText: [
              'MEETING SUMMARY: Review Advisors & Medina Quick Call',
              'Participants: Medina team; Review Advisors finance team.',
              'Investment contingency identified: founder must hire a CFO.',
              'DEAL INTELLIGENCE:',
              'Target company: Early-stage startup with AI revenue stream and partner-driven growth strategy.',
            ].join('\n'),
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'Review Advisors',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Review Advisors is central to the financial diligence call.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'block_create',
      canonical_name: null,
      hard_block_reason: 'source_names_different_target_company',
    });
  });

  it('blocks allow-labeled final decisions when the final reason says the row is not the target', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Northstar Wealth',
            normalizedName: normalizeProspectName('Northstar Wealth'),
          },
          cls: {
            prospectCompanyName: 'Northstar Wealth',
            metadata: {
              llm_reasoning: 'Northstar Wealth is the sender company website, not the investment target.',
              reasoning_judge: {
                reason: 'Generic round evidence appears nearby.',
              },
            },
          },
          existing: {
            companyId: 'company-northstar-wealth',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'RE: Event attendance confirmation',
            bodyText: 'Northstar Wealth is confirming attendance at a town hall event.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Northstar Wealth',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'Northstar Wealth is a wealth management firm and sender, not an investment target. No pitch, fundraise, round, or investment opportunity is present.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'block_create',
      canonical_name: null,
      hard_block_reason: 'final_quality_reason_says_not_target',
    });
  });

  it('renames financial diligence document labels to the named company target', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'Financial DD questionnaire',
            normalizedName: normalizeProspectName('Financial DD questionnaire'),
          },
          cls: {
            prospectCompanyName: 'Financial DD questionnaire',
            metadata: {
              llm_reasoning: 'NeuralPath is the central subject of a financial due diligence questionnaire with detailed financial model requests, indicating active investment review.',
              reasoning_judge: {
                reason: 'NeuralPath is the central subject of a private financial due diligence document and the company being reviewed for investment.',
              },
              target_evidence_reasons: ['pitch_or_investment_document_target'],
            },
          },
          existing: {
            companyId: null,
            dealId: null,
            matchStrength: null,
            identityScore: 0,
            identityStrength: 'none',
            identityCandidates: [],
          },
          item: {
            subject: 'NeuralPath Financial DD Questions_v3_TOP.docx',
            bodyText: 'NeuralPath financial due diligence questions ask for revenue, cash flow, projections, and investor model support.',
          },
        },
        neighborhood: null,
      } as any,
      {
        record_ordinal: 1,
        decision: 'rename_and_allow',
        canonical_name: 'Financial DD questionnaire',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'NeuralPath is the central subject of a financial due diligence document, indicating active investment review. Financial DD questionnaire is direct investment evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'rename_and_allow',
      canonical_name: 'NeuralPath',
    });
  });

  it('preserves real startup creates with direct round and deck evidence', () => {
    const decision = __prospectIntelligenceTestHooks.enforceProspectFinalQualityDecision(
      {
        row: {
          mention: {
            canonicalName: 'AtlasGrid',
            normalizedName: normalizeProspectName('AtlasGrid'),
          },
          cls: {
            prospectCompanyName: 'AtlasGrid',
            metadata: {
              llm_reasoning: 'AtlasGrid is raising a Seed round, shared an investor deck and data room with Medina, and is the investment target.',
              reasoning_judge: {
                reason: 'AtlasGrid is the candidate itself and the source contains Seed round, investor deck, and data room evidence.',
              },
              target_evidence_reasons: ['subject_line_target_opportunity', 'pitch_or_investment_document_target'],
            },
          },
          existing: {
            companyId: 'company-atlasgrid',
            dealId: null,
            matchStrength: 'domain',
            identityScore: 98,
            identityStrength: 'hard',
            identityCandidates: [],
          },
          item: {
            subject: 'AtlasGrid Seed round investor deck',
            bodyText: 'AtlasGrid is raising a Seed round and shared its investor deck, valuation, and data room with Medina.',
          },
        },
        neighborhood: {
          existingProspect: null,
          knownCompany: {
            id: 'company-atlasgrid',
            name: 'AtlasGrid',
            domain: 'atlasgrid.example',
            website: 'https://atlasgrid.example',
            type: 'startup',
            description: 'AtlasGrid is a venture-backed infrastructure software startup.',
          },
          knownDeal: null,
          identityCandidates: [],
          recentSignals: [],
          historicalContextCount: 0,
          duplicateGroupId: 'fqg:atlasgrid',
          aliasKeys: ['atlasgrid'],
          deterministicHint: { suggested_action: 'clean_create', reasons: [] },
        },
      } as any,
      {
        record_ordinal: 1,
        decision: 'allow_create',
        canonical_name: 'AtlasGrid',
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: 'The row has direct round and deck evidence.',
        model: 'claude-haiku-4-5-20251001',
      }
    );

    expect(decision).toMatchObject({
      decision: 'allow_create',
      canonical_name: 'AtlasGrid',
    });
  });

  it('repairs source-level classifier parse failures with small batch retries', async () => {
    resetClaudeMock();
    let sourceClassifierAttempts = 0;
    const names = Array.from({ length: 10 }, (_, index) => `Context Company ${index + 1}`);
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      let user: any;
      try {
        user = JSON.parse(String(request.user || '{}'));
      } catch {
        user = null;
      }
      if (!Array.isArray(user?.candidates)) {
        return {
          text: JSON.stringify({
            organizations: names.map(name => ({ name, raw: name, context: 'source context' })),
          }),
          usage: { input_tokens: 80, output_tokens: 16 },
          model: 'claude-haiku-4-5-20251001',
        };
      }
      sourceClassifierAttempts++;
      if (sourceClassifierAttempts === 1) {
        return {
          text: '{"decisions":[',
          usage: { input_tokens: 100, output_tokens: 4 },
          model: 'claude-haiku-4-5-20251001',
        };
      }
      return {
        text: JSON.stringify({
          decisions: (user.candidates || []).map((candidate: any) => ({
            mention_ordinal: candidate.mention_ordinal,
            is_prospect: false,
            prospect_company_name: null,
            direction: 'inbound',
            sector_key: 'uncategorized',
            sector_confidence: 0.2,
            confidence: 0.9,
            reasoning: 'The candidate is context only.',
          })),
        }),
        usage: { input_tokens: 90, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-source-parse-repair',
      source: 'email',
      subject: 'Family Office Call',
      bodyText: names.join('\\n'),
      bodyPreview: 'Context-heavy family office call.',
      fromEmail: 'source@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const result = await classifyProspectSignalsDryRun([item], 'org-1', env);

    expect(sourceClassifierAttempts).toBe(3);
    expect(result.stats.errors).toHaveLength(0);
    expect(result.decisions).toHaveLength(10);
    expect(result.decisions.every(row => row.prospect_action !== 'create_prospect' && !row.error)).toBe(true);
  });

  it('creates Tectonic from a one-pager document after deterministic name cleanup', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      let user: any;
      try {
        user = JSON.parse(request.user);
      } catch {
        return {
          text: '{"organizations":[{"name":"Tectonic","raw":"Tectonic_One Pager.pdf","context":"one-pager title"}]}',
          usage: { input_tokens: 80, output_tokens: 16 },
          model: 'claude-haiku-4-5-20251001',
        };
      }
      return {
        text: JSON.stringify({
          decisions: user.candidates.map((candidate: any) => ({
            mention_ordinal: candidate.mention_ordinal,
            is_prospect: candidate.company_name === 'Tectonic',
            prospect_company_name: candidate.company_name === 'Tectonic' ? 'Tectonic' : null,
            direction: 'inbound',
            sector_key: candidate.company_name === 'Tectonic' ? 'quantum' : 'uncategorized',
            sector_confidence: candidate.company_name === 'Tectonic' ? 0.9 : 0.2,
            confidence: candidate.company_name === 'Tectonic' ? 0.88 : 0.9,
            reasoning: candidate.company_name === 'Tectonic'
              ? 'Tectonic one-pager pitches post-quantum infrastructure with government credentials and migration opportunity.'
              : `${candidate.company_name} is context, not the investment target.`,
          })),
        }),
        usage: { input_tokens: 160, output_tokens: 48 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      externalId: 'doc-tectonic-one-pager',
      subject: 'Tectonic_One Pager.pdf',
      bodyText: [
        'Securing the world’s migration to post-quantum cryptography.',
        'Foundational infrastructure layer for government, defense, and enterprise.',
        'Active Navy SBIR, NIST CRADA, PQC Consortium Member, and DARPA ERIS Awardable.',
        'Products include post-quantum key management and cryptographic agility as a service.',
        'Navy SBIR, NIST, DARPA, and AWS are mentioned as context and credentials.',
      ].join('\n'),
      bodyPreview: 'Securing the world’s migration to post-quantum cryptography.',
      sentAt: '2026-06-11T15:18:47.609Z',
      orgId: 'org-1',
      visibility: 'private',
      entityType: 'document',
      entityId: 'doc-tectonic-one-pager',
      metadata: {
        org_id: 'org-1',
        visibility: 'private',
        document_type: 'deal_pitch',
        source_table: 'documents',
        source_id: 'doc-tectonic-one-pager',
        entity_name: 'Tectonic_One Pager.pdf',
        r2_key: 'org-1/document/doc-tectonic-one-pager.pdf',
        created_at: '2026-06-11T15:18:47.609Z',
      },
      text: [
        'Securing the world’s migration to post-quantum cryptography.',
        'Foundational infrastructure layer for government, defense, and enterprise.',
        'Active Navy SBIR, NIST CRADA, PQC Consortium Member, and DARPA ERIS Awardable.',
        'Products include post-quantum key management and cryptographic agility as a service.',
      ].join('\n'),
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'backfill' });

    expect(stats.errors).toEqual([]);
    expect(stats.prospects_upserted).toBe(1);
    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({
      canonical_name: 'Tectonic',
      normalized_name: 'tectonic',
    });
    expect(db.prospectSignals[0]).toMatchObject({
      normalized_mention: 'tectonic',
      mention_type: 'inbound_prospect',
      prospect_id: db.prospects[0].id,
    });
    expect(db.prospectSignals.map(signal => signal.normalized_mention)).not.toEqual(expect.arrayContaining(['tectoniconepager', 'navysbir', 'nist', 'darpa', 'aws']));
  });

  it('deduplicates same-source company and website aliases before classification', async () => {
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      entityType: 'document',
      entityId: 'doc-abra',
      subject: 'Pipeline Status Update',
      bodyText: 'Company Name Abra Company URL helloabra.com Short Description Abra builds procurement workflow automation.',
      text: 'Company Name Abra Company URL helloabra.com Short Description Abra builds procurement workflow automation.',
      sentAt: '2026-05-31T12:04:16.301Z',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', env, { allowLlm: false });

    expect(mentions.map(mention => mention.canonicalName)).toContain('Abra');
    expect(mentions.some(mention => mention.normalizedName === 'helloabra')).toBe(false);
    const abra = mentions.find(mention => mention.normalizedName === 'abra');
    expect(abra).toBeTruthy();
    expect(__prospectIntelligenceTestHooks.firstProspectDomainForMention(abra!, env)).toBe('helloabra.com');
  });

  it('does not treat money amounts as prospect domains', () => {
    const env = { D1: new FakeD1(), INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const mention: any = {
      raw: 'Atlas AI',
      canonicalName: 'Atlas AI',
      normalizedName: 'atlasai',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: 'Atlas AI has $10.3M ARR and is reviewing a financing path.',
      contextText: 'Generated meeting summary: Atlas AI has $10.3M ARR and $25.0M valuation discussion.',
      isListEntry: false,
      products: [],
    };

    expect(__prospectIntelligenceTestHooks.firstProspectDomainForMention(mention, env)).toBeNull();
  });

  it('uses manual prospect aliases to merge dirty spellings into existing prospects', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Neural Seq","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.93,"reasoning":"Neural Seq is named as the direct company being reviewed with deck and diligence evidence."}]}',
        usage: { input_tokens: 90, output_tokens: 30 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    db.prospects.push({
      id: 'prospect-neuralseek',
      org_id: 'org-1',
      canonical_name: 'NeuralSeek',
      normalized_name: 'neuralseek',
      domain: 'neuralseek.com',
      website: 'https://neuralseek.com',
      status: 'active',
      signal_count: 12,
      evidence_count: 12,
      created_at: '2026-05-01T00:00:00.000Z',
    });
    db.identityAliases.push({
      id: 'alias-neuralseq',
      org_id: 'org-1',
      entity_type: 'prospect',
      entity_id: 'prospect-neuralseek',
      alias_kind: 'manual',
      alias_value: 'neuralseq',
      confidence: 1,
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-neural-seq',
      source: 'email',
      subject: 'Neural Seq deck for Medina review',
      bodyText: 'Neural Seq founder shared a deck and diligence materials for Medina review.',
      bodyPreview: 'Neural Seq deck',
      fromEmail: 'founder@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(db.prospects.filter(row => row.normalized_name === 'neuralseq' && !row.deleted_at)).toHaveLength(0);
    expect(db.prospectSignals[0]).toMatchObject({
      prospect_id: 'prospect-neuralseek',
      mention_type: 'inbound_prospect',
    });
  });

  it('does not rename a source-backed candidate to a mismatched source company id', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) {
        return reasoningJudgeResponse(
          'allow_create',
          "Direct Medina partner email explicitly says the partner wants to learn more about Lattica and that Lattica fits Medina's wheelhouse."
        );
      }
      if (isFinalQualityGateRequest(request)) {
        const user = JSON.parse(String(request.user || '{}'));
        return finalQualityGateResponse((user.records || []).map((record: any) => ({
          record_ordinal: record.record_ordinal,
          decision: 'rename_and_allow',
          canonical_name: 'The Zeal Company',
          merge_target_ordinal: null,
          merge_target_prospect_id: null,
          reason: "Proposed name 'Lattica' is an alias or working name for known company The Zeal Company based on source_item_company_id/direct_company_id context.",
        })));
      }
      return {
        text: JSON.stringify({
          decisions: [{
            mention_ordinal: 1,
            is_prospect: true,
            prospect_company_name: 'Lattica',
            direction: 'outbound',
            sector_key: 'cybersecurity',
            sector_confidence: 0.86,
            confidence: 0.92,
            reasoning: "A Medina partner explicitly says he would love to learn more about Lattica, that it fits Medina Ventures' wheelhouse, and offers go-to-market support.",
          }],
        }),
        usage: { input_tokens: 120, output_tokens: 40 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    db.companies.push({
      id: 'company-zeal',
      org_id: 'org-1',
      name: 'The Zeal Company',
      domain: 'tz.co',
      website: 'https://tz.co',
      company_type: 'startup',
      investment_status: 'prospect',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-lattica',
      source: 'email',
      companyId: 'company-zeal',
      subject: 'Lattica & Medina Ventures',
      bodyText: "Sebastian, I'd love to learn more about Lattica. As I mentioned, it feels very much in our wheelhouse at Medina Ventures. We'd be happy to be helpful on the go-to-market side, particularly around national security opportunities.",
      bodyPreview: "I'd love to learn more about Lattica.",
      fromEmail: 'raul@medinavc.com',
      toEmails: ['sebastian@example.com'],
      sentAt: '2026-06-18T21:00:00.000Z',
      direction: 'outbound',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({
      canonical_name: 'Lattica',
      normalized_name: 'lattica',
    });
    expect(db.prospects[0].company_id || null).toBeNull();
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'inbound_prospect',
      raw_mention_text: 'Lattica',
      normalized_mention: 'lattica',
      prospect_id: db.prospects[0].id,
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.known_entity_audit).toMatchObject({
      match_strength: 'none',
      identity_strength: 'weak',
      identity_method: 'direct_company_id',
    });
    expect(metadata.known_entity_audit.identity_candidates[0].reasons).toEqual(
      expect.arrayContaining(['source_item_company_id_mismatch_candidate_name', 'source_company_context_audit_only'])
    );
    expect(metadata.prospect_final_quality_gate).toMatchObject({
      decision: 'allow_create',
      canonical_name: 'Lattica',
      renamed: false,
    });
    expect(metadata.prospect_final_quality_gate.reason).toMatch(/preserved source-backed candidate Lattica/i);
  });

  it('creates a new prospect-origin company instead of linking a domain-conflicting same-name CRM company', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock
      .mockResolvedValueOnce({
        text: '{"organizations":[]}',
        usage: { input_tokens: 80, output_tokens: 8 },
        model: 'claude-haiku-4-5-20251001',
      })
      .mockResolvedValueOnce({
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Abra","direction":"inbound","sector_key":"ai_data","sector_confidence":0.88,"confidence":0.85,"reasoning":"Abra is listed as a seed-stage AI procurement prospect."}]}',
        usage: { input_tokens: 100, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      });
    const db = new FakeD1();
    db.companies.push({ id: 'company-abra-old', org_id: 'org-1', name: 'Abra', domain: 'abra.com' });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'email_attachment',
      entityType: 'document',
      entityId: 'doc-abra-split',
      subject: 'Abra Seed Round Memo.pdf',
      bodyText: 'Company Name Abra Company URL helloabra.com Short Description Abra builds an AI-driven system of action for vendor relationships and is raising a seed round.',
      text: 'Company Name Abra Company URL helloabra.com Short Description Abra builds an AI-driven system of action for vendor relationships and is raising a seed round.',
      bodyPreview: 'Abra LOW Radar AI Mountain View helloabra.com',
      sentAt: '2026-05-31T12:04:16.301Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'backfill' });

    expect(stats.errors).toEqual([]);
    expect(stats.signals_recorded).toBe(1);
    expect(stats.prospects_upserted).toBe(1);
    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({
      canonical_name: 'Abra',
      normalized_name: 'abra',
      domain: 'helloabra.com',
      website: 'https://helloabra.com',
      company_id: db.companies.find(company => company.id !== 'company-abra-old')?.id,
      possible_company_id: null,
    });
    const createdCompany = db.companies.find(company => company.id !== 'company-abra-old');
    expect(createdCompany).toMatchObject({
      name: 'Abra',
      domain: 'helloabra.com',
      website: 'https://helloabra.com',
      company_type: 'startup',
      investment_status: 'prospect',
    });
    expect(db.prospectSignals).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      raw_mention_text: 'Abra',
      normalized_mention: 'abra',
      prospect_id: db.prospects[0].id,
      company_id: createdCompany?.id,
    });
    expect(db.companyTags[0]).toMatchObject({ company_id: createdCompany?.id, tag_id: db.tags[0].id });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.company_resolution).toMatchObject({
      action: 'created',
      company_id: createdCompany?.id,
      match_method: 'created_new_company_weak_candidates_ignored',
      match_score: 0.86,
    });
    expect(metadata.company_resolution.candidates[0]).toMatchObject({
      company_id: 'company-abra-old',
      method: 'exact_normalized_name_domain_conflict',
    });
  });

  it('routes later website-label mentions to the existing canonical prospect', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Helloabra","direction":"inbound","sector_key":"ai_data","sector_confidence":0.86,"confidence":0.82,"reasoning":"helloabra.com appears in a dealflow source as an AI procurement prospect."}]}',
      usage: { input_tokens: 100, output_tokens: 24 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.prospects.push({
      id: 'prospect-abra',
      org_id: 'org-1',
      canonical_name: 'Abra',
      normalized_name: 'abra',
      domain: 'helloabra.com',
      website: 'https://helloabra.com',
      status: 'provisional',
      sector_key: 'ai_data',
      sector_confidence: 0.8,
      signal_count: 1,
      evidence_count: 1,
      confidence: 0.54,
      provisional: 1,
      direction_uncertain: 1,
      deleted_at: null,
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'email_attachment',
      entityType: 'document',
      entityId: 'doc-helloabra',
      subject: 'Pipeline Status Update',
      bodyText: 'Website helloabra.com Description AI procurement workflow automation raise.',
      text: 'Website helloabra.com Description AI procurement workflow automation raise.',
      bodyPreview: 'helloabra.com',
      sentAt: '2026-06-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'backfill' });

    expect(stats.prospects_upserted).toBe(1);
    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({
      id: 'prospect-abra',
      canonical_name: 'Abra',
      normalized_name: 'abra',
    });
    expect(db.prospectSignals[0]).toMatchObject({
      normalized_mention: 'abra',
      prospect_id: 'prospect-abra',
    });
  });

  it('classifies prospect signals in dry-run mode without writing prospects or signals', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Artlabs","direction":"inbound","sector_key":"ai_data","sector_confidence":0.8,"confidence":0.94,"reasoning":"Artlabs is raising with a company profile and deck."}]}',
      usage: { input_tokens: 100, output_tokens: 24 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    const readOnlyD1 = {
      prepare(sql: string) {
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) {
          throw new Error(`unexpected write: ${sql}`);
        }
        return db.prepare(sql);
      },
    };
    const env = { D1: readOnlyD1, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      externalId: 'doc-dry',
      subject: 'Artlabs investment memo',
      bodyText: 'Company Name Artlabs Company URL https://artlabs.ai Founder(s) Ben Smith Short Description AI art infrastructure. Artlabs is raising a seed round and attached a pitch deck.',
      bodyPreview: 'Artlabs is raising a seed round.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      entityType: 'document',
      entityId: 'doc-dry',
      contactIds: [],
      participantUserIds: [],
      metadata: {
        org_id: 'org-1',
        visibility: 'private',
        document_type: 'pitch_deck',
        source_table: 'documents',
        source_id: 'doc-dry',
        r2_key: 'org-1/document/doc-dry.pdf',
        created_at: '2026-05-01T00:00:00.000Z',
        primary_entity_id: 'doc-dry',
      },
      text: 'Company Name Artlabs Company URL https://artlabs.ai Founder(s) Ben Smith Short Description AI art infrastructure. Artlabs is raising a seed round and attached a pitch deck.',
    };

    const result = await classifyProspectSignalsDryRun([item], 'org-1', env);

    expect(result).toMatchObject({
      dry_run: true,
      rows_written: 0,
      changed_db: false,
      decision_counts: {
        create_prospect: 1,
        attach_existing_deal: 0,
        record_context: 0,
        ignore: 0,
        classifier_error: 0,
      },
    });
    expect(result.decisions[0]).toMatchObject({
      source_type: 'document',
      source_id: 'doc-dry',
      company_name: 'Artlabs',
      prospect_action: 'create_prospect',
      duplicate_key: 'document:doc-dry:1:artlabs',
    });
    expect(callClaudeWithUsageMock.mock.calls[0][0]).toMatchObject({ dryRunNoBudgetWrites: true });
    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals).toHaveLength(0);
  });

  it('classifies multiple source candidates with one source-level Claude call in dry-run mode', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      const user = JSON.parse(request.user);
      return {
        text: JSON.stringify({
          decisions: user.candidates.map((row: any) => ({
            mention_ordinal: row.mention_ordinal,
            is_prospect: true,
            prospect_company_name: row.company_name,
            direction: 'inbound',
            sector_key: row.company_name === 'Betacyber' ? 'cybersecurity' : row.company_name === 'Gammaquantum' ? 'quantum' : 'ai_data',
            sector_confidence: 0.9,
            confidence: 0.97,
            reasoning: `${row.company_name} is presented as an investment opportunity and is raising a seed round.`,
          })),
        }),
        usage: { input_tokens: 100, output_tokens: 40 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const readOnlyD1 = {
      prepare(sql: string) {
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) {
          throw new Error(`unexpected write: ${sql}`);
        }
        return db.prepare(sql);
      },
    };
    const env = { D1: readOnlyD1, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      entityType: 'document',
      entityId: 'doc-multi-source',
      subject: 'Pipeline list',
      bodyText: [
        'Company Name AlphaAI Website alphaai.com Short Description AI workflow automation. AlphaAI is raising a seed round.',
        'Company Name BetaCyber Website betacyber.com Short Description security automation. BetaCyber is raising a seed round.',
        'Company Name GammaQuantum Website gammaquantum.io Short Description quantum software. GammaQuantum is raising a seed round.',
      ].join('\n'),
      bodyPreview: 'Three companies are raising seed rounds.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {
        org_id: 'org-1',
        visibility: 'private',
        source_table: 'documents',
        source_id: 'doc-multi-source',
      },
      text: [
        'Company Name AlphaAI Website alphaai.com Short Description AI workflow automation. AlphaAI is raising a seed round.',
        'Company Name BetaCyber Website betacyber.com Short Description security automation. BetaCyber is raising a seed round.',
        'Company Name GammaQuantum Website gammaquantum.io Short Description quantum software. GammaQuantum is raising a seed round.',
      ].join('\n'),
    };

    const result = await classifyProspectSignalsDryRun([item], 'org-1', env);

    const classifierCalls = callClaudeWithUsageMock.mock.calls.filter(([request]) => {
      try {
        return Array.isArray(JSON.parse(String(request.user || '{}')).candidates);
      } catch {
        return false;
      }
    });
    expect(classifierCalls).toHaveLength(1);
    const classifierPayload = JSON.parse(classifierCalls[0][0].user);
    const classifierSystem = classifierCalls[0][0].system as any[];
    expect(classifierSystem[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(classifierSystem[1].text).toContain('SOURCE-LEVEL MODE');
    expect(classifierSystem[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(classifierSystem[2].text).toContain('KNOWN open deals');
    expect(classifierPayload.candidates.length).toBeGreaterThanOrEqual(3);
    expect(result.stats.classifier_paid_calls).toBe(1);
    expect(result.stats.classifier_cache_misses).toBe(1);
    expect(result.stats.llm_stage_usage.source_classifier).toMatchObject({ paid_calls: 1, cache_misses: 1 });
    expect(result.stats.llm_stage_usage.reasoning_judge).toMatchObject({ paid_calls: classifierPayload.candidates.length });
    expect(result.decision_counts.create_prospect).toBe(classifierPayload.candidates.length);
    expect(result.decisions[0]).toMatchObject({
      original_llm_is_prospect: true,
      original_llm_prospect_action: 'create_prospect',
      reasoning_judge_action: 'allow_create',
      reasoning_judge_valid: true,
      second_look_required: false,
      second_look_lane: null,
      second_look_recommended_action: 'none',
      second_look_create_blocked: false,
      second_look_block_reason: null,
    });
    expect(result.decisions[0].target_evidence_reasons || '').toContain('classifier_reasoning_affirms_target_investment');
    expect(result.decisions.map(row => row.company_name)).toEqual(
      classifierPayload.candidates.map((row: any) => row.company_name)
    );
    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals).toHaveLength(0);
  });

  it('repairs missing source-level decisions with one missing-only retry', async () => {
    resetClaudeMock();
    let sourceBatchCallCount = 0;
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      try {
        const user = JSON.parse(String(request.user || '{}'));
        if (Array.isArray(user.candidates)) {
          sourceBatchCallCount++;
          return {
            text: JSON.stringify({
              decisions: user.candidates.map((row: any) => ({
                mention_ordinal: row.mention_ordinal,
                is_prospect: true,
                prospect_company_name: row.company_name,
                direction: 'inbound',
                sector_key: 'ai_data',
                sector_confidence: 0.9,
                confidence: sourceBatchCallCount === 1 && row.company_name === 'BetaCyber' ? 1.4 : 0.97,
                reasoning: sourceBatchCallCount === 1 && row.company_name === 'BetaCyber'
                  ? `${row.company_name} has malformed confidence and should be retried without falling back to a single-candidate call.`
                  : `${row.company_name} is presented as an investment opportunity and is raising a seed round.`,
              })),
            }),
            usage: { input_tokens: 100, output_tokens: 20 },
            model: 'claude-haiku-4-5-20251001',
          };
        }
      } catch {
        // Single-candidate prompts are text, not source-level JSON.
      }
      const company = String(request.user || '').match(/MENTION \(the company in question\): ([^\n]+)/)?.[1] || 'FallbackCo';
      return {
        text: JSON.stringify({
          is_prospect: true,
          prospect_company_name: company,
          direction: 'inbound',
          sector_key: company === 'BetaCyber' ? 'cybersecurity' : 'ai_data',
          sector_confidence: 0.86,
          confidence: 0.94,
          reasoning: `${company} is the company being pitched with a seed round.`,
        }),
        usage: { input_tokens: 70, output_tokens: 18 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const cacheRows = new Map<string, any>();
    const classifierCache = {
      async get(key: string) {
        return cacheRows.get(key) || null;
      },
      async put(value: any) {
        cacheRows.set(value.cache_key, value);
      },
    };
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      entityType: 'document',
      entityId: 'doc-partial-source-batch',
      subject: 'Pipeline list',
      bodyText: [
        'Company Name AlphaAI Website alphaai.com Short Description AI workflow automation. AlphaAI is raising a seed round.',
        'Company Name BetaCyber Website betacyber.com Short Description security automation. BetaCyber is raising a seed round.',
      ].join('\n'),
      bodyPreview: 'Two companies are raising seed rounds.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {},
      text: [
        'Company Name AlphaAI Website alphaai.com Short Description AI workflow automation. AlphaAI is raising a seed round.',
        'Company Name BetaCyber Website betacyber.com Short Description security automation. BetaCyber is raising a seed round.',
      ].join('\n'),
    };

    const result = await classifyProspectSignalsDryRun([item], 'org-1', env, { classifierCache });

    const sourceBatchCalls = callClaudeWithUsageMock.mock.calls.filter(([request]) => {
      try {
        return Array.isArray(JSON.parse(String(request.user || '{}')).candidates);
      } catch {
        return false;
      }
    });
    const singleCandidateCalls = callClaudeWithUsageMock.mock.calls.filter(([request]) =>
      /MENTION \(the company in question\):/i.test(String(request.user || ''))
    );
    expect(sourceBatchCalls).toHaveLength(2);
    const retryPayload = JSON.parse(sourceBatchCalls[1][0].user);
    expect(retryPayload.candidates).toHaveLength(1);
    expect(retryPayload.candidates[0]).toMatchObject({ company_name: 'BetaCyber' });
    expect(singleCandidateCalls).toHaveLength(0);
    expect(cacheRows.size).toBe(1);
    expect(result.stats.classifications_pending).toBe(0);
    expect(result.decisions.some(row => row.company_name === 'BetaCyber' && row.should_create_prospect)).toBe(true);
  });

  it('records still-missing source-level decisions as audit context instead of classifier errors', async () => {
    resetClaudeMock();
    let sourceBatchCallCount = 0;
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      try {
        const user = JSON.parse(String(request.user || '{}'));
        if (Array.isArray(user.candidates)) {
          sourceBatchCallCount++;
          return {
            text: JSON.stringify({
              decisions: user.candidates
                .filter((row: any) => row.company_name === 'AlphaAI')
                .map((row: any) => ({
                  mention_ordinal: row.mention_ordinal,
                  is_prospect: false,
                  prospect_company_name: null,
                  direction: 'inbound',
                  sector_key: 'ai_data',
                  sector_confidence: 0.7,
                  confidence: 0.82,
                  reasoning: `${row.company_name} is only reference context in this source.`,
                })),
            }),
            usage: { input_tokens: 100, output_tokens: 20 },
            model: 'claude-haiku-4-5-20251001',
          };
        }
      } catch {
        // Organization extraction prompts are plain text.
      }
      return {
        text: '{"organizations":[]}',
        usage: { input_tokens: 20, output_tokens: 5 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      entityType: 'document',
      entityId: 'doc-still-partial-source-batch',
      subject: 'Pipeline reference list',
      bodyText: [
        'Company Name AlphaAI Website alphaai.com Short Description AI workflow automation.',
        'Company Name BetaCyber Website betacyber.com Short Description security automation.',
      ].join('\n'),
      bodyPreview: 'Two company reference rows.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {},
      text: [
        'Company Name AlphaAI Website alphaai.com Short Description AI workflow automation.',
        'Company Name BetaCyber Website betacyber.com Short Description security automation.',
      ].join('\n'),
    };

    const result = await classifyProspectSignalsDryRun([item], 'org-1', env);
    const sourceBatchCalls = callClaudeWithUsageMock.mock.calls.filter(([request]) => {
      try {
        return Array.isArray(JSON.parse(String(request.user || '{}')).candidates);
      } catch {
        return false;
      }
    });
    const retryPayload = JSON.parse(sourceBatchCalls[1][0].user);
    const betaDecision = result.decisions.find(row => row.company_name === 'BetaCyber');

    expect(sourceBatchCallCount).toBe(2);
    expect(retryPayload.candidates).toHaveLength(1);
    expect(retryPayload.candidates[0]).toMatchObject({ company_name: 'BetaCyber' });
    expect(result.decision_counts.classifier_error).toBe(0);
    expect(result.stats.classifications_pending).toBe(1);
    expect(betaDecision).toMatchObject({
      prospect_action: 'record_context',
      mention_type: 'noise',
      should_create_prospect: false,
      error: null,
    });
    expect(betaDecision?.reasoning || '').toContain('omitted this candidate');
  });

  it('recovers explicit investment targets when source-level classification is too conservative', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      const user = JSON.parse(String(request.user || '{}'));
      return {
        text: JSON.stringify({
          decisions: user.candidates.map((row: any) => ({
            mention_ordinal: row.mention_ordinal,
            is_prospect: false,
            prospect_company_name: null,
            direction: 'inbound',
            sector_key: row.company_name === 'Diapin Therapeutics' ? 'healthcare' : 'ai_data',
            sector_confidence: 0.8,
            confidence: row.company_name === 'Diapin Therapeutics' ? 0.92 : 0.72,
            reasoning: row.company_name === 'Diapin Therapeutics'
              ? 'Diapin Therapeutics is off-thesis healthcare for Medina Ventures.'
              : 'Project Prometheus is explicitly pitched as an investment opportunity in the subject line.',
          })),
        }),
        usage: { input_tokens: 100, output_tokens: 40 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const items: any[] = [{
      type: 'email',
      source: 'outlook',
      entityType: 'conversation',
      entityId: 'conv-prometheus-repair',
      subject: 'Investment Opportunity: Project Prometheus Physical AI Lab',
      bodyText: 'Company Name Project Prometheus Short Description physical AI lab. The sender is forwarding an investment opportunity to Medina.',
      bodyPreview: 'Investment Opportunity: Project Prometheus',
      fromEmail: 'sender@example.com',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {},
      text: 'Company Name Project Prometheus Short Description physical AI lab. Investment opportunity.',
    }];

    const result = await classifyProspectSignalsDryRun(items, 'org-1', env);

    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        company_name: expect.stringMatching(/Project Prometheus/i),
        prospect_action: 'create_prospect',
      }),
    ]));
    expect(result.decision_counts.create_prospect).toBeGreaterThanOrEqual(1);
  });

  it('does not recover a known dealmaker/source as the prospect target', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      const user = JSON.parse(String(request.user || '{}'));
      return {
        text: JSON.stringify({
          decisions: user.candidates.map((row: any) => ({
            mention_ordinal: row.mention_ordinal,
            is_prospect: false,
            prospect_company_name: null,
            direction: 'inbound',
            sector_key: 'uncategorized',
            sector_confidence: 0.2,
            confidence: 0.97,
            reasoning: 'Warm intro from known dealmaker offering to share board/investor deck and meet. Clear investment opportunity signal.',
          })),
        }),
        usage: { input_tokens: 100, output_tokens: 40 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const items: any[] = [{
      type: 'email',
      source: 'outlook',
      entityType: 'conversation',
      entityId: 'conv-emerge-source',
      subject: 'Re: eMerge Update',
      bodyText: 'Company Name eMerge. Melissa from eMerge offered to share the board/investor deck and meet.',
      bodyPreview: 'eMerge Update',
      fromEmail: 'mmedina@emergeamericas.com',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {},
      text: 'Company Name eMerge. Melissa from eMerge offered to share the board/investor deck and meet.',
    }];

    const result = await classifyProspectSignalsDryRun(items, 'org-1', env);

    expect(result.decision_counts.create_prospect || 0).toBe(0);
    expect(result.decisions.some(row =>
      ['emerge', 'emergeamericas'].includes(row.normalized_company_name) &&
      row.should_create_prospect
    )).toBe(false);
  });

  it('recovers actual company rows from a fundraising packet when the source classifier is too conservative', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      const user = JSON.parse(String(request.user || '{}'));
      return {
        text: JSON.stringify({
          decisions: user.candidates.map((row: any) => {
            const company = String(row.company_name || '');
            return {
              mention_ordinal: row.mention_ordinal,
              is_prospect: false,
              prospect_company_name: null,
              direction: 'inbound',
              sector_key: /Portal|Engenius/i.test(company) ? 'aerospace_defense' : 'uncategorized',
              sector_confidence: /Portal|Engenius/i.test(company) ? 0.8 : 0.2,
              confidence: 0.94,
              reasoning: /Portal/i.test(company)
                ? `${company} is listed in the Army FUZE SBIR Companies Fund Raising packet with a $6.5M Seed/Series A ask and CEO contact.`
                : /Engenius/i.test(company)
                  ? `${company} is listed in the Army FUZE SBIR Companies Fund Raising packet with a Series A $20M ask and CEO contact.`
                  : `${company} is source or wrapper context, not the investment target.`,
            };
          }),
        }),
        usage: { input_tokens: 120, output_tokens: 60 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      source: 'outlook',
      entityType: 'document',
      entityId: 'doc-army-fuze',
      subject: 'Army FUZE SBIR Companies Fund Raising',
      bodyText: [
        'Army FUZE SBIR Companies Fund Raising',
        'Company Name Portal Aircraft Company Website portalaircraft.com Round Stage Seed/Series A Amount $6.5M POC CEO Short Description autonomous electric aircraft.',
        'Company Name EngeniusMicro Website engeniusmicro.com Round Stage Series A Amount $20M POC CEO Short Description rugged edge compute for defense systems.',
      ].join('\n'),
      bodyPreview: 'SBIR Companies Fund Raising with asks and contacts.',
      sentAt: '2026-05-01T00:00:00.000Z',
      orgId: 'org-1',
      visibility: 'private',
      metadata: {
        org_id: 'org-1',
        visibility: 'private',
        source_table: 'documents',
        source_id: 'doc-army-fuze',
      },
      text: [
        'Army FUZE SBIR Companies Fund Raising',
        'Company Name Portal Aircraft Company Website portalaircraft.com Round Stage Seed/Series A Amount $6.5M POC CEO Short Description autonomous electric aircraft.',
        'Company Name EngeniusMicro Website engeniusmicro.com Round Stage Series A Amount $20M POC CEO Short Description rugged edge compute for defense systems.',
      ].join('\n'),
    };

    const result = await classifyProspectSignalsDryRun([item], 'org-1', env);

    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        company_name: expect.stringMatching(/Portal Aircraft/i),
        prospect_action: 'create_prospect',
        should_create_prospect: true,
      }),
      expect.objectContaining({
        company_name: expect.stringMatching(/Engenius/i),
        prospect_action: 'create_prospect',
        should_create_prospect: true,
      }),
    ]));
    expect(result.decisions.some(row =>
      /Army FUZE|SBIR Companies Fund Raising/i.test(row.company_name) &&
      row.should_create_prospect
    )).toBe(false);
  });

  it('recovers a warm-intro target without promoting the known source beside it', () => {
    const { hasClassifierContradictoryTargetIntent } = __prospectIntelligenceTestHooks;
    const rawExcerpt = 'eMerge is forwarding VeryAI to Medina Ventures. VeryAI founder materials include an investor deck and Seed discussion for a follow-up meeting.';
    const baseInput: any = {
      sourceType: 'conversation',
      senderAndContext: 'subject: Warm intro: VeryAI <> Medina Ventures',
      rawExcerpt,
      prefilterHints: {},
      sectorHints: { key: 'ai_data', confidence: 0.8 },
      knownContext: { knownDeals: [], knownDealmakers: [{ name: 'eMerge', domain: 'emergeamericas.com' }] },
      orgId: 'org-1',
    };
    const targetMention: any = {
      raw: 'VeryAI',
      canonicalName: 'VeryAI',
      normalizedName: 'veryai',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: rawExcerpt,
      contextText: rawExcerpt,
      isListEntry: false,
      products: [],
    };
    const sourceMention: any = {
      ...targetMention,
      raw: 'eMerge',
      canonicalName: 'EMerge',
      normalizedName: 'emerge',
    };

    expect(hasClassifierContradictoryTargetIntent({
      isProspect: false,
      mentionType: 'noise',
      prospectAction: 'ignore',
      prospectCompanyName: null,
      direction: 'inbound',
      sectorKey: 'ai_data',
      sectorConfidence: 0.85,
      confidence: 0.72,
      reasoning: 'VeryAI is introduced to Medina by eMerge with founder materials, an investor deck, and a Seed discussion.',
      model: 'claude-haiku-4-5-20251001',
    } as any, { ...baseInput, companyName: 'VeryAI' }, targetMention)).toBe(true);

    expect(hasClassifierContradictoryTargetIntent({
      isProspect: false,
      mentionType: 'noise',
      prospectAction: 'ignore',
      prospectCompanyName: null,
      direction: 'inbound',
      sectorKey: 'uncategorized',
      sectorConfidence: 0.2,
      confidence: 0.96,
      reasoning: 'eMerge is the known intro source forwarding VeryAI, not itself as the investment target.',
      model: 'claude-haiku-4-5-20251001',
    } as any, { ...baseInput, companyName: 'EMerge' }, sourceMention)).toBe(false);
  });

  it('reuses the source-level classifier cache for repeated dry-run evaluations', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      try {
        const user = JSON.parse(String(request.user || '{}'));
        if (Array.isArray(user.candidates)) {
          return {
            text: JSON.stringify({
              decisions: user.candidates.map((row: any) => ({
                mention_ordinal: row.mention_ordinal,
                is_prospect: true,
                prospect_company_name: row.company_name,
                direction: 'inbound',
                sector_key: 'ai_data',
                sector_confidence: 0.9,
                confidence: 0.97,
                reasoning: `${row.company_name} is presented as an investment opportunity and is raising a seed round.`,
              })),
            }),
            usage: { input_tokens: 100, output_tokens: 40 },
            model: 'claude-haiku-4-5-20251001',
          };
        }
      } catch {
        // Extraction prompts are not JSON.
      }
      return {
        text: '{"organizations":[{"name":"CacheCo","raw":"CacheCo"}]}',
        usage: { input_tokens: 40, output_tokens: 10 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const cacheRows = new Map<string, any>();
    const classifierCache = {
      async get(key: string) {
        return cacheRows.get(key) || null;
      },
      async put(value: any) {
        cacheRows.set(value.cache_key, value);
      },
    };
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      source: 'outlook',
      entityType: 'conversation',
      entityId: 'conv-cacheco',
      subject: 'CacheCo seed round',
      bodyText: 'CacheCo is raising a seed round for AI workflow infrastructure.',
      bodyPreview: 'CacheCo is raising a seed round.',
      fromEmail: 'founder@cacheco.ai',
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const first = await classifyProspectSignalsDryRun([item], 'org-1', env, { classifierCache });
    const second = await classifyProspectSignalsDryRun([item], 'org-1', env, { classifierCache });
    const classifierCalls = callClaudeWithUsageMock.mock.calls.filter(([request]) => {
      try {
        return Array.isArray(JSON.parse(String(request.user || '{}')).candidates);
      } catch {
        return false;
      }
    });

    expect(first.stats.classifier_paid_calls).toBe(1);
    expect(second.stats.classifier_paid_calls).toBe(0);
    expect(second.stats.classifier_cache_hits).toBe(1);
    expect(second.stats.classifier_paid_calls_saved).toBe(1);
    expect(classifierCalls).toHaveLength(1);
  });

  it('only tolerates missing classifier context tables in explicit partial-schema dry runs', async () => {
    const env = {
      D1: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async all() {
              if (/firm_company_relationships/i.test(sql)) {
                throw new Error('D1_ERROR: no such table: firm_company_relationships');
              }
              if (/FROM dealmakers/i.test(sql)) {
                throw new Error('D1_ERROR: no such table: dealmakers');
              }
              return { results: [] };
            },
          };
        },
      },
    } as any;

    await expect(loadProspectClassifierKnownContext('org-1', env)).rejects.toThrow(/firm_company_relationships/);
    await expect(loadProspectClassifierKnownContext('org-1', env, { allowPartialSchema: true })).resolves.toEqual({
      knownDeals: [],
      knownDealmakers: [],
    });
  });

  it('marks the static classifier context for Anthropic prompt caching', () => {
    const { buildClassifierPrefilter, buildProspectClassifierPrompt, classifierInputForRuntime } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      bodyText: 'Auguria is raising a seed round.',
      fromEmail: 'alice@example.com',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = buildClassifierPrefilter(item, mention, existing, {} as any);
    const prompt = buildProspectClassifierPrompt(classifierInputForRuntime(item, mention, existing, prefilter, {
      knownDeals: [],
      knownDealmakers: [],
    }, 'org-1'));

    expect(Array.isArray(prompt.systemForApi)).toBe(true);
    expect((prompt.systemForApi as any[])[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('persists errored classifications as pending signals and retries them by deterministic key', async () => {
    callClaudeWithUsageMock
      .mockRejectedValueOnce(new Error('INVALID_JSON'))
      .mockResolvedValueOnce({
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Auguria","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Auguria is raising in an investment context."}]}',
        usage: { input_tokens: 100, output_tokens: 20 },
        model: 'claude-haiku-4-5-20251001',
      });

    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-1',
      source: 'email',
      subject: 'Funding update',
      bodyText: 'Auguria is raising a seed round for its security data platform.',
      bodyPreview: 'Auguria is raising',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const first = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'backfill' });

    expect(first.signals_recorded).toBe(1);
    expect(first.classifications_pending).toBe(1);
    expect(db.prospectSignals).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      source_type: 'conversation',
      source_id: 'conv-1',
      mention_ordinal: 1,
      classification_status: 'failed',
      resolution_status: 'pending',
      error_message: 'INVALID_JSON',
      classification_attempts: 1,
    });

    await recordProspectBackfillCoverage('org-1', env, {
      sourceFamily: 'email',
      windowStart: item.sentAt,
      windowEnd: item.sentAt,
      itemsScanned: 1,
      signalsRecorded: first.signals_recorded,
      prospectsUpserted: first.prospects_upserted,
      classificationsPending: first.classifications_pending,
      status: 'partial',
      error: first.errors[0]?.error,
    });
    expect(db.coverage[0]).toMatchObject({
      classifications_pending: 1,
      status: 'partial',
      error_message: 'INVALID_JSON',
    });

    const retry = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'backfill' });

    expect(retry.classifications_pending).toBe(0);
    expect(retry.prospects_upserted).toBe(1);
    expect(db.prospectSignals).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      source_type: 'conversation',
      source_id: 'conv-1',
      mention_ordinal: 1,
      classification_status: 'classified',
      resolution_status: 'resolved',
      error_message: null,
      classification_attempts: 2,
      mention_type: 'inbound_prospect',
      prospect_id: db.prospects[0].id,
    });
    expect(db.classificationHistory).toHaveLength(1);
  });

  it('commits medium-confidence classifications as final metadata and samples them for monitoring', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"organizations":[{"name":"Auguria","raw":"Auguria"}]}',
      usage: { input_tokens: 60, output_tokens: 12 },
      model: 'claude-haiku-4-5-20251001',
    }).mockResolvedValueOnce({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Auguria","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.8,"confidence":0.7,"reasoning":"Auguria is raising a seed round with diligence materials."}]}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.companies.push({ id: 'company-auguria-medium', org_id: 'org-1', name: 'Auguria', domain: 'auguria.com' });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-medium',
      source: 'email',
      subject: 'Intro to Auguria',
      bodyText: 'Auguria is raising a seed round for a security platform, with data room access and a diligence call requested.',
      bodyPreview: 'Warm intro to Auguria',
      fromEmail: 'founder@auguria.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);
    expect(stats.classifications_pending).toBe(0);
    expect(stats.production_samples_recorded).toBe(1);
    expect(db.prospects[0]).toMatchObject({ status: 'active', provisional: 0 });
    expect(db.prospectSignals[0]).toMatchObject({
      confidence_tier: 'medium',
      resolution_status: 'resolved',
    });
    expect(db.classifierSamples[0]).toMatchObject({
      source_id: 'conv-medium',
      sample_reason: 'medium_confidence',
      label_status: 'unlabeled',
    });
  });

  it('records signal-only inbound-looking relationship context without creating a prospect', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      try {
        const user = JSON.parse(String(request.user || '{}'));
        if (Array.isArray(user.candidates)) {
          return {
            text: JSON.stringify({
              decisions: user.candidates.map((row: any) => ({
                mention_ordinal: row.mention_ordinal,
                is_prospect: false,
                prospect_company_name: null,
                direction: 'inbound',
                sector_key: 'uncategorized',
                sector_confidence: 0.25,
                confidence: 0.86,
                reasoning: 'Useful relationship signal, but the named entity is not clearly the investment target.',
              })),
            }),
            usage: { input_tokens: 90, output_tokens: 30 },
            model: 'claude-haiku-4-5-20251001',
          };
        }
      } catch {
        // Non-JSON user payloads are extractor prompts in this test harness.
      }
      return {
        text: '{"organizations":[{"name":"MRAI Global","raw":"MRAI Global"}]}',
        usage: { input_tokens: 60, output_tokens: 12 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-signal-only',
      source: 'email',
      subject: 'Follow-up with MRAI Global',
      bodyText: 'Warm intro to MRAI Global as a relationship check-in; no company deck, round, or diligence ask yet.',
      bodyPreview: 'Warm intro to MRAI Global',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.signals_recorded).toBeGreaterThanOrEqual(1);
    expect(stats.prospects_upserted).toBe(0);
    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals.every(signal => signal.prospect_id == null)).toBe(true);
    const signal = db.prospectSignals.find(row => {
      const metadata = JSON.parse(row.metadata_json || '{}');
      return metadata.prospect_action === 'ignore';
    });
    expect(signal).toBeTruthy();
    expect(signal).toMatchObject({
      mention_type: 'noise',
      prospect_id: null,
    });
    expect(JSON.parse(signal!.metadata_json)).toMatchObject({
      prospect_action: 'ignore',
      should_create_prospect: false,
      context_signal: false,
    });
  });

  it('hard-vetoes LLM create_prospect outputs for obvious service-provider mentions', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      try {
        const user = JSON.parse(String(request.user || '{}'));
        if (Array.isArray(user.candidates)) {
          return {
            text: JSON.stringify({
              decisions: user.candidates.map((row: any) => ({
                mention_ordinal: row.mention_ordinal,
                is_prospect: true,
                prospect_company_name: row.company_name,
                direction: 'inbound',
                sector_key: 'fintech',
                sector_confidence: 0.65,
                confidence: 0.92,
                reasoning: row.company_name === 'Finalis Securities LLC'
                  ? 'Finalis Securities LLC appears near WavePoint investment opportunity language.'
                  : `${row.company_name} is the operating company raising $10M.`,
              })),
            }),
            usage: { input_tokens: 90, output_tokens: 30 },
            model: 'claude-haiku-4-5-20251001',
          };
        }
      } catch {
        // Organization extraction prompts are plain text.
      }
      return {
        text: '{"organizations":[{"name":"Finalis Securities LLC","raw":"Finalis Securities LLC"},{"name":"WavePoint Solutions","raw":"WavePoint Solutions"}]}',
        usage: { input_tokens: 60, output_tokens: 12 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-service-provider-veto',
      source: 'email',
      subject: 'WavePoint $10M raise',
      bodyText: 'Finalis Securities LLC is the exclusive financial advisor conducting a $10M raise for WavePoint Solutions. WavePoint Solutions is the operating company raising growth capital.',
      bodyPreview: 'Finalis Securities LLC is the exclusive financial advisor for WavePoint Solutions.',
      fromEmail: 'advisor@finalis.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);
    expect(stats.prospects_upserted).toBeGreaterThanOrEqual(1);
    expect(db.prospects.some(row => row.canonical_name === 'Finalis Securities LLC')).toBe(false);
    expect(db.prospectSignals.length).toBeGreaterThanOrEqual(1);
    const signal = db.prospectSignals.find(row => row.raw_mention_text === 'Finalis Securities LLC');
    expect(signal).toMatchObject({
      mention_type: 'noise',
      prospect_id: null,
      confidence_tier: 'high',
      resolution_status: 'resolved',
    });
    expect(JSON.parse(signal!.metadata_json)).toMatchObject({
      prospect_action: 'ignore',
      should_create_prospect: false,
      create_prospect_veto_applied: true,
      create_prospect_veto_reason: 'service_provider_or_intermediary',
      original_llm_prospect_action: 'create_prospect',
    });
  });

  it('does not let the cross-D1 role check second-guess high-confidence creates', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-helping-hands',
      org_id: 'org-1',
      name: 'Helping Hands',
      domain: 'helpinghands.org',
      company_type: 'other',
      description: 'Helping Hands is a nonprofit foundation.',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-high-confidence-role-exempt',
      source: 'email',
      subject: 'Pitch deck',
      bodyText: 'Company Name Helping Hands Company URL https://helpinghands.org Short Description AI platform with deck attached.',
      bodyPreview: 'Company Name Helping Hands',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      { companyId: 'company-helping-hands', dealId: null, companyDomain: 'helpinghands.org', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.96, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      checked: false,
      reason: 'high_confidence_create_exempt',
    });
  });

  it('uses company briefs and company_type to demote lower-confidence VC/fund creates', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-northstar',
      org_id: 'org-1',
      name: 'Northstar Ventures',
      domain: 'northstarventures.com',
      company_type: 'vc_firm',
      description: 'Northstar Ventures is a venture capital investment firm.',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-vc-demote',
      source: 'email',
      subject: 'Pitch deck',
      bodyText: 'Company Name Northstar Ventures Company URL https://northstarventures.com Short Description AI platform in dealflow note.',
      bodyPreview: 'Company Name Northstar Ventures',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      { companyId: 'company-northstar', dealId: null, companyDomain: 'northstarventures.com', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.87, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      checked: true,
      role: 'vc_firm',
      action_override: 'record_context',
      matched_company_id: 'company-northstar',
    });
  });

  it('does not let an ambiguous CRM fund label override a candidate-specific investor deck', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-cognovi',
      org_id: 'org-1',
      name: 'Cognovi',
      domain: 'cognovi.ai',
      company_type: 'lp',
      description: 'Legacy CRM label says LP, but the current source may still be new prospect evidence.',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'document',
      entityType: 'document',
      entityId: 'doc-cognovi-investor-deck',
      source: 'document',
      subject: 'Cognovi Investor Deck.pdf',
      bodyText: 'Cognovi Investor Deck. Cognovi is raising a Series A round and sharing diligence materials for Medina review.',
      bodyPreview: 'Cognovi Investor Deck',
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const mention: any = {
      raw: 'Cognovi',
      canonicalName: 'Cognovi',
      normalizedName: 'cognovi',
      mentionOrdinal: 1,
      spanStart: 0,
      spanEnd: 'Cognovi'.length,
      lineText: item.bodyText,
      contextText: item.bodyText,
      isListEntry: false,
      products: [],
    };

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      { companyId: 'company-cognovi', dealId: null, companyDomain: 'cognovi.ai', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.92, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      checked: true,
      role: 'lp_or_family_office',
      action_override: null,
      matched_company_id: 'company-cognovi',
      reason: 'cross_d1_lp_or_family_office_overridden_by_candidate_pitch_evidence',
    });
  });

  it('matches foundation-suffixed D1 company rows and demotes nonprofit creates', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-benefit-foundation',
      org_id: 'org-1',
      name: 'The Benefit Foundation',
      domain: 'benefit.org',
      company_type: 'other',
      investment_status: 'prospect',
      description: '501(c)(3) non-profit foundation supporting public safety personnel through charity events and programs.',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'event',
      entityType: 'event',
      entityId: 'event-benefit',
      source: 'outlook',
      subject: 'Benefit financial review',
      bodyText: 'Meeting summary: Benefit reviewed event financials and sponsorship follow-up with Medina.',
      bodyPreview: 'Benefit reviewed event financials.',
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const mention = {
      raw: 'Benefit',
      canonicalName: 'Benefit',
      normalizedName: 'benefit',
      mentionOrdinal: 0,
      spanStart: null,
      spanEnd: null,
      lineText: item.bodyText,
      contextText: item.bodyText,
      isListEntry: false,
      products: [],
    };

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.92, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      checked: true,
      role: 'nonprofit',
      action_override: 'record_context',
      matched_company_id: 'company-benefit-foundation',
    });
  });

  it('uses brokerage/risk-management briefs to demote source-firm creates', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-lockton',
      org_id: 'org-1',
      name: 'Lockton Companies',
      domain: 'lockton.com',
      company_type: 'other',
      description: 'Lockton is an insurance brokerage firm providing risk management and employee benefits services.',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-lockton-source',
      source: 'email',
      subject: 'Just FYI',
      bodyText: 'I connected O2i with Lockton and several family offices. Fernando Silva, Lockton Companies.',
      bodyPreview: 'I connected O2i with Lockton.',
      fromEmail: 'fsilva@lockton.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const mention = {
      raw: 'O2i',
      canonicalName: 'O2i',
      normalizedName: 'o2i',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: item.bodyText,
      contextText: item.bodyText,
      isListEntry: false,
      products: [],
    };

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      { companyId: 'company-lockton', dealId: null, companyDomain: 'lockton.com', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.78, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      role: 'vendor_or_service_provider',
      action_override: 'record_context',
      matched_company_id: 'company-lockton',
    });
  });

  it('uses brief text to demote lower-confidence investment-bank creates', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValue({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Bankco","direction":"inbound","sector_key":"fintech","sector_confidence":0.7,"confidence":0.86,"reasoning":"Bankco appears in a software platform opportunity."}]}',
      usage: { input_tokens: 90, output_tokens: 30 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.companies.push({
      id: 'company-bankco',
      org_id: 'org-1',
      name: 'Bankco',
      domain: 'bankco.com',
      company_type: 'other',
      description: 'Bankco is a commercial bank and financial institution.',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-bank-demote',
      source: 'email',
      subject: 'AI platform pitch deck',
      bodyText: 'Company Name Bankco Company URL https://bankco.com Short Description enterprise software platform raising seed.',
      bodyPreview: 'Company Name Bankco',
      fromEmail: 'founder@bankco.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(db.prospects).toHaveLength(0);
    expect(metadata.cross_d1_role_check).toMatchObject({
      role: 'bank',
      action_override: 'record_context',
    });
  });

  it('keeps lower-confidence creates with open-deal D1 evidence dedupe-only without emitting attach', async () => {
    const db = new FakeD1();
    db.companies.push({ id: 'company-toluai', org_id: 'org-1', name: 'TOLUAI', domain: 'toluai.com', company_type: 'startup' });
    db.deals.push({ id: 'deal-toluai', org_id: 'org-1', company_id: 'company-toluai', stage: 'due_diligence' });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-known-deal-role',
      source: 'email',
      subject: 'TOLUAI financial model',
      bodyText: 'Company Name TOLUAI Company URL https://toluai.com Short Description updated P&L and data room access for diligence.',
      bodyPreview: 'Company Name TOLUAI',
      fromEmail: 'founder@toluai.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      { companyId: 'company-toluai', dealId: 'deal-toluai', companyDomain: 'toluai.com', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.86, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      role: 'known_deal',
      action_override: null,
      matched_deal_id: 'deal-toluai',
    });
  });

  it('does not demote lower-confidence creates when D1 brief evidence says startup', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-nair',
      org_id: 'org-1',
      name: 'Nair Engineering',
      domain: 'nairengineering.com',
      company_type: 'startup',
      description: 'Nair Engineering is an early-stage medical AI startup building on-device AI models.',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-startup-allowed',
      source: 'email',
      subject: 'Pitch deck',
      bodyText: 'Company Name Nair Engineering Company URL https://nairengineering.com Short Description medical AI startup with pitch deck.',
      bodyPreview: 'Company Name Nair Engineering',
      fromEmail: 'founder@nairengineering.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      attachments: [{ id: 'deck', name: 'Nair Engineering Deck.pdf', size: 100, contentType: 'application/pdf' }],
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      { companyId: 'company-nair', dealId: null, companyDomain: 'nairengineering.com', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.86, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      role: 'startup_or_private_company',
      action_override: null,
    });
  });

  it('treats limited-info prospect-origin company rows as audit-only D1 support', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-thin',
      org_id: 'org-1',
      name: 'ThinCo',
      domain: null,
      website: null,
      company_type: 'startup',
      investment_status: 'prospect',
      custom_fields: JSON.stringify({
        prospect_origin: {
          created_by_prospect_pipeline: true,
          limited_info: true,
          evidence_quality: 'limited_info',
        },
        enrichment_guard: { status: 'blocked_insufficient_anchor' },
        limited_info_prospect: { status: 'limited_info' },
      }),
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'event',
      entityType: 'event',
      entityId: 'event-thinco',
      source: 'outlook',
      subject: 'Catch up: ThinCo & Medina',
      bodyText: 'Generated meeting summary: ThinCo was discussed in an investment-looking market update.',
      bodyPreview: 'ThinCo discussion',
      fromEmail: 'lucas@medinavc.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      direction: 'internal',
    };
    const mention: any = {
      raw: 'ThinCo',
      canonicalName: 'ThinCo',
      normalizedName: 'thinco',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: item.subject,
      contextText: item.bodyText,
      isListEntry: false,
      products: [],
    };

    const result = await __prospectIntelligenceTestHooks.classifyCompanyRoleFromD1(
      'org-1',
      item,
      mention,
      {
        companyId: 'company-thin',
        dealId: null,
        companyDomain: null,
        relationshipStates: [],
        isInternal: false,
        matchStrength: 'name',
      },
      env,
      { prospectAction: 'create_prospect', confidence: 0.86, provisional: true, directionUncertain: true }
    );

    expect(result.role).not.toBe('startup_or_private_company');
    expect(result.evidence.join(' ')).toMatch(/limited_info|audit-only|blocked_insufficient_anchor/);
    expect(result.action_override).toBeNull();
  });

  it('routes internal meeting rows with third-party allocation and only limited-info identity to context', () => {
    const env = { D1: new FakeD1(), INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'calendar_event',
      entityType: 'event',
      entityId: 'event-third-party-allocation',
      source: 'outlook',
      subject: 'Catch up: OSO & Medina',
      bodyText: 'Generated meeting summary: Pablo and OneSixOne secured allocations around ThinCo. Medina discussed market context and next steps.',
      bodyPreview: 'Pablo secured allocations around ThinCo.',
      fromEmail: 'lucas@medinavc.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      direction: 'internal',
    };
    const mention: any = {
      raw: 'ThinCo',
      canonicalName: 'ThinCo',
      normalizedName: 'thinco',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: item.subject,
      contextText: item.bodyText,
      isListEntry: false,
      products: [],
    };
    const existing = { companyId: 'company-thin', dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'name' as const };
    const prefilter = __prospectIntelligenceTestHooks.buildClassifierPrefilter(item, mention, existing, env);
    const result = __prospectIntelligenceTestHooks.verifyLowConfidenceProspect(
      item,
      mention,
      existing,
      prefilter,
      {
        checked: true,
        eligible: true,
        role: 'unknown',
        confidence: 'low',
        evidence: ['limited_info_prospect_company: audit-only company identity support'],
        action_override: null,
        matched_company_id: 'company-thin',
        matched_deal_id: null,
        reason: null,
      },
      env,
      { prospectAction: 'create_prospect', confidence: 0.86, provisional: true, directionUncertain: true }
    );

    expect(result).toMatchObject({
      checked: true,
      verdict: 'record_context',
      action_override: 'record_context',
      reason: 'low_confidence_third_party_allocation_context',
    });
    expect(result.extraction_flags).toContain('third_party_allocation_context');
  });

  it('still allows internal meeting creates when direct Medina evidence has a clean domain anchor', () => {
    const env = { D1: new FakeD1(), INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'calendar_event',
      entityType: 'event',
      entityId: 'event-clean-anchor',
      source: 'outlook',
      subject: 'CleanAI seed deck for Medina diligence',
      bodyText: 'Generated meeting summary: Medina reviewed CleanAI seed deck and diligence materials. Company URL cleanai.com.',
      bodyPreview: 'CleanAI seed deck',
      fromEmail: 'lucas@medinavc.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      direction: 'internal',
    };
    const mention: any = {
      raw: 'CleanAI',
      canonicalName: 'CleanAI',
      normalizedName: 'cleanai',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: item.subject,
      contextText: item.bodyText,
      isListEntry: false,
      products: [],
      listFields: { website: 'cleanai.com' },
    };
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = __prospectIntelligenceTestHooks.buildClassifierPrefilter(item, mention, existing, env);
    const result = __prospectIntelligenceTestHooks.verifyLowConfidenceProspect(
      item,
      mention,
      existing,
      prefilter,
      { checked: false, eligible: false, role: 'unknown', confidence: 'low', evidence: [], action_override: null, matched_company_id: null, matched_deal_id: null, reason: 'not_evaluated' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.86, provisional: true, directionUncertain: true }
    );

    expect(result.verdict).not.toBe('record_context');
    expect(result.extraction_flags).not.toContain('internal_meeting_without_clean_anchor');
  });

  it('keeps sub-0.8 creates when identity and investment intent are strongly verified', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Sentry AI","direction":"inbound","sector_key":"ai_data","sector_confidence":0.82,"confidence":0.78,"reasoning":"Sentry AI founder sent a direct seed pitch with a deck."}]}',
        usage: { input_tokens: 90, output_tokens: 30 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-low-confidence-verified',
      source: 'email',
      subject: 'Sentry AI seed pitch deck',
      bodyText: 'Company Name Sentry AI Company URL https://sentryai.com Problem security teams need AI agents Approach autonomous AI SOC analyst raising seed with pitch deck attached.',
      bodyPreview: 'Sentry AI seed pitch deck',
      fromEmail: 'founder@sentryai.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      attachments: [{ id: 'deck', name: 'Sentry AI Deck.pdf', size: 100, contentType: 'application/pdf' }],
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(db.prospects).toHaveLength(1);
    expect(db.prospects[0]).toMatchObject({ canonical_name: 'Sentry AI', status: 'active', provisional: 0 });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.low_confidence_verification).toMatchObject({
      checked: true,
      verdict: 'verified_create',
      action_override: null,
    });
  });

  it('keeps sub-0.8 one-signal opportunities as context instead of creating final prospects', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValue({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"MaybeCo","direction":"inbound","sector_key":"enterprise_software","sector_confidence":0.72,"confidence":0.78,"reasoning":"MaybeCo looks like a possible software company opportunity, but evidence is thin."}]}',
      usage: { input_tokens: 90, output_tokens: 30 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-low-confidence-provisional',
      source: 'email',
      subject: 'MaybeCo possible pitch',
      bodyText: 'Company Name MaybeCo Company URL https://maybeco.ai Short Description enterprise workflow software. Potential pitch opportunity.',
      bodyPreview: 'MaybeCo enterprise workflow software pitch.',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'noise',
      prospect_id: null,
      resolution_status: 'resolved',
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata).toMatchObject({
      prospect_action: 'record_context',
      should_create_prospect: false,
    });
    expect(metadata.low_confidence_verification).toMatchObject({
      checked: true,
      verdict: 'provisional_create',
      action_override: 'mark_provisional',
    });
    expect(metadata.prospect_finalization_gate).toMatchObject({
      final: false,
      blocked: true,
    });
    expect(metadata.prospect_finalization_gate.reasons).toContain('provisional_after_verification');
  });

  it('keeps D1-backed startup rows provisional when low-confidence source evidence is thin', async () => {
    const env = { D1: new FakeD1(), INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'calendar_event',
      entityType: 'event',
      entityId: 'event-hbeyond',
      source: 'outlook',
      subject: 'Accepted: Meet: Humberto Sanchez (HBeyond) & Medina Ventures',
      bodyText: '',
      bodyPreview: '',
      fromEmail: 'raul@medinavc.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      direction: 'internal',
    };
    const mention = {
      raw: 'HBeyond',
      canonicalName: 'HBeyond',
      normalizedName: 'hbeyond',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: item.subject,
      contextText: item.subject,
      isListEntry: false,
      products: [],
    };
    const prefilter = __prospectIntelligenceTestHooks.buildClassifierPrefilter(
      item,
      mention,
      { companyId: 'company-hbeyond', dealId: null, companyDomain: 'hbeyond.com', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      env
    );
    const result = __prospectIntelligenceTestHooks.verifyLowConfidenceProspect(
      item,
      mention,
      { companyId: 'company-hbeyond', dealId: null, companyDomain: 'hbeyond.com', relationshipStates: [], isInternal: false, matchStrength: 'domain' },
      prefilter,
      {
        checked: true,
        eligible: true,
        role: 'startup_or_private_company',
        confidence: 'medium',
        evidence: ['company brief describes startup/private software company'],
        action_override: null,
        matched_company_id: 'company-hbeyond',
        matched_deal_id: null,
        reason: null,
      },
      env,
      { prospectAction: 'create_prospect', confidence: 0.54, provisional: true, directionUncertain: true }
    );

    expect(result).toMatchObject({
      checked: true,
      verdict: 'provisional_create',
      action_override: 'mark_provisional',
    });
  });

  it('second-checks sub-0.96 creates and demotes thin context without investment intent', () => {
    const env = { D1: new FakeD1(), INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const ordinaryItem: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-ordinary-medium-confidence',
      source: 'email',
      subject: 'Intro to Northstar Analytics',
      bodyText: 'Alicia wanted to introduce Northstar Analytics to Medina for a first conversation.',
      bodyPreview: 'Intro to Northstar Analytics',
      fromEmail: 'alice@example.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const ordinaryMention = {
      raw: 'Northstar Analytics',
      canonicalName: 'Northstar Analytics',
      normalizedName: 'northstaranalytics',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: ordinaryItem.subject,
      contextText: ordinaryItem.bodyText,
      isListEntry: false,
      products: [],
    };
    const ordinaryExisting = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const ordinaryPrefilter = __prospectIntelligenceTestHooks.buildClassifierPrefilter(ordinaryItem, ordinaryMention, ordinaryExisting, env);

    expect(__prospectIntelligenceTestHooks.verifyLowConfidenceProspect(
      ordinaryItem,
      ordinaryMention,
      ordinaryExisting,
      ordinaryPrefilter,
      { checked: false, eligible: false, role: 'unknown', confidence: 'low', evidence: [], action_override: null, matched_company_id: null, matched_deal_id: null, reason: 'not_evaluated' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.85, provisional: false, directionUncertain: false }
    )).toMatchObject({
      checked: true,
      verdict: 'record_context',
      action_override: 'record_context',
      reason: 'low_confidence_context_without_investment_intent',
    });

    expect(__prospectIntelligenceTestHooks.verifyLowConfidenceProspect(
      ordinaryItem,
      ordinaryMention,
      ordinaryExisting,
      ordinaryPrefilter,
      { checked: false, eligible: false, role: 'unknown', confidence: 'low', evidence: [], action_override: null, matched_company_id: null, matched_deal_id: null, reason: 'not_evaluated' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.96, provisional: false, directionUncertain: false }
    )).toMatchObject({
      checked: false,
      reason: 'not_low_confidence',
    });

    const riskyItem: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-risky-medium-confidence',
      source: 'email',
      subject: 'Fwd: Congratulations and Thank You!',
      bodyText: 'Atlas Convene is a mature event company exploring a strategic partnership with a regional startup conference.',
      bodyPreview: 'Atlas Convene partnership',
      fromEmail: 'partner@conference.example',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const riskyMention = {
      raw: 'Atlas Convene',
      canonicalName: 'Atlas Convene',
      normalizedName: 'atlasconvene',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: riskyItem.subject,
      contextText: riskyItem.bodyText,
      isListEntry: false,
      products: [],
    };
    const riskyExisting = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const riskyPrefilter = __prospectIntelligenceTestHooks.buildClassifierPrefilter(riskyItem, riskyMention, riskyExisting, env);

    const risky = __prospectIntelligenceTestHooks.verifyLowConfidenceProspect(
      riskyItem,
      riskyMention,
      riskyExisting,
      riskyPrefilter,
      { checked: false, eligible: false, role: 'unknown', confidence: 'low', evidence: [], action_override: null, matched_company_id: null, matched_deal_id: null, reason: 'not_evaluated' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.85, provisional: false, directionUncertain: false }
    );

    expect(risky).toMatchObject({
      checked: true,
      verdict: 'record_context',
      action_override: 'record_context',
    });
    expect(risky.source_quality_signals).toContain('partnership_or_mature_company_without_investment_target');
  });

  it('uses explicit subject-line opportunity evidence to verify otherwise thin creates', () => {
    const env = { D1: new FakeD1(), INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-subject-opportunity',
      source: 'email',
      subject: '1200vc: Co-Investment Opportunity | Vital-Lyfe',
      bodyText: 'Caution: sender identity warning footer. Vital-Lyfe materials were forwarded for Medina review.',
      bodyPreview: 'Co-Investment Opportunity | Vital-Lyfe',
      fromEmail: 'partner@1200vc.example',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const mention: any = {
      raw: 'Vital-Lyfe',
      canonicalName: 'Vital-Lyfe',
      normalizedName: 'vitallyfe',
      mentionOrdinal: 1,
      spanStart: null,
      spanEnd: null,
      lineText: item.subject,
      contextText: item.bodyText,
      isListEntry: false,
      products: [],
    };
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = __prospectIntelligenceTestHooks.buildClassifierPrefilter(item, mention, existing, env);

    const result = __prospectIntelligenceTestHooks.verifyLowConfidenceProspect(
      item,
      mention,
      existing,
      prefilter,
      { checked: false, eligible: false, role: 'unknown', confidence: 'low', evidence: [], action_override: null, matched_company_id: null, matched_deal_id: null, reason: 'not_evaluated' },
      env,
      { prospectAction: 'create_prospect', confidence: 0.85, provisional: false, directionUncertain: false }
    );

    expect(result).toMatchObject({
      checked: true,
      verdict: 'verified_create',
      action_override: null,
    });
    expect(result.intent_signals).toContain('subject_line_target_opportunity');
  });

  it('demotes sub-0.8 source-domain/name mismatches to context', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValue({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"O2i","direction":"inbound","sector_key":"enterprise_software","sector_confidence":0.7,"confidence":0.78,"reasoning":"O2i appears to be mentioned as a potential opportunity."}]}',
      usage: { input_tokens: 90, output_tokens: 30 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-low-confidence-mismatch',
      source: 'email',
      subject: 'O2i update',
      bodyText: 'Company Name O2i Company URL https://lockton.com Short Description enterprise software.',
      bodyPreview: 'O2i update',
      fromEmail: 'advisor@lockton.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(db.prospects).toHaveLength(0);
    const signal = db.prospectSignals[0];
    expect(signal).toMatchObject({ mention_type: 'noise' });
    const metadata = JSON.parse(signal.metadata_json);
    expect(metadata).toMatchObject({
      prospect_action: 'record_context',
      should_create_prospect: false,
    });
    expect(metadata.low_confidence_verification).toMatchObject({
      checked: true,
      verdict: 'record_context',
      action_override: 'record_context',
      reason: 'low_confidence_identity_domain_mismatch',
    });
    expect(metadata.low_confidence_verification.extraction_flags).toContain('domain_name_mismatch');
  });

  it('records LLM direction conflicts as pending context instead of creating prospects', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock
      .mockResolvedValueOnce({
        text: '{"organizations":[{"name":"Auguria","raw":"Auguria"}]}',
        usage: { input_tokens: 60, output_tokens: 12 },
        model: 'claude-haiku-4-5-20251001',
      })
      .mockResolvedValueOnce({
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Auguria","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.8,"confidence":0.95,"reasoning":"Auguria looks like an intro."}]}',
        usage: { input_tokens: 90, output_tokens: 20 },
        model: 'claude-haiku-4-5-20251001',
      });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-direction',
      source: 'email',
      subject: 'Intro to Auguria',
      bodyText: 'Auguria founder@auguria.com would be a good customer intro.',
      bodyPreview: 'Auguria customer intro',
      fromEmail: 'lucas@medinavc.com',
      toEmails: ['founder@auguria.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'noise',
      prospect_id: null,
      confidence: 0.97,
      confidence_tier: 'high',
      direction_uncertain: 0,
      resolution_status: 'resolved',
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata).toMatchObject({
      prospect_action: 'record_context',
      should_create_prospect: false,
    });
  });

  it('creates prospects for exact-domain existing deals when they are newly pitched', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Qunnect","direction":"inbound","sector_key":"quantum","sector_confidence":0.9,"confidence":0.95,"reasoning":"Qunnect is raising and attached a deck."}]}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.companies.push({ id: 'company-qunnect', org_id: 'org-1', name: 'Qunnect', domain: 'qunnect.io' });
    db.deals.push({ id: 'deal-qunnect', org_id: 'org-1', company_id: 'company-qunnect', stage: 'talking' });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-qunnect',
      source: 'email',
      subject: 'Intro to Qunnect',
      bodyText: 'Qunnect founder@qunnect.io is raising and attached a deck.',
      bodyPreview: 'Qunnect founder@qunnect.io',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      attachments: [{ id: 'a1', name: 'Qunnect Deck.pdf', size: 100, contentType: 'application/pdf' }],
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.skipped_known_deal).toBe(0);
    expect(stats.prospects_upserted).toBe(1);
    expect(db.prospects).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'inbound_prospect',
      resolution_status: 'pending',
    });
    expect(db.prospectSignals[0].prospect_id).toBeTruthy();
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.known_entity_audit).toMatchObject({
      saved: true,
      known_entity_present: true,
      outcome: 'known_entity_new_pitch_allowed',
      match_strength: 'domain',
      company_id: 'company-qunnect',
      deal_id: 'deal-qunnect',
      llm_is_prospect: true,
      final_should_create_prospect: true,
      possible_company_id: 'company-qunnect',
      possible_deal_id: 'deal-qunnect',
      has_create_evidence: true,
      finalization_blocked: false,
    });
  });

  it('records non-prospect existing-deal context without creating or attaching a prospect', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":false,"prospect_company_name":null,"direction":"inbound","sector_key":"quantum","sector_confidence":0.9,"confidence":0.95,"reasoning":"Qunnect is existing deal context, not newly pitched."}]}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.companies.push({ id: 'company-qunnect', org_id: 'org-1', name: 'Qunnect', domain: 'qunnect.io' });
    db.deals.push({ id: 'deal-qunnect', org_id: 'org-1', company_id: 'company-qunnect', stage: 'talking' });
    db.prospects.push({
      id: 'prospect-qunnect',
      org_id: 'org-1',
      canonical_name: 'Qunnect',
      normalized_name: 'qunnect',
      deal_id: 'deal-qunnect',
      status: 'converted',
      sector_key: 'quantum',
      sector_confidence: 0.9,
      signal_strength: 85,
      signal_strength_reasons: '["known_deal_backlink"]',
      confidence: 1,
      provisional: 0,
      direction_uncertain: 0,
      metadata_json: '{}',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-qunnect-existing',
      source: 'email',
      subject: 'Intro to Qunnect',
      bodyText: 'Qunnect founder@qunnect.io is raising and attached a deck.',
      bodyPreview: 'Qunnect founder@qunnect.io',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      attachments: [{ id: 'a1', name: 'Qunnect Deck.pdf', size: 100, contentType: 'application/pdf' }],
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.skipped_noise).toBe(1);
    expect(stats.prospects_upserted).toBe(0);
    expect(db.prospects).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'noise',
      deal_id: 'deal-qunnect',
      company_id: 'company-qunnect',
      prospect_id: null,
      resolution_status: 'resolved',
    });
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata.known_entity_audit).toMatchObject({
      saved: true,
      known_entity_present: true,
      outcome: 'known_entity_non_prospect_audit_only',
      match_strength: 'domain',
      company_id: 'company-qunnect',
      deal_id: 'deal-qunnect',
      llm_is_prospect: false,
      final_should_create_prospect: false,
      final_prospect_action: 'ignore',
      final_mention_type: 'noise',
      possible_company_id: null,
      possible_deal_id: null,
      has_create_evidence: false,
      finalization_blocked: false,
    });
  });

  it('holds weak name-only deal matches as context without creating provisional prospects', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Portal Aircraft","direction":"inbound","sector_key":"aerospace_defense","sector_confidence":0.8,"confidence":0.9,"reasoning":"Portal Aircraft is framed as an investment intro."}]}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.companies.push({ id: 'company-portal', org_id: 'org-1', name: 'Portal Aircraft', domain: null });
    db.deals.push({ id: 'deal-portal', org_id: 'org-1', company_id: 'company-portal', stage: 'talking' });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-portal',
      source: 'email',
      subject: 'Intro to Portal Aircraft',
      bodyText: 'Portal Aircraft is raising a seed round for defense aviation.',
      bodyPreview: 'Portal Aircraft is raising',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.prospects_upserted).toBe(0);
    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'noise',
      deal_id: null,
      prospect_id: null,
    });
    expect(db.softLinks).toHaveLength(0);
    const metadata = JSON.parse(db.prospectSignals[0].metadata_json);
    expect(metadata).toMatchObject({
      prospect_action: 'record_context',
      should_create_prospect: false,
    });
    expect(metadata.prospect_finalization_gate).toMatchObject({ blocked: true });
  });

  it('records reversible audited prospect merges', async () => {
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    db.prospects.push(
      { id: 'prospect-winner', org_id: 'org-1', canonical_name: 'NeuralSeek', normalized_name: 'neuralseek', status: 'active', deleted_at: null },
      { id: 'prospect-loser', org_id: 'org-1', canonical_name: 'Neural Seek', normalized_name: 'neuralseek', status: 'provisional', deleted_at: null },
    );
    db.prospectSignals.push({
      id: 'signal-loser',
      org_id: 'org-1',
      prospect_id: 'prospect-loser',
      mention_type: 'inbound_prospect',
      signal_kind: 'intro',
      has_deck: 0,
      has_meeting: 0,
      confidence: 0.9,
      occurred_at: '2026-05-01T00:00:00.000Z',
    });

    const merge = await mergeProspects('org-1', 'prospect-winner', 'prospect-loser', env, {
      method: 'deterministic_normalized_name',
      score: 1,
    });

    expect(merge.moved_signals).toBe(1);
    expect(db.prospectSignals[0].prospect_id).toBe('prospect-winner');
    expect(db.prospects[1]).toMatchObject({ status: 'merged', possible_duplicate_of: 'prospect-winner' });
    expect(db.mergeAudit[0]).toMatchObject({ action: 'merge', loser_prospect_id: 'prospect-loser' });

    const reversed = await reverseProspectMerge('org-1', merge.audit_id, env);

    expect(reversed.restored_signals).toBe(1);
    expect(db.prospectSignals[0].prospect_id).toBe('prospect-loser');
    expect(db.prospects[1]).toMatchObject({ status: 'provisional', possible_duplicate_of: null });
    expect(db.mergeAudit[1]).toMatchObject({ action: 'unmerge', loser_prospect_id: 'prospect-loser' });
  });

  it('aggressively flags domain-brand prospect splits during reconciliation', async () => {
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    db.prospects.push(
      {
        id: 'prospect-abra',
        org_id: 'org-1',
        canonical_name: 'Abra',
        normalized_name: 'abra',
        status: 'provisional',
        domain: null,
        website: null,
        signal_count: 1,
        evidence_count: 1,
        created_at: '2026-06-01T23:17:11.961Z',
        deleted_at: null,
      },
      {
        id: 'prospect-helloabra',
        org_id: 'org-1',
        canonical_name: 'Helloabra',
        normalized_name: 'helloabra',
        status: 'provisional',
        domain: null,
        website: null,
        signal_count: 1,
        evidence_count: 1,
        created_at: '2026-06-01T23:17:23.490Z',
        deleted_at: null,
      },
    );

    const result = await runProspectReconciliation('org-1', env);

    expect(result.duplicate_links).toBe(1);
    expect(db.prospects.find(row => row.id === 'prospect-helloabra')).toMatchObject({
      possible_duplicate_of: 'prospect-abra',
    });
    expect(db.softLinks[0]).toMatchObject({
      prospect_id: 'prospect-helloabra',
      target_id: 'prospect-abra',
      link_type: 'possible_duplicate',
      score: 0.92,
    });
  });

  it('uses acronym aliases when comparing prospect identities', () => {
    const { prospectIdentityAliasesForName, scoreProspectRowDuplicate } = __prospectIntelligenceTestHooks;
    expect(prospectIdentityAliasesForName('River Valley Ranch').has('rvr')).toBe(true);

    const score = scoreProspectRowDuplicate(
      {
        id: 'prospect-rvr',
        canonical_name: 'RVR',
        normalized_name: 'rvr',
        domain: null,
        website: null,
        status: 'provisional',
        signal_count: 1,
        evidence_count: 1,
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'prospect-river-valley-ranch',
        canonical_name: 'River Valley Ranch',
        normalized_name: 'rivervalleyranch',
        domain: null,
        website: null,
        status: 'provisional',
        signal_count: 1,
        evidence_count: 1,
        created_at: '2026-06-01T00:01:00.000Z',
      },
    );

    expect(score).toMatchObject({ score: 0.92, method: 'aggressive_name_alias' });
  });

  it('applies corroborated own-domain enrichment through entity_field_state without overwriting filled fields', async () => {
    const db = new FakeD1();
    db.prospects.push({
      id: 'prospect-auguria',
      org_id: 'org-1',
      canonical_name: 'Auguria',
      normalized_name: 'auguria',
      domain: 'auguria.io',
      website: null,
      description: 'Deck-sourced description',
      status: 'active',
      enrichment_status: 'not_started',
      deleted_at: null,
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const result = await applyProspectEnrichmentCandidate('org-1', {
      prospectId: 'prospect-auguria',
      canonicalName: 'Auguria',
      domain: 'auguria.io',
      sourceKind: 'own_domain',
      sourceUrl: 'https://auguria.io',
      fields: {
        website: 'https://auguria.io',
        description: 'Website description should not overwrite.',
      },
    }, env);

    expect(result.applied).toEqual(['website']);
    expect(result.discarded).toContain('description');
    expect(db.prospects[0]).toMatchObject({
      website: 'https://auguria.io',
      description: 'Deck-sourced description',
      enrichment_status: 'enriched',
    });
    expect(db.entityFieldState[0]).toMatchObject({
      entity_type: 'prospect',
      entity_id: 'prospect-auguria',
      field_name: 'website',
      current_value: 'https://auguria.io',
    });
  });

  it('holds uncorroborated third-party enrichment candidates and discards wrong-company facts', async () => {
    const db = new FakeD1();
    db.prospects.push({
      id: 'prospect-portal',
      org_id: 'org-1',
      canonical_name: 'Portal Aircraft',
      normalized_name: 'portalaircraft',
      domain: 'portalaircraft.com',
      description: null,
      status: 'active',
      enrichment_status: 'not_started',
      deleted_at: null,
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const wrongCompany = await applyProspectEnrichmentCandidate('org-1', {
      prospectId: 'prospect-portal',
      canonicalName: 'Portal Software',
      domain: 'portalsoftware.com',
      sourceKind: 'duckduckgo',
      sourceUrl: 'https://portalsoftware.com/about',
      fields: { description: 'Wrong company.' },
    }, env);
    const held = await applyProspectEnrichmentCandidate('org-1', {
      prospectId: 'prospect-portal',
      canonicalName: 'Portal Aircraft',
      domain: 'portalaircraft.com',
      sourceKind: 'duckduckgo',
      sourceUrl: 'https://search.example/portal',
      fields: { description: 'Aerospace autonomy company.' },
      corroboratingSourceCount: 1,
    }, env);

    expect(wrongCompany.discarded).toEqual(['description']);
    expect(held.held).toEqual(['description']);
    expect(db.prospects[0].description).toBeNull();
    expect(db.prospects[0].enrichment_status).toBe('candidate');
    expect(db.entityFieldState[0]).toMatchObject({
      entity_type: 'prospect',
      field_name: 'description',
      current_value: null,
    });
    expect(JSON.parse(db.entityFieldState[0].pending_proposals)).toHaveProperty('Aerospace autonomy company.');
  });

  it('runs prospect enrichment in deterministic signal_strength priority order', async () => {
    const db = new FakeD1();
    db.prospects.push(
      {
        id: 'prospect-low',
        org_id: 'org-1',
        canonical_name: 'LowSignal',
        normalized_name: 'lowsignal',
        domain: 'low.example',
        website: null,
        description: null,
        signal_strength: 10,
        status: 'active',
        enrichment_status: 'not_started',
        deleted_at: null,
      },
      {
        id: 'prospect-high',
        org_id: 'org-1',
        canonical_name: 'HighSignal',
        normalized_name: 'highsignal',
        domain: 'high.example',
        website: null,
        description: null,
        signal_strength: 90,
        status: 'active',
        enrichment_status: 'not_started',
        deleted_at: null,
      },
      {
        id: 'prospect-provisional',
        org_id: 'org-1',
        canonical_name: 'ProvisionalSignal',
        normalized_name: 'provisionalsignal',
        domain: 'provisional.example',
        website: null,
        description: null,
        signal_strength: 100,
        status: 'provisional',
        provisional: 1,
        direction_uncertain: 0,
        enrichment_status: 'not_started',
        deleted_at: null,
      },
    );
    const fetched: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      fetched.push(url);
      return {
        ok: true,
        text: async () => '<html><head><title>HighSignal</title><meta name="description" content="Signal description"></head></html>',
      } as any;
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const result = await runProspectEnrichmentCycle('org-1', env, { limit: 2, fetcher: fetcher as any });

    expect(result.scanned).toBe(2);
    expect(fetched[0]).toBe('https://high.example');
    expect(fetched[1]).toBe('https://low.example');
    expect(fetched).not.toContain('https://provisional.example');
  });

  it('runs a tiny local windowed backfill with coverage and idempotent signal keys', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      return {
        text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Auguria","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Auguria is an investment intro."}]}',
        usage: { input_tokens: 90, output_tokens: 20 },
        model: 'claude-haiku-4-5-20251001',
      };
    });
    const db = new FakeD1();
    db.sourceConversations.push(
      {
        id: 'hist-conv-1',
        org_id: 'org-1',
        source: 'outlook',
        subject: 'Funding update',
        body_preview: 'Auguria is raising a seed round for security data.',
        sent_at: '2026-04-10T12:00:00.000Z',
        from_email: 'alice@example.com',
        to_emails: '["lucas@medinavc.com"]',
        cc_emails: '[]',
        direction: null,
        visibility: 'private',
        participant_user_ids: '[]',
      },
      {
        id: 'hist-conv-2',
        org_id: 'org-1',
        source: 'outlook',
        subject: 'Deck follow-up',
        body_preview: 'Meet Auguria for the follow-up deck.',
        sent_at: '2026-04-11T12:00:00.000Z',
        from_email: 'alice@example.com',
        to_emails: '["lucas@medinavc.com"]',
        cc_emails: '[]',
        direction: null,
        visibility: 'private',
        participant_user_ids: '[]',
      },
    );
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const first = await runProspectBackfillWindow('org-1', env, {
      windowStart: '2026-04-01T00:00:00.000Z',
      windowEnd: '2026-05-01T00:00:00.000Z',
      sourceFamilies: ['conversation'],
      batchLimit: 10,
      measuredCostPerItemUsd: 0.001,
    });
    const second = await runProspectBackfillWindow('org-1', env, {
      windowStart: '2026-04-01T00:00:00.000Z',
      windowEnd: '2026-05-01T00:00:00.000Z',
      sourceFamilies: ['conversation'],
      batchLimit: 10,
      measuredCostPerItemUsd: 0.001,
    });

    expect(first.items_found).toBe(2);
    expect(first.items_processed).toBe(2);
    expect(first.signals_recorded).toBe(2);
    expect(first.reconciliation.scanned).toBeGreaterThanOrEqual(1);
    expect(db.coverage[0]).toMatchObject({
      source_family: 'conversation',
      status: 'completed',
      items_scanned: 2,
      signals_recorded: 2,
      classifications_pending: 0,
    });
    expect(db.backfillRuns[0]).toMatchObject({
      status: 'completed',
      items_found: 2,
      estimated_total_cost: 0.002,
    });
    expect(second.items_found).toBe(2);
    expect(db.prospectSignals).toHaveLength(2);
    expect(new Set(db.prospectSignals.map(row => `${row.source_type}:${row.source_id}:${row.mention_ordinal}`)).size).toBe(2);
    expect(db.prospectSignals.every(row => row.ingestion_mode === 'backfill')).toBe(true);
  });

  it('records partial backfill progress instead of failing the window on Claude rate limits', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockRejectedValue(new Error('CLAUDE_RATE_LIMITED'));
    const db = new FakeD1();
    db.sourceConversations.push({
      id: 'rate-limited-conv',
      org_id: 'org-1',
      source: 'outlook',
      subject: 'Funding update',
      body_preview: 'Auguria is raising a seed round for security data.',
      sent_at: '2026-04-10T12:00:00.000Z',
      from_email: 'alice@example.com',
      to_emails: '["lucas@medinavc.com"]',
      cc_emails: '[]',
      direction: null,
      visibility: 'private',
      participant_user_ids: '[]',
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const result = await runProspectBackfillWindow('org-1', env, {
      windowStart: '2026-04-01T00:00:00.000Z',
      windowEnd: '2026-05-01T00:00:00.000Z',
      sourceFamilies: ['conversation', 'event'],
      batchLimit: 10,
      sliceSize: 1,
    });

    expect(result.items_found).toBe(1);
    expect(result.items_processed).toBe(1);
    expect(result.classifications_pending).toBe(1);
    expect(db.coverage[0]).toMatchObject({
      source_family: 'conversation',
      status: 'partial',
      items_scanned: 1,
      classifications_pending: 1,
      error_message: 'CLAUDE_RATE_LIMITED',
    });
    expect(db.coverage).toHaveLength(1);
    expect(db.backfillRuns[0]).toMatchObject({
      status: 'partial',
      items_found: 1,
      items_processed: 1,
      signals_recorded: 1,
      last_error: 'CLAUDE_RATE_LIMITED',
    });
  });

  it('classifies transient backfill infrastructure and classifier failures as deferrable', () => {
    const { isProspectBackfillDeferrableError } = __prospectIntelligenceTestHooks;

    expect(isProspectBackfillDeferrableError('CLAUDE_RATE_LIMITED')).toBe(true);
    expect(isProspectBackfillDeferrableError('Could not access `api.cloudflare.com`')).toBe(true);
    expect(isProspectBackfillDeferrableError('production_sample_failed')).toBe(false);
  });

  it('prioritizes high-signal backfill sources and collapses mailbox duplicate rows before classification', () => {
    const rows = [
      {
        id: 'ops-newest',
        subject: 'SVB deposit account statement is ready',
        body_preview: 'Your deposit account statement is ready.',
        sent_at: '2026-06-02T12:00:00.000Z',
        from_email: 'onlinebanking@svb.com',
      },
      {
        id: 'whitehawk-a',
        subject: 'Re: Zoom Meeting with Terry Roberts',
        body_preview: 'In preparation for our Thursday meeting, sending our Company 2 Pager. Terry Roberts Founder, President & CEO, whitehawk.com',
        sent_at: '2026-06-01T17:11:12.000Z',
        from_email: 'twr@whitehawk.com',
        has_attachments: 1,
        attachment_count: 2,
      },
      {
        id: 'whitehawk-b',
        subject: 'Re: Zoom Meeting with Terry Roberts',
        body_preview: 'In preparation for our Thursday meeting, sending our Company 2 Pager. Terry Roberts Founder, President & CEO, whitehawk.com',
        sent_at: '2026-06-01T17:11:12.000Z',
        from_email: 'twr@whitehawk.com',
        has_attachments: 1,
        attachment_count: 2,
      },
      {
        id: 'tolu',
        subject: 'Re: [eMerge Americas] 2026 Startup Showcase Winner - Next Steps',
        body_preview: 'We are updating the P&L and financial model and added Sebastian to the data room.',
        sent_at: '2026-06-01T15:50:48.000Z',
        from_email: 'tosin@toluai.com',
      },
      {
        id: 'acquisition',
        subject: '$57M rev / $36M EBITDA SaaS Acquisition Opportunity',
        body_preview: 'Quick check in on this acquisition opportunity.',
        sent_at: '2026-05-26T12:52:25.000Z',
        from_email: 'j.battison@settlucas.com',
      },
    ];

    const selected = __prospectIntelligenceTestHooks.rankAndDedupeBackfillSourceRows(rows, 'conversation', 4);

    expect(selected.map(row => row.id)).toEqual(['whitehawk-a', 'tolu', 'acquisition', 'ops-newest']);
    expect(selected).toHaveLength(4);
    expect(__prospectIntelligenceTestHooks.prospectBackfillSourceScore(rows[1], 'conversation'))
      .toBeGreaterThan(__prospectIntelligenceTestHooks.prospectBackfillSourceScore(rows[0], 'conversation'));
  });

  it('includes future meetings created inside the backfill window', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockResolvedValue({
      text: '{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"WhiteHawk","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"WhiteHawk is in a warm intro meeting."}]}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.sourceEvents.push({
      id: 'future-event-1',
      org_id: 'org-1',
      title: 'WhiteHawk / Medina Ventures intro',
      description: 'Future intro meeting created during the source window.',
      summary: '',
      start_time: '2026-06-04T19:30:00.000Z',
      created_at: '2026-06-01T17:11:12.000Z',
      source: 'outlook',
      transcript_r2_key: '',
      deleted_at: null,
    });

    const result = await runProspectBackfillWindow('org-1', { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      windowStart: '2026-06-01T00:00:00.000Z',
      windowEnd: '2026-06-02T00:00:00.000Z',
      sourceFamilies: ['event'],
      batchLimit: 10,
    });

    expect(result.items_found).toBe(1);
    expect(result.items_processed).toBe(1);
    expect(db.prospectSignals[0]).toMatchObject({
      source_type: 'event',
      source_id: 'future-event-1',
      raw_mention_text: 'WhiteHawk',
      ingestion_mode: 'backfill',
    });
  });

  it('runs the Phase 6 north-star fixtures end to end without duplicate prospects', async () => {
    resetClaudeMock();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      if (isReasoningJudgeRequest(request)) return reasoningJudgeResponse();
      if (isFinalQualityGateRequest(request)) return defaultFinalQualityGateResponseForRequest(request);
      const sectors: Record<string, string> = {
        MAX: 'ai_data',
        Auguria: 'cybersecurity',
        Sativa: 'materials_manufacturing',
        'Portal Aircraft': 'aerospace_defense',
      };
      let candidates: any[] = [];
      try {
        const user = JSON.parse(String(request.user || '{}'));
        candidates = Array.isArray(user.candidates) ? user.candidates : [];
      } catch {
        // Extraction prompts are not JSON; keep the fixture deterministic below.
      }
      if (candidates.length > 0) {
        return {
          text: JSON.stringify({
            decisions: candidates.map(row => ({
              mention_ordinal: row.mention_ordinal,
              is_prospect: true,
              prospect_company_name: row.company_name,
              direction: 'inbound',
              sector_key: sectors[row.company_name] || 'uncategorized',
              sector_confidence: 0.9,
              confidence: 0.96,
              reasoning: `${row.company_name} is presented as an investment opportunity in the fixture.`,
            })),
          }),
          usage: { input_tokens: 110, output_tokens: 24 },
          model: 'claude-haiku-4-5-20251001',
        };
      }
      return {
        text: JSON.stringify({
          organizations: [
            { name: 'MAX', raw: 'MAX' },
            { name: 'Auguria', raw: 'Auguria' },
            { name: 'Sativa', raw: 'Sativa' },
            { name: 'Portal Aircraft', raw: 'Portal Aircraft' },
          ],
        }),
        usage: { input_tokens: 60, output_tokens: 20 },
        model: 'claude-haiku-4-5-20251001',
      };
    });

    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const fixtures: any[] = [
      {
        type: 'document',
        entityType: 'document',
        entityId: 'fixture-max-evidence-report',
        subject: 'MAX evidence report',
        bodyText: 'Company Name MAX Company URL https://max.example MAX is raising a seed round for an AI data workflow platform. Deck attached and diligence call scheduled.',
        bodyPreview: 'MAX is raising a seed round',
        fromEmail: 'alice@example.com',
        sentAt: '2026-05-21T12:00:00.000Z',
        attachments: [{ id: 'max-deck', name: 'MAX Deck.pdf', size: 1024, contentType: 'application/pdf' }],
      },
      {
        type: 'email',
        entityType: 'conversation',
        entityId: 'fixture-auguria-thread',
        source: 'email',
        subject: 'Intro to Auguria',
        bodyText: 'Warm intro to Auguria; Auguria is raising a seed round for their security data platform and we should meet next week.',
        bodyPreview: 'Warm intro to Auguria',
        fromEmail: 'investor@example.com',
        toEmails: ['lucas@medinavc.com'],
        sentAt: '2026-05-22T12:00:00.000Z',
        attachments: [{ id: 'auguria-deck', name: 'Auguria Pitch Deck.pdf', size: 2048, contentType: 'application/pdf' }],
      },
      {
        type: 'document',
        entityType: 'document',
        entityId: 'fixture-armyfuze-list',
        subject: 'ArmyFUZE cohort shortlist',
        bodyText: [
          'ArmyFUZE cohort shortlist',
          '- Sativa - Seed - $1M - website sativa.example - Problem: hempcrete materials for deployable structures - Approach: manufacturing process',
          '- Portal Aircraft - Seed - $2M - website portalaircraft.example - Problem: defense aviation logistics - Approach: autonomous aircraft',
        ].join('\n'),
        bodyPreview: 'ArmyFUZE cohort shortlist',
        fromEmail: 'program@example.mil',
        sentAt: '2026-05-23T12:00:00.000Z',
      },
    ];

    const first = await detectAndRecordProspectSignals(fixtures, 'org-1', env, { ingestionMode: 'backfill' });
    await recordProspectBackfillCoverage('org-1', env, {
      sourceFamily: 'phase6_fixtures',
      windowStart: '2026-05-21T00:00:00.000Z',
      windowEnd: '2026-05-24T00:00:00.000Z',
      itemsScanned: fixtures.length,
      signalsRecorded: first.signals_recorded,
      prospectsUpserted: first.prospects_upserted,
      classificationsPending: first.classifications_pending,
      status: first.classifications_pending === 0 ? 'completed' : 'partial',
    });
    const second = await detectAndRecordProspectSignals(fixtures, 'org-1', env, { ingestionMode: 'backfill' });
    expect(first.items_scanned).toBe(3);
    expect(first.signals_recorded).toBe(4);
    expect(first.prospects_upserted).toBe(4);
    expect(first.classifications_pending).toBe(0);
    expect(db.coverage[0]).toMatchObject({
      source_family: 'phase6_fixtures',
      items_scanned: 3,
      signals_recorded: 4,
      prospects_upserted: 4,
      classifications_pending: 0,
      status: 'completed',
    });
    expect(db.prospects.map(row => row.canonical_name).sort()).toEqual([
      'Auguria',
      'MAX',
      'Portal Aircraft',
      'Sativa',
    ]);
    expect(db.prospectSignals).toHaveLength(4);
    expect(new Set(db.prospectSignals.map(row => `${row.source_type}:${row.source_id}:${row.mention_ordinal}`)).size).toBe(4);
    expect(second.signals_recorded).toBe(4);
    expect(db.prospects).toHaveLength(4);
    expect(db.prospectSignals).toHaveLength(4);
  });

  it('keeps migration 0114 aligned with the reconciled prospect contract', () => {
    const sql = readFileSync('migrations/0114_prospect_intelligence.sql', 'utf8');

    expect(sql).toContain('deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL');
    expect(sql).toContain('idx_prospect_signals_deal');
    expect(sql).toContain('prospect_merge_audit');
    expect(sql).toContain('idx_prospects_deal');
    expect(sql).toContain('ON prospects(org_id, deal_id)');
    expect(sql).toContain('signal_strength INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('description TEXT');
    expect(sql).toContain('founders_json TEXT NOT NULL DEFAULT');
    expect(sql).toContain('classification_status TEXT NOT NULL DEFAULT');
    expect(sql).toContain('resolution_status TEXT NOT NULL DEFAULT');
    expect(sql).toContain('classifications_pending INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('prospect_classifier_samples');
    expect(sql).not.toMatch(/thesis_score|thesis_band|review_queue/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+deals[\s\S]*prospect_id/i);
  });

  it('keeps migration 0116 aligned with the known-deal backlink contract', () => {
    const sql = readFileSync('migrations/0116_prospect_deal_backlinks.sql', 'utf8');

    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uniq_prospects_org_deal_active');
    expect(sql).toContain('ON prospects(org_id, deal_id)');
    expect(sql).toContain('WHERE deleted_at IS NULL AND deal_id IS NOT NULL');
  });
});
