import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { structuredDataQueryTool, type StructuredDataQueryInput } from './structured-query';

interface MartyWorkflowSmokeCase {
  id: string;
  user_prompt: string;
  expected_target: StructuredDataQueryInput['target'];
  input: StructuredDataQueryInput;
  min_count: number;
  required_columns: string[];
  require_semantic_filter?: boolean;
  note: string;
}

interface MartyWorkflowSmokeCaseResult {
  id: string;
  user_prompt: string;
  expected_target: string;
  passed: boolean;
  failures: string[];
  duration_ms: number;
  count: number;
  returned: number;
  columns: string[];
  semantic_filter_used: boolean;
  caveats: string[];
  sample_rows: Record<string, unknown>[];
  note: string;
}

const DEFAULT_SAMPLE_ROWS = 3;

export const MARTY_WORKFLOW_SMOKE_CASES: MartyWorkflowSmokeCase[] = [
  {
    id: 'companies_florida_cybersecurity_vc_funds',
    user_prompt: 'How many venture funds in our database are based in Florida and invest in cybersecurity?',
    expected_target: 'companies',
    min_count: 1,
    required_columns: ['name'],
    require_semantic_filter: true,
    note: 'Company/fund aggregation should route to structured company search with semantic investment focus filters.',
    input: {
      target: 'companies',
      operation: 'list',
      filters: {
        investor_only: true,
        locations: ['Florida', 'South Florida', 'Miami', 'Orlando', 'Tampa'],
        sectors: ['cybersecurity'],
        semantic_terms: ['cybersecurity'],
      },
      fields: ['id', 'name', 'website', 'company_type', 'sector', 'semantic_facts', 'semantic_tags', 'vc_profile'],
      limit: 50,
    },
  },
  {
    id: 'company_contacts_florida_cybersecurity_vc_funds',
    user_prompt: 'Give me names and emails at the Florida venture funds that invest in cybersecurity.',
    expected_target: 'company_contacts',
    min_count: 1,
    required_columns: ['first_name', 'email', 'company_name'],
    require_semantic_filter: true,
    note: 'Outreach/mail-merge requests about matching firms should route to company_contacts, not a vague RAG answer.',
    input: {
      target: 'company_contacts',
      operation: 'list',
      filters: {
        investor_only: true,
        has_email: true,
        locations: ['Florida', 'South Florida', 'Miami', 'Orlando', 'Tampa'],
        sectors: ['cybersecurity'],
        semantic_terms: ['cybersecurity'],
      },
      fields: ['first_name', 'email', 'full_name', 'job_title', 'company_name', 'company_sector', 'company_semantic_tags'],
      limit: 100,
    },
  },
  {
    id: 'document_people_south_florida_vc_directory',
    user_prompt: 'Look at the South Florida VC Directory v0 spreadsheet and pull names and emails for a mail merge.',
    expected_target: 'document_people',
    min_count: 1,
    required_columns: ['first_name', 'email', 'source_title'],
    note: 'Named spreadsheet/directory people extraction should route to document_people and parse numbered person/email columns.',
    input: {
      target: 'document_people',
      operation: 'list',
      filters: {
        document_query: 'South Florida VC Directory v0',
        has_email: true,
      },
      fields: ['first_name', 'email', 'full_name', 'job_title', 'company_name', 'source_title', 'source_person_slot', 'source_type'],
      limit: 100,
    },
  },
  {
    id: 'document_people_vc_directory_2026_florida',
    user_prompt: 'Pull names and emails from VC Directory 2026 Florida.',
    expected_target: 'document_people',
    min_count: 1,
    required_columns: ['first_name', 'email', 'source_title'],
    note: 'Simple spreadsheet rows with multiple emails should still produce deterministic document_people rows.',
    input: {
      target: 'document_people',
      operation: 'list',
      filters: {
        document_query: 'VC Directory 2026 Florida',
        has_email: true,
      },
      fields: ['first_name', 'email', 'full_name', 'job_title', 'company_name', 'source_title', 'source_type'],
      limit: 100,
    },
  },
  {
    id: 'event_people_intelligent_infrastructure_webinar',
    user_prompt: 'Export first names and emails for people myself or Raul invited to the Intelligent Infrastructure webinar on May 7, 2026.',
    expected_target: 'event_people',
    min_count: 1,
    required_columns: ['first_name', 'email', 'source_title', 'source_type'],
    note: 'Event mail merge should combine events, campaigns, and matching invite/attendee spreadsheets.',
    input: {
      target: 'event_people',
      operation: 'list',
      filters: {
        event_title: 'Intelligent Infrastructure',
        event_date: '2026-05-07',
        invited_by_users: ['me', 'Raul'],
        include_internal: false,
        has_email: true,
      },
      fields: ['first_name', 'email', 'full_name', 'company_name', 'source_title', 'source_type', 'invited_by'],
      limit: 250,
    },
  },
  {
    id: 'documents_named_directory_lookup',
    user_prompt: 'Find the South Florida VC Directory spreadsheet.',
    expected_target: 'documents',
    min_count: 1,
    required_columns: ['title', 'file_name'],
    note: 'Named document lookup should remain deterministic and feed source_document_ids/document_query for follow-on extraction.',
    input: {
      target: 'documents',
      operation: 'list',
      filters: {
        keyword: 'South Florida VC Directory',
      },
      fields: ['id', 'title', 'file_name', 'document_type', 'mime_type', 'semantic_facts'],
      limit: 10,
    },
  },
];

function sampleRows(rows: Record<string, unknown>[], maxRows: number): Record<string, unknown>[] {
  return rows.slice(0, maxRows).map(row => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string') out[key] = value.length > 220 ? `${value.slice(0, 217)}...` : value;
      else out[key] = value;
    }
    return out;
  });
}

async function runCase(
  ctx: AuthContext,
  env: Env,
  testCase: MartyWorkflowSmokeCase,
  sampleRowLimit: number
): Promise<MartyWorkflowSmokeCaseResult> {
  const started = Date.now();
  const result = await structuredDataQueryTool(ctx, testCase.input, env);
  const failures: string[] = [];
  if (testCase.input.target !== testCase.expected_target) {
    failures.push(`Expected target ${testCase.expected_target}, got ${testCase.input.target}.`);
  }
  if (result.count < testCase.min_count) {
    failures.push(`Expected at least ${testCase.min_count} row(s), got ${result.count}.`);
  }
  for (const column of testCase.required_columns) {
    if (!result.columns.includes(column)) failures.push(`Missing required column: ${column}.`);
  }
  if (testCase.require_semantic_filter && !result.semantic_filter_used) {
    failures.push('Expected semantic filters to be used.');
  }

  return {
    id: testCase.id,
    user_prompt: testCase.user_prompt,
    expected_target: testCase.expected_target,
    passed: failures.length === 0,
    failures,
    duration_ms: Date.now() - started,
    count: result.count,
    returned: result.returned,
    columns: result.columns,
    semantic_filter_used: result.semantic_filter_used,
    caveats: result.caveats,
    sample_rows: sampleRows(result.rows, sampleRowLimit),
    note: testCase.note,
  };
}

export async function runMartyWorkflowSmoke(
  ctx: AuthContext,
  env: Env,
  options: { caseIds?: string[]; sampleRows?: number } = {}
): Promise<Record<string, unknown>> {
  const selectedIds = new Set((options.caseIds || []).map(id => String(id || '').trim()).filter(Boolean));
  const cases = selectedIds.size > 0
    ? MARTY_WORKFLOW_SMOKE_CASES.filter(testCase => selectedIds.has(testCase.id))
    : MARTY_WORKFLOW_SMOKE_CASES;
  const sampleRowLimit = Math.max(0, Math.min(options.sampleRows ?? DEFAULT_SAMPLE_ROWS, 10));
  const started = Date.now();
  const results: MartyWorkflowSmokeCaseResult[] = [];

  for (const testCase of cases) {
    try {
      results.push(await runCase(ctx, env, testCase, sampleRowLimit));
    } catch (e) {
      results.push({
        id: testCase.id,
        user_prompt: testCase.user_prompt,
        expected_target: testCase.expected_target,
        passed: false,
        failures: [e instanceof Error ? e.message : String(e)],
        duration_ms: 0,
        count: 0,
        returned: 0,
        columns: [],
        semantic_filter_used: false,
        caveats: [],
        sample_rows: [],
        note: testCase.note,
      });
    }
  }

  const failed = results.filter(row => !row.passed);
  return {
    ok: failed.length === 0,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    total_cases: results.length,
    passed_cases: results.length - failed.length,
    failed_cases: failed.length,
    results,
    recommendations: failed.length === 0
      ? ['Structured MARTy workflows are passing the boss-style smoke suite.']
      : failed.map(row => `Fix ${row.id}: ${row.failures.join(' ')}`),
  };
}
