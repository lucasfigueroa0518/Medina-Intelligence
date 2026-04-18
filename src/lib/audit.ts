// TRD §18.3 — Audit queue producer
import type { Env } from '../types/env';
import type { AuditEvent } from '../types/audit';

export async function emitAudit(env: Env, event: AuditEvent): Promise<void> {
  try {
    await env.AUDIT_QUEUE.send(event);
  } catch (e) {
    console.error('Audit send failed:', e);
  }
}
