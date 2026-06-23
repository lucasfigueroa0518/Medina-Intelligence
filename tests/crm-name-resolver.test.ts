import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Papa from 'papaparse';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  crmNameResolutionCustomFields,
  extractPersonNames,
  fetchCompanyWebsiteMetadata,
  resolveCrmEntityName,
  resolveCrmEntityNameWithEvidence,
} from '../src/lib/crm-name-resolver';
import { evaluateCrmQualityGate } from '../src/lib/crm-quality-gate';

interface BadVerifiedRegressionRow {
  sample_index: string;
  entity_type: 'company' | 'contact';
  source_snapshot_name_for_review: string;
  email: string;
  domain: string;
  produced_name: string;
  resolver_reason: string;
  codex_validity_class: string;
}

function regressionEvidenceSourceType(reason: string): 'domain_metadata' | 'crm_neighbor' | 'source_payload' | 'conversation_header' {
  if (/crm_neighbor/i.test(reason)) return 'crm_neighbor';
  if (/source_payload/i.test(reason)) return 'source_payload';
  if (/page title|domain_metadata|metadata/i.test(reason)) return 'domain_metadata';
  return 'conversation_header';
}

function resolverEnv(handler: (sql: string, binds: unknown[]) => Record<string, any>[]): any {
  return {
    D1: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async all() {
                return { results: handler(sql, binds) };
              },
              async first() {
                return handler(sql, binds)[0] || null;
              },
            };
          },
        };
      },
    },
    R2: {
      async get() {
        return null;
      },
    },
    AZURE_CLIENT_ID: '',
    AZURE_TENANT_ID: '',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRM_QUALITY_ENABLE_LIVE_METADATA_IN_TESTS;
});

describe('CRM name resolver', () => {
  it('strips page-title boilerplate to a company brand candidate', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'AI Sales Agents for Revenue Teams | Demodesk',
      domain: 'demodesk.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Demodesk');
    expect(resolution.candidates[0]).toMatchObject({
      normalizedName: 'Demodesk',
      accepted: true,
    });
  });

  it('prefers concise brand segments over descriptive page-title segments', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Nearshore CX & Team Extension Solutions | Altiam CX',
      domain: 'altiamcx.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Altiam CX');
  });

  it('prefers a title segment that exactly matches the company domain brand', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Goldman Properties | We Create Magic',
      domain: 'goldmanproperties.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Goldman Properties');
  });

  it('does not let a short acronym domain segment beat a fuller university name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Florida A&M University - FAMU',
      domain: 'famu.edu',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Florida A&M University');
  });

  it('rejects generic fund advisory title segments in favor of the brand segment', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Fund Advisory | PJT Partners',
      domain: 'parkhillgroup.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('PJT Partners');
  });

  it('keeps domain-created companies as tentative placeholders', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'brightstar-mystorybiobook.co',
      domain: 'brightstar-mystorybiobook.co',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('domain_placeholder');
    expect(resolution.nameStatus).toBe('domain_placeholder');
    expect(resolution.normalizedName).toBe('brightstar-mystorybiobook.co');
    expect(crmNameResolutionCustomFields(resolution)).toContain('"name_status":"domain_placeholder"');
  });

  it('splits compound company strings into provisional organization candidates', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'DARPA / Applied Research Institute',
      source: { source_channel: 'import', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('DARPA');
    expect(crmNameResolutionCustomFields(resolution)).toContain('"name_status":"provisional"');
  });

  it('splits health compound company strings without keeping both companies', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Salubris Health and auria',
      source: { source_channel: 'import', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('Salubris Health');
  });

  it('parses contact local-parts into tentative person names', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'j.shade',
      email: 'j.shade@embarkwithus.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('J. Shade');
  });

  it('does not split single first names into bogus initial-plus-last names', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'darian@connectedcapital.vc',
      email: 'darian@connectedcapital.vc',
      relationshipEvidence: true,
      rootCause: 'single_token_or_partial_contact_name',
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('Darian');
  });

  it('uses a known given-name local before falling back to first-initial parsing', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'jacqueline@decisivepoint.com',
      email: 'jacqueline@decisivepoint.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('Jacqueline');
  });

  it('drops trailing local-part initials when the base token is a known given name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'dannym@grahamcos.com',
      email: 'dannym@grahamcos.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('Danny');
  });

  it('still parses first-initial-plus-last local parts when that is the stronger shape', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'dmcgregor',
      email: 'dmcgregor@example.com',
      relationshipEvidence: true,
      rootCause: 'email_local_part_used_as_contact_name',
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('D. McGregor');
  });

  it('ignores domain fragments in display names and falls back to the email local part', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Mbodet Bigcapllc.com',
      email: 'mbodet@bigcapllc.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('M. Bodet');
  });

  it('does not turn shared app aliases into contacts', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Qualified',
      email: 'app@qualified.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('no_entity');
    expect(resolution.normalizedName).toBeUndefined();
  });

  it('does not verify service/team labels as contact names', () => {
    for (const rawName of ['Annual Report Service', 'Team Langstroth']) {
      const resolution = resolveCrmEntityName({
        entityType: 'contact',
        rawName,
        email: 'person@example.com',
        relationshipEvidence: true,
        source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
      });

      expect(resolution.status).not.toBe('verified');
    }
  });

  it('normalizes directory/rank display names and honors preferred names', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Brown, Edmond Miles (Miles) LTG USARMY T2COM HQ (USA)',
      email: 'edmond.m.brown.mil@army.mil',
      relationshipEvidence: true,
      source: { source_channel: 'firefly', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Miles Edmond Brown');
  });

  it('preserves source middle initials in directory names when they are part of the person name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Chammas, Ana P. (CITD)',
      email: 'ana.chammas@miamidade.gov',
      relationshipEvidence: true,
      source: { source_channel: 'firefly', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Ana P. Chammas');
  });

  it('drops middle-looking initials when surrounding tokens are rank or agency context', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Frost, Tracy G SES OSD Ousd R&e (usa)',
      email: 'tracy.g.frost.civ@mail.mil',
      relationshipEvidence: true,
      source: { source_channel: 'firefly', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Tracy Frost');
  });

  it('removes military rank tokens without dropping source-backed middle initials', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Lopez, Nicholas J LTC USARMY USSOCOM SOCOM (USA)',
      email: 'nicholas.j.lopez.mil@socom.mil',
      relationshipEvidence: true,
      source: { source_channel: 'firefly', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Nicholas J Lopez');
  });

  it('allows single-token contact names only as provisional relationship evidence', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'adam',
      email: 'adam@tallwoodscap.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('Adam');
  });

  it('prefers a full source display name over an email local-part fragment', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'j.shade',
      email: 'j.shade@embarkwithus.com',
      sourceNameCandidates: ['Jeffrey Shade', 'j.shade'],
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Jeffrey Shade');
  });

  it('does not shorten a full source display name from email-local evidence alone', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Claudio Vilar Furtado',
      email: 'cfurtado@example.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Claudio Vilar Furtado');
  });

  it('uses domain-owned public people metadata when it matches the email local part', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'dmcgregor',
      email: 'dmcgregor@gencomgrp.com',
      relationshipEvidence: true,
      contactPublicMetadata: {
        ok: true,
        fetchedLive: true,
        candidates: [
          {
            name: 'Donald McGregor',
            sourceUrl: 'https://gencomgrp.com/our-team/',
            sourceType: 'domain_owned_page',
            confidence: 'strong',
          },
        ],
      },
      source: { source_channel: 'outlook', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Donald McGregor');
  });

  it('verifies a single domain-owned public person match when email local part is the first name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'nat@atomic.vc',
      email: 'nat@atomic.vc',
      relationshipEvidence: true,
      contactPublicMetadata: {
        ok: true,
        fetchedLive: true,
        candidates: [
          {
            name: 'Nat Disston',
            sourceUrl: 'https://www.atomic.vc/team',
            sourceType: 'domain_owned_page',
            confidence: 'weak',
          },
        ],
      },
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Nat Disston');
  });

  it('extracts overlapping person names with middle initials from team-page text', () => {
    const names = extractPersonNames(
      'Gaylord received a BA in Accounting from Florida Atlantic University. Marcus G. Bodet Principal and Founder Marcus Bodet is a principal.'
    );

    expect(names).toContain('Marcus G. Bodet');
  });

  it('prefers a simpler same-person public-name variant when the email does not corroborate a middle initial', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Mbodet Bigcapllc.com',
      email: 'mbodet@bigcapllc.com',
      relationshipEvidence: true,
      contactPublicMetadata: {
        ok: true,
        fetchedLive: true,
        candidates: [
          {
            name: 'Marcus G. Bodet',
            sourceUrl: 'https://bigcapllc.com/team/',
            sourceType: 'domain_owned_page',
            confidence: 'strong',
          },
          {
            name: 'Marcus Bodet',
            sourceUrl: 'https://bigcapllc.com/team/',
            sourceType: 'domain_owned_page',
            confidence: 'strong',
          },
        ],
      },
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Marcus Bodet');
  });

  it('keeps multi-part display names when email-local evidence alone would shorten them', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Eugenio Lopez Negrete',
      email: 'enegrete@quantumbb.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Eugenio Lopez Negrete');
  });

  it('collapses first-plus-initials display names to the strongest email-corroborated person name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Gonzalo Hevia Bailleres',
      email: 'gonzalohb@hbeyond.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Gonzalo Hevia');
  });

  it('preserves short middle-name display names when the email does not disprove them', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Veronica Nur Valdes',
      email: 'vvaldes@example.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Veronica Nur Valdes');
  });

  it('preserves repeated surname display names instead of trimming them from email shape alone', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Michelle Atherley Atherley',
      email: 'matherley10@example.com',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Michelle Atherley Atherley');
  });

  it('preserves doctor honorifics from explicit source display names', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'jgrant',
      email: 'jgrant@gulliverprep.org',
      sourceNameCandidates: ['Dr. Jacqueline Grant'],
      relationshipEvidence: true,
      source: { source_channel: 'outlook', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Dr. Jacqueline Grant');
  });

  it('promotes deterministic directory names to verified', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Hoyem, George',
      email: 'ghoyem@iqt.org',
      relationshipEvidence: true,
      source: { source_channel: 'current_crm_contact', codepath: 'unit', evidence_level: 'corroborated' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('George Hoyem');
  });

  it('uses production-like website metadata to resolve company brands', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'clickup.com',
      domain: 'clickup.com',
      allowDomainPlaceholder: true,
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'ClickUp™ | Project Management',
        ogSiteName: 'ClickUp',
        confidence: 'strong',
      },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('ClickUp');
  });

  it('rejects website boilerplate metadata instead of verifying it as a company name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'clover.com',
      domain: 'clover.com',
      allowDomainPlaceholder: true,
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'You need to enable JavaScript to run this app.',
        ogSiteName: 'You Need To',
        confidence: 'strong',
      },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('Clover');
  });

  it('prefers a clean source company name over compressed domain-stem metadata', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Boyne Capital',
      domain: 'boynecapital.com',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'BoyneCapital',
        ogSiteName: 'BoyneCapital',
        confidence: 'strong',
      },
      source: { source_channel: 'import', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Boyne Capital');
    expect(resolution.candidates.some(candidate => candidate.normalizedName === 'BoyneCapital')).toBe(false);
  });

  it('keeps source names above location-only or redirect-page metadata', () => {
    const studio = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'AE Studio',
      domain: 'ae.studio',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Los Angeles, CA, USA',
        ogSiteName: 'Los Angeles, CA, USA',
        confidence: 'strong',
      },
      source: { source_channel: 'import', codepath: 'unit' },
    });
    const financialGuide = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Financial Guide, LLC',
      domain: 'financialguide.com',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Field Admin Tool Redirect Page',
        ogSiteName: 'Field Admin Tool Redirect Page',
        confidence: 'strong',
      },
      source: { source_channel: 'import', codepath: 'unit' },
    });

    expect(studio.normalizedName).toBe('AE Studio');
    expect(financialGuide.normalizedName).toBe('Financial Guide');
  });

  it('rejects CTA, URL, address, and escaped-HTML metadata fragments', () => {
    const avestix = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'avestix.com',
      domain: 'avestix.com',
      allowDomainPlaceholder: true,
      websiteMetadata: { ok: true, fetchedLive: true, title: 'A Recap Of Avestix', confidence: 'strong' },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });
    const underdog = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'underdoglabs.io',
      domain: 'underdoglabs.io',
      allowDomainPlaceholder: true,
      websiteMetadata: { ok: true, fetchedLive: true, title: 'By Underdog Labs', confidence: 'strong' },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });
    const verkada = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'verkada.com',
      domain: 'verkada.com',
      allowDomainPlaceholder: true,
      websiteMetadata: { ok: true, fetchedLive: true, title: 'Call Center&rsquo;', confidence: 'strong' },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });
    const financialGuide = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'financialguide.com',
      domain: 'financialguide.com',
      allowDomainPlaceholder: true,
      websiteMetadata: { ok: true, fetchedLive: true, title: 'Springfield, MA 01111-0001.', confidence: 'strong' },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(avestix.normalizedName).toBe('Avestix');
    expect(underdog.normalizedName).toBe('Underdog Labs');
    expect(verkada.normalizedName).toBe('Verkada');
    expect(financialGuide.normalizedName).toBe('Financial Guide');
  });

  it('segments compact finance and company domain stems into useful brand words', () => {
    const mbf = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'mbfhealthcarepartners.com',
      domain: 'mbfhealthcarepartners.com',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });
    const cedar = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'cedarcap.com',
      domain: 'cedarcap.com',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(mbf.normalizedName).toBe('MBF Healthcare Partners');
    expect(cedar.normalizedName).toBe('Cedar Capital');
  });

  it('uses strong owned metadata to verify a corroborated side of a compound company name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Salubris Health and auria',
      domain: 'salubrishealth.com',
      rootCause: 'compound_multi_entity_company_name',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Salubris Health',
        ogSiteName: 'Salubris Health',
        confidence: 'strong',
      },
      source: { source_channel: 'import', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Salubris Health');
  });

  it('uses strong metadata to rename a bad page-title company without compacting the domain', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Physicians Capital',
      domain: 'dynamicleap.vc',
      rootCause: 'website_title_or_page_title_used_as_company_name',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Dynamic Leap',
        ogSiteName: 'Dynamic Leap',
        schemaNames: ['Dynamic Leap'],
        confidence: 'strong',
      },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Dynamic Leap');
  });

  it('does not let redirected off-domain metadata beat a company-indicator domain brand', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Actions',
      domain: 'k50ventures.com',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        fetchUrl: 'https://k50ventures.com',
        finalUrl: 'https://www.actions.capital/',
        title: 'Actions',
        confidence: 'weak',
      },
      rootCause: 'website_title_or_page_title_used_as_company_name',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('K50 Ventures');
  });

  it('uses compact company suffixes in domains as canonical company words', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'ACA株式会社',
      domain: 'acainc.jp',
      websiteMetadata: { ok: true, fetchedLive: true, title: 'ACA', confidence: 'weak' },
      rootCause: 'website_title_or_page_title_used_as_company_name',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.normalizedName).toBe('ACA Inc');
  });

  it('prefers a concise domain-corroborated metadata brand over longer legal/display variants', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Committed Capital Investeringen',
      domain: 'committedcapital.nl',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Investeerder in mensen en groei-ambities – Committed Capital',
        ogSiteName: 'Committed Capital Investeringen',
        schemaNames: ['Committed Capital'],
        confidence: 'strong',
      },
      rootCause: 'website_title_or_page_title_used_as_company_name',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Committed Capital');
  });

  it('fuses descriptive title evidence with the domain when the brand suffix is corroborated', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Our Planet, Digitally Mirrored',
      domain: 'synplanet.com',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Our Planet, Digitally Mirrored',
        confidence: 'weak',
      },
      rootCause: 'website_title_or_page_title_used_as_company_name',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.normalizedName).toBe('SynPlanet');
  });

  it('keeps weak unconventional website metadata names provisional', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'imecxpand.com',
      domain: 'imecxpand.com',
      allowDomainPlaceholder: true,
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'imec.xpand',
        ogSiteName: 'imec.xpand',
        confidence: 'weak',
      },
      source: { source_channel: 'email_domain', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('imec.xpand');
  });

  it('filters schema dropdown noise and uses the visible organization title', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'thehillandvalleyforum.com',
      domain: 'thehillandvalleyforum.com',
      allowDomainPlaceholder: true,
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'The Hill and Valley Forum Foundation',
        ogSiteName: 'The Hill and Valley Forum Foundation',
        schemaNames: ['\\u00C5land Islands', 'Andorra', 'Angola'],
        confidence: 'strong',
      },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('The Hill and Valley Forum');
  });

  it('does not let schema utility names outrank a segmented domain brand', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'massmutual.com',
      domain: 'massmutual.com',
      allowDomainPlaceholder: true,
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        schemaNames: ['mmcom', 'SocialShareList', 'linkedin', 'Insurance', 'Center', 'link-to-form'],
        confidence: 'strong',
      },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Mass Mutual');
  });

  it('keeps dotted page-title brands instead of collapsing them to the domain stem', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Simple, secure login | ID.me',
      domain: 'id.me',
      websiteMetadata: { ok: false, fetchedLive: true, confidence: 'unknown' },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('ID.me');
  });

  it('uses middle title brand segments and ignores location suffixes', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'q-branch.dev',
      domain: 'q-branch.dev',
      allowDomainPlaceholder: true,
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Dual-Use + Research & Development Accelerator | Q-Branch | Austin, Texas',
        confidence: 'weak',
      },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.nameStatus).toBe('provisional');
    expect(resolution.normalizedName).toBe('Q-Branch');
  });

  it('normalizes legal acronym website metadata without compacting it to the domain stem', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'fvssgr.it',
      domain: 'fvssgr.it',
      allowDomainPlaceholder: true,
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Societa di Gestione del Risparmio | FVS SGR SpA',
        ogSiteName: 'FVS S.G.R. S.p.A.',
        applicationName: 'FVS S.G.R. S.p.A.',
        confidence: 'strong',
      },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('FVS SGR SpA');
  });

  it('extracts official-site and welcome-page company names from source titles', () => {
    const heat = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Official Site Of The Miami HEAT',
      domain: 'heat.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });
    const physicians = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'phycapfund.com',
      domain: 'phycapfund.com',
      allowDomainPlaceholder: true,
      websiteMetadata: { ok: true, fetchedLive: true, title: 'Welcome to Physicians Capital Fund', confidence: 'weak' },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(heat.normalizedName).toBe('The Miami Heat');
    expect(physicians.normalizedName).toBe('Physicians Capital Fund');
  });

  it('lets fused domain-title brands survive the verification firewall', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Freshmen - Entrepreneurs for Entrepreneurs',
      domain: 'freshmenfund.com',
      websiteMetadata: { ok: true, fetchedLive: true, title: 'Freshmen - Entrepreneurs for Entrepreneurs', confidence: 'weak' },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Freshmen Fund - Entrepreneurs for Entrepreneurs');
  });

  it('uses domain abbreviation rules instead of descriptor page titles', () => {
    const alius = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Institutional Real Estate for Private Wealth',
      domain: 'aliuscp.com',
      websiteMetadata: { ok: true, fetchedLive: true, confidence: 'weak' },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });
    const grupo = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Grupo Enriquez Agencias Aduanales, S.C.',
      domain: 'grupohenriquez.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(alius.normalizedName).toBe('Alius Capital Partners');
    expect(grupo.normalizedName).toBe('Grupo Henriquez');
  });

  it('prefers concise owned metadata over repeated report-title artifacts', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'elikonos.com',
      domain: 'elikonos.com',
      allowDomainPlaceholder: true,
      evidenceCandidates: [{
        value: 'Elikonos',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'domain_metadata',
        source_channel: 'public_domain_metadata',
        source_record_id: 'https://elikonos.com',
        source_text_excerpt: 'Elikonos',
        confidence: 'strong',
        privacy_scope: 'public_web',
        observed_at: null,
        rule_ids: [],
        cost_tier: 4,
      }, {
        value: 'Elikonos Elikonos Capital Financial Reports',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'domain_metadata',
        source_channel: 'public_domain_metadata',
        source_record_id: 'https://elikonos.com',
        source_text_excerpt: 'Elikonos Elikonos Capital Financial Reports',
        confidence: 'strong',
        privacy_scope: 'public_web',
        observed_at: null,
        rule_ids: [],
        cost_tier: 4,
      }],
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.normalizedName).toBe('Elikonos');
    expect(resolution.candidates.some(candidate => candidate.accepted && candidate.normalizedName === 'Elikonos Elikonos Capital Financial Reports')).toBe(false);
  });

  it('prefers explicit undotted metadata over dotted domain brands', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Home page',
      domain: 'auguria.io',
      rootCause: 'compound_multi_entity_company_name',
      websiteMetadata: { ok: true, fetchedLive: true, title: 'Home page', ogSiteName: 'Auguria.', confidence: 'strong' },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.normalizedName).toBe('Auguria');
    expect(resolution.status).toBe('verified');
  });

  it('downgrades bare dotted domain brands to tentative stem names without explicit dotted evidence', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Home page',
      domain: 'auguria.io',
      rootCause: 'compound_multi_entity_company_name',
      websiteMetadata: { ok: true, fetchedLive: true, confidence: 'unknown' },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).toBe('Auguria');
  });

  it('rejects disclosure metadata and keeps short acronym fund domains provisional', () => {
    const ramp = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Ramp Business Corporation',
      domain: 'ramp.com',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Disclosures , Ramp Financing Corporation - Nmls',
        ogSiteName: 'Ramp',
        confidence: 'strong',
      },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });
    const axp = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'axpfund.com',
      domain: 'axpfund.com',
      allowDomainPlaceholder: true,
      websiteMetadata: { ok: true, fetchedLive: true, confidence: 'unknown' },
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(ramp.normalizedName).toBe('Ramp');
    expect(ramp.candidates.some(candidate => candidate.normalizedName === 'Nmls' && candidate.accepted)).toBe(false);
    expect(axp.status).toBe('provisional');
    expect(axp.normalizedName).toBe('Axp Fund');
  });

  it('allows assistant-bridge display names only when the person name is explicit', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'John Puente Via Read AI',
      email: 'executiveassistant@e.read.ai',
      relationshipEvidence: true,
      source: { source_channel: 'outlook', codepath: 'unit', source_text: 'John Puente Via Read AI', evidence_level: 'weak_single_source' },
    });
    const gate = evaluateCrmQualityGate({
      entityType: 'contact',
      action: 'create',
      proposedName: resolution.normalizedName,
      email: 'executiveassistant@e.read.ai',
      nameStatus: resolution.nameStatus,
      source: { source_channel: 'outlook', codepath: 'unit', source_text: 'John Puente Via Read AI' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('John Puente');
    expect(gate.writeAllowed).toBe(true);
    expect(gate.normalizedName).toBe('John Puente');
  });

  it('returns all split candidates for compound company strings', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'PEF Community / Vine Ventures',
      source: { source_channel: 'current_crm_company', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.splitNames).toEqual(['PEF Community', 'Vine Ventures']);
  });

  it('keeps evidence-bundle split company candidates provisional', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Defense Advanced Research Projects Agency (DARPA) / Applied Research Institute (ARI)',
      rootCause: 'compound_multi_entity_company_name',
      relationshipEvidence: true,
      evidenceCandidates: [{
        value: 'Defense Advanced Research Projects Agency (DARPA)',
        entity_type: 'company',
        candidate_kind: 'split_candidate',
        source_type: 'local_parser',
        source_channel: 'compound_parser',
        source_record_id: 'row-138',
        source_text_excerpt: 'Defense Advanced Research Projects Agency (DARPA) / Applied Research Institute (ARI)',
        confidence: 'medium',
        privacy_scope: 'source_payload',
        observed_at: null,
        rule_ids: [],
        cost_tier: 0,
      }, {
        value: 'Applied Research Institute (ARI)',
        entity_type: 'company',
        candidate_kind: 'split_candidate',
        source_type: 'local_parser',
        source_channel: 'compound_parser',
        source_record_id: 'row-138',
        source_text_excerpt: 'Defense Advanced Research Projects Agency (DARPA) / Applied Research Institute (ARI)',
        confidence: 'medium',
        privacy_scope: 'source_payload',
        observed_at: null,
        rule_ids: [],
        cost_tier: 0,
      }],
      source: { source_channel: 'current_crm_company', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.nameStatus).toBe('provisional');
  });

  it('marks page-title selections provisional when an earlier plausible name competes', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Dual-Use + Research & Development Accelerator',
      domain: 'q-branch.com',
      websiteMetadata: {
        ok: true,
        fetchedLive: true,
        title: 'Dual-Use + Research & Development Accelerator | Q-Branch | Austin, Texas',
        confidence: 'strong',
      },
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });

    expect(resolution.normalizedName).toBe('Q-Branch');
    expect(resolution.status).toBe('provisional');
    expect(resolution.nameStatus).toBe('provisional');
  });

  it('marks domain-stem fallback provisional when a page-title row has a competing organization phrase', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Dual-Use + Research & Development Accelerator',
      domain: 'q-branch.dev',
      websiteMetadata: { ok: true, fetchedLive: true, confidence: 'unknown' },
      source: { source_channel: 'current_crm_company', codepath: 'unit' },
    });

    expect(resolution.normalizedName).toBe('Q-Branch');
    expect(resolution.status).toBe('provisional');
    expect(resolution.nameStatus).toBe('provisional');
  });

  it('lets same-org evidence resolve a full contact name before local-part fallback', async () => {
    const { resolution, evidenceBundle } = await resolveCrmEntityNameWithEvidence({
      entityType: 'contact',
      rawName: 'enegrete',
      email: 'enegrete@quantumbb.com',
      relationshipEvidence: true,
      runtimeEvidenceCandidates: [{
        value: 'Eugenio López Negrete',
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'existing_crm_entity',
        source_channel: 'current_crm_contact',
        source_record_id: 'contact-1',
        source_text_excerpt: 'Eugenio López Negrete',
        confidence: 'strong',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    }, undefined, { includeNetwork: false });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Eugenio Lopez Negrete');
    expect(evidenceBundle.gold_used_at_runtime).toBe(false);
  });

  it('uses first-name plus family-domain evidence as a verified contact candidate', async () => {
    const { resolution } = await resolveCrmEntityNameWithEvidence({
      entityType: 'contact',
      rawName: 'Elias',
      email: 'elias@torrez.us',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    }, undefined, { includeNetwork: false });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Elias Torrez');
  });

  it('preserves useful legal suffixes while trimming public-company legal boilerplate', async () => {
    const ptt = await resolveCrmEntityNameWithEvidence({
      entityType: 'company',
      rawName: 'or.th',
      domain: 'or.th',
      allowDomainPlaceholder: true,
      runtimeEvidenceCandidates: [{
        value: 'PTT Oil and Retail Business Public Company Limited',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'existing_crm_entity',
        source_channel: 'current_crm_company',
        source_record_id: 'company-1',
        source_text_excerpt: 'PTT Oil and Retail Business Public Company Limited',
        confidence: 'medium',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'email_domain', codepath: 'unit' },
    }, undefined, { includeNetwork: false });
    const interiors = await resolveCrmEntityNameWithEvidence({
      entityType: 'company',
      rawName: 'southkendallinteriors.com',
      domain: 'southkendallinteriors.com',
      allowDomainPlaceholder: true,
      runtimeEvidenceCandidates: [{
        value: 'South Kendall Interiors, Inc.',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'existing_crm_entity',
        source_channel: 'current_crm_company',
        source_record_id: 'company-2',
        source_text_excerpt: 'South Kendall Interiors, Inc.',
        confidence: 'strong',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'email_domain', codepath: 'unit' },
    }, undefined, { includeNetwork: false });

    expect(ptt.resolution.status).toBe('verified');
    expect(ptt.resolution.normalizedName).toBe('PTT Oil and Retail Business');
    expect(interiors.resolution.normalizedName).toBe('South Kendall Interiors, Inc.');
  });

  it('keeps longer dot-io brands when the domain itself is the brand signal', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Front page',
      domain: 'pioneers.io',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Pioneers.io');
  });

  it('uses repeated org-owned conversation display names before local-part fallback', async () => {
    const env = resolverEnv(sql => {
      if (sql.includes('FROM conversations')) {
        return [
          {
            id: 'conv-1',
            source: 'outlook',
            from_email: 'casey.steadman@fiu.edu',
            from_name: 'Casey Steadman',
            subject: 'Re: FIU intro',
            body_preview: '',
            sent_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'conv-2',
            source: 'outlook',
            from_email: 'other@example.com',
            from_name: '',
            to_emails: JSON.stringify([{ email: 'casey.steadman@fiu.edu', name: 'Casey Steadman' }]),
            cc_emails: '[]',
            subject: 'Follow up',
            body_preview: '',
            sent_at: '2026-01-02T00:00:00Z',
          },
        ];
      }
      return [];
    });

    const { resolution, evidenceBundle } = await resolveCrmEntityNameWithEvidence({
      entityType: 'contact',
      rawName: 'csteadma',
      email: 'casey.steadman@fiu.edu',
      orgId: 'org-1',
      entityId: 'contact-1',
      relationshipEvidence: true,
      source: { source_channel: 'outlook', codepath: 'unit', evidence_level: 'weak_single_source' },
    }, env, { includeNetwork: false });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Casey Steadman');
    expect(evidenceBundle.candidates.some(candidate => candidate.source_type === 'conversation_header')).toBe(true);
  });

  it('extracts exact-email quoted headers and signatures from org-owned body previews', async () => {
    const env = resolverEnv(sql => sql.includes('FROM conversations')
      ? [{
        id: 'conv-1',
        source: 'outlook',
        from_email: 'raul@medinavc.com',
        from_name: 'Raul',
        subject: 'Forwarded intro',
        body_preview: 'From: Enrique Font <efont@cixsa.com>\nBest regards,\nEnrique Font\nCIXSA',
        sent_at: '2026-01-01T00:00:00Z',
      }]
      : []);

    const { resolution, evidenceBundle } = await resolveCrmEntityNameWithEvidence({
      entityType: 'contact',
      rawName: 'efont',
      email: 'efont@cixsa.com',
      orgId: 'org-1',
      entityId: 'contact-1',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    }, env, { includeNetwork: false });

    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Enrique Font');
    expect(evidenceBundle.candidates.some(candidate => candidate.source_type === 'quoted_header')).toBe(true);
  });

  it('skips provider identity gracefully when Graph credentials are absent', async () => {
    const { resolution, evidenceBundle } = await resolveCrmEntityNameWithEvidence({
      entityType: 'contact',
      rawName: 'jmansfield',
      email: 'jmansfield@tricap.com',
      orgId: 'org-1',
      entityId: 'contact-1',
      relationshipEvidence: true,
      source: { source_channel: 'outlook', codepath: 'unit', evidence_level: 'weak_single_source' },
    }, resolverEnv(() => []), { includeNetwork: true });

    expect(resolution.status).toBe('provisional');
    expect(evidenceBundle.gold_used_at_runtime).toBe(false);
    expect(evidenceBundle.builder_diagnostics?.some(item => item.builder === 'first_party_identity')).toBe(true);
  });

  it('does not let current CRM self-evidence verify a local-part junk contact name', () => {
    const resolution = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Csteadma',
      email: 'csteadma@fiu.edu',
      relationshipEvidence: true,
      evidenceCandidates: [{
        value: 'Csteadma',
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'existing_crm_entity',
        source_channel: 'current_crm_contact',
        source_record_id: 'contact-1',
        source_text_excerpt: 'Csteadma',
        confidence: 'medium',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'outlook', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(resolution.status).toBe('provisional');
    expect(resolution.normalizedName).not.toBe('Casey Steadman');
  });

  it('extracts company names from bounded same-domain pages beyond the homepage', async () => {
    process.env.CRM_QUALITY_ENABLE_LIVE_METADATA_IN_TESTS = 'true';
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const target = String(url);
      const body = target.includes('/about')
        ? '<html><head><title>About Us</title><script type="application/ld+json">{"@type":"Organization","name":"Boiling Point Capital"}</script></head><body>© 2026 Boiling Point Capital. All rights reserved.</body></html>'
        : '<html><head><title>Axp Fund</title><meta property="og:site_name" content="Axp Fund"></head><body><a href="/about">About</a></body></html>';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    });

    const metadata = await fetchCompanyWebsiteMetadata({ domain: 'axpfund.com', timeoutMs: 500 });
    const resolution = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'axpfund.com',
      domain: 'axpfund.com',
      allowDomainPlaceholder: true,
      websiteMetadata: metadata,
      source: { source_channel: 'email_domain', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(metadata?.schemaNames).toContain('Boiling Point Capital');
    expect(resolution.status).toBe('verified');
    expect(resolution.normalizedName).toBe('Boiling Point Capital');
  });

  it('blocks website artifacts and taglines from becoming verified company names', () => {
    const qualcomm = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Qualcomm: Intelligent Computing Everywhere',
      domain: 'qualcomm.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });
    expect(qualcomm.status).toBe('verified');
    expect(qualcomm.normalizedName).toBe('Qualcomm');
    expect(qualcomm.normalizedName).not.toBe('Intelligent Computing Everywhere');

    const blackwing = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Blackwing',
      domain: 'blackwing.vc',
      evidenceCandidates: [{
        value: 'Back To Blackwing',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'domain_metadata',
        source_channel: 'public_domain_metadata',
        source_record_id: 'https://blackwing.vc',
        source_text_excerpt: 'Back To Blackwing',
        confidence: 'strong',
        privacy_scope: 'public',
        observed_at: null,
        rule_ids: [],
        cost_tier: 4,
      }],
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });
    expect(blackwing.status).not.toBe('verified');
    expect(blackwing.normalizedName).toBe('Blackwing');

    const index = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Index of /',
      domain: 'pwaspa.com',
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });
    expect(index.normalizedName).not.toBe('Index Of');
    expect(index.status).not.toBe('verified');
  });

  it('blocks wrong-entity metadata and compressed CRM neighbors from verified company names', () => {
    const regent = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'REGENT',
      domain: 'regentcraft.com',
      evidenceCandidates: [{
        value: 'Valor Equity Partners',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'domain_metadata',
        source_channel: 'public_domain_metadata',
        source_record_id: 'https://regentcraft.com',
        source_text_excerpt: 'Valor Equity Partners',
        confidence: 'strong',
        privacy_scope: 'public',
        observed_at: null,
        rule_ids: [],
        cost_tier: 4,
      }],
      source: { source_channel: 'web_enrichment_company', codepath: 'unit' },
    });
    expect(regent.normalizedName).not.toBe('Valor Equity Partners');
    expect(regent.candidates.find(candidate => candidate.normalizedName === 'Valor Equity Partners')?.verification_decision).toBe('reject');

    const compressed = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'The FSB Companies',
      domain: 'fsbcompanies.com',
      evidenceCandidates: [{
        value: 'Thefsbcompanies',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'crm_neighbor',
        source_channel: 'crm_company_neighbor',
        source_record_id: 'company-1',
        source_text_excerpt: 'Thefsbcompanies fsbcompanies.com',
        confidence: 'strong',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'crm_neighbor', codepath: 'unit' },
    });
    expect(compressed.normalizedName).toBe('The FSB Companies');
    expect(compressed.candidates.find(candidate => candidate.normalizedName === 'Thefsbcompanies')?.verification_decision).toBe('reject');
  });

  it('blocks contact header artifacts and non-person contacts from being verified', () => {
    const pepe = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Pepe Fanjul Jr.',
      email: 'pf@fcsugar.com',
      relationshipEvidence: true,
      evidenceCandidates: [{
        value: 'Pepe Sent',
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: 'conversation_header',
        source_record_id: 'conv-1',
        source_text_excerpt: 'Pepe Sent',
        confidence: 'medium',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'corroborated' },
    });
    expect(pepe.normalizedName).toBe('Pepe Fanjul Jr.');
    expect(pepe.candidates.find(candidate => candidate.normalizedName === 'Pepe Sent')?.verification_decision).toBe('reject');

    const serviceDesk = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Federal Service Desk (fsd)',
      email: 'fsdsupport@gsa.gov',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });
    expect(serviceDesk.status).toBe('no_entity');

    const counselingOffice = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'College Counseling Office',
      email: 'm@mail3.veracross.com',
      relationshipEvidence: true,
      evidenceCandidates: [{
        value: 'Gulliver Prep',
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'crm_neighbor',
        source_channel: 'crm_contact_neighbor',
        source_record_id: 'contact-1',
        source_text_excerpt: 'Gulliver Prep',
        confidence: 'strong',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'corroborated' },
    });
    expect(counselingOffice.status).toBe('no_entity');
  });

  it('downgrades partial person names instead of verifying them', () => {
    const partial = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Sebastian Da Silva',
      email: 'sebastiands@ibrolur.com.uy',
      relationshipEvidence: true,
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'weak_single_source' },
    });
    expect(partial.normalizedName).toBe('Sebastian Da Silva');

    const headerNoise = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Cil, Jose',
      email: 'jose.cil@jabholco.com',
      relationshipEvidence: true,
      evidenceCandidates: [{
        value: 'Jose Get',
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: 'conversation_header',
        source_record_id: 'conv-2',
        source_text_excerpt: 'Jose Get',
        confidence: 'medium',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'corroborated' },
    });
    expect(headerNoise.normalizedName).toBe('Jose Cil');
    expect(headerNoise.candidates.find(candidate => candidate.normalizedName === 'Jose Get')?.verification_decision).toBe('reject');
  });

  it('prefers clean source company names over domain strings and truncated domain stems', () => {
    const angeles = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Angeles Equity Partners',
      currentName: 'Angeles Equity Partners',
      domain: 'angelesequity.com',
      allowDomainPlaceholder: true,
      evidenceCandidates: [{
        value: 'Ank You for Subscribing To Receive Our Latest News. Angeles Equity Partners',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'domain_metadata',
        source_channel: 'domain_metadata',
        source_record_id: 'https://angelesequity.com',
        source_text_excerpt: 'Ank You for Subscribing To Receive Our Latest News. Angeles Equity Partners',
        confidence: 'strong',
        privacy_scope: 'public',
        observed_at: null,
        rule_ids: [],
        cost_tier: 4,
      }],
      source: { source_channel: 'company_create', codepath: 'unit', evidence_level: 'weak_single_source' },
    });
    expect(angeles.normalizedName).toBe('Angeles Equity Partners');
    expect(angeles.status).toBe('provisional');

    const finra = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'Financial Industry Regulatory Authority',
      currentName: 'Financial Industry Regulatory Authority',
      domain: 'finra.org',
      allowDomainPlaceholder: true,
      evidenceCandidates: [{
        value: 'FINRA.org',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'domain_metadata',
        source_channel: 'domain_metadata',
        source_record_id: 'https://finra.org',
        source_text_excerpt: 'FINRA.org',
        confidence: 'strong',
        privacy_scope: 'public',
        observed_at: null,
        rule_ids: [],
        cost_tier: 4,
      }],
      source: { source_channel: 'company_create', codepath: 'unit', evidence_level: 'weak_single_source' },
    });
    expect(finra.normalizedName).toBe('Financial Industry Regulatory Authority');
    expect(finra.status).toBe('provisional');
    expect(finra.candidates.some(candidate => candidate.status === 'verified' && /finra\.org/i.test(candidate.normalizedName))).toBe(false);
  });

  it('retains single-token source brands tentatively instead of creating domain placeholders', () => {
    const appGate = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'AppGate',
      currentName: 'AppGate',
      domain: 'appgate.com',
      allowDomainPlaceholder: true,
      evidenceCandidates: [{
        value: 'AppGate Cybersecurity, Inc. and',
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'domain_metadata',
        source_channel: 'domain_metadata',
        source_record_id: 'https://appgate.com',
        source_text_excerpt: 'AppGate Cybersecurity, Inc. and',
        confidence: 'strong',
        privacy_scope: 'public',
        observed_at: null,
        rule_ids: [],
        cost_tier: 4,
      }],
      source: { source_channel: 'company_create', codepath: 'unit', evidence_level: 'weak_single_source' },
    });

    expect(appGate.normalizedName).toBe('AppGate');
    expect(appGate.status).toBe('provisional');
    expect(appGate.nameStatus).toBe('provisional');
  });

  it('segments deterministic domain stems with numbers and known company words', () => {
    const fiveSpheres = resolveCrmEntityName({
      entityType: 'company',
      rawName: '5spherescapital.com',
      domain: '5spherescapital.com',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });
    const csc108 = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'csc108.com',
      domain: 'csc108.com',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });
    const oceanAzul = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'oceanazulpartners.com',
      domain: 'oceanazulpartners.com',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });
    const sequentialConnect = resolveCrmEntityName({
      entityType: 'company',
      rawName: 'sequentialconnect.com',
      domain: 'sequentialconnect.com',
      allowDomainPlaceholder: true,
      source: { source_channel: 'email_domain', codepath: 'unit' },
    });

    expect(fiveSpheres.normalizedName).toBe('5 Spheres Capital');
    expect(csc108.normalizedName).toBe('CSC 108');
    expect(oceanAzul.normalizedName).toBe('Ocean Azul Partners');
    expect(sequentialConnect.normalizedName).toBe('Sequential Connect');
  });

  it('does not treat contractor context as a preferred contact name', () => {
    const contact = resolveCrmEntityName({
      entityType: 'contact',
      rawName: 'Rapp, Edith (contr)',
      currentName: 'Rapp, Edith (contr)',
      email: 'edith.rapp@example.com',
      relationshipEvidence: true,
      evidenceCandidates: [{
        value: 'Edith Edith',
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: 'conversation_header',
        source_record_id: 'conv-1',
        source_text_excerpt: 'Edith Edith',
        confidence: 'strong',
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [],
        cost_tier: 1,
      }],
      source: { source_channel: 'email_header', codepath: 'unit', evidence_level: 'corroborated' },
    });

    expect(contact.normalizedName).toBe('Edith Rapp');
    expect(contact.candidates.find(candidate => candidate.normalizedName === 'Edith Edith')?.verification_decision).toBe('reject');
  });

  it('keeps the four human-confirmed bad verified names out of verified status', () => {
    const fixtures = [
      {
        entityType: 'company' as const,
        rawName: 'Platina 2019-2021,',
        domain: 'platina.com',
      },
      {
        entityType: 'company' as const,
        rawName: 'Ankuraprotectcreateandrecovervalue',
        domain: 'ankura.com',
      },
      {
        entityType: 'company' as const,
        rawName: 'Balerion SpAce',
        domain: 'balerion.space',
      },
      {
        entityType: 'contact' as const,
        rawName: 'Marc Cadieux And Jesse Hurley Frank Holding',
        email: 'marc@example.com',
        relationshipEvidence: true,
      },
    ];

    for (const fixture of fixtures) {
      const result = resolveCrmEntityName({
        ...fixture,
        allowDomainPlaceholder: fixture.entityType === 'company',
        source: {
          source_channel: 'bad_verified_regression',
          codepath: 'unit',
          evidence_level: 'corroborated',
        },
      });
      expect(result.status, fixture.rawName).not.toBe('verified');
      expect(result.nameStatus, fixture.rawName).not.toBe('verified');
    }
  });

  it('does not re-verify reviewed bad-verified cloud canary fixtures', () => {
    const fixturePath = join(
      process.cwd(),
      'outputs',
      'crm-stage1-investigation-20260619',
      'crm-quality-cloud-canary-20260622-300-v1',
      'cloud-canary-bad-verified-names.csv'
    );
    if (!existsSync(fixturePath)) return;

    const parsed = Papa.parse<BadVerifiedRegressionRow>(readFileSync(fixturePath, 'utf8'), {
      header: true,
      skipEmptyLines: true,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data.length).toBe(39);

    const stillBadVerified: string[] = [];
    for (const row of parsed.data) {
      const sourceType = regressionEvidenceSourceType(row.resolver_reason);
      const result = resolveCrmEntityName({
        entityType: row.entity_type,
        rawName: row.source_snapshot_name_for_review,
        currentName: row.source_snapshot_name_for_review,
        email: row.email || undefined,
        domain: row.domain || undefined,
        relationshipEvidence: true,
        evidenceCandidates: [{
          value: row.produced_name,
          entity_type: row.entity_type,
          candidate_kind: row.entity_type === 'company' ? 'company_name' : 'contact_name',
          source_type: row.entity_type === 'contact' && sourceType !== 'crm_neighbor' ? 'conversation_header' : sourceType,
          source_channel: 'bad_verified_regression',
          source_record_id: row.domain || row.email || row.sample_index,
          source_text_excerpt: row.produced_name,
          confidence: 'strong',
          privacy_scope: row.entity_type === 'company' ? 'public' : 'org_owned',
          observed_at: null,
          rule_ids: [],
          cost_tier: row.entity_type === 'company' ? 4 : 1,
        }],
        source: {
          source_channel: 'bad_verified_regression',
          codepath: 'unit',
          evidence_level: 'corroborated',
        },
      });
      if (result.status === 'verified' && result.normalizedName?.toLowerCase() === row.produced_name.toLowerCase()) {
        stillBadVerified.push(`${row.sample_index}:${row.entity_type}:${row.produced_name}:${row.codex_validity_class}`);
      }
    }

    expect(stillBadVerified).toEqual([]);
  });
});
