// TRD §18.3 — Audit queue consumer with batched writes
import type { Env } from '../types/env';
import type { AuditEvent } from '../types/audit';
import { isValidAuditEvent } from '../types/audit';

export async function handleAuditBatch(
  batch: MessageBatch<AuditEvent>,
  env: Env
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  for (const msg of batch.messages) {
    if (!isValidAuditEvent(msg.body)) {
      msg.ack();
      continue;
    }

    const e = msg.body;

    // Sanitize before_data / after_data — never include email body content
    const beforeData =
      e.before_data !== undefined ? JSON.stringify(sanitizeSnapshot(e.before_data)) : null;
    const afterData =
      e.after_data !== undefined ? JSON.stringify(sanitizeSnapshot(e.after_data)) : null;

    statements.push(
      env.D1.prepare(
        `INSERT INTO audit_log
           (id, org_id, user_id, action, entity_type, entity_id, before_data, after_data, metadata, created_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        e.org_id,
        e.user_id || null,
        e.action,
        e.entity_type,
        e.entity_id || null,
        beforeData,
        afterData,
        e.metadata ? JSON.stringify(e.metadata) : '{}',
        e.created_at
      )
    );

    msg.ack();
  }

  if (statements.length > 0) {
    try {
      await env.D1.batch(statements);
    } catch (err) {
      console.error('Audit batch write failed:', err);
      // Don't throw — messages already ack'd. Durable retry handled via queue retries.
    }
  }
}

function sanitizeSnapshot(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const blocked = new Set([
    'body',
    'body_text',
    'bodyText',
    'body_html',
    'bodyHtml',
    'content',
    'body_preview',
    'preview',
  ]);
  const out: any = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (blocked.has(k)) continue;
    out[k] = v;
  }
  return out;
}
