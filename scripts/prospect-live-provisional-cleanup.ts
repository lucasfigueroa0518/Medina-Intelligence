#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const CONFIRMATION = 'PROSPECT_LIVE_PROVISIONAL_CLEANUP_GO';
const TARGET_NORMALIZED = ['neuralseq', 'neuralseek', 'nucor', 'edgerunner'];
const TARGET_ALIAS_VALUES = ['neuralseq', 'neural seq', 'nucor', 'edgerunner', 'edgerunnerai', 'edge runner ai'];

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
  status: string | null;
  company_id: string | null;
  possible_company_id: string | null;
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
  custom_fields: string | null;
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
    outputDir: resolve(raw.get('output-dir') || join('outputs', `prospect-live-provisional-cleanup-${stamp}`)),
    apply: raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
  };
}

function sqlString(value: string | null | undefined): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlList(values: string[]): string {
  return values.map(sqlString).join(', ');
}

function parseJson(value: string | null | undefined): Record<string, any> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
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

function patchMetadata(row: { metadata_json: string | null }, patch: Record<string, any>): string {
  return JSON.stringify({
    ...parseJson(row.metadata_json),
    live_prospect_cleanup: {
      applied_at: new Date().toISOString(),
      ...patch,
    },
  });
}

function patchCustomFields(row: CompanyRow, patch: Record<string, any>): string {
  const custom = parseJson(row.custom_fields);
  return JSON.stringify({
    ...custom,
    prospect_origin: {
      ...(custom.prospect_origin || {}),
      disabled_by_live_cleanup: true,
      evidence_quality: 'limited_info',
    },
    limited_info_prospect: {
      ...(custom.limited_info_prospect || {}),
      status: 'demoted_context',
    },
    enrichment_guard: {
      ...(custom.enrichment_guard || {}),
      status: 'blocked_insufficient_anchor',
    },
    live_prospect_cleanup: {
      applied_at: new Date().toISOString(),
      ...patch,
    },
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
           last_signal_at = (
             SELECT MAX(occurred_at) FROM prospect_signals
              WHERE org_id=${sqlString(orgId)} AND prospect_id=${sqlString(prospectId)} AND mention_type='inbound_prospect'
           ),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id=${sqlString(orgId)} AND id=${sqlString(prospectId)};`;
}

function aliasInsertSql(args: { orgId: string; entityType: 'prospect' | 'company'; entityId: string; aliasValue: string; evidence: Record<string, any> }): string {
  return `INSERT INTO entity_identity_aliases (
    org_id, entity_type, entity_id, alias_kind, alias_value, confidence, source_kind, evidence_json, created_at, updated_at
  ) VALUES (
    ${sqlString(args.orgId)}, ${sqlString(args.entityType)}, ${sqlString(args.entityId)}, 'manual', ${sqlString(args.aliasValue)}, 1.0,
    'manual', ${sqlString(JSON.stringify(args.evidence))}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(org_id, entity_type, entity_id, alias_kind, alias_value) DO UPDATE SET
    confidence = 1.0,
    source_kind = excluded.source_kind,
    evidence_json = excluded.evidence_json,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`;
}

export async function runLiveProvisionalCleanup(args: Args): Promise<Record<string, unknown>> {
  mkdirSync(args.outputDir, { recursive: true });

  const prospects = runD1<ProspectRow>(args.database, `
    SELECT *
      FROM prospects
     WHERE org_id=${sqlString(args.orgId)}
       AND (
         normalized_name IN (${sqlList(TARGET_NORMALIZED)})
         OR lower(replace(canonical_name, ' ', '')) IN ('neuralseq','neuralseek','nucor','edgerunner','edgerunnerai')
       )
     ORDER BY canonical_name, id`);
  const affectedProspectIds = prospects.map(row => row.id);
  const signals = affectedProspectIds.length
    ? runD1<SignalRow>(args.database, `
        SELECT *
          FROM prospect_signals
         WHERE org_id=${sqlString(args.orgId)}
           AND (prospect_id IN (${sqlList(affectedProspectIds)}) OR normalized_mention IN (${sqlList(TARGET_NORMALIZED)}))
         ORDER BY created_at, id`)
    : [];
  const companyIds = Array.from(new Set([
    ...prospects.flatMap(row => [row.company_id, row.possible_company_id]),
    ...signals.map(row => row.company_id || null),
  ].filter(Boolean) as string[]));
  const companies = runD1<CompanyRow>(args.database, `
    SELECT *
      FROM companies
     WHERE org_id=${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND (
         ${companyIds.length ? `id IN (${sqlList(companyIds)}) OR` : ''}
         lower(replace(name, ' ', '')) IN ('neuralseek','nucor','edgerunnerai','edgerunner')
       )
     ORDER BY name, id`);
  const aliasEntityIds = Array.from(new Set([...affectedProspectIds, ...companies.map(row => row.id)]));
  const aliases = aliasEntityIds.length
    ? runD1(args.database, `
        SELECT *
          FROM entity_identity_aliases
         WHERE org_id=${sqlString(args.orgId)}
           AND (entity_id IN (${sqlList(aliasEntityIds)}) OR alias_value IN (${sqlList(TARGET_ALIAS_VALUES)}))
         ORDER BY entity_type, entity_id, alias_kind, alias_value`)
    : [];
  const tags = runD1(args.database, `
    SELECT * FROM tags
     WHERE org_id=${sqlString(args.orgId)}
       AND entity_type='company'
       AND lower(name)=lower('Investment Prospect')`);
  const companyTags = companyIds.length
    ? runD1(args.database, `SELECT * FROM company_tags WHERE company_id IN (${sqlList(companyIds)})`)
    : [];

  const backup = {
    prospects,
    signals,
    companies,
    aliases,
    tags,
    company_tags: companyTags,
  };
  const backupPath = join(args.outputDir, 'affected-live-prospect-rows.jsonl');
  const backupSha = writeJsonl(backupPath, [backup]);

  const neuralSeek = prospects.find(row => row.normalized_name === 'neuralseek' && !row.deleted_at);
  const neuralSeq = prospects.find(row => row.normalized_name === 'neuralseq' && !row.deleted_at) ||
    prospects.find(row => row.normalized_name === 'neuralseq');
  const nucor = prospects.find(row => row.normalized_name === 'nucor' && !row.deleted_at);
  const edgeRunner = prospects.find(row => row.normalized_name === 'edgerunner' && !row.deleted_at);
  const neuralSeekCompany = companies.find(row => row.id === neuralSeek?.company_id || normalizeName(row.name) === 'neuralseek');
  const nucorCompany = companies.find(row => row.id === nucor?.possible_company_id || normalizeName(row.name) === 'nucor');
  const edgeRunnerCompany = companies.find(row => row.id === edgeRunner?.possible_company_id || normalizeName(row.name) === 'edgerunner');
  const investmentProspectTag = tags[0] as { id?: string } | undefined;

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
      company_tags: companyTags.length,
    },
    planned_actions: {
      merge_neural_seq_into_neuralseek: Boolean(neuralSeek && neuralSeq && !neuralSeq.deleted_at),
      neural_seq_signals_to_move: neuralSeq && !neuralSeq.deleted_at ? signals.filter(row => row.prospect_id === neuralSeq.id).length : 0,
      demote_nucor: Boolean(nucor),
      nucor_signals_to_demote: nucor ? signals.filter(row => row.prospect_id === nucor.id).length : 0,
      canonicalize_edge_runner: Boolean(edgeRunner && edgeRunnerCompany),
      seed_neuralseq_aliases: Boolean(neuralSeek && neuralSeekCompany),
    },
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.pre-apply.json'), JSON.stringify(manifest, null, 2));
  if (!args.apply) return manifest;
  if (args.confirmProductionWrite !== CONFIRMATION) {
    throw new Error(`PROSPECT_LIVE_PROVISIONAL_CLEANUP_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${CONFIRMATION}`);
  }
  if (!existsSync(backupPath)) throw new Error(`PROSPECT_LIVE_PROVISIONAL_CLEANUP_BACKUP_MISSING:${backupPath}`);
  if (!neuralSeek) throw new Error('NEURALSEEK_TARGET_NOT_FOUND');
  if (!nucor) throw new Error('NUCOR_PROSPECT_NOT_FOUND');

  if (neuralSeq && !neuralSeq.deleted_at) {
    const neuralSeqSignals = signals.filter(row => row.prospect_id === neuralSeq.id);
    for (const signal of neuralSeqSignals) {
      const metadata = patchMetadata(signal, {
        action: 'merge_neural_seq_into_neuralseek',
        previous_prospect_id: neuralSeq.id,
        merged_into_prospect_id: neuralSeek.id,
        preserve_raw_mention: signal.raw_mention_text,
      });
      runD1(args.database, `
        UPDATE prospect_signals
           SET prospect_id=${sqlString(neuralSeek.id)},
               company_id=${sqlString(neuralSeekCompany?.id || null)},
               metadata_json=${sqlString(metadata)},
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(signal.id)}`);
    }
    runD1(args.database, `
      UPDATE prospects
         SET possible_duplicate_of=${sqlString(neuralSeek.id)},
             metadata_json=json_patch(COALESCE(metadata_json, '{}'), ${sqlString(JSON.stringify({
               live_prospect_cleanup: {
                 action: 'merged_into_neuralseek',
                 merged_into_prospect_id: neuralSeek.id,
                 applied_at: new Date().toISOString(),
               },
             }))}),
             deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(neuralSeq.id)}`);
  }
  if (neuralSeq?.id) {
    runD1(args.database, `DELETE FROM entity_identity_aliases WHERE org_id=${sqlString(args.orgId)} AND entity_type='prospect' AND entity_id=${sqlString(neuralSeq.id)}`);
  }
  runD1(args.database, aliasInsertSql({
    orgId: args.orgId,
    entityType: 'prospect',
    entityId: neuralSeek.id,
    aliasValue: 'neuralseq',
    evidence: { source: 'live_prospect_cleanup', canonical_name: 'NeuralSeek', raw_alias: 'Neural Seq' },
  }));
  if (neuralSeekCompany?.id) {
    runD1(args.database, aliasInsertSql({
      orgId: args.orgId,
      entityType: 'company',
      entityId: neuralSeekCompany.id,
      aliasValue: 'neuralseq',
      evidence: { source: 'live_prospect_cleanup', company_name: neuralSeekCompany.name, raw_alias: 'Neural Seq' },
    }));
  }

  const nucorSignals = signals.filter(row => row.prospect_id === nucor.id);
  for (const signal of nucorSignals) {
    const metadata = {
      ...parseJson(signal.metadata_json),
      prospect_action: 'record_context',
      should_create_prospect: false,
      live_prospect_cleanup: {
        applied_at: new Date().toISOString(),
        action: 'demote_nucor_to_context',
        previous_prospect_id: nucor.id,
        previous_mention_type: signal.mention_type,
        reason: 'public_company_or_dirty_alias_without_clean_startup_anchor',
      },
    };
    runD1(args.database, `
      UPDATE prospect_signals
         SET mention_type='noise',
             prospect_id=NULL,
             company_id=NULL,
             deal_id=NULL,
             metadata_json=${sqlString(JSON.stringify(metadata))},
             resolution_status='resolved',
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(signal.id)}`);
  }
  runD1(args.database, `
    UPDATE prospects
       SET metadata_json=json_patch(COALESCE(metadata_json, '{}'), ${sqlString(JSON.stringify({
         live_prospect_cleanup: {
           action: 'demoted_nucor_to_context',
           reason: 'public_company_or_dirty_alias_without_clean_startup_anchor',
           applied_at: new Date().toISOString(),
         },
       }))}),
           deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(nucor.id)}`);
  runD1(args.database, `DELETE FROM entity_identity_aliases WHERE org_id=${sqlString(args.orgId)} AND entity_type='prospect' AND entity_id=${sqlString(nucor.id)}`);
  if (nucorCompany?.id) {
    runD1(args.database, `
      UPDATE companies
         SET investment_status='tracking',
             custom_fields=${sqlString(patchCustomFields(nucorCompany, {
               action: 'demote_nucor_limited_info_company',
               reason: 'limited-info prospect-origin company should not drive prospect behavior',
             }))},
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(nucorCompany.id)}`);
    if (investmentProspectTag?.id) {
      runD1(args.database, `DELETE FROM company_tags WHERE company_id=${sqlString(nucorCompany.id)} AND tag_id=${sqlString(investmentProspectTag.id)}`);
    }
  }

  if (edgeRunner && edgeRunnerCompany?.name) {
    runD1(args.database, `
      UPDATE prospects
         SET canonical_name=${sqlString(edgeRunnerCompany.name)},
             possible_company_id=COALESCE(possible_company_id, ${sqlString(edgeRunnerCompany.id)}),
             metadata_json=json_patch(COALESCE(metadata_json, '{}'), ${sqlString(JSON.stringify({
               live_prospect_cleanup: {
                 action: 'canonicalize_edge_runner_limited_info_link',
                 canonical_name: edgeRunnerCompany.name,
                 possible_company_id: edgeRunnerCompany.id,
                 link_strength: 'limited_info_audit_only',
                 applied_at: new Date().toISOString(),
               },
             }))}),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE org_id=${sqlString(args.orgId)} AND id=${sqlString(edgeRunner.id)}`);
  }

  runD1(args.database, refreshAggregateSql(neuralSeek.id, args.orgId));
  if (neuralSeq?.id) runD1(args.database, refreshAggregateSql(neuralSeq.id, args.orgId));
  runD1(args.database, refreshAggregateSql(nucor.id, args.orgId));
  if (edgeRunner?.id) runD1(args.database, refreshAggregateSql(edgeRunner.id, args.orgId));

  const post = {
    ...manifest,
    dry_run: false,
    post_checks: {
      neural_seq_active_or_provisional: runD1(args.database, `
        SELECT COUNT(*) AS count FROM prospects
         WHERE org_id=${sqlString(args.orgId)}
           AND deleted_at IS NULL
           AND normalized_name='neuralseq'
           AND status IN ('active','provisional')`)[0]?.count || 0,
      nucor_active_or_provisional: runD1(args.database, `
        SELECT COUNT(*) AS count FROM prospects
         WHERE org_id=${sqlString(args.orgId)}
           AND deleted_at IS NULL
           AND normalized_name='nucor'
           AND status IN ('active','provisional')`)[0]?.count || 0,
      inbound_null_prospect_id: runD1(args.database, `
        SELECT COUNT(*) AS count FROM prospect_signals
         WHERE org_id=${sqlString(args.orgId)}
           AND mention_type='inbound_prospect'
           AND prospect_id IS NULL`)[0]?.count || 0,
      neuralseq_aliases_to_neuralseek: runD1(args.database, `
        SELECT COUNT(*) AS count FROM entity_identity_aliases
         WHERE org_id=${sqlString(args.orgId)}
           AND alias_value='neuralseq'
           AND entity_id IN (${sqlString(neuralSeek.id)}${neuralSeekCompany?.id ? `, ${sqlString(neuralSeekCompany.id)}` : ''})`)[0]?.count || 0,
    },
    applied_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.post-apply.json'), JSON.stringify(post, null, 2));
  return post;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runLiveProvisionalCleanup(parseArgs(process.argv.slice(2)))
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
