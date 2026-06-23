import { describe, expect, it } from 'vitest';

import { discoverNewContact, findOrCreateCompanyByDomain } from '../src/lib/discovery';
import { autoCreateContactFromAttendee } from '../src/lib/firefly-intelligence';
import { reconcileMatchedEntityName } from '../src/lib/crm-name-promotion';
import type { CrmNameEvidenceCandidate } from '../src/lib/crm-name-resolver';

interface ContactRow {
  id: string;
  org_id: string;
  full_name: string;
  email: string | null;
  company_id?: string | null;
  custom_fields: string | null;
  deleted_at?: string | null;
}

interface CompanyRow {
  id: string;
  org_id: string;
  name: string;
  domain: string | null;
  website?: string | null;
  custom_fields: string | null;
  deleted_at?: string | null;
  merged_into?: string | null;
}

interface FieldStateRow {
  id: string;
  entity_type: string;
  entity_id: string;
  field_name: string;
  current_value: string | null;
  current_value_sources: string;
  pending_proposals: string;
  last_human_edit_at: string | null;
  permanently_locked: number;
}

class FakeD1 {
  contacts: ContactRow[] = [];
  companies: CompanyRow[] = [];
  fieldStates: FieldStateRow[] = [];

  prepare(sql: string) {
    return {
      bind: (...binds: unknown[]) => ({
        first: async () => this.first(sql, binds),
        all: async () => ({ results: this.all(sql, binds) }),
        run: async () => {
          this.run(sql, binds);
          return { meta: { changes: 1 } };
        },
      }),
    };
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ meta: { changes: 1 } }));
  }

  first(sql: string, binds: unknown[]): any {
    const rows = this.all(sql, binds);
    return rows[0] || null;
  }

  all(sql: string, binds: unknown[]): any[] {
    if (/SELECT id, full_name AS name, email, custom_fields\s+FROM contacts/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.contacts.find(c => c.id === id && c.org_id === orgId && !c.deleted_at);
      return row ? [{ id: row.id, name: row.full_name, email: row.email, custom_fields: row.custom_fields }] : [];
    }
    if (/SELECT id FROM contacts/i.test(sql) && /LOWER\(email\) IN/i.test(sql)) {
      const orgId = String(binds[0]);
      const emails = binds.slice(1).map(item => String(item).toLowerCase());
      return this.contacts
        .filter(c => c.org_id === orgId && !c.deleted_at && c.email && emails.includes(c.email.toLowerCase()))
        .map(c => ({ id: c.id }));
    }
    if (/SELECT id, company_id FROM contacts/i.test(sql) && /LOWER\(email\) =/i.test(sql)) {
      const [orgId, email] = binds;
      return this.contacts
        .filter(c => c.org_id === orgId && !c.deleted_at && (c.email || '').toLowerCase() === String(email).toLowerCase())
        .map(c => ({ id: c.id, company_id: c.company_id || null }));
    }
    if (/SELECT company_id FROM contacts/i.test(sql) && /company_id IS NOT NULL/i.test(sql)) {
      const row = this.contacts.find(c => c.id === binds[0] && c.company_id);
      return row ? [{ company_id: row.company_id }] : [];
    }
    if (/SELECT id, name, domain, website, custom_fields\s+FROM companies/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.companies.find(c => c.id === id && c.org_id === orgId && !c.deleted_at && !c.merged_into);
      return row ? [{ id: row.id, name: row.name, domain: row.domain, website: row.website || null, custom_fields: row.custom_fields }] : [];
    }
    if (/SELECT id FROM companies/i.test(sql) && /LOWER\(domain\) =/i.test(sql)) {
      const [orgId, domain] = binds;
      return this.companies
        .filter(c => c.org_id === orgId && !c.deleted_at && (c.domain || '').toLowerCase() === String(domain).toLowerCase())
        .map(c => ({ id: c.id }));
    }
    if (/FROM entity_field_state/i.test(sql) && /SELECT id, current_value/i.test(sql)) {
      const [entityType, entityId, fieldName] = binds;
      return this.fieldStates.filter(row => row.entity_type === entityType && row.entity_id === entityId && row.field_name === fieldName);
    }
    if (/SELECT id FROM companies/i.test(sql) && /LOWER\(name\) = LOWER\(\?\)/i.test(sql)) {
      const [orgId, name, id] = binds;
      return this.companies
        .filter(c => c.org_id === orgId && c.id !== id && !c.deleted_at && !c.merged_into && c.name.toLowerCase() === String(name).toLowerCase())
        .map(c => ({ id: c.id }));
    }
    if (/FROM contacts/i.test(sql) && /full_name/i.test(sql)) {
      const orgId = binds[0];
      const entityId = String(binds[2] || '');
      const email = String(binds[3] || '').toLowerCase();
      return this.contacts
        .filter(c => c.org_id === orgId && !c.deleted_at && (c.id === entityId || (c.email || '').toLowerCase() === email))
        .map(c => ({
          id: c.id,
          full_name: c.full_name,
          email: c.email,
          custom_fields: c.custom_fields,
          total_interactions: 0,
        }));
    }
    if (/FROM companies/i.test(sql) && /SELECT id, name, domain/i.test(sql)) {
      const orgId = binds[0];
      return this.companies
        .filter(c => c.org_id === orgId && !c.deleted_at && !c.merged_into)
        .map(c => ({ ...c, linked_contact_count: 0, conversation_count: 0, event_count: 0, deal_count: 0, document_count: 0 }));
    }
    return [];
  }

  run(sql: string, binds: unknown[]): void {
    if (/INSERT OR IGNORE INTO entity_field_state/i.test(sql)) {
      const [entityType, entityId, fieldName, currentValue, currentSources] = binds;
      if (!this.fieldStates.some(row => row.entity_type === entityType && row.entity_id === entityId && row.field_name === fieldName)) {
        this.fieldStates.push({
          id: `efs-${this.fieldStates.length + 1}`,
          entity_type: String(entityType),
          entity_id: String(entityId),
          field_name: String(fieldName),
          current_value: currentValue == null ? null : String(currentValue),
          current_value_sources: String(currentSources),
          pending_proposals: '{}',
          last_human_edit_at: null,
          permanently_locked: 0,
        });
      }
      return;
    }
    if (/UPDATE entity_field_state\s+SET pending_proposals/i.test(sql)) {
      const [pending, id] = binds;
      const row = this.fieldStates.find(r => r.id === id);
      if (row) row.pending_proposals = String(pending);
      return;
    }
    if (/UPDATE entity_field_state\s+SET current_value_sources/i.test(sql)) {
      const [sources, id] = binds;
      const row = this.fieldStates.find(r => r.id === id);
      if (row) row.current_value_sources = String(sources);
      return;
    }
    if (/UPDATE entity_field_state\s+SET current_value =/i.test(sql)) {
      const [value, sources, pending, id] = binds;
      const row = this.fieldStates.find(r => r.id === id);
      if (row) {
        row.current_value = String(value);
        row.current_value_sources = String(sources);
        row.pending_proposals = String(pending);
      }
      return;
    }
    if (/UPDATE contacts\s+SET full_name =/i.test(sql)) {
      const [name, customFields, id] = binds;
      const row = this.contacts.find(c => c.id === id);
      if (row) {
        row.full_name = String(name);
        row.custom_fields = String(customFields);
      }
      return;
    }
    if (/UPDATE companies\s+SET name =/i.test(sql)) {
      const [name, customFields, id] = binds;
      const row = this.companies.find(c => c.id === id);
      if (row) {
        row.name = String(name);
        row.custom_fields = String(customFields);
      }
      return;
    }
  }
}

function env(db: FakeD1): any {
  return {
    D1: db,
    R2: { async get() { return null; } },
    KV: { async get() { return null; }, async put() {} },
    AUDIT_QUEUE: { async send() {} },
    AZURE_CLIENT_ID: '',
    AZURE_TENANT_ID: '',
  };
}

function contactCandidate(value: string, sourceType: CrmNameEvidenceCandidate['source_type'] = 'first_party_identity'): CrmNameEvidenceCandidate {
  return {
    value,
    entity_type: 'contact',
    candidate_kind: 'contact_name',
    source_type: sourceType,
    source_channel: sourceType,
    source_record_id: 'source-1',
    source_text_excerpt: value,
    confidence: 'strong',
    privacy_scope: sourceType === 'first_party_identity' ? 'provider_identity' : 'org_owned',
    observed_at: null,
    rule_ids: [],
    cost_tier: sourceType === 'first_party_identity' ? 3 : 1,
  };
}

function companyCandidate(value: string): CrmNameEvidenceCandidate {
  return {
    value,
    entity_type: 'company',
    candidate_kind: 'company_name',
    source_type: 'domain_metadata',
    source_channel: 'public_domain_metadata',
    source_record_id: 'https://example.com',
    source_text_excerpt: value,
    confidence: 'strong',
    privacy_scope: 'public',
    observed_at: null,
    rule_ids: [],
    cost_tier: 4,
  };
}

describe('matched entity name promotion', () => {
  it('promotes a provisional contact when strong matched evidence provides a verified full name', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'Anna P.',
      email: 'anna@example.com',
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'provisional', label: 'Tentative name' } }),
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'contact',
      entityId: 'contact-1',
      orgId: 'org-1',
      rawName: 'Anna P. Chammas',
      email: 'anna@example.com',
      trigger: 'unit',
      channelSource: 'display_name',
      channelContext: { userId: 'user-1' },
      runtimeEvidenceCandidates: [contactCandidate('Anna P. Chammas')],
      source: { source_channel: 'email_header', source_text: 'Anna P. Chammas', codepath: 'unit', evidence_level: 'corroborated' },
    }, env(db));

    expect(result.action).toBe('promoted_verified');
    expect(db.contacts[0].full_name).toBe('Anna P. Chammas');
    expect(JSON.parse(db.contacts[0].custom_fields || '{}').crm_quality.name_status).toBe('verified');
    expect(JSON.parse(db.contacts[0].custom_fields || '{}').crm_quality.label).toBeNull();
  });

  it('keeps an improved but still provisional matched contact name tentative', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'J.',
      email: 'j.shade@example.com',
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'provisional', label: 'Tentative name' } }),
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'contact',
      entityId: 'contact-1',
      orgId: 'org-1',
      rawName: 'j.shade',
      email: 'j.shade@example.com',
      trigger: 'unit',
      channelSource: 'display_name',
      channelContext: { userId: 'user-1' },
      source: { source_channel: 'email_header', source_text: 'j.shade', codepath: 'unit', evidence_level: 'weak_single_source' },
    }, env(db));

    expect(result.action).toBe('updated_provisional');
    expect(db.contacts[0].full_name).toBe('J. Shade');
    expect(JSON.parse(db.contacts[0].custom_fields || '{}').crm_quality.name_status).toBe('provisional');
  });

  it('records one verified conflict against a verified contact without overwriting', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'Anna Chammas',
      email: 'anna@example.com',
      custom_fields: '{}',
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'contact',
      entityId: 'contact-1',
      orgId: 'org-1',
      rawName: 'Anna Patricia Chammas',
      email: 'anna@example.com',
      trigger: 'unit',
      channelSource: 'display_name',
      channelContext: { userId: 'user-1' },
      runtimeEvidenceCandidates: [contactCandidate('Anna Patricia Chammas')],
      source: { source_channel: 'email_header', source_text: 'Anna Patricia Chammas', codepath: 'unit', evidence_level: 'corroborated' },
    }, env(db));

    expect(result.action).toBe('recorded_pending');
    expect(db.contacts[0].full_name).toBe('Anna Chammas');
    expect(JSON.parse(db.fieldStates[0].pending_proposals)['Anna Patricia Chammas']).toEqual(['email_display_name_inbox_user-1']);
  });

  it('promotes a verified contact conflict after a second independent verified source', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'Anna Chammas',
      email: 'anna@example.com',
      custom_fields: '{}',
    });
    db.fieldStates.push({
      id: 'efs-1',
      entity_type: 'contact',
      entity_id: 'contact-1',
      field_name: 'full_name',
      current_value: 'Anna Chammas',
      current_value_sources: '["historical_unknown"]',
      pending_proposals: JSON.stringify({ 'Anna Patricia Chammas': ['email_display_name_inbox_user-1'] }),
      last_human_edit_at: null,
      permanently_locked: 0,
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'contact',
      entityId: 'contact-1',
      orgId: 'org-1',
      rawName: 'Anna Patricia Chammas',
      email: 'anna@example.com',
      trigger: 'unit',
      channelSource: 'firefly_attendee_data',
      runtimeEvidenceCandidates: [contactCandidate('Anna Patricia Chammas', 'calendar_attendee')],
      source: { source_channel: 'firefly', source_text: 'Anna Patricia Chammas', codepath: 'unit', evidence_level: 'corroborated' },
    }, env(db));

    expect(result.action).toBe('promoted_verified');
    expect(db.contacts[0].full_name).toBe('Anna Patricia Chammas');
    expect(JSON.parse(db.fieldStates[0].pending_proposals)).toEqual({});
    expect(JSON.parse(db.fieldStates[0].current_value_sources)).toEqual(['email_display_name_inbox_user-1', 'firefly_attendee_data']);
  });

  it('does not overwrite a verified contact with weak provisional matched evidence', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'Anna Chammas',
      email: 'anna@example.com',
      custom_fields: '{}',
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'contact',
      entityId: 'contact-1',
      orgId: 'org-1',
      rawName: 'Anna P.',
      email: 'anna@example.com',
      trigger: 'unit',
      channelSource: 'display_name',
      channelContext: { userId: 'user-1' },
      source: { source_channel: 'email_header', source_text: 'Anna P.', codepath: 'unit', evidence_level: 'weak_single_source' },
    }, env(db));

    expect(db.contacts[0].full_name).toBe('Anna Chammas');
  });

  it('records pending evidence instead of promoting when the name field is locked', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'Anna P.',
      email: 'anna@example.com',
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'provisional', label: 'Tentative name' } }),
    });
    db.fieldStates.push({
      id: 'efs-1',
      entity_type: 'contact',
      entity_id: 'contact-1',
      field_name: 'full_name',
      current_value: 'Anna P.',
      current_value_sources: '["historical_unknown"]',
      pending_proposals: '{}',
      last_human_edit_at: new Date().toISOString(),
      permanently_locked: 0,
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'contact',
      entityId: 'contact-1',
      orgId: 'org-1',
      rawName: 'Anna P. Chammas',
      email: 'anna@example.com',
      trigger: 'unit',
      channelSource: 'display_name',
      channelContext: { userId: 'user-1' },
      runtimeEvidenceCandidates: [contactCandidate('Anna P. Chammas')],
      source: { source_channel: 'email_header', source_text: 'Anna P. Chammas', codepath: 'unit', evidence_level: 'corroborated' },
    }, env(db));

    expect(result.action).toBe('blocked_locked');
    expect(db.contacts[0].full_name).toBe('Anna P.');
    expect(JSON.parse(db.fieldStates[0].pending_proposals)['Anna P. Chammas']).toEqual(['email_display_name_inbox_user-1']);
  });

  it('promotes a company domain placeholder when verified canonical metadata arrives', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-1',
      org_id: 'org-1',
      name: 'examplecapital.com',
      domain: 'examplecapital.com',
      website: 'https://examplecapital.com',
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'domain_placeholder', label: 'Tentative name' } }),
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'company',
      entityId: 'company-1',
      orgId: 'org-1',
      rawName: 'examplecapital.com',
      domain: 'examplecapital.com',
      website: 'https://examplecapital.com',
      trigger: 'unit',
      channelSource: 'web_enrichment_company',
      runtimeEvidenceCandidates: [companyCandidate('Example Capital')],
      source: { source_channel: 'web_enrichment_company', source_text: 'Example Capital', codepath: 'unit', evidence_level: 'corroborated' },
    }, env(db));

    expect(result.action).toBe('promoted_verified');
    expect(db.companies[0].name).toBe('Example Capital');
    expect(JSON.parse(db.companies[0].custom_fields || '{}').crm_quality.name_status).toBe('verified');
  });

  it('records pending company evidence instead of promoting into a duplicate company name', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-1',
      org_id: 'org-1',
      name: 'examplecapital.com',
      domain: 'examplecapital.com',
      website: 'https://examplecapital.com',
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'domain_placeholder', label: 'Tentative name' } }),
    }, {
      id: 'company-2',
      org_id: 'org-1',
      name: 'Example Capital',
      domain: 'example.com',
      website: 'https://example.com',
      custom_fields: '{}',
    });

    const result = await reconcileMatchedEntityName({
      entityType: 'company',
      entityId: 'company-1',
      orgId: 'org-1',
      rawName: 'examplecapital.com',
      domain: 'examplecapital.com',
      website: 'https://examplecapital.com',
      trigger: 'unit',
      channelSource: 'web_enrichment_company',
      runtimeEvidenceCandidates: [companyCandidate('Example Capital')],
      source: { source_channel: 'web_enrichment_company', source_text: 'Example Capital', codepath: 'unit', evidence_level: 'corroborated' },
    }, env(db));

    expect(result.action).toBe('blocked_duplicate');
    expect(db.companies[0].name).toBe('examplecapital.com');
    expect(JSON.parse(db.fieldStates[0].pending_proposals)['Example Capital']).toEqual(['llm_extraction_inbox_unknown']);
  });

  it('promotes an existing discovery contact instead of creating a duplicate', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'Anna P.',
      email: 'anna@example.com',
      company_id: 'company-1',
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'provisional', label: 'Tentative name' } }),
    });

    const result = await discoverNewContact('anna@example.com', {
      source: 'outlook_email',
      externalId: 'message-1',
      userId: 'user-1',
      fromEmail: 'anna@example.com',
      fromName: 'Anna P. Chammas',
      recipientNames: {},
      crmNameEvidenceCandidates: [contactCandidate('Anna P. Chammas')],
    } as any, 'org-1', env(db), { kind: 'reply' } as any);

    expect(result).toEqual({ id: 'contact-1', created: false });
    expect(db.contacts[0].full_name).toBe('Anna P. Chammas');
    expect(JSON.parse(db.contacts[0].custom_fields || '{}').crm_quality.name_status).toBe('verified');
  });

  it('promotes an existing Firefly attendee contact instead of creating a duplicate', async () => {
    const db = new FakeD1();
    db.contacts.push({
      id: 'contact-1',
      org_id: 'org-1',
      full_name: 'Anna P.',
      email: 'anna@example.com',
      company_id: null,
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'provisional', label: 'Tentative name' } }),
    });

    const result = await autoCreateContactFromAttendee({
      email: 'anna@example.com',
      displayName: 'Anna P. Chammas',
      orgId: 'org-1',
      env: env(db),
      evidenceCandidates: [contactCandidate('Anna P. Chammas', 'calendar_attendee')],
    });

    expect(result).toEqual({ contactId: 'contact-1', created: false, companyId: null });
    expect(db.contacts[0].full_name).toBe('Anna P. Chammas');
    expect(JSON.parse(db.contacts[0].custom_fields || '{}').crm_quality.name_status).toBe('verified');
  });

  it('promotes an existing domain-placeholder company instead of creating a duplicate company', async () => {
    const db = new FakeD1();
    db.companies.push({
      id: 'company-1',
      org_id: 'org-1',
      name: 'examplecapital.com',
      domain: 'examplecapital.com',
      website: 'https://examplecapital.com',
      custom_fields: JSON.stringify({ crm_quality: { name_status: 'domain_placeholder', label: 'Tentative name' } }),
    });

    const result = await findOrCreateCompanyByDomain('examplecapital.com', 'org-1', env(db), [companyCandidate('Example Capital')]);

    expect(result).toBe('company-1');
    expect(db.companies).toHaveLength(1);
    expect(db.companies[0].name).toBe('Example Capital');
    expect(JSON.parse(db.companies[0].custom_fields || '{}').crm_quality.name_status).toBe('verified');
  });
});
