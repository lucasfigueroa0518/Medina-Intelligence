import type { Env } from '../types/env';
import { triggerContactEnrichment } from './enrichment';
import { emitAudit } from './audit';
import { updateEntityInIndex } from './entity-index';
import type { ChannelContext } from './source-channels';
import { evaluateProposal, recordApproval } from './proposal-evaluator';

interface FieldUpdate {
  field: string;
  value: string;
  source: string;
  confidence: number;
  source_description?: string;
  source_communication_id?: string;
  /** Channel attribution for the Wave 6 corroboration model. Optional
   *  during Phase B rollout — sources that don't yet thread context
   *  will hit resolveChannel's fallback path. */
  context?: ChannelContext;
}

export type SourceType =
  | 'email_signature' | 'meeting_transcript' | 'slack'
  | 'enrichment' | 'llm_extraction' | 'display_name'
  | 'web_enrichment_company' | 'news_article';

/** @deprecated Wave 6: corroboration is the only quality signal. The
 *  policy distinction (always_queue vs auto_if_confident) is a no-op
 *  but the type stays exported to avoid breaking call sites that pass
 *  it through their own type signatures. */
export type UpdatePolicy = 'always_queue' | 'auto_if_confident';

const CONTACT_FIELDS = new Set([
  'full_name', 'job_title', 'phone', 'email', 'linkedin_url', 'twitter_url',
  'location', 'company_id', 'bio_summary', 'investment_focus', 'check_size_range',
  'communication_channel_preference', 'introduced_via', 'fund_name',
  // LLM extraction emits these (see prompts/extraction.ts); they map to real
  // contact columns and need to flow through the same dedup/skip-if-equal path.
  'topics_of_interest', 'pain_points', 'investment_thesis_tags',
]);

const COMPANY_FIELDS = new Set([
  'name', 'sector', 'website', 'domain', 'description', 'hq_location',
  'employee_count', 'investment_status', 'stage', 'current_valuation',
  'linkedin_url', 'last_funding_amount', 'last_funding_round', 'last_funding_date',
]);

function tableForEntity(entityType: string): string {
  if (entityType === 'contact') return 'contacts';
  if (entityType === 'company') return 'companies';
  return 'deals';
}

function fieldsForEntity(entityType: string): Set<string> {
  if (entityType === 'contact') return CONTACT_FIELDS;
  if (entityType === 'company') return COMPANY_FIELDS;
  return new Set<string>();
}

async function getCurrentFieldValue(
  entityType: string,
  entityId: string,
  field: string,
  env: Env
): Promise<string | null> {
  const allowed = fieldsForEntity(entityType);
  if (!allowed.has(field)) return null;

  const table = tableForEntity(entityType);
  const row = await env.D1.prepare(
    `SELECT ${field} as v FROM ${table} WHERE id = ?`
  ).bind(entityId).first<{ v: string | null }>().catch(() => null);

  return row?.v ?? null;
}

// Title abbreviation expansion still drives normalizeForComparison so
// "VP of Eng" and "Vice President of Engineering" hash to the same
// pending_proposals key in the evaluator.
const TITLE_ABBREVIATIONS: [RegExp, string][] = [
  [/\bvp\b/gi, 'vice president'],
  [/\bceo\b/gi, 'chief executive officer'],
  [/\bcto\b/gi, 'chief technology officer'],
  [/\bcfo\b/gi, 'chief financial officer'],
  [/\bcoo\b/gi, 'chief operating officer'],
  [/\bcmo\b/gi, 'chief marketing officer'],
  [/\bcio\b/gi, 'chief information officer'],
  [/\bcpo\b/gi, 'chief product officer'],
  [/\bcro\b/gi, 'chief revenue officer'],
  [/\bsvp\b/gi, 'senior vice president'],
  [/\bevp\b/gi, 'executive vice president'],
  [/\bavp\b/gi, 'assistant vice president'],
  [/\bsr\.?\b/gi, 'senior'],
  [/\bjr\.?\b/gi, 'junior'],
  [/\bdir\.?\b/gi, 'director'],
  [/\bmgr\.?\b/gi, 'manager'],
  [/\bengr\.?\b/gi, 'engineer'],
  [/\beng\b/gi, 'engineer'],
];

function normalizeTitle(value: string): string {
  let v = value.trim().toLowerCase();
  for (const [pat, replacement] of TITLE_ABBREVIATIONS) {
    v = v.replace(pat, replacement);
  }
  return v.replace(/\bof\b/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeForComparison(field: string, value: string): string {
  const v = value.trim().toLowerCase();
  if (field === 'phone') return v.replace(/[^\d+]/g, '');
  if (field === 'linkedin_url' || field === 'twitter_url') {
    return v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
  if (field === 'job_title') return normalizeTitle(value);
  return v;
}

/**
 * Wave 6: this is now a thin shim over evaluateProposal(). The legacy
 * three-state return type is preserved for back-compat with existing
 * callers, mapped from the evaluator's four dispositions:
 *   apply (fill_empty)            → 'auto_applied'
 *   apply (silent_corroboration)  → 'skipped'   (no value change visible)
 *   queue                          → 'proposed'  (surfaced for human review)
 *   hold                           → 'skipped'   (stashed, not surfaced)
 *   reject                         → 'skipped'
 *
 * The pre-Wave-6 "auto-apply on high confidence" path is GONE — Wave 6
 * is corroboration-only. The `policy` parameter is now a no-op, kept
 * for back-compat to avoid touching every call site.
 */
export async function proposeEntityUpdate(
  orgId: string,
  entityType: 'contact' | 'company',
  entityId: string,
  field: string,
  proposedValue: string,
  source: SourceType,
  confidence: number,
  env: Env,
  opts?: {
    source_description?: string;
    source_communication_id?: string;
    /** @deprecated Wave 6: ignored. Corroboration is now the only
     *  quality signal — confidence-based auto-apply was retired. */
    policy?: UpdatePolicy;
    /** Channel attribution for the corroboration model. */
    context?: ChannelContext;
  }
): Promise<'auto_applied' | 'proposed' | 'skipped'> {
  const allowed = fieldsForEntity(entityType);
  if (!allowed.has(field)) return 'skipped';

  // Normalize before passing to the evaluator so two source paths
  // proposing the "same" value with different formatting (whitespace,
  // case for non-meaningful fields) collapse to one corroboration
  // bucket. The evaluator keys pending_proposals by exact string so
  // normalization MUST happen here, not inside the evaluator.
  const normalizedProposed = normalizeForComparison(field, proposedValue);

  const result = await evaluateProposal(
    {
      orgId,
      entityType,
      entityId,
      fieldName: field,
      proposedValue: normalizedProposed,
      source,
      context: opts?.context || {},
      confidence,
      sourceCommunicationId: opts?.source_communication_id || null,
      sourceVisibility: 'org_wide',
      sourceDescription: opts?.source_description || source,
    },
    env
  );

  // Update Vectorize index when the entity's actual value changed.
  if (result.disposition === 'apply' && result.applyMode === 'fill_empty') {
    try { await updateEntityInIndex(orgId, entityType, entityId, env); } catch {}
    return 'auto_applied';
  }
  if (result.disposition === 'queue') return 'proposed';
  return 'skipped';
}

export async function proposeMultipleUpdates(
  orgId: string,
  entityType: 'contact' | 'company',
  entityId: string,
  updates: FieldUpdate[],
  env: Env,
  opts?: { policy?: UpdatePolicy }
): Promise<{ auto_applied: string[]; proposed: string[]; skipped: string[] }> {
  const result = { auto_applied: [] as string[], proposed: [] as string[], skipped: [] as string[] };

  for (const u of updates) {
    const outcome = await proposeEntityUpdate(
      orgId, entityType, entityId, u.field, u.value, u.source as SourceType, u.confidence, env,
      {
        source_description: u.source_description,
        source_communication_id: u.source_communication_id,
        policy: opts?.policy,
        context: u.context,
      }
    );
    result[outcome].push(u.field);
  }

  return result;
}

/**
 * Records that a human edited these fields directly (PATCH endpoints
 * on contacts/companies/deals, OR queue approval). Wave 6: ALSO syncs
 * entity_field_state — the new value's source becomes the user's
 * manual_edit channel, pending_proposals is reset to empty (any
 * accumulated suggestions are stale now), and last_human_edit_at is
 * stamped to gate the 180-day human-edit lock.
 *
 * Caller must have already written the new field value(s) to the
 * entity table — this function reads the entity table to discover
 * what value to record as the new current_value.
 *
 * Continues to write entity_field_provenance for back-compat with any
 * read path that still queries it. Phase E or a follow-up commit may
 * collapse the two tables.
 */
export async function markFieldsHumanEdited(
  orgId: string,
  entityType: 'contact' | 'company' | 'deal',
  entityId: string,
  fields: string[],
  userId: string | null,
  env: Env
): Promise<void> {
  if (fields.length === 0) return;
  const now = new Date().toISOString();

  // Provenance table — legacy back-compat write.
  await env.D1.batch(
    fields.map(f =>
      env.D1.prepare(
        `INSERT INTO entity_field_provenance
           (org_id, entity_type, entity_id, field_name, last_human_edit_at, last_human_edit_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, entity_type, entity_id, field_name) DO UPDATE SET
           last_human_edit_at = excluded.last_human_edit_at,
           last_human_edit_user_id = excluded.last_human_edit_user_id`
      ).bind(orgId, entityType, entityId, f, now, userId)
    )
  );

  // entity_field_state — Wave 6 source of truth for corroboration math.
  // Per-field: read the (just-written) entity value, call recordApproval
  // which resets current_value_sources to [manual_edit_<userId>], clears
  // pending_proposals, and stamps last_human_edit_at.
  const table = tableForEntity(entityType);
  for (const field of fields) {
    if (!fieldsForEntity(entityType).has(field)) continue;
    try {
      const row = await env.D1.prepare(
        `SELECT ${field} as v FROM ${table} WHERE id = ?`
      ).bind(entityId).first<{ v: unknown }>();
      const currentValue =
        row?.v == null ? '' :
        typeof row.v === 'string' ? row.v :
        String(row.v);
      await recordApproval(
        {
          orgId,
          entityType,
          entityId,
          fieldName: field,
          approvedValue: currentValue,
          userId,
        },
        env
      );
    } catch (e) {
      console.error(
        `[progressive] markFieldsHumanEdited entity_field_state sync failed for ${entityType}/${entityId}.${field}:`,
        e
      );
    }
  }
}

const RE_ENRICH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export async function commitProgressiveApproval(
  item: any,
  env: Env
): Promise<{ reEnrich: boolean }> {
  let reEnrich = false;

  if (!item.field_name || !item.proposed_value) return { reEnrich };

  let parsedValue: string;
  try {
    const parsed = JSON.parse(item.proposed_value);
    if (typeof parsed === 'string') {
      parsedValue = parsed;
    } else if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
      parsedValue = String(parsed.value);
    } else {
      parsedValue = String(parsed);
    }
  } catch {
    parsedValue = item.proposed_value;
  }

  const table = tableForEntity(item.entity_type);
  const allowed = fieldsForEntity(item.entity_type);
  if (!allowed.has(item.field_name)) return { reEnrich };

  const oldValue = await getCurrentFieldValue(item.entity_type, item.entity_id, item.field_name, env);

  await env.D1.prepare(
    `UPDATE ${table} SET ${item.field_name} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(parsedValue, item.entity_id).run();

  // Clean up any other pending entries for this same field (stale duplicates)
  if (item.org_id) {
    await env.D1.prepare(
      `DELETE FROM approval_queue WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND field_name = ? AND status = 'pending' AND id != ?`
    ).bind(item.org_id, item.entity_type, item.entity_id, item.field_name, item.id).run();
  }

  if (item.entity_type === 'contact') {
    const shouldReEnrich =
      (item.field_name === 'full_name' && oldValue &&
        oldValue.trim().toLowerCase() !== parsedValue.trim().toLowerCase() &&
        parsedValue.trim().split(/\s+/).length > oldValue.trim().split(/\s+/).length) ||
      (item.field_name === 'linkedin_url' && !oldValue && parsedValue);

    if (shouldReEnrich) {
      const row = await env.D1.prepare(
        'SELECT enrichment_last_run FROM contacts WHERE id = ?'
      ).bind(item.entity_id).first<{ enrichment_last_run: string | null }>();

      const lastRun = row?.enrichment_last_run ? new Date(row.enrichment_last_run).getTime() : 0;
      if (Date.now() - lastRun > RE_ENRICH_COOLDOWN_MS) {
        reEnrich = true;
      } else {
        console.log(`[progressive] skipping re-enrich for ${item.entity_id}: last run ${Math.round((Date.now() - lastRun) / 60000)}m ago (cooldown: 60m)`);
      }
    }
  }

  return { reEnrich };
}
