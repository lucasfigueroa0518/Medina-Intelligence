#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import Papa from 'papaparse';

import type { Env } from '../src/types/env';
import type { ClassifiableItem } from '../src/types/interfaces';
import {
  CRM_QUALITY_RULES,
  evaluateCrmQualityGate,
  type CrmQualityGateResult,
} from '../src/lib/crm-quality-gate';
import {
  discoverNewContact,
  findOrCreateCompanyByDomain,
  type DiscoveryEligibility,
} from '../src/lib/discovery';
import { autoCreateContactFromAttendee, normalizeAttendeeName } from '../src/lib/firefly-intelligence';
import { resolveContactName } from '../src/lib/name-quality';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONTRACT_DIR = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');

interface Args {
  contractDir: string;
  outputDir: string;
  allowFailures: boolean;
}

interface CanaryRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_bad_output: string;
  ideal_expected_output: string;
  root_cause_represented: string;
  why_selected: string;
  proposed_pipeline_behavior: string;
  pass_fail_criteria: string;
}

interface MatrixRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_name: string;
  proposed_action: 'keep' | 'rename' | 'merge' | 'delete' | 'investigate';
  proposed_name: string;
  final_proposed_name: string;
  merge_target_id: string;
  delete_reason: string;
  root_cause: string;
  exact_validation_rule_ids: string;
  root_cause_evidence_basis: string;
  path_confidence: string;
  correction_confidence: string;
  stage1_evidence: string;
}

interface ContactEvidence {
  id: string;
  full_name: string;
  email: string | null;
  company_id?: string | null;
  company_domain?: string | null;
}

interface CompanyEvidence {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  custom_fields?: string | null;
}

interface EventNameEvidence {
  contact_id: string;
  email: string | null;
  display_name: string | null;
  evidence_count?: number;
  sample_event_titles?: string | null;
}

interface AuditCreateEvidence {
  entity_type: string;
  entity_id: string;
  auto_created?: number | null;
  discovered_from?: string | null;
  metadata_sample?: string | null;
}

export interface SourceReplayDecision {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  root_cause: string;
  expected_action: string;
  expected_output: string;
  replay_path: string;
  validation_strength: 'raw_evidence_codepath' | 'source_shaped_fixture' | 'contract_only_missing_source_trace';
  safety_passed: boolean;
  after_state_recovered: boolean;
  source_trace_gap: boolean;
  production_rows_written: 0;
  isolated_rows_written: number;
  observed_output: string;
  observed_decision: string;
  rule_ids: string;
  notes: string;
}

export interface CrmQualitySourceReplaySummary {
  dry_run: true;
  validation_layer: 'source_shaped_replay';
  contract_dir: string;
  canary_rows: number;
  production_rows_written: 0;
  isolated_rows_written: number;
  safety_passed: number;
  safety_failed: number;
  after_state_recovered: number;
  after_state_not_recovered: number;
  source_trace_gaps: number;
  validation_strength_counts: Record<string, number>;
  replay_path_counts: Record<string, number>;
  decisions_path: string;
  failures_path: string;
  summary_path: string;
}

class ReplayStatement {
  private binds: unknown[] = [];
  constructor(private readonly db: ReplayD1, private readonly sql: string) {}
  bind(...args: unknown[]): ReplayStatement {
    this.binds = args;
    return this;
  }
  async first<T = any>(): Promise<T | null> {
    return this.db.first(this.sql, this.binds) as T | null;
  }
  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.binds) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    return this.db.run(this.sql, this.binds);
  }
}

class ReplayD1 {
  companies: Array<Record<string, any>>;
  contacts: Array<Record<string, any>>;
  writes: Array<{ sql: string; binds: unknown[] }> = [];

  constructor(args: { companies?: Array<Record<string, any>>; contacts?: Array<Record<string, any>> } = {}) {
    this.companies = args.companies || [];
    this.contacts = args.contacts || [];
  }

  prepare(sql: string): ReplayStatement {
    return new ReplayStatement(this, sql);
  }

  async batch(statements: ReplayStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  first(sql: string, binds: unknown[]): Record<string, any> | null {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    if (/SELECT id FROM companies/i.test(normalizedSql) && /LOWER\(domain\) = \?/i.test(normalizedSql)) {
      const domain = clean(binds[1]).toLowerCase();
      const like = clean(binds[2]).replace(/%/g, '').toLowerCase();
      const row = this.companies.find(company =>
        lower(company.domain) === domain || (like && lower(company.website).includes(like))
      );
      return row ? { id: row.id } : null;
    }

    if (/SELECT id FROM companies/i.test(normalizedSql) && /LOWER\(website\) LIKE \?/i.test(normalizedSql)) {
      const like = clean(binds[1]).replace(/%/g, '').toLowerCase();
      const row = this.companies.find(company => like && lower(company.website).includes(like));
      return row ? { id: row.id } : null;
    }

    if (/SELECT id FROM companies/i.test(normalizedSql) && /LOWER\(name\) LIKE \?/i.test(normalizedSql)) {
      const like = clean(binds[1]).replace(/%/g, '').toLowerCase();
      const row = this.companies.find(company => like && lower(company.name).includes(like));
      return row ? { id: row.id } : null;
    }

    if (/SELECT id FROM contacts/i.test(normalizedSql) && /LOWER\(email\) IN/i.test(normalizedSql)) {
      const emails = binds.slice(1).map(value => lower(value));
      const row = this.contacts.find(contact => emails.includes(lower(contact.email)));
      return row ? { id: row.id } : null;
    }

    if (/SELECT company_id FROM contacts WHERE id = \?/i.test(normalizedSql)) {
      const row = this.contacts.find(contact => contact.id === binds[0]);
      return row?.company_id ? { company_id: row.company_id } : null;
    }

    if (/SELECT id, company_id FROM contacts/i.test(normalizedSql) && /LOWER\(email\) = \?/i.test(normalizedSql)) {
      const email = lower(binds[1]);
      const row = this.contacts.find(contact => lower(contact.email) === email);
      return row ? { id: row.id, company_id: row.company_id || null } : null;
    }

    if (/SELECT id FROM contacts/i.test(normalizedSql) && /LOWER\(full_name\) = \?/i.test(normalizedSql)) {
      const name = lower(binds[1]);
      const companyId = clean(binds[2]);
      const row = this.contacts.find(contact => lower(contact.full_name) === name && clean(contact.company_id) === companyId);
      return row ? { id: row.id } : null;
    }

    return null;
  }

  all(sql: string, binds: unknown[]): Array<Record<string, any>> {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    if (/SELECT id, name, domain, website FROM companies/i.test(normalizedSql)) {
      return this.companies.map(({ id, name, domain, website }) => ({ id, name, domain: domain || null, website: website || null }));
    }
    if (/SELECT id, domain FROM companies/i.test(normalizedSql)) {
      return this.companies.filter(company => company.domain).map(({ id, domain }) => ({ id, domain }));
    }
    return [];
  }

  run(sql: string, binds: unknown[]): { meta: { changes: number } } {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    this.writes.push({ sql: normalizedSql, binds });

    if (/INSERT INTO companies/i.test(normalizedSql)) {
      const [id, orgId, name, domain, website, maybeCustomFields] = binds;
      this.companies.push({
        id,
        org_id: orgId,
        name,
        domain,
        website,
        custom_fields: typeof maybeCustomFields === 'string' && maybeCustomFields.startsWith('{') ? maybeCustomFields : '{}',
        deleted_at: null,
      });
      return { meta: { changes: 1 } };
    }

    if (/INSERT OR IGNORE INTO contacts|INSERT INTO contacts/i.test(normalizedSql)) {
      const [id, orgId, fullName, email, maybeCompanyId] = binds;
      const maybeCustomFields = [...binds].reverse().find(value => typeof value === 'string' && String(value).trim().startsWith('{'));
      if (this.contacts.some(contact => lower(contact.email) === lower(email))) return { meta: { changes: 0 } };
      this.contacts.push({
        id,
        org_id: orgId,
        full_name: fullName,
        email,
        company_id: typeof maybeCompanyId === 'string' ? maybeCompanyId : null,
        custom_fields: typeof maybeCustomFields === 'string' ? maybeCustomFields : '{}',
        deleted_at: null,
      });
      return { meta: { changes: 1 } };
    }

    if (/UPDATE contacts SET company_id = \?/i.test(normalizedSql)) {
      const [companyId, contactId] = binds;
      const row = this.contacts.find(contact => contact.id === contactId);
      if (row && !row.company_id) {
        row.company_id = companyId;
        return { meta: { changes: 1 } };
      }
    }

    return { meta: { changes: 0 } };
  }
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      i += 1;
    }
  }
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    contractDir: raw.get('contract-dir') || DEFAULT_CONTRACT_DIR,
    outputDir: raw.get('output-dir') || join(DEFAULT_CONTRACT_DIR, `crm-quality-source-replay-${today}`),
    allowFailures: raw.get('allow-failures') === 'true',
  };
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function readCsv<T>(path: string): T[] {
  const parsed = Papa.parse<T>(readFileSync(path, 'utf8'), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`CSV_PARSE_ERROR:${path}:${JSON.stringify(parsed.errors.slice(0, 3))}`);
  return parsed.data;
}

function readEvidenceJson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Array<{ results?: T[] }>;
  return parsed.flatMap(chunk => chunk.results || []);
}

function csv(rows: object[]): string {
  return `${Papa.unparse(rows, { quotes: true, newline: '\n' })}\n`;
}

function indexById<T extends { id?: string; entity_id?: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const id = clean(row.id || row.entity_id);
    if (id) out.set(id, row);
  }
  return out;
}

function expectedAction(row: MatrixRow | undefined): MatrixRow['proposed_action'] {
  return row?.proposed_action || 'investigate';
}

function expectedOutput(row: MatrixRow | undefined, canary: CanaryRow): string {
  return clean(row?.final_proposed_name || row?.proposed_name || canary.ideal_expected_output);
}

function ruleIds(row: MatrixRow | undefined): string[] {
  return clean(row?.exact_validation_rule_ids).split(';').map(clean).filter(Boolean);
}

function fakeEnv(db: ReplayD1): Env {
  return {
    D1: db,
    KV: { get: async () => null, put: async () => undefined, delete: async () => undefined } as any,
    R2: {} as any,
    AI: {} as any,
    VECTORIZE: {} as any,
    AUDIT_QUEUE: { send: async () => undefined } as any,
    AUDIT_DLQ: {} as any,
    WEBHOOK_QUEUE: {} as any,
    WEBHOOK_DLQ: {} as any,
    INGESTION_WORKFLOW: {} as any,
    INGESTION_CHUNK_WORKFLOW: {} as any,
    INGESTION_FINALIZER_WORKFLOW: {} as any,
    ENRICHMENT_WORKFLOW: {} as any,
    CAMPAIGN_WORKFLOW: {} as any,
    DAILY_CRON_WORKFLOW: {} as any,
    ENVIRONMENT: 'crm-quality-source-replay',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_AI_GATEWAY_SLUG: '',
    AZURE_CLIENT_ID: '',
    AZURE_TENANT_ID: '',
    ANTHROPIC_API_KEY: '',
    GOOGLE_GEMINI_API_KEY: '',
    SLACK_CLIENT_ID: '',
    SLACK_CLIENT_SECRET: '',
    SLACK_SIGNING_SECRET: '',
    SLACK_BOT_TOKEN: '',
    REVERSECONTACT_API_KEY: '',
    FIREFLY_WEBHOOK_SECRET: '',
    TOKEN_ENCRYPTION_KEY: '',
    JWT_SECRET: '',
  } as unknown as Env;
}

function gateReplay(
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  sourceText: string,
  validationStrength: SourceReplayDecision['validation_strength'],
  notes: string
): SourceReplayDecision {
  const action = expectedAction(matrix);
  const gate = evaluateCrmQualityGate({
    entityType: canary.entity_type,
    action: action === 'rename' || action === 'keep' ? 'update_name' : action,
    currentName: canary.current_bad_output,
    proposedName: sourceText || canary.current_bad_output,
    rootCause: matrix?.root_cause || canary.root_cause_represented,
    mergeTargetId: matrix?.merge_target_id || null,
    deleteReason: matrix?.delete_reason || null,
    source: {
      source_channel: 'source_replay',
      source_record_id: canary.original_row_number,
      source_text: sourceText,
      codepath: 'crm_quality_source_replay_gate',
    },
  });
  return decisionFromGate(canary, matrix, gate, 'crm_quality_gate_source_shape', validationStrength, notes, 0);
}

function decisionFromGate(
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  gate: CrmQualityGateResult,
  replayPath: string,
  validationStrength: SourceReplayDecision['validation_strength'],
  notes: string,
  isolatedRowsWritten: number
): SourceReplayDecision {
  const expected = expectedOutput(matrix, canary);
  const action = expectedAction(matrix);
  const observed = clean(gate.normalizedName || gate.mergeTargetId || gate.deleteReason || gate.decision);
  const recovered = action === 'rename'
    ? lower(observed) === lower(expected)
    : action === 'merge'
      ? gate.decision === 'merge_plan' && (!matrix?.merge_target_id || gate.mergeTargetId === matrix.merge_target_id)
      : action === 'delete'
        ? gate.decision === 'delete_candidate'
        : action === 'investigate'
          ? ['hold', 'queue'].includes(gate.decision) && !gate.writeAllowed
          : gate.writeAllowed;
  const badCanonicalAllowed = gate.writeAllowed && lower(observed) === lower(canary.current_bad_output) && action !== 'keep';
  return {
    original_row_number: canary.original_row_number,
    entity_type: canary.entity_type,
    entity_id: canary.entity_id,
    root_cause: matrix?.root_cause || canary.root_cause_represented,
    expected_action: action,
    expected_output: expected,
    replay_path: replayPath,
    validation_strength: validationStrength,
    safety_passed: !badCanonicalAllowed,
    after_state_recovered: recovered,
    source_trace_gap: !recovered || validationStrength === 'contract_only_missing_source_trace',
    production_rows_written: 0,
    isolated_rows_written: isolatedRowsWritten,
    observed_output: observed,
    observed_decision: gate.decision,
    rule_ids: gate.ruleIds.join('; '),
    notes,
  };
}

function bestEventName(events: EventNameEvidence[], expected: string): EventNameEvidence | undefined {
  if (!events.length) return undefined;
  const expectedLower = lower(expected);
  return events.find(event => lower(event.display_name) === expectedLower)
    || events.find(event => clean(event.display_name).includes(','))
    || events[0];
}

async function replayCompanyDomainPath(
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  company: CompanyEvidence | undefined,
  audit: AuditCreateEvidence | undefined
): Promise<SourceReplayDecision> {
  const domain = clean(company?.domain || company?.website || canary.current_bad_output);
  if (!domain || !domain.includes('.')) {
    return gateReplay(canary, matrix, canary.current_bad_output, 'contract_only_missing_source_trace', 'No company domain/website source evidence available for source-codepath replay.');
  }
  const db = new ReplayD1();
  const env = fakeEnv(db);
  const beforeWrites = db.writes.length;
  const id = await findOrCreateCompanyByDomain(domain, 'org-canary', env);
  const writes = db.writes.length - beforeWrites;
  const created = id ? db.companies.find(row => row.id === id) : null;
  const customFields = clean(created?.custom_fields);
  const placeholderTagged = /"name_status":"domain_placeholder"/.test(customFields);
  const provisionalTagged = /"name_status":"provisional"/.test(customFields);
  const verifiedTagged = /"status":"verified"|"name_status":"verified"/.test(customFields);
  const serviceOrInvalid = matrix?.root_cause === 'service_or_invalid_domain_company_creation';
  const action = expectedAction(matrix);
  const expected = expectedOutput(matrix, canary);
  const recovered = serviceOrInvalid
    ? !id && writes === 0
    : action === 'investigate'
      ? Boolean(created && (placeholderTagged || provisionalTagged || lower(created.name) !== lower(canary.current_bad_output)))
      : false;
  const badCanonicalWritten = Boolean(created && lower(created.name) === lower(canary.current_bad_output) && !placeholderTagged && !provisionalTagged && !verifiedTagged);
  const safety = serviceOrInvalid
    ? !id && writes === 0
    : !badCanonicalWritten;

  return {
    original_row_number: canary.original_row_number,
    entity_type: canary.entity_type,
    entity_id: canary.entity_id,
    root_cause: matrix?.root_cause || canary.root_cause_represented,
    expected_action: action,
    expected_output: expected,
    replay_path: 'find_or_create_company_by_domain',
    validation_strength: company || audit ? 'raw_evidence_codepath' : 'source_shaped_fixture',
    safety_passed: safety,
    after_state_recovered: recovered,
    source_trace_gap: !recovered,
    production_rows_written: 0,
    isolated_rows_written: writes,
    observed_output: created ? `${created.name} ${created.custom_fields || ''}` : 'no company created',
    observed_decision: created ? 'placeholder_created_in_isolated_db' : 'rejected_or_skipped',
    rule_ids: [
      CRM_QUALITY_RULES.WRITE_GATE,
      CRM_QUALITY_RULES.EVIDENCE_LEDGER,
      serviceOrInvalid ? CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN : CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER,
    ].join('; '),
    notes: `domain=${domain}; audit_auto_created=${audit?.auto_created ?? 'unknown'}`,
  };
}

async function replayContactSourcePath(
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  contact: ContactEvidence | undefined,
  events: EventNameEvidence[]
): Promise<SourceReplayDecision> {
  const expected = expectedOutput(matrix, canary);
  const event = bestEventName(events, expected);
  const email = clean(event?.email || contact?.email || `${canary.current_bad_output.replace(/\s+/g, '.').toLowerCase()}@example.invalid`);
  const displayName = clean(event?.display_name || canary.current_bad_output);
  const rootCause = matrix?.root_cause || canary.root_cause_represented;

  if (rootCause === 'automated_shared_mailbox_contact_creation') {
    const db = new ReplayD1();
    const env = fakeEnv(db);
    const result = await autoCreateContactFromAttendee({
      email: email.includes('@') ? email : `mailer-daemon@google.com`,
      displayName,
      orgId: 'org-canary',
      env,
    });
    return {
      original_row_number: canary.original_row_number,
      entity_type: canary.entity_type,
      entity_id: canary.entity_id,
      root_cause: rootCause,
      expected_action: expectedAction(matrix),
      expected_output: expected,
      replay_path: 'firefly_auto_create_contact_from_attendee',
      validation_strength: contact || event ? 'raw_evidence_codepath' : 'source_shaped_fixture',
      safety_passed: !result && db.writes.length === 0,
      after_state_recovered: !result && db.writes.length === 0,
      source_trace_gap: false,
      production_rows_written: 0,
      isolated_rows_written: db.writes.length,
      observed_output: result ? `created:${result.contactId}` : 'no contact created',
      observed_decision: result ? 'created_in_isolated_db' : 'blocked',
      rule_ids: [CRM_QUALITY_RULES.WRITE_GATE, CRM_QUALITY_RULES.EVIDENCE_LEDGER, CRM_QUALITY_RULES.CONTACT_AUTOMATED].join('; '),
      notes: `email=${email}; display_name=${displayName}`,
    };
  }

  if (rootCause === 'email_local_part_used_as_contact_name' || rootCause === 'single_token_or_partial_contact_name') {
    const resolved = resolveContactName(
      email,
      email,
      displayName,
      { [email.toLowerCase()]: displayName }
    );
    const recovered = resolved ? lower(resolved) === lower(expected) : false;
    return {
      original_row_number: canary.original_row_number,
      entity_type: canary.entity_type,
      entity_id: canary.entity_id,
      root_cause: rootCause,
      expected_action: expectedAction(matrix),
      expected_output: expected,
      replay_path: 'resolve_contact_name',
      validation_strength: contact || event ? 'raw_evidence_codepath' : 'source_shaped_fixture',
      safety_passed: true,
      after_state_recovered: recovered,
      source_trace_gap: !recovered,
      production_rows_written: 0,
      isolated_rows_written: 0,
      observed_output: resolved || 'no usable name resolved',
      observed_decision: resolved ? 'resolved' : 'blocked',
      rule_ids: [
        CRM_QUALITY_RULES.WRITE_GATE,
        CRM_QUALITY_RULES.EVIDENCE_LEDGER,
        rootCause === 'email_local_part_used_as_contact_name'
          ? CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART
          : CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN,
      ].join('; '),
      notes: `email=${email}; display_name=${displayName}`,
    };
  }

  if (rootCause === 'directory_last_first_or_ranked_display_name') {
    const normalized = normalizeAttendeeName(displayName) || '';
    if (normalized) {
      const gate = evaluateCrmQualityGate({
        entityType: 'contact',
        action: 'update_name',
        proposedName: normalized,
        email,
        rootCause,
        source: {
          source_channel: event ? 'event_attendee_display_name' : 'source_shape_fixture',
          source_record_id: canary.original_row_number,
          source_text: displayName,
          codepath: 'normalize_attendee_name',
        },
      });
      return decisionFromGate(
        canary,
        matrix,
        gate,
        'normalize_attendee_name',
        contact || event ? 'raw_evidence_codepath' : 'source_shaped_fixture',
        `email=${email}; display_name=${displayName}`,
        0
      );
    }
  }

  return gateReplay(canary, matrix, displayName, contact || event ? 'raw_evidence_codepath' : 'source_shaped_fixture', `email=${email}; display_name=${displayName}`);
}

async function replayDiscoverNewContact(
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  contact: ContactEvidence | undefined,
  event: EventNameEvidence | undefined
): Promise<SourceReplayDecision> {
  const email = clean(event?.email || contact?.email);
  if (!email) return gateReplay(canary, matrix, canary.current_bad_output, 'contract_only_missing_source_trace', 'No email evidence available for discoverNewContact replay.');
  const db = new ReplayD1();
  const env = fakeEnv(db);
  const item: ClassifiableItem = {
    type: 'email',
    source: 'outlook',
    externalId: `canary-${canary.original_row_number}`,
    bodyText: '',
    bodyPreview: '',
    fromEmail: email,
    fromName: clean(event?.display_name || canary.current_bad_output),
    toEmails: [],
    ccEmails: [],
    recipientNames: { [email.toLowerCase()]: clean(event?.display_name || canary.current_bad_output) },
    sentAt: new Date().toISOString(),
    orgId: 'org-canary',
    visibility: 'org_wide',
  };
  const eligibility: DiscoveryEligibility = { kind: 'reply' };
  const discovered = await discoverNewContact(email, item, 'org-canary', env, eligibility);
  const created = discovered ? db.contacts.find(row => row.id === discovered.id) : null;
  const expected = expectedOutput(matrix, canary);
  const customFields = clean(created?.custom_fields);
  const provisionalTagged = /"name_status":"provisional"/.test(customFields);
  const verifiedTagged = /"status":"verified"|"name_status":"verified"/.test(customFields);
  const action = expectedAction(matrix);
  const recovered = action === 'investigate'
    ? Boolean(created && provisionalTagged)
    : Boolean(created && lower(created.full_name) === lower(expected));
  const badCanonicalWritten = Boolean(
    created &&
    lower(created.full_name) === lower(canary.current_bad_output) &&
    !provisionalTagged &&
    !verifiedTagged &&
    action !== 'keep'
  );
  return {
    original_row_number: canary.original_row_number,
    entity_type: canary.entity_type,
    entity_id: canary.entity_id,
    root_cause: matrix?.root_cause || canary.root_cause_represented,
    expected_action: action,
    expected_output: expected,
    replay_path: 'discover_new_contact',
    validation_strength: 'raw_evidence_codepath',
    safety_passed: !badCanonicalWritten,
    after_state_recovered: recovered,
    source_trace_gap: !recovered,
    production_rows_written: 0,
    isolated_rows_written: db.writes.length,
    observed_output: created ? `${clean(created.full_name)} ${created.custom_fields || ''}` : 'no contact created',
    observed_decision: created ? (provisionalTagged ? 'provisional_created_in_isolated_db' : 'created_in_isolated_db') : 'blocked',
    rule_ids: ruleIds(matrix).join('; '),
    notes: `email=${email}; fromName=${item.fromName}`,
  };
}

export async function buildCrmQualitySourceReplaySummary(args: Args): Promise<CrmQualitySourceReplaySummary> {
  const canaryPath = join(args.contractDir, 'canary-set-200-reviewed.csv');
  const matrixPath = join(args.contractDir, 'junk-to-rule-coverage-matrix-reviewed.csv');
  for (const required of [canaryPath, matrixPath]) {
    if (!existsSync(required)) throw new Error(`CRM_QUALITY_SOURCE_REPLAY_CONTRACT_MISSING:${required}`);
  }

  const canaryRows = readCsv<CanaryRow>(canaryPath);
  const matrixRows = readCsv<MatrixRow>(matrixPath);
  const matrixById = new Map(matrixRows.map(row => [row.entity_id, row]));
  const contactsById = indexById(readEvidenceJson<ContactEvidence>(join(args.contractDir, 'evidence-contacts.json')));
  const companiesById = indexById(readEvidenceJson<CompanyEvidence>(join(args.contractDir, 'evidence-companies.json')));
  const auditById = indexById(readEvidenceJson<AuditCreateEvidence>(join(args.contractDir, 'evidence-audit-create.json')));
  const eventNames = readEvidenceJson<EventNameEvidence>(join(args.contractDir, 'evidence-contact-event-names.json'));
  const eventsByContact = new Map<string, EventNameEvidence[]>();
  for (const event of eventNames) {
    const bucket = eventsByContact.get(event.contact_id) || [];
    bucket.push(event);
    eventsByContact.set(event.contact_id, bucket);
  }

  const decisions: SourceReplayDecision[] = [];
  for (const canary of canaryRows) {
    const matrix = matrixById.get(canary.entity_id);
    const rootCause = matrix?.root_cause || canary.root_cause_represented;
    if (canary.entity_type === 'company') {
      const company = companiesById.get(canary.entity_id) as CompanyEvidence | undefined;
      const audit = auditById.get(canary.entity_id) as AuditCreateEvidence | undefined;
      if (rootCause === 'domain_placeholder_not_canonicalized' || rootCause === 'service_or_invalid_domain_company_creation') {
        decisions.push(await replayCompanyDomainPath(canary, matrix, company, audit));
      } else {
        decisions.push(gateReplay(
          canary,
          matrix,
          clean(company?.name || canary.current_bad_output),
          company || audit ? 'raw_evidence_codepath' : 'source_shaped_fixture',
          company ? `company_domain=${company.domain || ''}; website=${company.website || ''}` : 'No company evidence row; replayed workbook source-shaped value.'
        ));
      }
      continue;
    }

    const contact = contactsById.get(canary.entity_id) as ContactEvidence | undefined;
    const events = eventsByContact.get(canary.entity_id) || [];
    if (rootCause === 'email_local_part_used_as_contact_name' && events.length) {
      decisions.push(await replayDiscoverNewContact(canary, matrix, contact, bestEventName(events, expectedOutput(matrix, canary))));
    } else {
      decisions.push(await replayContactSourcePath(canary, matrix, contact, events));
    }
  }

  mkdirSync(args.outputDir, { recursive: true });
  const decisionsPath = join(args.outputDir, 'crm-quality-source-replay-decisions.csv');
  const failuresPath = join(args.outputDir, 'crm-quality-source-replay-safety-failures.csv');
  const summaryPath = join(args.outputDir, 'crm-quality-source-replay-summary.json');
  writeFileSync(decisionsPath, csv(decisions));
  writeFileSync(failuresPath, csv(decisions.filter(row => !row.safety_passed)));

  const validationStrengthCounts: Record<string, number> = {};
  const replayPathCounts: Record<string, number> = {};
  let isolatedRowsWritten = 0;
  for (const row of decisions) {
    validationStrengthCounts[row.validation_strength] = (validationStrengthCounts[row.validation_strength] || 0) + 1;
    replayPathCounts[row.replay_path] = (replayPathCounts[row.replay_path] || 0) + 1;
    isolatedRowsWritten += row.isolated_rows_written;
  }

  const summary: CrmQualitySourceReplaySummary = {
    dry_run: true,
    validation_layer: 'source_shaped_replay',
    contract_dir: args.contractDir,
    canary_rows: decisions.length,
    production_rows_written: 0,
    isolated_rows_written: isolatedRowsWritten,
    safety_passed: decisions.filter(row => row.safety_passed).length,
    safety_failed: decisions.filter(row => !row.safety_passed).length,
    after_state_recovered: decisions.filter(row => row.after_state_recovered).length,
    after_state_not_recovered: decisions.filter(row => !row.after_state_recovered).length,
    source_trace_gaps: decisions.filter(row => row.source_trace_gap).length,
    validation_strength_counts: validationStrengthCounts,
    replay_path_counts: replayPathCounts,
    decisions_path: decisionsPath,
    failures_path: failuresPath,
    summary_path: summaryPath,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  if (!args.allowFailures && summary.safety_failed > 0) {
    throw new Error(`CRM_QUALITY_SOURCE_REPLAY_SAFETY_FAILED:${summary.safety_failed}; failures=${failuresPath}`);
  }

  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCrmQualitySourceReplaySummary(parseArgs(process.argv.slice(2))).then(summary => {
    console.log(JSON.stringify(summary, null, 2));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
