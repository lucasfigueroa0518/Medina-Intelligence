import { describe, expect, it } from 'vitest';

import {
  buildCompanyDuplicateGroups,
  buildContactDuplicateGroups,
  buildQualityReviewRows,
  scoreCompanyCandidate,
  scoreContactCandidate,
  toCsv,
  type CompanyReviewRecord,
  type ContactReviewRecord,
} from '../scripts/crm-quality-review-export';

function contact(overrides: Partial<ContactReviewRecord>): ContactReviewRecord {
  return {
    record_type: 'contact',
    id: overrides.id || `contact-${Math.random()}`,
    name: overrides.name || 'Jane Founder',
    email: overrides.email ?? 'jane@example.com',
    phone: overrides.phone ?? null,
    linkedin_url: overrides.linkedin_url ?? null,
    domain: overrides.domain ?? (overrides.email ? String(overrides.email).split('@')[1] : 'example.com'),
    company_id: overrides.company_id ?? 'company-a',
    company_name: overrides.company_name ?? 'Example',
    source: overrides.source ?? 'outlook',
    entity_type: overrides.entity_type ?? 'individual',
    status: overrides.status ?? null,
    created_at: overrides.created_at || '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-01-02T00:00:00.000Z',
    deleted_at: overrides.deleted_at ?? null,
    merged_into: overrides.merged_into ?? null,
    interaction_count: overrides.interaction_count ?? 1,
    conversation_count: overrides.conversation_count ?? 1,
    event_count: overrides.event_count ?? 0,
    deal_count: overrides.deal_count ?? 0,
    document_count: overrides.document_count ?? 0,
    tag_count: overrides.tag_count ?? 0,
    audit_origin: overrides.audit_origin ?? 'outlook',
    audit_auto_created: overrides.audit_auto_created ?? null,
  };
}

function company(overrides: Partial<CompanyReviewRecord>): CompanyReviewRecord {
  return {
    record_type: 'company',
    id: overrides.id || `company-${Math.random()}`,
    name: overrides.name || 'Example AI',
    domain: overrides.domain ?? 'example.com',
    website: overrides.website ?? 'https://example.com',
    source: overrides.source ?? null,
    entity_type: overrides.entity_type ?? 'startup',
    status: overrides.status ?? 'tracking',
    created_at: overrides.created_at || '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-01-02T00:00:00.000Z',
    deleted_at: overrides.deleted_at ?? null,
    merged_into: overrides.merged_into ?? null,
    interaction_count: overrides.interaction_count ?? 1,
    conversation_count: overrides.conversation_count ?? 1,
    event_count: overrides.event_count ?? 0,
    deal_count: overrides.deal_count ?? 0,
    document_count: overrides.document_count ?? 0,
    tag_count: overrides.tag_count ?? 0,
    linked_contact_count: overrides.linked_contact_count ?? 1,
    audit_origin: overrides.audit_origin ?? null,
    audit_auto_created: overrides.audit_auto_created ?? null,
  };
}

describe('CRM quality review export helpers', () => {
  it('scores non-person contacts and automated/shared mailboxes as suspicious', () => {
    const scored = scoreContactCandidate(contact({
      id: 'contact-support',
      name: 'support',
      email: 'support@slack.com',
      source: 'import',
      interaction_count: 0,
      conversation_count: 0,
      company_id: null,
      company_name: null,
    }));

    expect(scored.score).toBeGreaterThan(150);
    expect(scored.reasons).toContain('generic_non_person_name');
    expect(scored.reasons).toContain('automated_or_shared_mailbox_email');
  });

  it('scores weak auto-created company stubs as suspicious', () => {
    const scored = scoreCompanyCandidate(company({
      id: 'company-stripe',
      name: 'stripe.com',
      domain: 'stripe.com',
      website: 'https://stripe.com',
      entity_type: 'other',
      status: 'tracking',
      linked_contact_count: 0,
      conversation_count: 0,
      interaction_count: 0,
      audit_auto_created: 1,
    }));

    expect(scored.score).toBeGreaterThan(200);
    expect(scored.reasons).toContain('auto_created_from_email_domain');
    expect(scored.reasons).toContain('vendor_or_automated_domain');
    expect(scored.reasons).toContain('no_contacts_deals_docs_or_tags');
  });

  it('groups contact and company duplicate candidates', () => {
    const contactGroups = buildContactDuplicateGroups([
      contact({ id: 'c1', name: 'Alice Partner', email: 'alice@fund.com', company_id: 'fund' }),
      contact({ id: 'c2', name: 'Alice Partner', email: 'alice.partner@fund.com', company_id: 'fund' }),
      contact({ id: 'c3', name: 'Bob Builder', email: 'bob@build.com', company_id: 'build' }),
    ]);

    expect(contactGroups.some(group =>
      group.reason.includes('name_company')
      && group.memberIds.includes('c1')
      && group.memberIds.includes('c2')
    )).toBe(true);

    const companyGroups = buildCompanyDuplicateGroups([
      company({ id: 'co1', name: 'Acme AI Inc.', domain: 'acme.ai' }),
      company({ id: 'co2', name: 'Acme AI', domain: 'getacme.ai' }),
      company({ id: 'co3', name: 'OtherCo', domain: 'otherco.com' }),
    ]);

    expect(companyGroups.some(group =>
      group.memberIds.includes('co1')
      && group.memberIds.includes('co2')
    )).toBe(true);

    const linkedinGroups = buildContactDuplicateGroups([
      contact({ id: 'li1', name: 'Per Roman', email: 'per@gpbullhound.com', company_id: 'bullhound', linkedin_url: 'https://uk.linkedin.com/in/perroman' }),
      contact({ id: 'li2', name: 'Ganesh Rengaswamy', email: 'ganesh@quona.com', company_id: 'quona', linkedin_url: 'https://in.linkedin.com/in/ganeshrengaswamy' }),
    ]);
    expect(linkedinGroups.some(group => group.reason.includes('linkedin_handle'))).toBe(false);
  });

  it('builds exact non-overlapping quotas with blank review columns and skips deleted/merged rows', () => {
    const contacts = [
      contact({ id: 'c-dup-a', name: 'Alice Founder', email: 'alice@acme.com', company_id: 'acme' }),
      contact({ id: 'c-dup-b', name: 'Alice Founder', email: 'alice.founder@acme.com', company_id: 'acme' }),
      contact({ id: 'c-random-a', name: 'Ben Capital', email: 'ben@capital.com', company_id: 'capital' }),
      contact({ id: 'c-random-b', name: 'Cara VC', email: 'cara@vc.com', company_id: 'vc' }),
      contact({ id: 'c-extra', name: 'Dana LP', email: 'dana@lp.com', company_id: 'lp' }),
      contact({ id: 'c-deleted', deleted_at: '2026-01-03T00:00:00.000Z' }),
      contact({ id: 'c-merged', merged_into: 'c-extra' }),
    ];
    const companies = [
      company({ id: 'co-dup-a', name: 'Acme AI Inc.', domain: 'acme.ai' }),
      company({ id: 'co-dup-b', name: 'Acme AI', domain: 'getacme.ai' }),
      company({ id: 'co-random-a', name: 'BetterCo', domain: 'better.co' }),
      company({ id: 'co-random-b', name: 'Clear Robotics', domain: 'clear.ai' }),
      company({ id: 'co-extra', name: 'Delta Systems', domain: 'delta.systems' }),
      company({ id: 'co-deleted', deleted_at: '2026-01-03T00:00:00.000Z' }),
      company({ id: 'co-merged', merged_into: 'co-extra' }),
    ];

    const rows = buildQualityReviewRows({
      contacts,
      companies,
      seed: 'unit-seed',
      suspectLimit: 2,
      randomLimit: 2,
    });

    expect(rows).toHaveLength(8);
    expect(rows.filter(row => row.record_type === 'contact' && row.sample_type === 'suspect')).toHaveLength(2);
    expect(rows.filter(row => row.record_type === 'contact' && row.sample_type === 'random')).toHaveLength(2);
    expect(rows.filter(row => row.record_type === 'company' && row.sample_type === 'suspect')).toHaveLength(2);
    expect(rows.filter(row => row.record_type === 'company' && row.sample_type === 'random')).toHaveLength(2);
    expect(rows.every(row => row.review_grade === '' && row.review_notes === '')).toBe(true);
    expect(rows.map(row => row.id)).not.toContain('c-deleted');
    expect(rows.map(row => row.id)).not.toContain('c-merged');
    expect(rows.map(row => row.id)).not.toContain('co-deleted');
    expect(rows.map(row => row.id)).not.toContain('co-merged');

    const contactSuspectIds = new Set(rows.filter(row => row.record_type === 'contact' && row.sample_type === 'suspect').map(row => row.id));
    const contactRandomIds = new Set(rows.filter(row => row.record_type === 'contact' && row.sample_type === 'random').map(row => row.id));
    for (const id of contactRandomIds) expect(contactSuspectIds.has(id)).toBe(false);

    const duplicateRows = rows.filter(row => row.candidate_reasons.includes('possible_duplicate'));
    expect(duplicateRows.length).toBeGreaterThan(0);
    expect(duplicateRows.every(row => row.duplicate_group_id && row.duplicate_group_size && row.possible_duplicate_ids)).toBe(true);
  });

  it('uses deterministic random ordering and emits the expected CSV header', () => {
    const contacts = Array.from({ length: 6 }, (_, index) => contact({
      id: `contact-${index}`,
      name: `Person ${index}`,
      email: `person${index}@example.com`,
      company_id: `company-${index}`,
    }));
    const companies = Array.from({ length: 6 }, (_, index) => company({
      id: `company-${index}`,
      name: `Company ${index}`,
      domain: `company${index}.com`,
    }));

    const first = buildQualityReviewRows({ contacts, companies, seed: 'stable', suspectLimit: 2, randomLimit: 2 });
    const second = buildQualityReviewRows({ contacts, companies, seed: 'stable', suspectLimit: 2, randomLimit: 2 });

    expect(first.map(row => row.id)).toEqual(second.map(row => row.id));
    const csv = toCsv(first);
    expect(csv.split('\n')[0]).toBe('review_grade,review_notes,record_type,sample_type,sample_rank,candidate_score,candidate_reasons,duplicate_group_id,duplicate_group_size,possible_duplicate_ids,id,name,email,domain,website,company_id,company_name,source,entity_type,status,created_at,updated_at,interaction_count,conversation_count,event_count,deal_count,document_count,tag_count,linked_contact_count,audit_origin,audit_auto_created,crm_url');
  });
});
