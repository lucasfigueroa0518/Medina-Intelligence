import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PROSPECT_BRIDGE_CONFIRMATION_TOKEN,
  buildCompanyDedupeDecisions,
  buildContactDedupeDecisions,
  buildDealConflictDecisions,
  buildProspectDedupeDecisions,
  decideProspectMaterialization,
  shouldPromoteInvestmentStatus,
  type BridgeCompanyRow,
  type BridgeDealRow,
  type BridgeProspectRow,
  type BridgeSignalRow,
  type ContactRow,
} from '../scripts/prospect-bridge-materialize';

function prospect(overrides: Partial<BridgeProspectRow>): BridgeProspectRow {
  return {
    id: 'prospect-1',
    org_id: 'org-1',
    canonical_name: 'Mully AI',
    normalized_name: 'mully',
    domain: null,
    status: 'active',
    confidence: 0.94,
    provisional: 0,
    company_id: null,
    possible_company_id: null,
    deal_id: null,
    possible_deal_id: null,
    metadata_json: '{}',
    ...overrides,
  };
}

function company(overrides: Partial<BridgeCompanyRow>): BridgeCompanyRow {
  return {
    id: 'company-1',
    org_id: 'org-1',
    name: 'Mully AI',
    domain: 'mully.ai',
    website: null,
    investment_status: 'tracking',
    custom_fields: '{}',
    contacts_count: 0,
    deals_count: 0,
    documents_count: 0,
    tags_count: 0,
    human_edits_count: 0,
    ...overrides,
  };
}

function signal(overrides: Partial<BridgeSignalRow> = {}): BridgeSignalRow {
  return {
    id: 'signal-1',
    org_id: 'org-1',
    prospect_id: 'prospect-1',
    company_id: null,
    deal_id: null,
    source_type: 'event',
    source_id: 'event-1',
    source_title: 'Mully AI Investor Deck',
    raw_mention_text: 'Mully AI',
    normalized_mention: 'mully',
    occurred_at: '2026-06-01T00:00:00.000Z',
    mention_type: 'inbound_prospect',
    signal_kind: 'deck',
    confidence: 0.94,
    metadata_json: '{}',
    ...overrides,
  };
}

describe('prospect bridge materialization decisions', () => {
  it('finalizes a Mully-style possible_company_id and repairs polluted source domains', () => {
    const row = prospect({
      id: '8bdd56cb-b93a-4b5f-adc6-23775fb9ffb5',
      domain: 'rvrgolf.com',
      possible_company_id: 'cf255637-0d22-4c30-8484-a11dfc0ec4bb',
      metadata_json: JSON.stringify({ identity_dedupe: { domain: 'mully.ai' } }),
    });
    const target = company({ id: 'cf255637-0d22-4c30-8484-a11dfc0ec4bb' });
    const decision = decideProspectMaterialization(row, [
      signal({ source_title: 'Mully AI Investor Deck' }),
      signal({ id: 'signal-2', source_title: 'Mully AI Intro' }),
    ], [target], []);

    expect(decision).toMatchObject({
      action: 'finalize',
      selected_company_id: target.id,
      selected_company_name: 'Mully AI',
    });
    expect(decision.score).toBeGreaterThanOrEqual(0.92);
    expect(decision.evidence.repaired_domain).toBe('mully.ai');
  });

  it('promotes only blank/tracking-like investment statuses to prospect', () => {
    expect(shouldPromoteInvestmentStatus(null)).toBe(true);
    expect(shouldPromoteInvestmentStatus('tracking')).toBe(true);
    expect(shouldPromoteInvestmentStatus('due_diligence')).toBe(false);
    expect(shouldPromoteInvestmentStatus('term_sheet')).toBe(false);
    expect(shouldPromoteInvestmentStatus('invested')).toBe(false);
    expect(shouldPromoteInvestmentStatus('passed')).toBe(false);
    expect(shouldPromoteInvestmentStatus('exited')).toBe(false);
  });

  it('treats hello/get/try/use/join/go/ask domain-brand aliases as strong evidence', () => {
    const row = prospect({
      canonical_name: 'Abra',
      normalized_name: 'abra',
      domain: 'helloabra.com',
      possible_company_id: null,
    });
    const decision = decideProspectMaterialization(row, [], [
      company({ id: 'company-abra', name: 'Abra', domain: null }),
      company({ id: 'company-helloabra', name: 'HelloAbra', domain: 'helloabra.com' }),
    ], []);

    expect(decision.action).toBe('finalize');
    expect(decision.selected_company_id).toBe('company-helloabra');
    expect(decision.method).toBe('exact_domain');
  });

  it('does not auto-finalize fuzzy or same-name matches with conflicting real domains', () => {
    const row = prospect({
      canonical_name: 'Acme',
      normalized_name: 'acme',
      domain: 'acme.ai',
      metadata_json: '{}',
    });
    const decision = decideProspectMaterialization(row, [], [
      company({ id: 'company-acme-golf', name: 'Acme', domain: 'acmegolf.com' }),
    ], []);

    expect(decision.action).toBe('needs_review');
    expect(decision.selected_company_id).toBeNull();
  });

  it('keeps uncorroborated possible_company_id links review-only', () => {
    const row = prospect({
      canonical_name: 'Fallom',
      normalized_name: 'fallom',
      domain: 'fallom.com',
      possible_company_id: 'company-evqlv',
    });
    const decision = decideProspectMaterialization(row, [], [
      company({ id: 'company-evqlv', name: 'EVQLV', domain: 'evqlv.com' }),
    ], []);

    expect(decision.action).toBe('needs_review');
    expect(decision.score).toBeLessThan(0.92);
  });

  it('ignores weak existing-company candidates and creates a new company when own-domain evidence is strong', () => {
    const row = prospect({
      canonical_name: 'WavePoint Solution',
      normalized_name: 'wavepointsolution',
      domain: 'wavepointsolution.com',
      possible_company_id: 'company-source-firm',
      confidence: 0.92,
      provisional: 0,
      direction_uncertain: 0,
    });
    const decision = decideProspectMaterialization(row, [
      signal({
        source_title: 'Hi Tony - WavePoint: Gamechanger in Public Safety - 1st Radar-Based Bullet Tracking',
        signal_kind: 'intro',
        confidence: 0.92,
      }),
    ], [
      company({ id: 'company-source-firm', name: 'Sheehan Finance', domain: 'sheehanfinance.com' }),
    ], []);

    expect(decision).toMatchObject({
      action: 'create_company',
      selected_company_name: 'WavePoint Solution',
      method: 'create_company_own_domain',
    });
    expect(decision.reasons).toContain('ignored weak existing-company candidates');
    expect(decision.rejected_candidates[0]).toMatchObject({
      company_id: 'company-source-firm',
      score: 0.86,
      method: 'prior_possible_company',
    });
  });

  it('emits create-company decisions for strong final prospects with no CRM match', () => {
    const row = prospect({
      canonical_name: 'ClearMetal',
      normalized_name: 'clearmetal',
      domain: 'clearmetal.ai',
      confidence: 0.94,
      provisional: 0,
      direction_uncertain: 0,
    });
    const decision = decideProspectMaterialization(row, [
      signal({ id: 'signal-deck', source_title: 'ClearMetal Investor Deck', signal_kind: 'deck', confidence: 0.94 }),
      signal({ id: 'signal-intro', source_title: 'ClearMetal Intro', signal_kind: 'intro', confidence: 0.92 }),
    ], [], []);

    expect(decision).toMatchObject({
      action: 'create_company',
      selected_company_id: null,
      selected_company_name: 'ClearMetal',
      method: 'create_company_own_domain',
    });
    expect(decision.evidence.target_company_kind).toBe('new');
  });

  it('creates limited-info company cards for list/report-only prospect evidence', () => {
    const row = prospect({
      canonical_name: 'Breaktheweb',
      normalized_name: 'breaktheweb',
      domain: 'breaktheweb.co',
      confidence: 0.92,
      provisional: 0,
      direction_uncertain: 0,
    });
    const decision = decideProspectMaterialization(row, [
      signal({ source_title: 'automatic_report - Pipeline Industry Pie.pdf', signal_kind: 'list_entry', confidence: 0.92 }),
      signal({ id: 'signal-2', source_title: 'automatic_report - Pipeline Status Update.pdf', signal_kind: 'list_entry', confidence: 0.9 }),
    ], [], []);

    expect(decision).toMatchObject({
      action: 'create_company',
      selected_company_name: 'Breaktheweb',
      method: 'create_company_limited_info_domain',
    });
    expect(decision.evidence.company_card_quality).toBe('limited_info');
    expect(decision.reasons).toContain('list/report-only evidence retained as limited info');
  });

  it('creates limited-info cards for plausible prospects without enough verified company data', () => {
    const row = prospect({
      canonical_name: 'Humanetics Corp.',
      normalized_name: 'humanetics',
      domain: null,
      confidence: 0.88,
      provisional: 0,
      direction_uncertain: 0,
    });
    const decision = decideProspectMaterialization(row, [
      signal({
        source_title: 'Humanetics Executive Sum may 2026.pdf',
        signal_kind: 'deck',
        confidence: 0.88,
      }),
    ], [], []);

    expect(decision).toMatchObject({
      action: 'create_company',
      selected_company_name: 'Humanetics Corp.',
      method: 'create_company_limited_info',
    });
    expect(decision.evidence.company_card_quality).toBe('limited_info');
    expect(decision.reasons).toContain('limited-info prospect card');
  });

  it('still refuses to create a company card without any linked prospect signal', () => {
    const row = prospect({
      canonical_name: 'Kestrel Labs',
      normalized_name: 'kestrellabs',
      domain: null,
      confidence: 0.92,
      provisional: 0,
      direction_uncertain: 0,
    });
    const decision = decideProspectMaterialization(row, [], [], []);

    expect(decision.action).toBe('needs_review');
    expect(decision.review_reason).toBe('no high-confidence unblocked company match');
  });

  it('creates a limited-info card for a proven prospect row even when the child signal is not linked', () => {
    const row = prospect({
      canonical_name: 'Kestrel Labs',
      normalized_name: 'kestrel',
      domain: null,
      confidence: 0.92,
      provisional: 0,
      direction_uncertain: 0,
      signal_count: 1,
      evidence_count: 1,
      last_signal_at: '2026-06-01T12:00:00Z',
      metadata_json: JSON.stringify({
        prospect_action: 'create_prospect',
        prospect_company_name: 'Kestrel Labs',
        identity_dedupe: { method: 'self', aliases: ['kestrel'] },
      }),
    });
    const decision = decideProspectMaterialization(row, [], [], []);

    expect(decision).toMatchObject({
      action: 'create_company',
      selected_company_name: 'Kestrel Labs',
      method: 'create_company_limited_info',
    });
    expect(decision.evidence.company_card_quality).toBe('limited_info');
    expect(decision.reasons).toContain('proven prospect row without linked signal');
  });

  it('keeps the 7-day window keyed to prospect/signal activity, not only last_signal_at', () => {
    const source = readFileSync('scripts/prospect-bridge-materialize.ts', 'utf8');

    expect(source).toContain('(created_at >= ? AND created_at <= ?)');
    expect(source).toContain('(updated_at >= ? AND updated_at <= ?)');
    expect(source).toContain('FROM prospect_signals s');
    expect(source).toContain('(s.created_at >= ? AND s.created_at <= ?)');
    expect(source).toContain('(s.updated_at >= ? AND s.updated_at <= ?)');
    expect(source).toContain('(s.occurred_at >= ? AND s.occurred_at <= ?)');
  });
});

describe('prospect bridge dedupe decisions', () => {
  it('auto-merges duplicate prospects only on exact domain/name identity', () => {
    const decisions = buildProspectDedupeDecisions([
      prospect({ id: 'prospect-abra', canonical_name: 'Abra', normalized_name: 'abra', domain: 'helloabra.com', signal_count: 3 }),
      prospect({ id: 'prospect-helloabra', canonical_name: 'HelloAbra', normalized_name: 'helloabra', domain: 'helloabra.com', signal_count: 1 }),
      prospect({ id: 'prospect-other', canonical_name: 'Abra Robotics', normalized_name: 'abrarobotics', domain: null }),
    ]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ entity_type: 'prospect', action: 'merge', method: 'exact_domain' });
  });

  it('auto-merges company duplicates only on exact domain plus alias agreement', () => {
    const decisions = buildCompanyDedupeDecisions([
      company({ id: 'company-abra', name: 'Abra', domain: 'helloabra.com', deals_count: 2 }),
      company({ id: 'company-helloabra', name: 'HelloAbra Inc.', domain: 'helloabra.com' }),
      company({ id: 'company-acme', name: 'Abra', domain: 'abra-golf.com' }),
    ]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      entity_type: 'company',
      action: 'merge',
      winner_id: 'company-abra',
      loser_id: 'company-helloabra',
      method: 'exact_domain',
    });
  });

  it('merges contacts by exact email and only flags exact-name/same-company contacts', () => {
    const contacts: ContactRow[] = [
      { id: 'contact-a', org_id: 'org-1', full_name: 'Ava Lee', email: 'ava@example.com', company_id: 'company-1' },
      { id: 'contact-b', org_id: 'org-1', full_name: 'Ava L.', email: 'AVA@example.com', company_id: 'company-2' },
      { id: 'contact-c', org_id: 'org-1', full_name: 'Sam Patel', email: null, company_id: 'company-1' },
      { id: 'contact-d', org_id: 'org-1', full_name: 'Sam Patel', email: null, company_id: 'company-1' },
    ];

    expect(buildContactDedupeDecisions(contacts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_type: 'contact', action: 'merge', method: 'exact_email' }),
      expect.objectContaining({ entity_type: 'contact', action: 'flag', method: 'exact_name_same_company' }),
    ]));
  });

  it('flags open deal conflicts instead of merging deals', () => {
    const deals: BridgeDealRow[] = [
      { id: 'deal-1', org_id: 'org-1', company_id: 'company-1', title: 'Abra Seed', stage: 'prospect' },
      { id: 'deal-2', org_id: 'org-1', company_id: 'company-1', title: 'Abra Extension', stage: 'due_diligence' },
    ];

    expect(buildDealConflictDecisions(deals)).toEqual([
      expect.objectContaining({ entity_type: 'deal', action: 'flag', method: 'open_deal_conflict' }),
    ]);
  });

  it('keeps production apply behind an exact confirmation token', () => {
    const source = readFileSync('scripts/prospect-bridge-materialize.ts', 'utf8');
    expect(PROSPECT_BRIDGE_CONFIRMATION_TOKEN).toBe('PROSPECT_BRIDGE_MATERIALIZE_PRODUCTION_GO');
    expect(source).toContain('PROSPECT_BRIDGE_APPLY_REQUIRES_EXACT_CONFIRMATION');
    expect(source).toContain('readOnlyEnv');
  });
});
