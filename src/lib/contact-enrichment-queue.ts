import type { Env } from '../types/env';
import { enqueueWork } from './work-queue';

export const CONTACT_ENRICHMENT_DOMAIN = 'contact_enrichment';
export const CONTACT_ENRICHMENT_PAUSE_MS = 10 * 60 * 1000;

export function contactEnrichmentPauseKey(orgId: string): string {
  return `contact_enrichment:paused:${orgId}`;
}

interface ContactEnrichmentCandidate {
  id: string;
  enrichment_last_run: string | null;
  total_interactions: number | null;
}

export interface EnqueueContactEnrichmentOptions {
  limit?: number;
  targetBacklog?: number;
  contactIds?: string[];
}

export interface EnqueueContactEnrichmentResult {
  selected: number;
  inserted: number;
  existing: number;
  active_backlog: number;
}

function contactEnrichmentIdempotencyKey(
  orgId: string,
  contact: Pick<ContactEnrichmentCandidate, 'id' | 'enrichment_last_run'>
): string {
  return `${orgId}:contact_enrichment:${contact.id}:${contact.enrichment_last_run || 'never'}`;
}

function enqueuePriority(contact: ContactEnrichmentCandidate): number {
  const interactions = Number(contact.total_interactions || 0);
  return Math.max(0, Math.min(100, Math.round(interactions)));
}

export async function enqueueDueContactEnrichment(
  orgId: string,
  env: Env,
  opts: EnqueueContactEnrichmentOptions = {}
): Promise<EnqueueContactEnrichmentResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const targetBacklog = Math.max(limit, opts.targetBacklog ?? 60);

  const active = await env.D1.prepare(
    `SELECT COUNT(*) AS count
       FROM work_queue
      WHERE org_id = ?
        AND domain = ?
        AND status IN ('pending','in_progress')`
  ).bind(orgId, CONTACT_ENRICHMENT_DOMAIN).first<{ count: number }>();
  const activeBacklog = active?.count ?? 0;

  const pausedUntil = await env.KV.get(contactEnrichmentPauseKey(orgId));
  if (pausedUntil && Date.parse(pausedUntil) > Date.now()) {
    return { selected: 0, inserted: 0, existing: 0, active_backlog: activeBacklog };
  }

  const available = Math.max(0, Math.min(limit, targetBacklog - activeBacklog));
  if (available <= 0) {
    return { selected: 0, inserted: 0, existing: 0, active_backlog: activeBacklog };
  }

  let candidates: ContactEnrichmentCandidate[] = [];
  if (opts.contactIds && opts.contactIds.length > 0) {
    const ids = [...new Set(opts.contactIds.filter(Boolean))].slice(0, available);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = await env.D1.prepare(
        `SELECT id, enrichment_last_run, total_interactions
           FROM contacts
          WHERE org_id = ?
            AND id IN (${placeholders})
            AND deleted_at IS NULL
            AND merged_into IS NULL
            AND email IS NOT NULL AND email != ''
            AND LENGTH(full_name) >= 4`
      ).bind(orgId, ...ids).all<ContactEnrichmentCandidate>();
      candidates = rows.results;
    }
  } else {
    const rows = await env.D1.prepare(
      `SELECT c.id, c.enrichment_last_run, c.total_interactions
         FROM contacts c
        WHERE c.org_id = ?
          AND c.deleted_at IS NULL
          AND c.merged_into IS NULL
          AND c.email IS NOT NULL AND c.email != ''
          AND LENGTH(c.full_name) >= 4
          AND (
            c.enrichment_last_run IS NULL
            OR (
              c.enrichment_last_run < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
              AND c.total_interactions > 0
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM work_queue w
             WHERE w.org_id = c.org_id
               AND w.domain = ?
               AND w.status IN ('pending','in_progress','failed')
               AND w.idempotency_key = c.org_id || ':contact_enrichment:' || c.id || ':' || COALESCE(c.enrichment_last_run, 'never')
          )
        ORDER BY
          CASE WHEN c.enrichment_last_run IS NULL THEN 0 ELSE 1 END,
          c.total_interactions DESC,
          c.updated_at ASC
        LIMIT ?`
    ).bind(orgId, CONTACT_ENRICHMENT_DOMAIN, available).all<ContactEnrichmentCandidate>();
    candidates = rows.results;
  }

  let inserted = 0;
  let existing = 0;
  for (const contact of candidates) {
    const result = await enqueueWork(
      env,
      orgId,
      CONTACT_ENRICHMENT_DOMAIN,
      {
        contact_id: contact.id,
        selected_at: new Date().toISOString(),
        prior_enrichment_last_run: contact.enrichment_last_run,
      },
      {
        // Contact enrichment has multiple source paths now: ReverseContact,
        // Gemini, and fallback web/news search. Do not let a Gemini circuit
        // stop the whole contact lane before the handler can use non-Gemini
        // sources or its own source-specific backoff.
        upstream: null,
        idempotency_key: contactEnrichmentIdempotencyKey(orgId, contact),
        priority: enqueuePriority(contact),
        max_attempts: 4,
      }
    );
    if (result.inserted) inserted += 1;
    else existing += 1;
  }

  if (inserted > 0) {
    console.log(`[contact-enrichment] enqueued ${inserted}/${candidates.length} contact enrichment rows for org=${orgId}`);
  }

  return {
    selected: candidates.length,
    inserted,
    existing,
    active_backlog: activeBacklog + inserted,
  };
}
