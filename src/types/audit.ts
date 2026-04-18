export type AuditAction =
  | 'create' | 'update' | 'soft_delete' | 'hard_delete'
  | 'merge' | 'enrich'
  | 'tag_apply' | 'tag_remove' | 'tag_delete'
  | 'approve' | 'reject' | 'auto_approve'
  | 'campaign_send' | 'import' | 'login' | 'token_refresh_failed';

export type AuditEntityType =
  | 'contact' | 'company' | 'deal' | 'event' | 'conversation'
  | 'document' | 'task' | 'tag' | 'campaign' | 'user'
  | 'sync_job' | 'integration' | 'import_job';

export interface AuditEvent {
  org_id: string;
  user_id?: string;
  action: AuditAction;
  entity_type: AuditEntityType;
  entity_id?: string;
  before_data?: unknown;
  after_data?: unknown;
  metadata?: Record<string, unknown>;
  created_at: string;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  'create', 'update', 'soft_delete', 'hard_delete',
  'merge', 'enrich',
  'tag_apply', 'tag_remove', 'tag_delete',
  'approve', 'reject', 'auto_approve',
  'campaign_send', 'import', 'login', 'token_refresh_failed',
]);

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'contact', 'company', 'deal', 'event', 'conversation',
  'document', 'task', 'tag', 'campaign', 'user',
  'sync_job', 'integration', 'import_job',
]);

export function isValidAuditEvent(event: unknown): event is AuditEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  if (typeof e.org_id !== 'string') return false;
  if (typeof e.action !== 'string' || !VALID_ACTIONS.has(e.action)) return false;
  if (typeof e.entity_type !== 'string' || !VALID_ENTITY_TYPES.has(e.entity_type)) return false;
  if (typeof e.created_at !== 'string') return false;
  return true;
}
