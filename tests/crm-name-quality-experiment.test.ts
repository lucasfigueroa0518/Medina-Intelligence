import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { adjudicateExperimentRow, type ExperimentRuntimeRow } from '../scripts/crm-name-quality-experiment';

function row(overrides: Partial<ExperimentRuntimeRow>): ExperimentRuntimeRow {
  return {
    experiment_id: 'unit',
    cohort: 'fresh_blind_generalization',
    entity_type: 'company',
    entity_id: 'entity-1',
    org_id: 'org-1',
    mode: 'first_time',
    trigger_codepath: 'unit',
    source_snapshot_name_for_review: 'Blackwing',
    email: '',
    domain: 'blackwing.co',
    website: 'https://blackwing.co',
    company_context: '',
    expected_name: '',
    expected_status: '',
    gold_available: false,
    runtime_allowed_fields: 'source_snapshot_name_for_review; domain; production_like_evidence_bundle',
    produced_name: 'Blackwing',
    produced_name_status: 'verified',
    ui_tag_if_created: '',
    confidence: 'high',
    resolver_reason: 'domain_metadata evidence candidate resolved company name',
    semantic_class: 'clean_name',
    risk_flags: '',
    verification_decision: 'verify',
    firewall_block_reason: '',
    status_before_firewall: 'verified',
    status_after_firewall: 'verified',
    evidence_source_types: 'source_payload; domain_metadata',
    network_calls: 1,
    gold_used_at_runtime: false,
    production_rows_written: 0,
    runtime_source_channel: 'unit',
    runtime_codepath: 'unit',
    runtime_source_fields_used: 'source_snapshot_name_for_review; domain',
    runtime_metadata_fetched_live: true,
    ...overrides,
  };
}

describe('CRM name quality experiment adjudication', () => {
  it('treats bad verified company artifacts as P0 failures', () => {
    const reviewed = adjudicateExperimentRow(row({
      source_snapshot_name_for_review: 'Qualcomm: Intelligent Computing Everywhere',
      produced_name: 'Intelligent Computing Everywhere',
      produced_name_status: 'verified',
      resolver_reason: 'page title stripped to brand segment',
      evidence_source_types: 'domain_metadata',
    }));

    expect(reviewed.codex_final_pass).toBe('no');
    expect(reviewed.gap_cluster).toBe('semantic_firewall_gap');
    expect(reviewed.fix_priority).toBe('P0');
  });

  it('accepts clean brand extraction from a descriptive page title', () => {
    const reviewed = adjudicateExperimentRow(row({
      source_snapshot_name_for_review: 'Clarifying the Complex | Thomson Reuters',
      produced_name: 'Thomson Reuters',
      produced_name_status: 'verified',
      resolver_reason: 'page title stripped to brand segment',
      evidence_source_types: 'source_payload; domain_metadata',
    }));

    expect(reviewed.codex_final_pass).toBe('yes');
    expect(reviewed.codex_validity_class).toBe('valid_company_name');
  });

  it('allows weak useful names only when tagged provisional', () => {
    const reviewed = adjudicateExperimentRow(row({
      entity_type: 'contact',
      source_snapshot_name_for_review: 'j.shade',
      email: 'j.shade@example.com',
      produced_name: 'J. Shade',
      produced_name_status: 'provisional',
      ui_tag_if_created: 'Tentative name',
      semantic_class: 'weak_name',
      verification_decision: 'downgrade_provisional',
      status_after_firewall: 'provisional',
      evidence_source_types: 'local_parser',
    }));

    expect(reviewed.codex_final_pass).toBe('yes');
    expect(reviewed.codex_validity_class).toBe('valid_tentative_contact_name');
  });

  it('fails a domain placeholder when the source snapshot has a clean company name', () => {
    const reviewed = adjudicateExperimentRow(row({
      source_snapshot_name_for_review: 'NeoPollard',
      produced_name: 'neopollard.com',
      produced_name_status: 'domain_placeholder',
      ui_tag_if_created: 'Tentative name',
      semantic_class: 'domain_placeholder',
      verification_decision: 'accept_domain_placeholder',
      evidence_source_types: 'source_payload',
    }));

    expect(reviewed.codex_final_pass).toBe('no');
    expect(reviewed.gap_cluster).toBe('source_extraction_gap');
    expect(reviewed.codex_recommended_name_or_action).toBe('NeoPollard');
  });

  it('scores approved exact name and status matches as passing', () => {
    const reviewed = adjudicateExperimentRow(row({
      cohort: 'approved_recall_suite',
      source_snapshot_name_for_review: 'AI Sales Agents for Revenue Teams | Demodesk',
      expected_name: 'Demodesk',
      expected_status: 'verified',
      gold_available: true,
      produced_name: 'Demodesk',
      produced_name_status: 'verified',
    }));

    expect(reviewed.codex_final_pass).toBe('yes');
  });

  it('keeps the cloud worker row count variable instead of hard-coded to 300', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'crm-quality-cloud-canary-worker.ts'), 'utf8');

    expect(source).toContain('MAX_CANARY_ROWS');
    expect(source).not.toContain('rows.length !== 300');
    expect(source).toContain("error: 'missing rows'");
  });
});
