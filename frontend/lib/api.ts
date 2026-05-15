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

export type ChatUploadType = 'pdf' | 'image' | 'document' | 'spreadsheet' | 'presentation' | 'text' | 'data';

export interface ChatUploadSummary {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  upload_type: ChatUploadType;
  preview_text: string | null;
  saved_to_documents: boolean;
  saved_document_id: string | null;
  in_context: boolean;
  extraction_status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
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
    return request<{ contacts: any[]; limit: number; offset: number; total: number; has_more?: boolean }>(`/contacts${q}`);
  },
  listContactCompanies: () =>
    request<{ companies: { id: string; name: string; count: number }[] }>(`/contacts/companies`),
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
    return request<{ companies: any[]; limit: number; offset: number; total: number; has_more?: boolean }>(`/companies${q}`);
  },
  listCompanyCities: () =>
    request<{ cities: { name: string; count: number }[] }>(`/companies/cities`),
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

  // Deals — Day-5 Phase A: multi-value filter support. Pass a value
  // as `string` for single-value params (back-compat) or `string[]` to
  // emit ?key=v1&key=v2 (matches the backend's getAll('key') reads).
  listDeals: (params?: Record<string, string | string[]> | URLSearchParams) => {
    let q = '';
    if (params instanceof URLSearchParams) {
      const s = params.toString();
      q = s ? `?${s}` : '';
    } else if (params) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) for (const item of v) sp.append(k, item);
        else if (v !== undefined && v !== '') sp.append(k, v);
      }
      const s = sp.toString();
      q = s ? `?${s}` : '';
    }
    return request<{ deals: any[]; total?: number; limit?: number; offset?: number; has_more?: boolean }>(`/deals${q}`);
  },
  createDeal: (data: any) =>
    request<{ deal: any }>('/deals', { method: 'POST', body: JSON.stringify(data) }),
  updateDeal: (id: string, data: any) =>
    request<{ deal: any }>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // Day-5 Phase C: bulk update / bulk archive. Backend caps at 100 ids per
  // call. archive=true sets deleted_at=now (soft delete); otherwise the
  // updates object is field-whitelisted server-side (stage / owner_id /
  // instrument_type / lead_source / thesis_fit / expected_close /
  // actual_close_date / probability).
  bulkUpdateDeals: (data: { deal_ids: string[]; updates?: Record<string, unknown>; archive?: boolean }) =>
    request<{ ok: boolean; updated_count: number; skipped_ids: string[]; archived: boolean }>(
      '/deals/bulk-update',
      { method: 'POST', body: JSON.stringify(data) }
    ),
  bulkDecideDeals: async (data: { deal_ids: string[]; decision: 'yes' | 'no' | 'delete' }) => {
    const result = await request<{ ok: boolean; updated_count: number; skipped_ids: string[]; archived: boolean }>(
      '/deals/bulk-update',
      {
        method: 'POST',
        body: JSON.stringify(data.decision === 'yes'
          ? { deal_ids: data.deal_ids, updates: { stage: 'talking' } }
          : { deal_ids: data.deal_ids, archive: true }),
      }
    );
    return { ...result, decision: data.decision };
  },
  getDetectedDealCandidates: (params?: { limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request<DetectedDealCandidatesResponse>(`/deals/detected${qs ? `?${qs}` : ''}`);
  },
  promoteDetectedDealCandidate: (company_id: string) =>
    request<{ promoted: boolean; dealId: string | null; evidenceCount: number; reason: string; deal: any }>(
      '/deals/detected/promote',
      { method: 'POST', body: JSON.stringify({ company_id }) }
    ),
  getDealReplayStatus: () =>
    request<DealReplayStatusSnapshot>('/deals/replay/status'),
  getDealReplayEvidence: (params?: { limit?: number; offset?: number; company_id?: string }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set('limit', String(params.limit));
    if (params?.offset) search.set('offset', String(params.offset));
    if (params?.company_id) search.set('company_id', params.company_id);
    const qs = search.toString();
    return request<DealReplayEvidenceResponse>(`/deals/replay/evidence${qs ? `?${qs}` : ''}`);
  },
  startDealReplay: (data: { confirmation: string; days_back?: number }) =>
    request<{ run: DealReplayRunSnapshot; deleted_deals: number; enqueued_count: number }>(
      '/deals/replay/start',
      { method: 'POST', body: JSON.stringify(data) }
    ),
  cancelDealReplay: () =>
    request<{ cancelled: boolean; run: DealReplayRunSnapshot | null; cancelled_work: number }>(
      '/deals/replay/cancel',
      { method: 'POST' }
    ),
  getDeal: (id: string) =>
    request<{ deal: any; contacts: { theirs: any[]; ours: any[]; other: any[] }; action_items: any[]; notes: any[]; company: any; users: any[] }>(`/deals/${id}`),
  deleteDeal: (id: string) =>
    request<{ ok: boolean }>(`/deals/${id}`, { method: 'DELETE' }),
  getDealTimeline: (id: string) =>
    request<{ entries: any[] }>(`/deals/${id}/timeline`),
  // Day-5 deal_intelligence consumer wave: read endpoint produced by T3's
  // Wave 6+ evaluator (PR #15 schema, PR #16 + #17 compute + endpoint, live
  // on worker 82c62635). Per-(deal_id, user_id) composite-keyed; auth
  // header scopes to the requesting user. Returns is_stale=true when a row
  // is served from cache + background recompute queued via
  // ctxExec.waitUntil. See docs/deal-intelligence-contract.md for v1.0
  // contract; T3's example payload + smoke tests on issue #4.
  getDealIntelligence: (id: string) =>
    request<{
      deal_id: string;
      user_id: string;
      sentiment: 'positive' | 'neutral' | 'negative' | null;
      sentiment_score: number | null;
      topics: string[];
      risk_signals: Array<{
        type: string;
        severity: 'info' | 'warning' | 'critical';
        detail: string;
      }>;
      momentum: 'accelerating' | 'steady' | 'stalled' | 'declining' | null;
      momentum_score: number | null;
      conversation_count: number;
      brief_summary: string | null;
      computed_at: string;
      is_stale: boolean;
    }>(`/deals/${id}/intelligence`),
  // Day-5 Phase-2: thread-grouped, ACL-aware conversation surfacing.
  // Subject + metadata visible to anyone who can see the deal; body_preview
  // + sender_name/email nulled when canReadEmailContent returns false for
  // the requesting user. Mirrors getDealTimeline's redaction model.
  getDealConversations: (id: string, limit?: number) => {
    const q = typeof limit === 'number' ? `?limit=${limit}` : '';
    return request<{
      threads: Array<{
        external_thread_id: string | null;
        subject: string;
        last_sender_name: string | null;
        last_sent_at: string;
        message_count: number;
        can_read_any: boolean;
        participants: Array<{ contact_id: string | null; name: string | null; email: string | null }>;
        messages: Array<{
          id: string;
          external_message_id: string | null;
          source: string;
          sender_name: string | null;
          sender_email: string | null;
          sent_at: string;
          direction: string | null;
          can_read_body: boolean;
          body_preview: string | null;
          has_attachments: boolean;
        }>;
      }>;
      ungrouped_count: number;
      total_threads_seen: number;
      truncated: boolean;
    }>(`/deals/${id}/conversations${q}`);
  },
  getConversationThread: (id: string) =>
    request<ConversationThreadResponse>(`/conversations/${id}/thread`),
  addDealContact: (dealId: string, data: { contact_id: string; role: string; side: string }) =>
    request<{ ok: boolean }>(`/deals/${dealId}/contacts`, { method: 'POST', body: JSON.stringify(data) }),

  // Phase F — evidence trail. Returns conversation_deals + event_deals +
  // slack_channel_deals joined to source records, ACL-filtered, reverse-chron.
  getDealEvidence: (id: string) =>
    request<{
      deal_id: string;
      evidence: Array<
        | {
            type: 'conversation';
            id: string;
            conversation_id: string;
            subject: string | null;
            sent_at: string;
            from_email: string | null;
            from_name: string | null;
            body_preview: string | null;
            source: string;
            confidence: number;
            linked_at: string;
            created_by: string | null;
            created_by_name: string | null;
            can_read_body: boolean;
          }
        | {
            type: 'event';
            id: string;
            event_id: string;
            title: string;
            start_time: string;
            end_time: string | null;
            event_type: string | null;
            source: string;
            confidence: number;
            linked_at: string;
            created_by: string | null;
            created_by_name: string | null;
          }
        | {
            type: 'slack_channel';
            id: string;
            channel_id: string;
            channel_name: string | null;
            is_member: boolean;
            source: string;
            confidence: number;
            linked_at: string;
            created_by: string | null;
            created_by_name: string | null;
          }
      >;
      counts: { conversations: number; events: number; slack_channels: number; total: number };
    }>(`/deals/${id}/evidence`),

  getDealEvidenceCandidates: (dealId: string, opts: { q?: string; type?: 'conversation' | 'event' | 'slack_channel' | 'all'; limit?: number } = {}) => {
    const sp = new URLSearchParams();
    if (opts.q) sp.set('q', opts.q);
    if (opts.type) sp.set('type', opts.type);
    if (opts.limit) sp.set('limit', String(opts.limit));
    const qs = sp.toString() ? `?${sp.toString()}` : '';
    return request<{
      candidates: Array<
        | { type: 'conversation'; id: string; subject: string; sent_at: string; from_name: string | null; body_preview: string | null; can_read_body: boolean }
        | { type: 'event'; id: string; title: string; start_time: string; event_type: string | null }
        | { type: 'slack_channel'; id: string; channel_name: string | null; is_member: boolean }
      >;
    }>(`/deals/${dealId}/evidence/candidates${qs}`);
  },
  linkConversationToDealEvidence: (dealId: string, conversationId: string) =>
    request<{ inserted: boolean; source: 'manual' }>(
      `/deals/${dealId}/evidence/conversation`,
      { method: 'POST', body: JSON.stringify({ conversation_id: conversationId }) }
    ),
  unlinkConversationFromDealEvidence: (dealId: string, conversationId: string) =>
    request<{ removed: number }>(
      `/deals/${dealId}/evidence/conversation/${conversationId}`,
      { method: 'DELETE' }
    ),
  linkEventToDealEvidence: (dealId: string, eventId: string) =>
    request<{ inserted: boolean; source: 'manual' }>(
      `/deals/${dealId}/evidence/event`,
      { method: 'POST', body: JSON.stringify({ event_id: eventId }) }
    ),
  unlinkEventFromDealEvidence: (dealId: string, eventId: string) =>
    request<{ removed: number }>(
      `/deals/${dealId}/evidence/event/${eventId}`,
      { method: 'DELETE' }
    ),
  linkSlackChannelToDealEvidence: (dealId: string, channelId: string, backfill = true) =>
    request<{ inserted: boolean; has_channel: boolean; backfilled: number; source: 'manual' }>(
      `/deals/${dealId}/evidence/slack-channel`,
      { method: 'POST', body: JSON.stringify({ channel_id: channelId, backfill }) }
    ),
  unlinkSlackChannelFromDealEvidence: (dealId: string, channelId: string) =>
    request<{ removed: number }>(
      `/deals/${dealId}/evidence/slack-channel/${channelId}`,
      { method: 'DELETE' }
    ),
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
  dismissAllApprovals: () =>
    request<{ ok: boolean; resolved_count: number }>('/approval-queue/dismiss-all', {
      method: 'POST', body: JSON.stringify({}),
    }),
  // Wave 6 UX — held proposals (entity_field_state.pending_proposals)
  approveHeldProposal: (entityType: string, entityId: string, fieldName: string, value: string) =>
    request<{ ok: boolean }>('/approval-queue/held/approve', {
      method: 'POST',
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId, field_name: fieldName, value }),
    }),
  dismissHeldProposal: (entityType: string, entityId: string, fieldName: string, value: string) =>
    request<{ ok: boolean }>('/approval-queue/held/dismiss', {
      method: 'POST',
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId, field_name: fieldName, value }),
    }),
  // Wave 6 UX — per-field permanent lock
  listFieldLocks: (entityType: string, entityId: string) =>
    request<{ fields: Array<{ field_name: string; permanently_locked: boolean; last_human_edit_at: string | null }> }>(
      `/field-locks?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`
    ),
  toggleFieldLock: (entityType: string, entityId: string, fieldName: string, locked: boolean) =>
    request<{ ok: boolean; field_name: string; locked: boolean }>('/field-locks', {
      method: 'POST',
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId, field_name: fieldName, locked }),
    }),
  // Q11 — held DELETION (clear-this-field) approve/dismiss. Backend
  // overload of the same endpoints with is_deletion=true.
  approveHeldDeletion: (entityType: string, entityId: string, fieldName: string) =>
    request<{ ok: boolean; deletion: true }>('/approval-queue/held/approve', {
      method: 'POST',
      body: JSON.stringify({
        entity_type: entityType, entity_id: entityId, field_name: fieldName,
        is_deletion: true,
      }),
    }),
  dismissHeldDeletion: (entityType: string, entityId: string, fieldName: string) =>
    request<{ ok: boolean; deletion: true }>('/approval-queue/held/dismiss', {
      method: 'POST',
      body: JSON.stringify({
        entity_type: entityType, entity_id: entityId, field_name: fieldName,
        is_deletion: true,
      }),
    }),
  // Q12 — synthetic observations (separate table, not approval_queue).
  listEntityObservations: (entityType: string, entityId: string) =>
    request<{
      observations: Array<{
        id: string;
        observation_type: string;
        observation_value: string;
        channels: string[];
        confidence: number;
        evidence: string | null;
        source_communication_id: string | null;
        first_observed_at: string;
        last_observed_at: string;
      }>;
    }>(`/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/observations`),
  dismissObservation: (observationId: string) =>
    request<{ ok: boolean }>(`/observations/${encodeURIComponent(observationId)}/dismiss`, {
      method: 'POST',
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
  cancelAgentQuery: (request_id: string) =>
    request<{ ok: boolean; local: boolean }>('/agent/cancel', {
      method: 'POST',
      body: JSON.stringify({ request_id }),
    }).catch(() => ({ ok: false, local: false })),
  logCitationClick: (payload: {
    message_id?: string;
    source_id: number;
    source_type?: string;
    source_table?: string;
    source_row_id?: string;
  }) =>
    request<{ ok: boolean }>(`/agent/citation-click`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }).catch(() => ({ ok: false })),
  uploadChatFiles: async (
    files: File[],
    opts?: { sessionId?: string | null; saveToDocuments?: boolean }
  ) => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    if (opts?.sessionId) form.append('session_id', opts.sessionId);
    if (opts?.saveToDocuments) form.append('save_to_documents', 'true');
    const token = getAuthToken();
    const res = await fetch(`${API_BASE}/agent/upload-file`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    const text = await res.text();
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { /* leave empty */ }
    if (!res.ok) {
      const message = parsed?.message || parsed?.error || text || 'Upload failed';
      throw new ApiError(res.status, message);
    }
    return parsed as { uploads: ChatUploadSummary[] };
  },

  // Wave 5 Phase H — Send a permanent document into a MARTy chat as an
  // ephemeral attachment. Backend materializes a chat_uploads row from
  // the documents row (R2 bytes copied; 7-day TTL) and returns the
  // upload_id + session_id (created if not provided) for navigation.
  attachDocumentToChat: async (
    documentId: string,
    opts?: { sessionId?: string | null }
  ) => {
    return request<{ upload_id: string; session_id: string; summary: ChatUploadSummary }>(
      `/agent/attach-document`,
      {
        method: 'POST',
        body: JSON.stringify({
          document_id: documentId,
          session_id: opts?.sessionId || undefined,
        }),
      }
    );
  },
  listSessionUploads: (sessionId: string) =>
    request<{ uploads: ChatUploadSummary[] }>(`/agent/sessions/${sessionId}/uploads`),
  uploadContentUrl: (uploadId: string) => `${API_BASE}/agent/uploads/${uploadId}/content`,

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

  // Progressive backfill (server-side, multi-window, cron-driven)
  startProgressiveBackfill: (data: { user_id?: string; days_back?: 30 | 60 | 90 | 180; start_date?: string; end_date?: string }) =>
    request<{
      ok: boolean;
      parent_id: string;
      mode: 'days_back' | 'date_range';
      days_back?: number;
      start_date?: string;
      end_date?: string;
      window_size_days: number;
      total_windows: number;
    }>('/backfill/start', { method: 'POST', body: JSON.stringify(data) }),
  getProgressiveBackfillProgress: (userId?: string) =>
    request<{
      ok: boolean;
      parent: null | {
        id: string;
        org_id: string;
        user_id: string;
        window_size_days: number;
        total_windows: number;
        status: 'active' | 'completed' | 'cancelled';
        created_at: string;
        updated_at: string;
        completed_at: string | null;
      };
      windows: Array<{
        id: string;
        window_index: number;
        start_date: string;
        end_date: string;
        status: 'pending' | 'in_progress' | 'completed' | 'failed';
        emails_fetched: number;
        conversations_added: number;
        embedded_count: number;
        attachments_processed: number;
        attachments_persisted: number;
        attachments_failed: number;
        attachments_skipped: number;
        started_at: string | null;
        completed_at: string | null;
        last_error: string | null;
      }>;
      summary: null | {
        windows_completed: number;
        windows_total: number;
        windows_in_progress_index: number | null;
        emails_total: number;
        conversations_added: number;
        embedded_total: number;
        attachments_processed: number;
        attachments_persisted: number;
        attachments_failed: number;
        attachments_skipped: number;
        avg_window_seconds: number | null;
        eta_seconds: number | null;
        elapsed_seconds: number;
      };
    }>(`/backfill/progress${userId ? `?user_id=${encodeURIComponent(userId)}` : ''}`),
  cancelProgressiveBackfill: (userId?: string) =>
    request<{ ok: boolean; result: 'cancelled' | 'not_found'; user_id: string }>(
      '/backfill/cancel',
      { method: 'POST', body: JSON.stringify(userId ? { user_id: userId } : {}) }
    ),
  listProgressiveEligibleUsers: () =>
    request<{
      ok: boolean;
      users: Array<{ id: string; email: string; full_name: string | null; role: string }>;
    }>('/backfill/eligible-users'),

  // Progressive Firefly backfill (Phase F + Phase 4, self-service).
  //
  // Phase 4 (2026-05-04): fireflies_api_key is now OPTIONAL. When omitted,
  // the driver resolves the user's persistent credential row from
  // user_firefly_credentials (set via the /api/settings/firefly-credentials
  // endpoints below). If a key IS supplied, it dual-writes — legacy per-job
  // path AND persistent storage — for transition safety on in-flight jobs.
  // Members may start/view/cancel their own import. Owners may inspect and
  // start/cancel for org members, but the target user's stored credential is
  // always the credential used by the backend driver.
  //
  // days_back ∈ {30,60,90}. The 180-day option was dropped in Phase 4 sub-
  // stage 1c (MAX_BACKFILL_DAYS lowered to 120 in src/lib/firefly-progressive
  // -backfill.ts; 180 would now be rejected at the backend).
  startFireflyProgressiveBackfill: (data: {
    user_id?: string;
    fireflies_api_key?: string;
    days_back?: 30 | 60 | 90;
    start_date?: string;
    end_date?: string;
    window_size_days?: number;
  }) =>
    request<{
      ok: boolean;
      parent_id: string;
      mode: 'days_back' | 'date_range';
      days_back?: number;
      start_date?: string;
      end_date?: string;
      window_size_days: number;
      total_windows: number;
    }>('/admin/firefly-progressive-backfill', { method: 'POST', body: JSON.stringify(data) }),
  getFireflyProgressiveBackfillProgress: (userId?: string) =>
    request<{
      ok: boolean;
      parent: null | {
        id: string;
        org_id: string;
        user_id: string;
        api_key_encrypted: string;          // wire payload: '<redacted>' or ''
        window_size_days: number;
        total_windows: number;
        status: 'active' | 'completed' | 'cancelled';
        created_at: string;
        updated_at: string;
        completed_at: string | null;
      };
      credential_status?: {
        exists: boolean;
        user_id: string;
        created_at: string | null;
        updated_at: string | null;
        last_used_at: string | null;
        rotation_count: number;
      };
      windows: Array<{
        id: string;
        window_index: number;
        start_date: string;
        end_date: string;
        status: 'pending' | 'in_progress' | 'completed' | 'failed';
        last_skip: number;
        transcripts_fetched: number;
        transcripts_persisted: number;
        transcripts_skipped_duplicate: number;
        transcripts_failed: number;
        started_at: string | null;
        completed_at: string | null;
        last_error: string | null;
      }>;
    }>(
      userId
        ? `/admin/firefly-progressive-backfill?user_id=${encodeURIComponent(userId)}`
        : `/admin/firefly-progressive-backfill`
    ),
  cancelFireflyProgressiveBackfill: (userId?: string) =>
    request<{ ok: boolean; result: 'cancelled' | 'not_found'; user_id: string }>(
      '/admin/firefly-progressive-backfill/cancel',
      { method: 'POST', body: JSON.stringify(userId ? { user_id: userId } : {}) }
    ),

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
  getMartyLabStatus: () => request<MartyLabStatusSnapshot>('/admin/marty-lab'),
  getMartyLabReadiness: () => request<MartyLabReadinessSnapshot>('/admin/marty-lab/readiness'),
  repairMartyLabReadiness: (data?: { action?: 'clear_orphaned_lab_queue' }) =>
    request<MartyLabStatusSnapshot>('/admin/marty-lab/repair-readiness', {
      method: 'POST',
      body: JSON.stringify(data || { action: 'clear_orphaned_lab_queue' }),
    }),
  startMartyLabRun: (data?: {
    suite_name?: string;
    baseline_label?: string;
    candidate_label?: string;
    mode?: MartyLabRunMode;
    round_count?: number;
    focus_prompt?: string;
    queue_if_blocked?: boolean;
  }) =>
    request<MartyLabStatusSnapshot>('/admin/marty-lab/runs', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),
  getMartyLabRun: (runId: string) =>
    request<MartyLabStatusSnapshot>(`/admin/marty-lab/runs/${encodeURIComponent(runId)}`),
  cancelMartyLabRun: (runId: string) =>
    request<MartyLabStatusSnapshot>(`/admin/marty-lab/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
  decideMartyLabRun: (runId: string, decision: 'ship' | 'reject') =>
    request<MartyLabStatusSnapshot>(`/admin/marty-lab/runs/${encodeURIComponent(runId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),
  reviewMartyLabRound: (runId: string, decision: 'approve_continue' | 'reject_continue') =>
    request<MartyLabStatusSnapshot>(`/admin/marty-lab/runs/${encodeURIComponent(runId)}/round-review`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),
  startMartyLabCodePatch: (
    runId: string,
    deepWorkItemId: string,
    data?: { focus_prompt?: string }
  ) =>
    request<MartyLabStatusSnapshot>(
      `/admin/marty-lab/runs/${encodeURIComponent(runId)}/deep-work/${encodeURIComponent(deepWorkItemId)}/code-patch`,
      {
        method: 'POST',
        body: JSON.stringify(data || {}),
      }
    ),
  recordMartyLabExperimentResult: (
    runId: string,
    experimentId: string,
    data: Record<string, unknown>
  ) =>
    request<MartyLabStatusSnapshot>(
      `/admin/marty-lab/runs/${encodeURIComponent(runId)}/experiments/${encodeURIComponent(experimentId)}/result`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),
  getFireflyWebhookSecret: () =>
    request<{ secret: string }>('/integrations/firefly/webhook-secret'),

  // Phase 4 (2026-05-04): persistent per-user Firefly API key endpoints.
  // All three are auth-gated to the caller's own user_id. Plaintext is
  // ONLY accepted on POST and is NEVER returned by any of these calls.
  getMyFireflyCredential: () =>
    request<{
      status: {
        exists: boolean;
        user_id: string;
        created_at: string | null;
        updated_at: string | null;
        last_used_at: string | null;
        rotation_count: number;
      };
    }>('/settings/firefly-credentials'),
  storeMyFireflyCredential: (api_key: string) =>
    request<{
      stored: 'created' | 'rotated';
      status: {
        exists: boolean;
        user_id: string;
        created_at: string | null;
        updated_at: string | null;
        last_used_at: string | null;
        rotation_count: number;
      };
    }>('/settings/firefly-credentials', {
      method: 'POST',
      body: JSON.stringify({ api_key }),
    }),
  revokeMyFireflyCredential: () =>
    request<{ revoked: boolean }>('/settings/firefly-credentials', {
      method: 'DELETE',
    }),

  // Documents
  listDocuments: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{
      documents: any[];
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    }>(`/documents${q}`);
  },
  getDocument: (id: string) =>
    request<{ document: any; downloadUrl: string }>(`/documents/${id}`),
  getDocumentFilterCounts: () =>
    request<{
      source: Record<string, number>;
      document_type: Record<string, number>;
      date_bucket: { last_7d: number; last_30d: number; older: number };
      mine: number;
    }>('/documents/filter-counts'),
  uploadDocument: (
    file: File,
    data: {
      title?: string;
      contact_id?: string;
      company_id?: string;
      deal_id?: string;
      document_type?: string;
      visibility?: 'private' | 'org_wide' | 'public' | 'confidential';
      participants?: string[];
    }
  ) => {
    const fd = new FormData();
    fd.append('file', file);
    if (data.title) fd.append('title', data.title);
    if (data.contact_id) fd.append('contact_id', data.contact_id);
    if (data.company_id) fd.append('company_id', data.company_id);
    if (data.deal_id) fd.append('deal_id', data.deal_id);
    if (data.document_type) fd.append('document_type', data.document_type);
    if (data.visibility) fd.append('visibility', data.visibility);
    if (data.participants && data.participants.length > 0) fd.append('participants', JSON.stringify(data.participants));
    return request<{ document: any; duplicate?: boolean }>('/documents', { method: 'POST', body: fd });
  },
  deleteDocument: (id: string) =>
    request<{ ok: boolean }>(`/documents/${id}`, { method: 'DELETE' }),

  // Imports
  listImports: () => request<{ imports: any[] }>('/imports'),
  getImportJob: (id: string) => request<{ job: any; report?: any }>(`/imports/${id}`),
  intelligentImport: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    // Always async — server returns { job_id, status: 'processing' } and the
    // import runs through the durable work queue so the user can navigate away.
    return request<{ job_id: string; status: string; file_name: string; message: string }>(
      '/imports/intelligent', { method: 'POST', body: fd }
    );
  },
  undoImport: (jobId: string) =>
    request<{ ok: boolean; job_id: string; reverted: { document: number; contact: number; company: number; deal: number; vectors: number }; note: string }>(
      `/imports/${jobId}/undo`, { method: 'POST' }
    ),
  hideImport: (jobId: string) =>
    request<{ ok: boolean; job_id: string; hidden_at: string }>(
      `/imports/${jobId}/hide`, { method: 'POST' }
    ),
  deleteImportHistory: (jobId: string) =>
    request<{ ok: boolean; job_id: string; deleted_at: string; note: string }>(
      `/imports/${jobId}`, { method: 'DELETE' }
    ),

  // Auth
  login: (email: string, password: string) =>
    request<{ token: string; user: { id: string; email: string; full_name: string; role: string; org_id: string } }>(
      '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }
    ),
  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),
  getMe: () =>
    request<{ user: UserProfile; warnings?: UserWarning[] }>('/auth/me'),

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

export interface UserWarning {
  type: string;
  message: string;
  consecutive_failures?: number;
  last_successful_sync?: string | null;
  missed_days?: number;
  suggest_backfill_days?: 30;
  backfill_prompt?: string;
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

export interface ConversationThreadMessage {
  id: string;
  source: string;
  external_message_id: string | null;
  subject: string | null;
  sent_at: string | null;
  direction: string | null;
  from_name: string | null;
  from_email: string | null;
  body_preview: string | null;
  body: string | null;
  has_attachments: boolean;
}

export interface ConversationThreadResponse {
  thread: {
    anchor_id: string;
    external_thread_id: string | null;
    subject: string;
    source: string;
    message_count: number;
    last_sent_at: string | null;
    messages: ConversationThreadMessage[];
  };
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

// Phase 5 1c (2026-05-05): work_queue surface.
export interface WorkQueueInventoryEntry {
  domain: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'dead_letter';
  count: number;
}
export interface StuckWorkQueueEntry {
  id: string;
  org_id: string;
  domain: string;
  started_at: string | null;
  heartbeat_at: string | null;
  silent_for_minutes: number;
}

export interface BudgetSnapshotRow {
  org_id: string;
  user_id: string;
  upstream: string;
  bucket_window: string;
  used: number;
  cap: number;
  reset_at: string | null;
  circuit_open: boolean;
  circuit_open_until: string | null;
  consecutive_429s: number;
  consecutive_successes: number;
  cap_lowered_at: string | null;
  last_429_at: string | null;
}

export type MartyLabRunStatus = 'queued' | 'configured' | 'running' | 'completed' | 'cancelled' | 'failed';
export type MartyLabExperimentStatus = 'queued' | 'running' | 'graded' | 'blocked' | 'failed' | 'cancelled';
export type MartyLabUpgradeStatus = 'hypothesis' | 'sandbox_applied' | 'validated' | 'rejected';
export type MartyLabExperimentPriority =
  | 'context_retrieval'
  | 'document_artifact'
  | 'privacy'
  | 'timeline'
  | 'deal_intelligence'
  | 'conversation_quality'
  | 'drafting';
export type MartyLabVersionStatus = 'accepted' | 'candidate' | 'rejected' | 'archived';
export type MartyLabUpgradeTrialStatus = 'pending' | 'accepted' | 'rejected' | 'inconclusive';

export interface MartyLabPersona {
  name: string;
  role: string;
  permissions: string;
}

export interface MartyLabRubricDimension {
  key: string;
  label: string;
  weight: number;
  success_criteria: string;
}

export interface MartyLabRubric {
  version: string;
  goal: string;
  dimensions: MartyLabRubricDimension[];
  automatic_failures: string[];
}

export interface MartyLabRunSnapshot {
  id: string;
  status: MartyLabRunStatus;
  suite_name: string;
  baseline_label: string;
  candidate_label: string;
  baseline_version_id: string | null;
  candidate_version_id: string | null;
  upgrade_title: string | null;
  upgrade_variable: Record<string, unknown>;
  bootcamp_phase: string;
  total_experiments: number;
  completed_experiments: number;
  privacy_failures: number;
  average_baseline_score: number | null;
  average_candidate_score: number | null;
  winning_candidate_count: number;
  recent_events: Array<{ at: string; message: string; experiment_id?: string }>;
  summary: Record<string, unknown>;
  completed_at: string | null;
  cancelled_at: string | null;
  discarded_at: string | null;
  discard_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MartyLabExperimentSnapshot {
  id: string;
  run_id: string;
  status: MartyLabExperimentStatus;
  persona: MartyLabPersona;
  goal: string;
  starting_prompt: string;
  priority: MartyLabExperimentPriority;
  replicate_group: string | null;
  variable_under_test: string | null;
  followup_policy: Record<string, unknown>;
  rubric: MartyLabRubric;
  baseline_transcript: Array<Record<string, unknown>>;
  candidate_transcript: Array<Record<string, unknown>>;
  tool_trace: Record<string, unknown> | null;
  sources: Record<string, unknown> | null;
  friction: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  baseline_score: number | null;
  candidate_score: number | null;
  recommendation: string | null;
  privacy_failure: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MartyLabUpgradeCandidateSnapshot {
  id: string;
  status: MartyLabUpgradeStatus;
  title: string;
  hypothesis: string;
  change_summary: string | null;
  expected_benefit: string | null;
  evidence: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MartyLabVersionSnapshot {
  id: string;
  org_id: string;
  status: MartyLabVersionStatus;
  label: string;
  generation: number;
  parent_version_id: string | null;
  prompt_addendum: string;
  applied_upgrades: string[];
  evidence: Record<string, unknown>;
  source_run_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MartyLabUpgradeTrialSnapshot {
  id: string;
  org_id: string;
  run_id: string;
  status: MartyLabUpgradeTrialStatus;
  baseline_version_id: string | null;
  candidate_version_id: string | null;
  upgrade_key: string;
  title: string;
  sample_size: number;
  valid_sample_size: number;
  average_delta: number | null;
  target_average_delta: number | null;
  wins: number;
  losses: number;
  ties: number;
  privacy_failures: number;
  severe_regressions: number;
  conclusion: string | null;
  evidence: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MartyLabDeepWorkItemSnapshot {
  id: string;
  org_id: string;
  run_id: string;
  status: 'open' | 'closed';
  cluster_key: string;
  title: string;
  priority: MartyLabExperimentPriority;
  failure_type: string;
  lever_ids: string[];
  evidence: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type MartyLabCodePatchStatus =
  | 'queued'
  | 'planning'
  | 'ready_for_agent'
  | 'in_agent_worktree'
  | 'ready_for_review'
  | 'validated'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export interface MartyLabCodePatchJobSnapshot {
  id: string;
  org_id: string;
  run_id: string;
  deep_work_item_id: string | null;
  status: MartyLabCodePatchStatus;
  title: string;
  priority: MartyLabExperimentPriority;
  failure_type: string;
  model: string;
  branch_name: string;
  worktree_path: string;
  patch_scope: Record<string, unknown>;
  validation_plan: Record<string, unknown>;
  evidence: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type MartyLabRunMode = 'bootcamp' | 'canary';
export type MartyLabReadinessStatus = 'pass' | 'warn' | 'block';

export interface MartyLabReadinessCheck {
  key: string;
  label: string;
  status: MartyLabReadinessStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface MartyLabReadinessSnapshot {
  ok: boolean;
  harness_version: string;
  generated_at: string;
  blockers: string[];
  warnings: string[];
  checks: MartyLabReadinessCheck[];
}

export interface MartyLabStatusSnapshot {
  run: MartyLabRunSnapshot | null;
  recent_runs: MartyLabRunSnapshot[];
  queued_runs: MartyLabRunSnapshot[];
  experiments: MartyLabExperimentSnapshot[];
  upgrade_candidates: MartyLabUpgradeCandidateSnapshot[];
  versions: MartyLabVersionSnapshot[];
  upgrade_trials: MartyLabUpgradeTrialSnapshot[];
  deep_work_items: MartyLabDeepWorkItemSnapshot[];
  code_patch_jobs: MartyLabCodePatchJobSnapshot[];
  readiness: MartyLabReadinessSnapshot;
  generated_at: string;
}

export type DealReplayStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface DealReplayRunSnapshot {
  id: string;
  org_id: string;
  status: DealReplayStatus;
  days_back: number;
  cutoff_at: string;
  reset_mode: 'hard_delete';
  started_by: string | null;
  enqueued_count: number;
  scanned_count: number;
  processed_count: number;
  skipped_count: number;
  evidence_recorded_count: number;
  promoted_count: number;
  rate_limited_count: number;
  error_count: number;
  skip_reasons: Record<string, number>;
  promoted_companies: Array<{ deal_id: string | null; company_name: string; at: string }>;
  recent_evidence: Array<{
    company_name: string;
    source_type: string;
    source_title: string | null;
    evidence: string | null;
    confidence: number | null;
    at: string;
  }>;
  recent_errors: Array<{ source_type?: string; source_id?: string; error: string; at: string }>;
  last_event: string | null;
  started_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  elapsed_seconds: number;
  pace_per_minute: number;
}

export interface DealReplayStatusSnapshot {
  run: DealReplayRunSnapshot | null;
  queue: {
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
    dead_letter: number;
  };
  generated_at: string;
}

export interface DealReplayEvidenceRow {
  id: string;
  company_id: string;
  company_name: string | null;
  deal_id: string | null;
  source_type: 'conversation' | 'event' | 'document';
  source_id: string;
  source_title: string | null;
  source_excerpt: string | null;
  source_date: string | null;
  signal_kind: string | null;
  funding_stage: string | null;
  amount_usd: number | null;
  confidence: number;
  evidence_note: string | null;
  created_at: string;
  promoted_at: string | null;
}

export interface DealReplayEvidenceResponse {
  evidence: DealReplayEvidenceRow[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface DetectedDealCandidate {
  company_id: string;
  company_name: string;
  evidence_count: number;
  source_family_count: number;
  source_families: Array<'conversation' | 'event' | 'document' | string>;
  avg_confidence: number;
  max_confidence: number;
  amount_usd: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  latest_evidence: DealReplayEvidenceRow | null;
  evidence: DealReplayEvidenceRow[];
}

export interface DetectedDealCandidatesResponse {
  candidates: DetectedDealCandidate[];
  min_evidence: number;
  min_confidence: number;
  auto_promote_evidence: number;
}

export interface SystemStatusResponse {
  active_tasks: SystemStatusActiveTask[];
  run_history: SystemStatusRunHistoryEntry[];
  completeness: {
    email_embedding: CompletenessMetric;
    email_linkage: CompletenessMetric;
    document_embedding: CompletenessMetric;
    contact_enrichment: CompletenessMetric;
    contact_company: CompletenessMetric;
    contact_linkedin: CompletenessMetric;
    company_enrichment: CompletenessMetric;
    company_linkedin: CompletenessMetric;
    meeting_embedding: CompletenessMetric;
    meeting_attendees: CompletenessMetric;
    connected_users: CompletenessMetric & { names_missing: string[] };
  };
  // Phase 5 1c — universal work_queue surface. Empty until domain pilots
  // (5.1+) plug in. Backend always returns these fields; frontend renders
  // an empty-state card when registry is unpopulated.
  work_queue_inventory: WorkQueueInventoryEntry[];
  stuck_work_queue: StuckWorkQueueEntry[];
  marty_lab: MartyLabStatusSnapshot;
  deal_replay: DealReplayStatusSnapshot;
  budgets: BudgetSnapshotRow[];
  generated_at: string;
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
  onError: (err: string, opts?: { retryable?: boolean }) => void,
  onToolEvent?: (event: any) => void,
  uploadIds?: string[]
): Promise<void> {
  const form = new FormData();
  form.append('query', query);
  if (sessionId) form.append('session_id', sessionId);
  if (contextEntityType) form.append('context_entity_type', contextEntityType);
  if (contextEntityId) form.append('context_entity_id', contextEntityId);
  if (file) form.append('file', file);
  if (deepDive) form.append('deep_dive', 'true');
  if (uploadIds && uploadIds.length > 0) form.append('upload_ids', JSON.stringify(uploadIds));

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
    // Backend returns JSON: { error, message, retryable }. Prefer the friendly
    // `message` over the technical `error` code when surfacing to users.
    const body = await res.text();
    let friendly = body;
    let retryable: boolean | undefined;
    try {
      const parsed = JSON.parse(body);
      friendly = parsed.message || parsed.error || body;
      retryable = parsed.retryable;
    } catch {
      // Plain-text body — leave as-is.
    }
    onError(friendly, { retryable });
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
          } else if (evt.type === 'request') {
            // Cancellation handle — first event the server emits per turn.
            onToolEvent?.({ type: 'request', request_id: evt.request_id });
          } else if (evt.type === 'sources') {
            onToolEvent?.({ type: 'sources', sources: evt.sources });
          } else if (evt.type === 'attachments') {
            onToolEvent?.(evt);
          } else if (evt.type === 'document_cards') {
            onToolEvent?.(evt);
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
