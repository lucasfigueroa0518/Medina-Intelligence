import type { Env } from '../types/env';
import { emitAudit } from './audit';
import { invalidateRagCache } from './cache';
import { cleanupVectorsForEntity, mergeContacts } from './merge';
import {
  safelyDeleteContactSearchIndexForContact,
  safelyRebuildContactSearchIndexForCompany,
} from './contact-search';
import { safelyDeleteContactDetailReadModelForContact } from './contact-detail-read-model';

export type CrmEntityCleanupResultAction =
  | 'merge_applied'
  | 'merge_blocked'
  | 'soft_delete_applied'
  | 'delete_pending_review'
  | 'skip_missing'
  | 'skip_already_merged_or_deleted'
  | 'error';

type EntityType = 'contact' | 'company';

interface CleanupPlanRow {
  id: string;
  org_id: string;
  entity_type: EntityType;
  entity_id: string;
  current_name: string | null;
  cleanup_action: 'merge' | 'delete';
  merge_target_id: string | null;
  delete_reason: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  approved: number;
  apply_policy: 'apply' | 'pending_review';
}

interface EntitySnapshot {
  id: string;
  name?: string | null;
  full_name?: string | null;
  domain?: string | null;
  deleted_at?: string | null;
  merged_into?: string | null;
}

function tableFor(entityType: EntityType): 'contacts' | 'companies' {
  return entityType === 'contact' ? 'contacts' : 'companies';
}

function nameColumnFor(entityType: EntityType): 'full_name' | 'name' {
  return entityType === 'contact' ? 'full_name' : 'name';
}

function entityName(row: EntitySnapshot | null, entityType: EntityType): string {
  if (!row) return '';
  return String(entityType === 'contact' ? row.full_name || '' : row.name || '');
}

async function loadEntity(env: Env, orgId: string, entityType: EntityType, entityId: string): Promise<EntitySnapshot | null> {
  const table = tableFor(entityType);
  const nameColumn = nameColumnFor(entityType);
  const extra = entityType === 'company' ? ', domain' : '';
  return await env.D1.prepare(
    `SELECT id, ${nameColumn}${extra}, deleted_at, merged_into
       FROM ${table}
      WHERE id = ? AND org_id = ?`
  ).bind(entityId, orgId).first<EntitySnapshot>();
}

async function writeCleanupResult(args: {
  env: Env;
  plan: CleanupPlanRow;
  resultAction: CrmEntityCleanupResultAction;
  beforeName?: string | null;
  afterName?: string | null;
  applied: boolean;
  details?: Record<string, unknown> | string | null;
  error?: string | null;
}): Promise<void> {
  const details = typeof args.details === 'string'
    ? args.details
    : args.details
      ? JSON.stringify(args.details)
      : null;
  await args.env.D1.prepare(
    `INSERT INTO crm_entity_cleanup_results
       (org_id, plan_id, entity_type, entity_id, cleanup_action, result_action,
        merge_target_id, before_name, after_name, applied, details, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, plan_id) DO UPDATE SET
       result_action = excluded.result_action,
       merge_target_id = excluded.merge_target_id,
       before_name = excluded.before_name,
       after_name = excluded.after_name,
       applied = excluded.applied,
       details = excluded.details,
       error = excluded.error,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    args.plan.org_id,
    args.plan.id,
    args.plan.entity_type,
    args.plan.entity_id,
    args.plan.cleanup_action,
    args.resultAction,
    args.plan.merge_target_id || null,
    args.beforeName || null,
    args.afterName || null,
    args.applied ? 1 : 0,
    details,
    args.error || null
  ).run();
}

async function countCompanyDependents(env: Env, orgId: string, companyId: string): Promise<Record<string, number>> {
  const count = async (table: string) => {
    const row = await env.D1.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ? AND org_id = ?`
    ).bind(companyId, orgId).first<{ n: number }>();
    return row?.n || 0;
  };
  const companyTags = await env.D1.prepare(
    `SELECT COUNT(*) AS n FROM company_tags WHERE company_id = ?`
  ).bind(companyId).first<{ n: number }>();
  return {
    contacts: await count('contacts'),
    deals: await count('deals'),
    documents: await count('documents'),
    tasks: await count('tasks'),
    news_articles: await count('news_articles'),
    company_tags: companyTags?.n || 0,
  };
}

async function mergeCompany(args: {
  env: Env;
  orgId: string;
  userId: string;
  loser: EntitySnapshot;
  survivor: EntitySnapshot;
}): Promise<{ ok: true; details: Record<string, number> } | { ok: false; error: string }> {
  if (args.survivor.deleted_at) return { ok: false, error: 'SURVIVOR_DELETED' };
  if (args.loser.merged_into) return { ok: false, error: `LOSER_ALREADY_MERGED:${args.loser.merged_into}` };

  const openDealConflict = await args.env.D1.prepare(
    `SELECT company_id
       FROM deals
      WHERE org_id = ?
        AND company_id IN (?, ?)
        AND deleted_at IS NULL
        AND stage NOT IN ('closed','closed_won','closed_lost')
      GROUP BY company_id
      LIMIT 2`
  ).bind(args.orgId, args.loser.id, args.survivor.id).all<{ company_id: string }>();
  if (openDealConflict.results.length > 1) return { ok: false, error: 'OPEN_DEAL_CONFLICT' };

  const counts = await countCompanyDependents(args.env, args.orgId, args.loser.id);
  const now = new Date().toISOString();
  await args.env.D1.batch([
    args.env.D1.prepare(`UPDATE contacts SET company_id = ?, updated_at = ? WHERE company_id = ?`).bind(args.survivor.id, now, args.loser.id),
    args.env.D1.prepare(`UPDATE deals SET company_id = ?, updated_at = ? WHERE company_id = ?`).bind(args.survivor.id, now, args.loser.id),
    args.env.D1.prepare(`UPDATE documents SET company_id = ? WHERE company_id = ?`).bind(args.survivor.id, args.loser.id),
    args.env.D1.prepare(`UPDATE tasks SET company_id = ? WHERE company_id = ?`).bind(args.survivor.id, args.loser.id),
    args.env.D1.prepare(`UPDATE news_articles SET company_id = ? WHERE company_id = ?`).bind(args.survivor.id, args.loser.id),
    args.env.D1.prepare(`DELETE FROM company_tags WHERE company_id = ?`).bind(args.loser.id),
    args.env.D1.prepare(`UPDATE companies SET merged_into = ?, deleted_at = ?, updated_at = ? WHERE id = ?`).bind(args.survivor.id, now, now, args.loser.id),
  ]);
  await emitAudit(args.env, {
    org_id: args.orgId,
    user_id: args.userId,
    action: 'merge',
    entity_type: 'company',
    entity_id: args.loser.id,
    after_data: { merged_into: args.survivor.id, repointed: counts },
    created_at: now,
  });
  await safelyRebuildContactSearchIndexForCompany(args.env, args.orgId, args.survivor.id, args.loser.domain || null);
  await invalidateRagCache(args.orgId, args.env);
  return { ok: true, details: counts };
}

async function softDeleteEntity(args: {
  env: Env;
  orgId: string;
  userId: string;
  entityType: EntityType;
  entity: EntitySnapshot;
  reason: string | null;
}): Promise<void> {
  const table = tableFor(args.entityType);
  const now = new Date().toISOString();
  if (args.entityType === 'company') {
    await args.env.D1.batch([
      args.env.D1.prepare(`UPDATE companies SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`).bind(now, now, args.entity.id, args.orgId),
      args.env.D1.prepare(`UPDATE contacts SET company_id = NULL, updated_at = ? WHERE company_id = ? AND org_id = ?`).bind(now, args.entity.id, args.orgId),
    ]);
    await safelyRebuildContactSearchIndexForCompany(args.env, args.orgId, args.entity.id, args.entity.domain || null);
    try { await cleanupVectorsForEntity(args.entity.id, 'companies', args.env); } catch {}
  } else {
    await args.env.D1.prepare(
      `UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`
    ).bind(now, now, args.entity.id, args.orgId).run();
    await args.env.D1.batch([
      args.env.D1.prepare('DELETE FROM deal_contacts WHERE contact_id = ?').bind(args.entity.id),
      args.env.D1.prepare('DELETE FROM entity_associations WHERE (entity_a_type = ? AND entity_a_id = ?) OR (entity_b_type = ? AND entity_b_id = ?)').bind('contact', args.entity.id, 'contact', args.entity.id),
    ]);
    try { await cleanupVectorsForEntity(args.entity.id, 'contacts', args.env); } catch {}
    await safelyDeleteContactSearchIndexForContact(args.env, args.orgId, args.entity.id);
    await safelyDeleteContactDetailReadModelForContact(args.env, args.orgId, args.entity.id);
  }
  await emitAudit(args.env, {
    org_id: args.orgId,
    user_id: args.userId,
    action: 'soft_delete',
    entity_type: args.entityType,
    entity_id: args.entity.id,
    before_data: args.entity,
    metadata: { reason: 'crm_entity_cleanup_plan', delete_reason: args.reason, table },
    created_at: now,
  });
  await invalidateRagCache(args.orgId, args.env);
}

async function cleanupPlanRows(env: Env, orgId: string): Promise<CleanupPlanRow[]> {
  const rows = await env.D1.prepare(
    `SELECT *
       FROM crm_entity_cleanup_plan
      WHERE org_id = ?
        AND approved = 1
      ORDER BY CASE cleanup_action WHEN 'merge' THEN 0 ELSE 1 END, entity_type, entity_id`
  ).bind(orgId).all<CleanupPlanRow>();
  return rows.results;
}

export async function validateCrmEntityCleanupPlan(env: Env, orgId: string): Promise<Record<string, unknown>> {
  const rows = await cleanupPlanRows(env, orgId);
  const counts: Record<string, number> = {};
  const problems: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const key = `${row.cleanup_action}:${row.apply_policy}:${row.confidence || 'unknown'}`;
    counts[key] = (counts[key] || 0) + 1;
    const entity = await loadEntity(env, orgId, row.entity_type, row.entity_id);
    if (!entity) {
      problems.push({ plan_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, problem: 'missing_entity' });
      continue;
    }
    if (entity.deleted_at || entity.merged_into) {
      problems.push({ plan_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, problem: 'already_inactive', merged_into: entity.merged_into || null });
    }
    if (row.cleanup_action === 'merge') {
      const target = row.merge_target_id ? await loadEntity(env, orgId, row.entity_type, row.merge_target_id) : null;
      if (!target) problems.push({ plan_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, problem: 'missing_merge_target', merge_target_id: row.merge_target_id });
      else if (target.deleted_at || target.merged_into) problems.push({ plan_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, problem: 'inactive_merge_target', merge_target_id: row.merge_target_id });
      if (row.entity_type === 'company' && target) {
        const conflict = await env.D1.prepare(
          `SELECT company_id
             FROM deals
            WHERE org_id = ?
              AND company_id IN (?, ?)
              AND deleted_at IS NULL
              AND stage NOT IN ('closed','closed_won','closed_lost')
            GROUP BY company_id
            LIMIT 2`
        ).bind(orgId, row.entity_id, row.merge_target_id).all<{ company_id: string }>();
        if (conflict.results.length > 1) problems.push({ plan_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, problem: 'open_deal_conflict', merge_target_id: row.merge_target_id });
      }
    }
  }
  return { total: rows.length, counts, problems };
}

export async function applyCrmEntityCleanupPlan(args: {
  env: Env;
  orgId: string;
  userId: string;
  dryRun?: boolean;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const rows = await cleanupPlanRows(args.env, args.orgId);
  const selected = typeof args.limit === 'number' && args.limit > 0 ? rows.slice(0, args.limit) : rows;
  const counts: Record<string, number> = {};
  const errors: Array<Record<string, unknown>> = [];

  for (const plan of selected) {
    const bump = (action: CrmEntityCleanupResultAction) => {
      counts[action] = (counts[action] || 0) + 1;
    };
    try {
      const entity = await loadEntity(args.env, args.orgId, plan.entity_type, plan.entity_id);
      if (!entity) {
        if (!args.dryRun) await writeCleanupResult({ env: args.env, plan, resultAction: 'skip_missing', applied: false });
        bump('skip_missing');
        continue;
      }
      const beforeName = entityName(entity, plan.entity_type);
      if (entity.deleted_at || entity.merged_into) {
        if (!args.dryRun) await writeCleanupResult({
          env: args.env,
          plan,
          resultAction: 'skip_already_merged_or_deleted',
          beforeName,
          applied: false,
          details: { merged_into: entity.merged_into || null, deleted_at: entity.deleted_at || null },
        });
        bump('skip_already_merged_or_deleted');
        continue;
      }
      if (plan.cleanup_action === 'delete') {
        if (plan.apply_policy !== 'apply') {
          if (!args.dryRun) await writeCleanupResult({ env: args.env, plan, resultAction: 'delete_pending_review', beforeName, applied: false });
          bump('delete_pending_review');
          continue;
        }
        if (!args.dryRun) {
          await softDeleteEntity({
            env: args.env,
            orgId: args.orgId,
            userId: args.userId,
            entityType: plan.entity_type,
            entity,
            reason: plan.delete_reason,
          });
          await writeCleanupResult({ env: args.env, plan, resultAction: 'soft_delete_applied', beforeName, applied: true, details: plan.delete_reason });
        }
        bump('soft_delete_applied');
        continue;
      }

      if (!plan.merge_target_id) {
        if (!args.dryRun) await writeCleanupResult({ env: args.env, plan, resultAction: 'error', beforeName, applied: false, error: 'missing_merge_target_id' });
        bump('error');
        continue;
      }
      const target = await loadEntity(args.env, args.orgId, plan.entity_type, plan.merge_target_id);
      if (!target || target.deleted_at || target.merged_into) {
        if (!args.dryRun) await writeCleanupResult({
          env: args.env,
          plan,
          resultAction: target ? 'merge_blocked' : 'skip_missing',
          beforeName,
          afterName: target ? entityName(target, plan.entity_type) : null,
          applied: false,
          error: target ? 'inactive_merge_target' : 'missing_merge_target',
        });
        bump(target ? 'merge_blocked' : 'skip_missing');
        continue;
      }
      const afterName = entityName(target, plan.entity_type);
      if (args.dryRun) {
        bump('merge_applied');
        continue;
      }
      if (plan.entity_type === 'contact') {
        const result = await mergeContacts(plan.merge_target_id, plan.entity_id, args.userId, args.orgId, args.env);
        if (result.success) {
          await writeCleanupResult({ env: args.env, plan, resultAction: 'merge_applied', beforeName, afterName, applied: true });
          bump('merge_applied');
        } else {
          await writeCleanupResult({ env: args.env, plan, resultAction: 'merge_blocked', beforeName, afterName, applied: false, error: result.error || result.message || 'contact_merge_failed' });
          bump('merge_blocked');
        }
      } else {
        const result = await mergeCompany({ env: args.env, orgId: args.orgId, userId: args.userId, loser: entity, survivor: target });
        if (result.ok) {
          await writeCleanupResult({ env: args.env, plan, resultAction: 'merge_applied', beforeName, afterName, applied: true, details: result.details });
          bump('merge_applied');
        } else {
          await writeCleanupResult({ env: args.env, plan, resultAction: 'merge_blocked', beforeName, afterName, applied: false, error: result.error });
          bump('merge_blocked');
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ plan_id: plan.id, entity_type: plan.entity_type, entity_id: plan.entity_id, error: message });
      if (!args.dryRun) await writeCleanupResult({ env: args.env, plan, resultAction: 'error', applied: false, error: message.slice(0, 1000) });
      counts.error = (counts.error || 0) + 1;
    }
  }

  return { dry_run: !!args.dryRun, total: selected.length, counts, errors };
}
