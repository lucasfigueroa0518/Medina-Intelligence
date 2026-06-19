#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const CONFIRMATION = 'PROSPECT_LATTICA_CORRECTION_GO';
const ZEAL_PROSPECT_ID = '44ef374b-8ad3-4f55-ae8e-cc596e99ea95';
const ZEAL_COMPANY_ID = '7b19c2ec-7ec6-4418-8fae-329cf1af200d';
const LATTICA_NAME = 'Lattica';
const LATTICA_NORMALIZED = 'lattica';

type Args = {
  orgId: string;
  database: string;
  outputDir: string;
  apply: boolean;
  confirmProductionWrite: string | null;
};

type ProspectRow = {
  id: string;
  org_id: string;
  canonical_name: string | null;
  normalized_name: string | null;
  company_id: string | null;
  possible_company_id: string | null;
  status: string | null;
  signal_count: number | null;
  evidence_count: number | null;
  metadata_json: string | null;
  deleted_at?: string | null;
};

type SignalRow = {
  id: string;
  org_id: string;
  prospect_id: string | null;
  company_id?: string | null;
  deal_id?: string | null;
  mention_type: string | null;
  raw_mention_text: string | null;
  normalized_mention: string | null;
  source_title: string | null;
  classifier_version: string | null;
  metadata_json: string | null;
};

type CompanyRow = {
  id: string;
  org_id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  company_type: string | null;
  investment_status: string | null;
};

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      index += 1;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    orgId: raw.get('org-id') || DEFAULT_ORG_ID,
    database: raw.get('database') || DEFAULT_DATABASE,
    outputDir: resolve(raw.get('output-dir') || join('outputs', `prospect-lattica-correction-${stamp}`)),
    apply: raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
  };
}

function sqlString(value: string | null | undefined): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseJson(value: string | null | undefined): Record<string, any> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function writeJsonl(path: string, rows: unknown[]): string {
  const body = rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '';
  writeFileSync(path, body);
  return createHash('sha256').update(body).digest('hex');
}

function runD1<T = any>(database: string, sql: string): T[] {
  const stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 120 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Array<{ results?: T[]; success?: boolean }>;
  const first = parsed[0] || {};
  if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
  return first.results || [];
}

function normalizeName(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:incorporated|inc|llc|ltd|limited|corp|corporation|company|co|technologies|technology|systems|solutions|labs|ai)\b\.?/g, ' ')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '');
}

function nowIso(): string {
  return new Date().toISOString();
}

function correctionPatch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applied_at: nowIso(),
    action: 'correct_mismatched_source_company_override',
    previous_prospect_name: 'The Zeal Company',
    corrected_prospect_name: LATTICA_NAME,
    previous_possible_company_id: ZEAL_COMPANY_ID,
    reason: 'The source, classifier, and reasoning judge named Lattica as the target; The Zeal Company came only from mismatched source_item_company_id context.',
    ...extra,
  };
}

function patchProspectMetadata(row: ProspectRow): string {
  const metadata = parseJson(row.metadata_json);
  return JSON.stringify({
    ...metadata,
    prospect_company_name: LATTICA_NAME,
    identity_dedupe: {
      ...(metadata.identity_dedupe || {}),
      aliases: [LATTICA_NORMALIZED],
      method: 'source_backed_production_correction',
      matched_existing_prospect_id: row.id,
      previous_method: metadata.identity_dedupe?.method || null,
      previous_aliases: metadata.identity_dedupe?.aliases || null,
      previous_possible_company_id: row.possible_company_id || null,
      score: 1,
    },
    lattica_production_correction: correctionPatch({
      previous_canonical_name: row.canonical_name,
      previous_normalized_name: row.normalized_name,
    }),
  });
}

function patchSignalMetadata(row: SignalRow): string {
  const metadata = parseJson(row.metadata_json);
  const audit = parseJson(JSON.stringify(metadata.known_entity_audit || {}));
  const finalGate = parseJson(JSON.stringify(metadata.prospect_final_quality_gate || {}));
  const crossD1 = parseJson(JSON.stringify(metadata.cross_d1_role_check || {}));
  const identityCandidates = Array.isArray(audit.identity_candidates)
    ? audit.identity_candidates.map((candidate: any) => {
        if (candidate?.entity_id !== ZEAL_COMPANY_ID && candidate?.company_id !== ZEAL_COMPANY_ID) return candidate;
        const reasons = Array.from(new Set([
          ...(Array.isArray(candidate.reasons) ? candidate.reasons : []),
          'source_item_company_id_mismatch_candidate_name',
          'source_company_context_audit_only',
        ]));
        return {
          ...candidate,
          score: Math.min(Number(candidate.score || 0) || 0, 84),
          reasons,
        };
      })
    : [];

  return JSON.stringify({
    ...metadata,
    prospect_company_name: LATTICA_NAME,
    corrected_prospect_company_name: LATTICA_NAME,
    known_entity_audit: {
      ...audit,
      known_entity_present: Boolean(identityCandidates.length),
      outcome: 'source_backed_candidate_preserved_mismatched_company_audit_only',
      match_strength: 'none',
      company_id: null,
      possible_company_id: null,
      company_domain: null,
      identity_score: 84,
      identity_strength: 'weak',
      identity_method: audit.identity_method || 'direct_company_id',
      identity_ambiguous: false,
      identity_candidates: identityCandidates,
      final_prospect_action: 'create_prospect',
      final_mention_type: 'inbound_prospect',
    },
    cross_d1_role_check: {
      ...crossD1,
      matched_company_id: null,
      evidence: Array.from(new Set([
        ...(Array.isArray(crossD1.evidence) ? crossD1.evidence : []),
        'mismatched source company id treated as audit-only',
      ])),
    },
    low_confidence_verification: {
      ...(metadata.low_confidence_verification || {}),
      identity_signals: Array.from(new Set([
        ...((metadata.low_confidence_verification?.identity_signals || []) as string[]).filter(signal => signal !== 'existing_company_id_match'),
        'source_names_company',
      ])),
      intent_signals: Array.from(new Set([
        ...((metadata.low_confidence_verification?.intent_signals || []) as string[]),
        'medina_outbound_prospect_interest',
      ])),
    },
    target_evidence_reasons: Array.from(new Set([
      ...((metadata.target_evidence_reasons || []) as string[]),
      'medina_outbound_prospect_interest',
    ])),
    prospect_second_look: {
      ...(metadata.prospect_second_look || {}),
      packet: {
        ...(metadata.prospect_second_look?.packet || {}),
        candidate_name: LATTICA_NAME,
        prospect_company_name: LATTICA_NAME,
        known_entity: {
          ...(metadata.prospect_second_look?.packet?.known_entity || {}),
          company_id: null,
          match_strength: 'none',
          identity_score: 84,
          identity_strength: 'weak',
        },
      },
    },
    prospect_final_quality_gate: {
      ...finalGate,
      decision: 'allow_create',
      canonical_name: LATTICA_NAME,
      original_name: LATTICA_NAME,
      reason: 'Production correction: source, classifier reasoning, and reasoning judge identify Lattica as the investment target; mismatched The Zeal Company source-company context is audit-only.',
      hard_block_reason: null,
      target_proof: Array.from(new Set([
        ...((finalGate.target_proof || []) as string[]),
        'medina_outbound_prospect_interest',
      ])),
      duplicate_group_id: 'name:lattica',
      renamed: false,
      merged: false,
      attach_only: false,
      resolved_merge_target_prospect_id: null,
      merge_target_resolved: false,
    },
    company_resolution: {
      ...(metadata.company_resolution || {}),
      action: 'skipped',
      match_method: 'no_verified_company_identity',
      candidates: [],
      enrichment: {
        ...(metadata.company_resolution?.enrichment || {}),
        status: 'blocked',
        reason: 'mismatched_source_company_context_audit_only',
      },
    },
    lattica_production_correction: correctionPatch({
      signal_id: row.id,
      previous_normalized_mention: row.normalized_mention,
      previous_company_id: row.company_id || null,
    }),
  });
}

function refreshAggregateSql(prospectId: string, orgId: string): string {
  return `
    UPDATE prospects
       SET signal_count = (
             SELECT COUNT(*) FROM prospect_signals
              WHERE org_id=${sqlString(orgId)} AND prospect_id=${sqlString(prospectId)} AND mention_type='inbound_prospect'
           ),
           evidence_count = (
             SELECT COUNT(*) FROM prospect_signals
              WHERE org_id=${sqlString(orgId)} AND prospect_id=${sqlString(prospectId)} AND mention_type='inbound_prospect'
           ),
           first_seen_at = (
             SELECT MIN(occurred_at) FROM prospect_signals
              WHERE org_id=${sqlString(orgId)} AND prospect_id=${sqlString(prospectId)} AND mention_type='inbound_prospect'
           ),
           last_seen_at = (
             SELECT MAX(occurred_at) FROM prospect_signals
              WHERE org_id=${sqlString(orgId)} AND prospect_id=${sqlString(prospectId)} AND mention_type='inbound_prospect'
           ),
           last_signal_at = (
             SELECT MAX(occurred_at) FROM prospect_signals
              WHERE org_id=${sqlString(orgId)} AND prospect_id=${sqlString(prospectId)} AND mention_type='inbound_prospect'
           ),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id=${sqlString(orgId)} AND id=${sqlString(prospectId)};`;
}

function aliasInsertSql(args: { orgId: string; entityType: 'prospect' | 'company'; entityId: string; aliasKind: string; aliasValue: string; evidence: Record<string, any> }): string {
  return `INSERT INTO entity_identity_aliases (
    org_id, entity_type, entity_id, alias_kind, alias_value, confidence, source_kind, evidence_json, created_at, updated_at
  ) VALUES (
    ${sqlString(args.orgId)}, ${sqlString(args.entityType)}, ${sqlString(args.entityId)}, ${sqlString(args.aliasKind)}, ${sqlString(args.aliasValue)}, 1.0,
    'manual', ${sqlString(JSON.stringify(args.evidence))}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(org_id, entity_type, entity_id, alias_kind, alias_value) DO UPDATE SET
    confidence = 1.0,
    source_kind = excluded.source_kind,
    evidence_json = excluded.evidence_json,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`;
}

export async function runLatticaCorrection(args: Args): Promise<Record<string, unknown>> {
  mkdirSync(args.outputDir, { recursive: true });

  const prospects = runD1<ProspectRow>(args.database, `
    SELECT *
      FROM prospects
     WHERE org_id=${sqlString(args.orgId)}
       AND (
         id=${sqlString(ZEAL_PROSPECT_ID)}
         OR normalized_name IN ('thezeal', ${sqlString(LATTICA_NORMALIZED)})
       )
     ORDER BY canonical_name, id`);
  const prospect = prospects.find(row => row.id === ZEAL_PROSPECT_ID);
  const signals = runD1<SignalRow>(args.database, `
    SELECT *
      FROM prospect_signals
     WHERE org_id=${sqlString(args.orgId)}
       AND (
         prospect_id=${sqlString(ZEAL_PROSPECT_ID)}
         OR raw_mention_text=${sqlString(LATTICA_NAME)}
         OR normalized_mention IN ('thezeal', ${sqlString(LATTICA_NORMALIZED)})
       )
     ORDER BY created_at, id`);
  const companies = runD1<CompanyRow>(args.database, `
    SELECT *
      FROM companies
     WHERE org_id=${sqlString(args.orgId)}
       AND (
         id=${sqlString(ZEAL_COMPANY_ID)}
         OR lower(replace(name, ' ', '')) IN ('thezealcompany','thezeal','lattica')
       )
     ORDER BY name, id`);
  const aliases = runD1(args.database, `
    SELECT *
      FROM entity_identity_aliases
     WHERE org_id=${sqlString(args.orgId)}
       AND (
         entity_id IN (${sqlString(ZEAL_PROSPECT_ID)}, ${sqlString(ZEAL_COMPANY_ID)})
         OR alias_value IN ('thezeal', ${sqlString(LATTICA_NORMALIZED)})
       )
     ORDER BY entity_type, entity_id, alias_kind, alias_value`);

  const backup = { prospects, signals, companies, aliases };
  const backupPath = join(args.outputDir, 'affected-lattica-rows.jsonl');
  const backupSha = writeJsonl(backupPath, [backup]);
  const activeLatticaProspects = prospects.filter(row =>
    row.id !== ZEAL_PROSPECT_ID &&
    row.normalized_name === LATTICA_NORMALIZED &&
    !row.deleted_at &&
    ['active', 'provisional'].includes(String(row.status || ''))
  );

  const manifest: Record<string, unknown> = {
    dry_run: !args.apply,
    org_id: args.orgId,
    database: args.database,
    output_dir: args.outputDir,
    backup_path: backupPath,
    backup_sha256: backupSha,
    backup_counts: {
      prospects: prospects.length,
      signals: signals.length,
      companies: companies.length,
      aliases: aliases.length,
    },
    planned_actions: {
      rename_prospect_to_lattica: Boolean(prospect && !activeLatticaProspects.length),
      signals_to_normalize: signals.filter(row => row.prospect_id === ZEAL_PROSPECT_ID && row.raw_mention_text === LATTICA_NAME).length,
      remove_bad_prospect_thezeal_alias: aliases.filter((row: any) =>
        row.entity_type === 'prospect' && row.entity_id === ZEAL_PROSPECT_ID && row.alias_value === 'thezeal'
      ).length,
      add_lattica_prospect_alias: Boolean(prospect),
    },
    blockers: {
      missing_target_prospect: !prospect,
      active_lattica_duplicate_count: activeLatticaProspects.length,
    },
    completed_at: nowIso(),
  };
  writeFileSync(join(args.outputDir, 'manifest.pre-apply.json'), JSON.stringify(manifest, null, 2));
  if (!args.apply) return manifest;
  if (args.confirmProductionWrite !== CONFIRMATION) {
    throw new Error(`PROSPECT_LATTICA_CORRECTION_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${CONFIRMATION}`);
  }
  if (!existsSync(backupPath)) throw new Error(`PROSPECT_LATTICA_CORRECTION_BACKUP_MISSING:${backupPath}`);
  if (!prospect) throw new Error('LATTICA_TARGET_PROSPECT_NOT_FOUND');
  if (activeLatticaProspects.length) throw new Error(`LATTICA_ACTIVE_DUPLICATE_EXISTS:${activeLatticaProspects.map(row => row.id).join(',')}`);

  runD1(args.database, `
    UPDATE prospects
       SET canonical_name=${sqlString(LATTICA_NAME)},
           normalized_name=${sqlString(LATTICA_NORMALIZED)},
           company_id=NULL,
           possible_company_id=NULL,
           domain=NULL,
           website=NULL,
           metadata_json=${sqlString(patchProspectMetadata(prospect))},
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(ZEAL_PROSPECT_ID)}`);

  for (const signal of signals.filter(row => row.prospect_id === ZEAL_PROSPECT_ID && row.raw_mention_text === LATTICA_NAME)) {
    runD1(args.database, `
      UPDATE prospect_signals
         SET normalized_mention=${sqlString(LATTICA_NORMALIZED)},
             company_id=NULL,
             deal_id=NULL,
             metadata_json=${sqlString(patchSignalMetadata(signal))},
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(signal.id)}`);
  }

  runD1(args.database, `
    DELETE FROM entity_identity_aliases
     WHERE org_id=${sqlString(args.orgId)}
       AND entity_type='prospect'
       AND entity_id=${sqlString(ZEAL_PROSPECT_ID)}
       AND alias_value='thezeal'`);
  runD1(args.database, aliasInsertSql({
    orgId: args.orgId,
    entityType: 'prospect',
    entityId: ZEAL_PROSPECT_ID,
    aliasKind: 'normalized_name',
    aliasValue: LATTICA_NORMALIZED,
    evidence: {
      source: 'lattica_production_correction',
      corrected_prospect_name: LATTICA_NAME,
      previous_prospect_name: 'The Zeal Company',
    },
  }));
  runD1(args.database, refreshAggregateSql(ZEAL_PROSPECT_ID, args.orgId));

  const post = {
    ...manifest,
    dry_run: false,
    post_checks: {
      active_lattica_prospects: runD1(args.database, `
        SELECT COUNT(*) AS count FROM prospects
         WHERE org_id=${sqlString(args.orgId)}
           AND deleted_at IS NULL
           AND normalized_name=${sqlString(LATTICA_NORMALIZED)}
           AND status IN ('active','provisional')`)[0]?.count || 0,
      active_thezeal_prospects: runD1(args.database, `
        SELECT COUNT(*) AS count FROM prospects
         WHERE org_id=${sqlString(args.orgId)}
           AND deleted_at IS NULL
           AND normalized_name='thezeal'
           AND status IN ('active','provisional')`)[0]?.count || 0,
      lattica_signal_count: runD1(args.database, `
        SELECT COUNT(*) AS count FROM prospect_signals
         WHERE org_id=${sqlString(args.orgId)}
           AND prospect_id=${sqlString(ZEAL_PROSPECT_ID)}
           AND raw_mention_text=${sqlString(LATTICA_NAME)}
           AND normalized_mention=${sqlString(LATTICA_NORMALIZED)}
           AND mention_type='inbound_prospect'`)[0]?.count || 0,
      inbound_null_prospect_id: runD1(args.database, `
        SELECT COUNT(*) AS count FROM prospect_signals
         WHERE org_id=${sqlString(args.orgId)}
           AND mention_type='inbound_prospect'
           AND prospect_id IS NULL`)[0]?.count || 0,
      duplicate_active_normalized_names: runD1(args.database, `
        SELECT COUNT(*) AS count FROM (
          SELECT normalized_name
            FROM prospects
           WHERE org_id=${sqlString(args.orgId)}
             AND deleted_at IS NULL
             AND status IN ('active','provisional')
           GROUP BY normalized_name
          HAVING COUNT(*) > 1
        )`)[0]?.count || 0,
      lattica_aliases: runD1(args.database, `
        SELECT COUNT(*) AS count FROM entity_identity_aliases
         WHERE org_id=${sqlString(args.orgId)}
           AND entity_type='prospect'
           AND entity_id=${sqlString(ZEAL_PROSPECT_ID)}
           AND alias_value=${sqlString(LATTICA_NORMALIZED)}`)[0]?.count || 0,
      bad_thezeal_prospect_aliases: runD1(args.database, `
        SELECT COUNT(*) AS count FROM entity_identity_aliases
         WHERE org_id=${sqlString(args.orgId)}
           AND entity_type='prospect'
           AND entity_id=${sqlString(ZEAL_PROSPECT_ID)}
           AND alias_value='thezeal'`)[0]?.count || 0,
    },
    applied_at: nowIso(),
  };
  writeFileSync(join(args.outputDir, 'manifest.post-apply.json'), JSON.stringify(post, null, 2));
  return post;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runLatticaCorrection(parseArgs(process.argv.slice(2)))
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(error instanceof Error ? error.stack || error.message : error);
      process.exit(1);
    });
}
