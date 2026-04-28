// Typed API client — base URL is read from NEXT_PUBLIC_API_URL (see frontend/.env.local).
// All API routes on the Worker are mounted under /api, so we append that suffix here
// and keep call sites path-only (e.g. `/contacts`).
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;
if (!API_ORIGIN && typeof window !== 'undefined') {
  // Surface misconfiguration loudly in dev — the app is unusable without this var.
  // eslint-disable-next-line no-console
  console.error(
    '[api] NEXT_PUBLIC_API_URL is not set. Create frontend/.env.local with NEXT_PUBLIC_API_URL=http://localhost:8787 and restart `next dev`.'
  );
}
const API_BASE = `${API_ORIGIN ?? ''}/api`;

const TOKEN_KEY = 'auth_token';
const SESSION_EXPIRED_EVENT = 'auth:session-expired';

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const token = getAuthToken();

  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearAuthToken();
    throw new ApiError(401, 'Session expired', 'SESSION_EXPIRED');
  }

  if (res.status === 403) {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body);
      if (parsed.error === 'EMAIL_NOT_VERIFIED') {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('auth:email-not-verified'));
        }
        throw new ApiError(403, parsed.message || 'Email not verified', 'EMAIL_NOT_VERIFIED');
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
    throw new ApiError(403, body);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new ApiError(res.status, err);
  }
  return res.json();
}

export const api = {
  // Contacts
  listContacts: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ contacts: any[]; limit: number; offset: number; total: number }>(`/contacts${q}`);
  },
  getContact: (id: string) =>
    request<{ contact: any; tags: any[]; associations: any[] }>(`/contacts/${id}`),
  createContact: (data: any) =>
    request<{ contact: any }>('/contacts', { method: 'POST', body: JSON.stringify(data) }),
  updateContact: (id: string, data: any) =>
    request<{ contact: any }>(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteContact: (id: string) =>
    request<{ ok: boolean }>(`/contacts/${id}`, { method: 'DELETE' }),
  getContactTimeline: (id: string) =>
    request<{ entries: any[] }>(`/contacts/${id}/timeline`),
  getContactEnrichment: (id: string) =>
    request<{
      contact_id: string;
      short_bio: string | null;
      full_bio: string | null;
      enrichment_confidence: number | null;
      enrichment_last_run: string | null;
      status: string;
    }>(`/contacts/${id}/enrichment`),
  mergeContacts: (keep_id: string, discard_id: string) =>
    request<{ ok: boolean }>(`/contacts/merge`, {
      method: 'POST',
      body: JSON.stringify({ keep_id, discard_id }),
    }),

  // Companies
  listCompanies: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ companies: any[]; limit: number; offset: number; total: number }>(`/companies${q}`);
  },
  getCompany: (id: string) =>
    request<{ company: any; contacts: any[]; deals: any[]; tags: any[]; news_articles: any[] }>(`/companies/${id}`),
  createCompany: (data: any) =>
    request<{ company: any }>('/companies', { method: 'POST', body: JSON.stringify(data) }),
  updateCompany: (id: string, data: any) =>
    request<{ company: any }>(`/companies/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getCompanyNews: (id: string) => request<{
    company: any; articles: any[]; legacy_news: any[];
    news_relevance_score: number | null; last_summary: string | null;
  }>(`/companies/${id}/news`),
  deleteCompany: (id: string) =>
    request<{ ok: boolean }>(`/companies/${id}`, { method: 'DELETE' }),
  enrichCompany: (id: string) =>
    request<{ ok: boolean; message: string }>(`/companies/${id}/enrich`, { method: 'POST' }),
  getCompanyEnrichment: (id: string) =>
    request<{
      company_id: string;
      full_bio: string | null;
      enrichment_confidence: number | null;
      enrichment_last_run: string | null;
      status: string;
    }>(`/companies/${id}/enrichment`),
  enrichContact: (id: string) =>
    request<{ ok: boolean; message: string }>(`/contacts/${id}/enrich`, { method: 'POST' }),
  getContactAssociations: (id: string) =>
    request<{ associations: any[] }>(`/contacts/${id}/associations`),
  getCompanyAssociations: (id: string) =>
    request<{ associations: any[] }>(`/companies/${id}/associations`),

  // Deals
  listDeals: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ deals: any[] }>(`/deals${q}`);
  },
  createDeal: (data: any) =>
    request<{ deal: any }>('/deals', { method: 'POST', body: JSON.stringify(data) }),
  updateDeal: (id: string, data: any) =>
    request<{ deal: any }>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getDeal: (id: string) =>
    request<{ deal: any; contacts: { theirs: any[]; ours: any[]; other: any[] }; action_items: any[]; notes: any[]; company: any; users: any[] }>(`/deals/${id}`),
  deleteDeal: (id: string) =>
    request<{ ok: boolean }>(`/deals/${id}`, { method: 'DELETE' }),
  getDealTimeline: (id: string) =>
    request<{ entries: any[] }>(`/deals/${id}/timeline`),
  addDealContact: (dealId: string, data: { contact_id: string; role: string; side: string }) =>
    request<{ ok: boolean }>(`/deals/${dealId}/contacts`, { method: 'POST', body: JSON.stringify(data) }),
  removeDealContact: (dealId: string, contactId: string) =>
    request<{ ok: boolean }>(`/deals/${dealId}/contacts/${contactId}`, { method: 'DELETE' }),
  createDealActionItem: (dealId: string, data: { description: string; assignee_id: string | null; due_date: string | null }) =>
    request<{ action_item: any }>(`/deals/${dealId}/action-items`, { method: 'POST', body: JSON.stringify(data) }),
  updateDealActionItem: (dealId: string, itemId: string, data: any) =>
    request<{ action_item: any }>(`/deals/${dealId}/action-items/${itemId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDealActionItem: (dealId: string, itemId: string) =>
    request<{ ok: boolean }>(`/deals/${dealId}/action-items/${itemId}`, { method: 'DELETE' }),
  createDealNote: (dealId: string, data: { content: string }) =>
    request<{ note: any }>(`/deals/${dealId}/notes`, { method: 'POST', body: JSON.stringify(data) }),
  updateDealNote: (dealId: string, noteId: string, data: { content: string }) =>
    request<{ note: any }>(`/deals/${dealId}/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDealNote: (dealId: string, noteId: string) =>
    request<{ ok: boolean }>(`/deals/${dealId}/notes/${noteId}`, { method: 'DELETE' }),

  // Tags
  listTags: (entityType?: string) => {
    const q = entityType ? `?entity_type=${entityType}` : '';
    return request<{ tags: any[] }>(`/tags${q}`);
  },
  createTag: (data: { name: string; color?: string; entity_type?: string }) =>
    request<{ tag: any }>('/tags', { method: 'POST', body: JSON.stringify(data) }),
  applyContactTags: (contactId: string, tagIds: string[]) =>
    request<{ ok: boolean }>(`/contacts/${contactId}/tags`, {
      method: 'POST', body: JSON.stringify({ tag_ids: tagIds }),
    }),
  removeContactTag: (contactId: string, tagId: string) =>
    request<{ ok: boolean }>(`/contacts/${contactId}/tags/${tagId}`, { method: 'DELETE' }),
  applyCompanyTags: (companyId: string, tagIds: string[]) =>
    request<{ ok: boolean }>(`/companies/${companyId}/tags`, {
      method: 'POST', body: JSON.stringify({ tag_ids: tagIds }),
    }),
  removeCompanyTag: (companyId: string, tagId: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/tags/${tagId}`, { method: 'DELETE' }),
  updateTag: (id: string, data: { name?: string; color?: string }) =>
    request<{ tag: any }>(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTag: (id: string) =>
    request<{ ok: boolean }>(`/tags/${id}`, { method: 'DELETE' }),
  getContactFilterCounts: () =>
    request<{ contact_type: Record<string, number>; engagement_status: Record<string, number>; tags: Record<string, number>; overdue_followups: number }>('/contacts/filter-counts'),
  getCompanyFilterCounts: () =>
    request<{ tags: Record<string, number> }>('/companies/filter-counts'),

  // Tasks
  listTasks: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ tasks: any[] }>(`/tasks${q}`);
  },
  createTask: (data: any) =>
    request<{ task: any }>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: string, data: any) =>
    request<{ task: any }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Approval queue
  listApprovalQueue: (status = 'pending') =>
    request<{ entries: any[] }>(`/approval-queue?status=${status}`),
  listApprovalQueueGrouped: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ entities: any[] }>(`/approval-queue/grouped${q}`);
  },
  approveItem: (id: string) =>
    request<{ ok: boolean; re_enrich_triggered?: boolean }>(`/approval-queue/${id}/approve`, { method: 'POST' }),
  rejectItem: (id: string) =>
    request<{ ok: boolean }>(`/approval-queue/${id}/reject`, { method: 'POST' }),
  bulkApprove: (ids: string[]) =>
    request<{ resolved: string[]; conflicts: string[] }>('/approval-queue/bulk-approve', {
      method: 'POST', body: JSON.stringify({ ids }),
    }),
  approveAllForEntity: (entityType: string, entityId: string) =>
    request<{ ok: boolean; resolved_count: number }>('/approval-queue/approve-all', {
      method: 'POST', body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
    }),
  rejectAllForEntity: (entityType: string, entityId: string) =>
    request<{ ok: boolean; resolved_count: number }>('/approval-queue/reject-all', {
      method: 'POST', body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
    }),
  getContactPendingUpdates: (id: string) =>
    request<{ updates: any[] }>(`/contacts/${id}/pending-updates`),

  // Agent
  listSessions: () => request<{ sessions: any[] }>('/agent/sessions'),
  getSessionMessages: (id: string) =>
    request<{ session: any; messages: any[] }>(`/agent/sessions/${id}/messages`),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/agent/sessions/${id}`, { method: 'DELETE' }),
  renameSession: (id: string, title: string) =>
    request<{ ok: boolean }>(`/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),

  // Campaigns
  listCampaigns: () => request<{ campaigns: any[] }>('/campaigns'),
  getCampaign: (id: string) => request<{ campaign: any; recipients: any[] }>(`/campaigns/${id}`),
  createCampaign: (data: any) =>
    request<{ campaign: any }>('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
  sendCampaign: (id: string) =>
    request<{ ok: boolean }>(`/campaigns/${id}/send`, { method: 'POST' }),

  // Users
  listUsers: () => request<{ users: any[] }>('/admin/users').catch(() => ({ users: [] })),

  // Admin
  listDlq: (status = 'unresolved') =>
    request<{ entries: any[] }>(`/admin/dlq?status=${status}`),
  replayDlq: (id: string) =>
    request<{ ok: boolean }>(`/admin/dlq/${id}/replay`, { method: 'POST' }),
  getEnrichmentStatus: () =>
    request<{ status: Record<string, unknown> }>('/admin/enrichment-status'),
  getAdminIntegrationStatus: () =>
    request<{ users: any[]; tokenHealth: Record<string, any> }>('/me/integration-status'),
  getSystemStatus: () => request<{ mode: string; cache_stale: boolean }>('/system/status'),

  // Sync
  getSyncStatus: () => request<any>('/sync/status'),
  getSyncConfig: () => request<{ config: { sync_history_days: number } }>('/sync/config'),
  updateSyncConfig: (data: { sync_history_days: number }) =>
    request<{ ok: boolean }>('/sync/config', { method: 'PATCH', body: JSON.stringify(data) }),

  // Backfill
  startBackfill: (data: { user_id?: string; days_back?: number; start_date?: string; end_date?: string }) =>
    request<{ ok: boolean; progress: any }>('/admin/backfill-email', { method: 'POST', body: JSON.stringify(data) }),
  getBackfillProgress: () =>
    request<{ progress: any }>('/admin/backfill-progress'),
  triggerSync: (workflow: 'ingestion' | 'enrichment') =>
    request<{ ok: boolean; instance_id: string }>('/admin/trigger-sync', {
      method: 'POST', body: JSON.stringify({ workflow }),
    }),
  triggerIngestion: (data: { user_id?: string; start_date?: string; end_date?: string }) =>
    request<{ ok: boolean; instance_id: string; progress?: any }>('/admin/trigger-ingestion', {
      method: 'POST', body: JSON.stringify(data),
    }),

  // Integrations
  getIntegrationsStatus: () =>
    request<IntegrationsStatusResponse>('/integrations/status'),

  // Settings → System Status tab (distinct from getSystemStatus above which
  // hits /system/status for admin mode/cache info).
  getSettingsSystemStatus: () => request<SystemStatusResponse>('/settings/system-status'),
  getFireflyWebhookSecret: () =>
    request<{ secret: string }>('/integrations/firefly/webhook-secret'),
  fireflyBackfill: (apiKey: string, days?: number, opts?: { start_date?: string; end_date?: string }) =>
    request<FireflyBackfillResult>('/admin/firefly-backfill', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey, ...(opts?.start_date ? opts : { days: days ?? 30 }) }),
    }),

  // Documents
  listDocuments: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ documents: any[] }>(`/documents${q}`);
  },
  uploadDocument: (file: File, data: { title?: string; contact_id?: string; company_id?: string; deal_id?: string; document_type?: string }) => {
    const fd = new FormData();
    fd.append('file', file);
    if (data.title) fd.append('title', data.title);
    if (data.contact_id) fd.append('contact_id', data.contact_id);
    if (data.company_id) fd.append('company_id', data.company_id);
    if (data.deal_id) fd.append('deal_id', data.deal_id);
    if (data.document_type) fd.append('document_type', data.document_type);
    return request<{ document: any; duplicate?: boolean }>('/documents', { method: 'POST', body: fd });
  },
  deleteDocument: (id: string) =>
    request<{ ok: boolean }>(`/documents/${id}`, { method: 'DELETE' }),

  // Imports
  listImports: () => request<{ imports: any[] }>('/imports'),
  getImportJob: (id: string) => request<{ job: any }>(`/imports/${id}`),
  intelligentImport: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    // Always async — server returns { job_id, status: 'processing' } and the
    // import runs in waitUntil so the user can navigate away.
    return request<{ job_id: string; status: string; file_name: string; message: string }>(
      '/imports/intelligent', { method: 'POST', body: fd }
    );
  },
  undoImport: (jobId: string) =>
    request<{ ok: boolean; job_id: string; reverted: { document: number; contact: number; company: number; deal: number; vectors: number }; note: string }>(
      `/imports/${jobId}/undo`, { method: 'POST' }
    ),

  // Auth
  login: (email: string, password: string) =>
    request<{ token: string; user: { id: string; email: string; full_name: string; role: string; org_id: string } }>(
      '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }
    ),
  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),
  getMe: () =>
    request<{ user: UserProfile }>('/auth/me'),

  // Self-service profile
  updateMyProfile: (data: Partial<Pick<UserProfile, 'full_name' | 'phone' | 'job_title' | 'linkedin_url' | 'bio' | 'avatar_url'>>) =>
    request<{ user: UserProfile }>('/users/me', { method: 'PATCH', body: JSON.stringify(data) }),
  uploadMyAvatar: (file: File) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return request<{ ok: boolean; avatar_url: string }>('/users/me/avatar', { method: 'POST', body: fd });
  },
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean }>('/users/me/change-password', {
      method: 'POST', body: JSON.stringify({ current_password, new_password }),
    }),
  listMySessions: () =>
    request<{ sessions: Array<{ id: string; created_at: string; expires_at: string; current: boolean }> }>('/users/me/sessions'),
  revokeMySession: (id: string) =>
    request<{ ok: boolean }>(`/users/me/sessions/${id}`, { method: 'DELETE' }),
  revokeAllOtherSessions: () =>
    request<{ ok: boolean; revoked: number }>('/users/me/sessions/logout-all', { method: 'POST' }),

  // 2FA
  mfaStatus: () =>
    request<{ enabled: boolean; enrolled_at: string | null }>('/auth/mfa/status'),
  mfaEnrollStart: () =>
    request<{ secret: string; otpauth_url: string; recovery_codes: string[] }>('/auth/mfa/enroll/start', { method: 'POST' }),
  mfaEnrollConfirm: (code: string) =>
    request<{ ok: boolean }>('/auth/mfa/enroll/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaDisable: (code: string) =>
    request<{ ok: boolean }>('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
};

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  role: string;
  org_id: string;
  avatar_url: string | null;
  phone: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  bio: string | null;
  last_login_at: string | null;
  share_emails_org_wide: number | null;
  email_verified: number | null;
}

// Resolve avatar_url for display. The backend stores R2-backed avatars as `r2:<key>`
// — we route those through the authenticated /users/me/avatar?key=... endpoint so
// the browser sends the bearer token. External http(s) URLs pass through unchanged.
export function resolveAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith('r2:')) {
    const key = avatarUrl.slice(3);
    return `${API_BASE}/users/me/avatar?key=${encodeURIComponent(key)}`;
  }
  return avatarUrl;
}

// --- Integration status types (mirrors src/handlers/integrations.ts) ---

export type IntegrationStatus =
  | 'connected'
  | 'not_connected'
  | 'configured'
  | 'not_configured'
  | 'configured_no_channels'
  | 'auth_failed'
  | 'webhook_ready';

export interface IntegrationRow {
  status: IntegrationStatus;
  label: string;
  detail?: string;
  last_sync?: string | null;
  connected_email?: string | null;
  token_healthy?: boolean;
  webhook_url?: string;
  items_processed?: number;
  items_failed?: number;
  enriched_count?: number;
  rate_limit_status?: 'active' | 'rate_limited' | 'auth_failed';
  rate_limit_until?: string | null;
  // Slack-specific
  team_name?: string | null;
  bot_user_id?: string | null;
  channels_visible?: number;
  messages_synced?: number;
  warnings?: string[];
}

export interface IntegrationsStatusResponse {
  outlook: IntegrationRow;
  slack: IntegrationRow;
  reversecontact: IntegrationRow;
  firefly: IntegrationRow;
}

// --- Settings → System Status types (mirror src/handlers/system-status.ts) ---

export interface SystemStatusActiveTask {
  type: string;
  items_processed: number;
  started_at: string;
  elapsed_seconds: number;
}

export interface SystemStatusRunHistoryEntry {
  id: string;
  type: string;
  status: 'completed' | 'failed' | 'timed_out';
  items_processed: number;
  items_failed: number;
  started_at: string;
  duration_seconds: number;
  error_message: string | null;
}

export interface CompletenessMetric {
  current: number;
  total: number;
  percentage: number;
}

export interface SystemStatusResponse {
  active_tasks: SystemStatusActiveTask[];
  run_history: SystemStatusRunHistoryEntry[];
  completeness: {
    email_embedding: CompletenessMetric;
    email_linkage: CompletenessMetric;
    contact_enrichment: CompletenessMetric;
    contact_company: CompletenessMetric;
    contact_linkedin: CompletenessMetric;
    company_enrichment: CompletenessMetric;
    company_linkedin: CompletenessMetric;
    meeting_embedding: CompletenessMetric;
    meeting_attendees: CompletenessMetric;
    connected_users: CompletenessMetric & { names_missing: string[] };
  };
  generated_at: string;
}

export interface FireflyBackfillResult {
  total_found: number;
  ingested: number;
  skipped_duplicates: number;
  failed: number;
  errors: Array<{ transcript_id: string; title: string; error: string }>;
  partial?: boolean;
  partial_reason?: string;
}

export async function streamAgentQuery(
  query: string,
  sessionId: string | null,
  contextEntityType: string | null,
  contextEntityId: string | null,
  file: File | null,
  deepDive: boolean,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  onToolEvent?: (event: any) => void
): Promise<void> {
  const form = new FormData();
  form.append('query', query);
  if (sessionId) form.append('session_id', sessionId);
  if (contextEntityType) form.append('context_entity_type', contextEntityType);
  if (contextEntityId) form.append('context_entity_id', contextEntityId);
  if (file) form.append('file', file);
  if (deepDive) form.append('deep_dive', 'true');

  const token = getAuthToken();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/agent/query`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
    });
  } catch (e) {
    onError(`Network error: ${(e as Error).message || 'failed to connect'}`);
    return;
  }

  if (res.status === 401) {
    clearAuthToken();
    onError('Session expired');
    return;
  }

  if (!res.ok) {
    onError(`${res.status}: ${await res.text()}`);
    return;
  }
  if (!res.body) {
    onError('No response body');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedContent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') {
          onDone();
          return;
        }
        try {
          const evt = JSON.parse(json);
          if (evt.type === 'session') {
            onToolEvent?.({ type: 'session', session_id: evt.session_id });
          } else if (evt.text) {
            receivedContent = true;
            onToken(evt.text);
          }
          if (evt.type === 'tool_call' || evt.type === 'tool_result') {
            onToolEvent?.(evt);
          }
        } catch {
          // skip malformed SSE line
        }
      }
    }
  } catch (e) {
    onError(`Stream interrupted: ${(e as Error).message || 'connection lost'}`);
    return;
  }

  // Stream ended without [DONE] — premature close
  if (receivedContent) {
    onDone();
  } else {
    onError('Connection lost — no response received. The request may have timed out.');
  }
}
