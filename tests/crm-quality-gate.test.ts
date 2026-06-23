import { describe, expect, it } from 'vitest';

import {
  CRM_QUALITY_RULES,
  crmQualityCustomFieldsForGate,
  evaluateCrmQualityGate,
} from '../src/lib/crm-quality-gate';
import { isValidContactName, resolveContactName } from '../src/lib/name-quality';

describe('CRM quality gate', () => {
  it('holds page-title company names unless the reviewed contract supplies a canonical target', () => {
    const hold = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'update_name',
      proposedName: 'AI Sales Agents for Revenue Teams | Demodesk',
      source: { codepath: 'unit' },
    });

    expect(hold.decision).toBe('hold');
    expect(hold.writeAllowed).toBe(false);
    expect(hold.normalizedName).toBe('Demodesk');
    expect(hold.ruleIds).toContain(CRM_QUALITY_RULES.COMPANY_PAGE_TITLE);

    const queue = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'rename',
      currentName: 'Actions',
      proposedName: 'K50 Ventures',
      expectedAction: 'rename',
      expectedName: 'K50 Ventures',
      rootCause: 'website_title_or_page_title_used_as_company_name',
      source: { codepath: 'unit' },
    });

    expect(queue.decision).toBe('queue');
    expect(queue.normalizedName).toBe('K50 Ventures');
    expect(queue.ruleIds).toContain(CRM_QUALITY_RULES.COMPANY_PAGE_TITLE);
  });

  it('keeps domain-derived company names as placeholders only when explicitly allowed', () => {
    const finalName = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'create',
      proposedName: 'clover.com',
      domain: 'clover.com',
      source: { codepath: 'unit' },
    });

    expect(finalName.decision).toBe('hold');
    expect(finalName.writeAllowed).toBe(false);
    expect(finalName.ruleIds).toContain(CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER);

    const placeholder = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'create',
      proposedName: 'mail.clover.com',
      domain: 'clover.com',
      allowDomainPlaceholder: true,
      source: { codepath: 'unit' },
    });

    expect(placeholder.decision).toBe('apply');
    expect(placeholder.normalizedName).toBe('mail.clover.com');
    expect(placeholder.ruleIds).toContain(CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER);

    const dottedBrand = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'create',
      proposedName: 'imec.xpand',
      domain: 'imecxpand.com',
      nameStatus: 'provisional',
      source: { source_channel: 'email_domain', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(dottedBrand.decision).toBe('apply');
    expect(dottedBrand.normalizedName).toBe('imec.xpand');
    expect(dottedBrand.nameStatus).toBe('provisional');

    const verifiedDottedBrand = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'create',
      proposedName: 'ID.me',
      domain: 'id.me',
      nameStatus: 'verified',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(verifiedDottedBrand.decision).toBe('apply');
    expect(verifiedDottedBrand.normalizedName).toBe('ID.me');
    expect(verifiedDottedBrand.nameStatus).toBe('verified');

    const hyphenBrand = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'create',
      proposedName: 'Q-Branch',
      domain: 'q-branch.dev',
      nameStatus: 'verified',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(hyphenBrand.decision).toBe('apply');
    expect(hyphenBrand.normalizedName).toBe('Q-Branch');
  });

  it('rejects email local-parts and automated contacts before create', () => {
    const localPart = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'jgrant',
      email: 'jgrant@example.com',
      source: { codepath: 'unit' },
    });

    expect(localPart.decision).toBe('reject');
    expect(localPart.ruleIds).toContain(CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART);

    const automated = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'Mail Delivery Subsystem',
      email: 'mailer-daemon@google.com',
      source: { codepath: 'unit' },
    });

    expect(automated.decision).toBe('reject');
    expect(automated.ruleIds).toContain(CRM_QUALITY_RULES.CONTACT_AUTOMATED);

    const eventContact = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'Balerion Space: Upcoming Events',
      email: 'balerionfiresides@calendar.luma-mail.com',
      source: { source_channel: 'firefly', codepath: 'unit' },
    });

    expect(eventContact.decision).toBe('reject');
    expect(eventContact.ruleIds).toContain(CRM_QUALITY_RULES.CONTACT_AUTOMATED);
  });

  it('creates weak single-source human-looking names as tentative', () => {
    const weak = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'Luis Soto',
      email: 'lsoto@tccargo.us',
      source: {
        source_channel: 'email_header',
        source_text: 'LUIS SOTO',
        codepath: 'discover_new_contact',
        evidence_level: 'weak_single_source',
      },
    });

    expect(weak.decision).toBe('apply');
    expect(weak.writeAllowed).toBe(true);
    expect(weak.normalizedName).toBe('Luis Soto');
    expect(weak.nameStatus).toBe('provisional');
    expect(weak.ruleIds).toContain(CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART);
    expect(weak.ruleIds).toContain(CRM_QUALITY_RULES.PROVISIONAL_NAME);
    expect(crmQualityCustomFieldsForGate(weak)).toContain('"name_status":"provisional"');

    const explicit = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'Luis Soto',
      email: 'lsoto@tccargo.us',
      source: {
        source_channel: 'manual_ui',
        source_text: 'Luis Soto',
        codepath: 'unit',
        evidence_level: 'manual',
      },
      manualOverride: true,
    });

    expect(explicit.decision).toBe('apply');
    expect(explicit.normalizedName).toBe('Luis Soto');
  });

  it('creates source-backed single-token local-part names as tentative', () => {
    const gate = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'Adam',
      email: 'adam@tallwoodscap.com',
      source: {
        source_channel: 'email_header',
        source_text: 'adam',
        codepath: 'discover_new_contact',
        evidence_level: 'weak_single_source',
      },
    });

    expect(gate.decision).toBe('apply');
    expect(gate.writeAllowed).toBe(true);
    expect(gate.normalizedName).toBe('Adam');
    expect(gate.nameStatus).toBe('provisional');
    expect(gate.ruleIds).toContain(CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN);
    expect(gate.ruleIds).toContain(CRM_QUALITY_RULES.PROVISIONAL_NAME);
  });

  it('parses directory last-first names and fails closed on uncorroborated single tokens', () => {
    const directory = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'update_name',
      proposedName: 'Brown, Edmond Miles (miles) LTG Usarmy T2com HQ (usa)',
      source: { codepath: 'unit' },
    });

    expect(directory.decision).toBe('apply');
    expect(directory.normalizedName).toBe('Edmond Miles Brown');
    expect(directory.ruleIds).toContain(CRM_QUALITY_RULES.CONTACT_DIRECTORY_NAME);

    const singleToken = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'Tony',
      source: { codepath: 'unit' },
    });

    expect(singleToken.decision).toBe('hold');
    expect(singleToken.writeAllowed).toBe(false);
    expect(singleToken.ruleIds).toContain(CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN);
  });

  it('lets manual single-token contacts through while still blocking automated names', () => {
    const manual = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: 'Tony',
      manualOverride: true,
      source: { codepath: 'unit' },
    });

    expect(manual.decision).toBe('apply');
    expect(manual.normalizedName).toBe('Tony');

    expect(isValidContactName('Tony')).toBe(false);
    expect(resolveContactName('jgrant@example.com', 'jgrant@example.com', 'jgrant', undefined)).toBe('J. Grant');
  });

  it('blocks service-domain company creation and homepage-only names', () => {
    const serviceCompany = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'create',
      proposedName: 'docsend.com',
      domain: 'docsend.com',
      source: { codepath: 'unit' },
    });

    expect(serviceCompany.decision).toBe('reject');
    expect(serviceCompany.ruleIds).toContain(CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN);

    const homepage = evaluateCrmQualityGate({
      entityType: 'company',
      action: 'update_name',
      proposedName: 'Home page',
      source: { codepath: 'unit' },
    });

    expect(homepage.decision).toBe('hold');
    expect(homepage.ruleIds).toContain(CRM_QUALITY_RULES.COMPANY_PAGE_TITLE);
  });
});
