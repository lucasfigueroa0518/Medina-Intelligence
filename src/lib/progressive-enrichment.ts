import type { Env } from '../types/env';
import { hashShort } from './helpers';
import { triggerContactEnrichment } from './enrichment';
import { emitAudit } from './audit';

interface FieldUpdate {
  field: string;
  value: string;
  source: string;
  confidence: number;
  source_description?: string;
  source_communication_id?: string;
}

export type SourceType =
  | 'email_signature' | 'meeting_transcript' | 'slack'
  | 'enrichment' | 'llm_extraction' | 'display_name'
  | 'web_enrichment_company' | 'news_article';

export type UpdatePolicy = 'always_queue' | 'auto_if_confident';

// Threshold above which `auto_if_confident` writes directly instead of queuing
// (provided no recent human edit on that field — see HUMAN_EDIT_LOCK_DAYS).
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;

// A field touched by a human inside this window is treated as "curated" — the
// auto-apply path always defers to the queue so a person can still see the
// proposed change. Older edits no longer block (people forget; new info wins
// after a quarter).
const HUMAN_EDIT_LOCK_DAYS = 30;

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

async function fieldRecentlyHumanEdited(
  orgId: string,
  entityType: string,
  entityId: string,
  field: string,
  env: Env
): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT last_human_edit_at FROM entity_field_provenance
       WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(orgId, entityType, entityId, field).first<{ last_human_edit_at: string | null }>().catch(() => null);

  if (!row?.last_human_edit_at) return false;
  const editedAt = new Date(row.last_human_edit_at).getTime();
  if (!Number.isFinite(editedAt)) return false;
  return Date.now() - editedAt < HUMAN_EDIT_LOCK_DAYS * 86400000;
}

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
    policy?: UpdatePolicy;
  }
): Promise<'auto_applied' | 'proposed' | 'skipped'> {
  const allowed = fieldsForEntity(entityType);
  if (!allowed.has(field)) return 'skipped';

  const policy: UpdatePolicy = opts?.policy ?? 'always_queue';

  const currentValue = await getCurrentFieldValue(entityType, entityId, field, env);
  const normalizedCurrent = currentValue ? normalizeForComparison(field, currentValue) : null;
  const normalizedProposed = normalizeForComparison(field, proposedValue);

  if (normalizedCurrent === normalizedProposed) return 'skipped';

  if (currentValue === null || currentValue.trim() === '') {
    const table = tableForEntity(entityType);
    await env.D1.prepare(
      `UPDATE ${table} SET ${field} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(proposedValue.trim(), entityId).run();

    // Clean up any stale pending entries for this field
    await env.D1.prepare(
      `DELETE FROM approval_queue WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND field_name = ? AND status = 'pending'`
    ).bind(orgId, entityType, entityId, field).run();

    console.log(`[progressive] auto-applied ${entityType}/${entityId} ${field} = "${proposedValue.slice(0, 60)}" (was NULL, source: ${source})`);
    return 'auto_applied';
  }

  if (
    policy === 'auto_if_confident' &&
    confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD &&
    !(await fieldRecentlyHumanEdited(orgId, entityType, entityId, field, env))
  ) {
    const table = tableForEntity(entityType);
    await env.D1.prepare(
      `UPDATE ${table} SET ${field} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(proposedValue.trim(), entityId).run();

    await env.D1.prepare(
      `DELETE FROM approval_queue WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND field_name = ? AND status = 'pending'`
    ).bind(orgId, entityType, entityId, field).run();

    await emitAudit(env, {
      org_id: orgId,
      action: 'enrich',
      entity_type: entityType,
      entity_id: entityId,
      metadata: {
        field, old_value: currentValue, new_value: proposedValue.trim(),
        source, confidence,
        reason: 'auto_apply_high_confidence',
      },
      created_at: new Date().toISOString(),
    });

    console.log(`[progressive] auto-applied ${entityType}/${entityId} ${field}: "${currentValue.slice(0, 30)}" → "${proposedValue.slice(0, 30)}" (high confidence ${confidence}, source: ${source})`);
    return 'auto_applied';
  }

  const metadataObj = {
    current_value: currentValue,
    source_type: source,
    source_description: opts?.source_description || source,
  };

  const proposedJson = JSON.stringify({ value: proposedValue.trim(), metadata: metadataObj });

  // Check for existing pending entry for same entity + field — update it instead of duplicating
  const existing = await env.D1.prepare(
    `SELECT id FROM approval_queue
     WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND field_name = ? AND status = 'pending'
     LIMIT 1`
  ).bind(orgId, entityType, entityId, field).first<{ id: string }>();

  if (existing) {
    await env.D1.prepare(
      `UPDATE approval_queue SET proposed_value = ?, confidence = ?, source_communication_id = ?,
              created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).bind(proposedJson, confidence, opts?.source_communication_id || null, existing.id).run();
  } else {
    const idempotencyKey = `${orgId}:prog:${entityId}:${field}:${hashShort(proposedValue)}`;
    await env.D1.prepare(
      `INSERT OR IGNORE INTO approval_queue
         (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
          proposed_value, source_communication_id, source_visibility, confidence, status)
       VALUES (?, ?, ?, ?, 'progressive_update', ?, ?, ?, 'org_wide', ?, 'pending')`
    ).bind(
      idempotencyKey, orgId, entityType, entityId, field,
      proposedJson, opts?.source_communication_id || null, confidence
    ).run();
  }

  console.log(`[progressive] proposed ${entityType}/${entityId} ${field}: "${currentValue?.slice(0, 30)}" → "${proposedValue.slice(0, 30)}" (source: ${source})`);
  return 'proposed';
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
      }
    );
    result[outcome].push(u.field);
  }

  return result;
}

// Records that a human (not enrichment, not the agent) edited these fields.
// Auto-apply enrichment will defer to the approval queue for HUMAN_EDIT_LOCK_DAYS
// after this stamp, so curated facts aren't silently overwritten.
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
