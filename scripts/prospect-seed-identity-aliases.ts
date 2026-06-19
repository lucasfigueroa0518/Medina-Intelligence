#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { buildEntityIdentityAliasValues } from '../src/lib/prospect-intelligence';

const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const CONFIRMATION = 'PROSPECT_ALIAS_SEED_GO';

type Args = {
  orgId: string;
  database: string;
  outputDir: string;
  apply: boolean;
  confirmProductionWrite: string | null;
};

type AliasProjection = {
  org_id: string;
  entity_type: 'company' | 'prospect';
  entity_id: string;
  alias_kind: string;
  alias_value: string;
  confidence: number;
  source_kind: 'migration';
  evidence_json: string;
};

type ProspectRow = {
  id: string;
  canonical_name: string | null;
  normalized_name: string | null;
  domain: string | null;
  website: string | null;
  status: string | null;
  provisional: number | null;
};

type CompanyRow = {
  id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
};

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      index++;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    orgId: raw.get('org-id') || DEFAULT_ORG_ID,
    database: raw.get('database') || DEFAULT_DATABASE,
    outputDir: resolve(raw.get('output-dir') || join('outputs', `prospect-identity-alias-seed-${stamp}`)),
    apply: raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
  };
}

function sqlString(value: string | null | undefined): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'NULL';
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

function writeJsonl(path: string, rows: unknown[]): string {
  const body = rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '';
  writeFileSync(path, body);
  return createHash('sha256').update(body).digest('hex');
}

function buildAliases(args: Args, prospects: ProspectRow[], companies: CompanyRow[]): AliasProjection[] {
  const aliases: AliasProjection[] = [];
  const seen = new Set<string>();
  const add = (row: AliasProjection): void => {
    const key = `${row.org_id}:${row.entity_type}:${row.entity_id}:${row.alias_kind}:${row.alias_value}`;
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(row);
  };

  for (const prospect of prospects) {
    for (const alias of buildEntityIdentityAliasValues({
      name: prospect.canonical_name,
      normalizedName: prospect.normalized_name,
      domain: prospect.domain,
      website: prospect.website,
    })) {
      add({
        org_id: args.orgId,
        entity_type: 'prospect',
        entity_id: prospect.id,
        alias_kind: alias.aliasKind,
        alias_value: alias.aliasValue,
        confidence: alias.confidence,
        source_kind: 'migration',
        evidence_json: JSON.stringify({
          source: 'prospect_identity_alias_seed',
          canonical_name: prospect.canonical_name,
          status: prospect.status,
        }),
      });
    }
  }

  for (const company of companies) {
    for (const alias of buildEntityIdentityAliasValues({
      name: company.name,
      domain: company.domain,
      website: company.website,
    })) {
      add({
        org_id: args.orgId,
        entity_type: 'company',
        entity_id: company.id,
        alias_kind: alias.aliasKind,
        alias_value: alias.aliasValue,
        confidence: alias.confidence,
        source_kind: 'migration',
        evidence_json: JSON.stringify({
          source: 'prospect_identity_alias_seed',
          company_name: company.name,
        }),
      });
    }
  }

  return aliases;
}

function aliasInsertSql(rows: AliasProjection[]): string {
  return `INSERT INTO entity_identity_aliases (
  org_id, entity_type, entity_id, alias_kind, alias_value, confidence, source_kind, evidence_json,
  created_at, updated_at
) VALUES
${rows.map(row => `(${sqlString(row.org_id)}, ${sqlString(row.entity_type)}, ${sqlString(row.entity_id)}, ${sqlString(row.alias_kind)}, ${sqlString(row.alias_value)}, ${sqlNumber(row.confidence)}, ${sqlString(row.source_kind)}, ${sqlString(row.evidence_json)}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).join(',\n')}
ON CONFLICT(org_id, entity_type, entity_id, alias_kind, alias_value) DO UPDATE SET
  confidence = MAX(entity_identity_aliases.confidence, excluded.confidence),
  source_kind = excluded.source_kind,
  evidence_json = excluded.evidence_json,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
}

export async function runProspectIdentityAliasSeed(args: Args): Promise<Record<string, unknown>> {
  mkdirSync(args.outputDir, { recursive: true });
  const prospects = runD1<ProspectRow>(args.database, `
    SELECT id, canonical_name, normalized_name, domain, website, status, provisional
      FROM prospects
     WHERE org_id=${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND status IN ('active','provisional','converted')
     ORDER BY canonical_name, id`);
  const companies = runD1<CompanyRow>(args.database, `
    SELECT id, name, domain, website
      FROM companies
     WHERE org_id=${sqlString(args.orgId)}
       AND deleted_at IS NULL
     ORDER BY name, id`);
  const inconsistentActiveProvisional = prospects.filter(row => row.status === 'active' && Number(row.provisional || 0) === 1);
  const inconsistentProvisionalFlag = prospects.filter(row => row.status === 'provisional' && Number(row.provisional || 0) !== 1);
  const aliases = buildAliases(args, prospects, companies);
  const aliasesPath = join(args.outputDir, 'identity-aliases.jsonl');
  const manifest = {
    dry_run: !args.apply,
    org_id: args.orgId,
    database: args.database,
    output_dir: args.outputDir,
    prospects_scanned: prospects.length,
    companies_scanned: companies.length,
    aliases_projected: aliases.length,
    inconsistent_active_provisional: inconsistentActiveProvisional.length,
    inconsistent_provisional_flag: inconsistentProvisionalFlag.length,
    aliases_path: aliasesPath,
    aliases_sha256: writeJsonl(aliasesPath, aliases),
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.pre-apply.json'), JSON.stringify(manifest, null, 2));
  if (!args.apply) return manifest;
  if (args.confirmProductionWrite !== CONFIRMATION) {
    throw new Error(`PROSPECT_ALIAS_SEED_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${CONFIRMATION}`);
  }
  if (!existsSync(aliasesPath)) throw new Error(`PROSPECT_ALIAS_SEED_BACKUP_MISSING:${aliasesPath}`);

  for (const rows of chunk(aliases, 75)) runD1(args.database, aliasInsertSql(rows));
  runD1(args.database, `
    UPDATE prospects
       SET provisional = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id=${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND status IN ('active','converted')
       AND provisional = 1`);
  runD1(args.database, `
    UPDATE prospects
       SET provisional = 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id=${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND status = 'provisional'
       AND COALESCE(provisional, 0) != 1`);

  const after = {
    identity_aliases: runD1<{ count: number }>(args.database, `SELECT COUNT(*) AS count FROM entity_identity_aliases WHERE org_id=${sqlString(args.orgId)}`)[0]?.count || 0,
    active_provisional_mismatch: runD1<{ count: number }>(args.database, `
      SELECT COUNT(*) AS count
        FROM prospects
       WHERE org_id=${sqlString(args.orgId)}
         AND deleted_at IS NULL
         AND status IN ('active','converted')
         AND provisional = 1`)[0]?.count || 0,
    provisional_flag_mismatch: runD1<{ count: number }>(args.database, `
      SELECT COUNT(*) AS count
        FROM prospects
       WHERE org_id=${sqlString(args.orgId)}
         AND deleted_at IS NULL
         AND status = 'provisional'
         AND COALESCE(provisional, 0) != 1`)[0]?.count || 0,
  };
  const summary = {
    ...manifest,
    dry_run: false,
    applied: true,
    after,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.json'), JSON.stringify(summary, null, 2));
  return summary;
}

async function main(): Promise<void> {
  const summary = await runProspectIdentityAliasSeed(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
