import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const outputRoot = path.join(repoRoot, 'outputs/crm-stage1-investigation-20260619');
const dryRunRoot = path.join(outputRoot, 'crm-name-production-dry-run-20260623-coveragefix');

const ORG_ID = process.env.CRM_CLEANUP_ORG_ID || 'medina-ventures';
const SOURCE_RUN_ID = process.env.CRM_NAME_SOURCE_RUN_ID || 'crm-name-dryrun-coveragefix-20260623213918';

const overrideFiles = [
  path.join(dryRunRoot, 'verified-renames-codex-fixed.csv'),
  path.join(dryRunRoot, 'pending-proposals-jumbled-verified-codex-fixed.csv'),
  path.join(dryRunRoot, 'quick-pass-review-wins.csv'),
];
const cleanupFile = path.join(outputRoot, 'stage1-cleanup-report-approved-baseline.csv');
const outFile = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(dryRunRoot, 'production-reviewed-overlay-and-cleanup-plan.sql');

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function sql(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function readCsv(file: string): Record<string, string>[] {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

const statements: string[] = [
  'BEGIN TRANSACTION;',
];

let overrideCount = 0;
for (const file of overrideFiles) {
  const artifact = path.basename(file);
  for (const row of readCsv(file)) {
    const entityType = row.entity_type;
    const entityId = row.entity_id;
    const action = row.codex_corrected_action;
    const name = row.codex_corrected_name;
    const status = row.codex_corrected_status;
    const confidence = row.codex_corrected_confidence;
    const rationale = row.codex_rationale;
    const applyReady = row.codex_apply_ready === 'yes' ? 1 : 0;
    if (!entityType || !entityId || !action) throw new Error(`Invalid override row in ${artifact}`);
    statements.push(
      `INSERT INTO crm_name_backfill_review_overrides
        (org_id, source_run_id, entity_type, entity_id, corrected_action, corrected_name, corrected_status,
         corrected_confidence, rationale, source_artifact, apply_ready)
       VALUES (${sql(ORG_ID)}, ${sql(SOURCE_RUN_ID)}, ${sql(entityType)}, ${sql(entityId)}, ${sql(action)}, ${sql(name)},
               ${sql(status)}, ${sql(confidence)}, ${sql(rationale)}, ${sql(artifact)}, ${applyReady})
       ON CONFLICT(org_id, source_run_id, entity_type, entity_id) DO UPDATE SET
         corrected_action = excluded.corrected_action,
         corrected_name = excluded.corrected_name,
         corrected_status = excluded.corrected_status,
         corrected_confidence = excluded.corrected_confidence,
         rationale = excluded.rationale,
         source_artifact = excluded.source_artifact,
         apply_ready = excluded.apply_ready,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`
    );
    overrideCount++;
  }
}

const cleanupRows = readCsv(cleanupFile).filter(row => row.proposed_action === 'merge' || row.proposed_action === 'delete');
let mergeCount = 0;
let deleteCount = 0;
let deleteApplyCount = 0;
let deletePendingCount = 0;
for (const row of cleanupRows) {
  const action = row.proposed_action;
  const confidence = row.confidence || null;
  const applyPolicy = action === 'merge' || confidence === 'high' || confidence === 'medium'
    ? 'apply'
    : 'pending_review';
  if (action === 'merge') mergeCount++;
  if (action === 'delete') {
    deleteCount++;
    if (applyPolicy === 'apply') deleteApplyCount++;
    else deletePendingCount++;
  }
  statements.push(
    `INSERT INTO crm_entity_cleanup_plan
      (org_id, source_artifact, source_row_number, entity_type, entity_id, current_name, cleanup_action,
       merge_target_id, delete_reason, confidence, approved, apply_policy, evidence, notes)
     VALUES (${sql(ORG_ID)}, ${sql(path.basename(cleanupFile))}, ${sql(Number(row.original_row_number) || null)},
             ${sql(row.entity_type)}, ${sql(row.entity_id)}, ${sql(row.current_name)}, ${sql(action)},
             ${sql(row.merge_target_id)}, ${sql(row.delete_reason)}, ${sql(confidence)}, 1, ${sql(applyPolicy)},
             ${sql(row.evidence)}, ${sql(row.notes)})
     ON CONFLICT(org_id, entity_type, entity_id, cleanup_action) DO UPDATE SET
       source_artifact = excluded.source_artifact,
       source_row_number = excluded.source_row_number,
       current_name = excluded.current_name,
       merge_target_id = excluded.merge_target_id,
       delete_reason = excluded.delete_reason,
       confidence = excluded.confidence,
       approved = excluded.approved,
       apply_policy = excluded.apply_policy,
       evidence = excluded.evidence,
       notes = excluded.notes,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`
  );
}

statements.push('COMMIT;');

if (mergeCount !== 26) throw new Error(`Expected 26 merge rows, found ${mergeCount}`);
if (deleteCount !== 27) throw new Error(`Expected 27 delete rows, found ${deleteCount}`);

fs.writeFileSync(outFile, `${statements.join('\n')}\n`);
console.log(JSON.stringify({
  outFile,
  orgId: ORG_ID,
  sourceRunId: SOURCE_RUN_ID,
  overrideCount,
  mergeCount,
  deleteCount,
  deleteApplyCount,
  deletePendingCount,
}, null, 2));
