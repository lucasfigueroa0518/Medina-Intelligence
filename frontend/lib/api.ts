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

// Dev token — owner JWT for lucas-admin / medina-ventures. Set in frontend/.env.local
// as NEXT_PUBLIC_DEV_JWT. Seeded into localStorage on first load. Replace with real auth later.
const DEV_JWT_TOKEN = process.env.NEXT_PUBLIC_DEV_JWT ?? '';

const TOKEN_KEY = 'auth_token';
const SESSION_EXPIRED_EVENT = 'auth:session-expired';

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token && DEV_JWT_TOKEN) {
    localStorage.setItem(TOKEN_KEY, DEV_JWT_TOKEN);
    token = DEV_JWT_TOKEN;
  }
  return token;
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
    return request<{ contacts: any[]; limit: number; offset: number }>(`/contacts${q}`);
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
    return request<{ companies: any[] }>(`/companies${q}`);
  },
  getCompany: (id: string) =>
    request<{ company: any; contacts: any[]; deals: any[]; tags: any[] }>(`/companies/${id}`),
  createCompany: (data: any) =>
    request<{ company: any }>('/companies', { method: 'POST', body: JSON.stringify(data) }),
  updateCompany: (id: string, data: any) =>
    request<{ company: any }>(`/companies/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getCompanyNews: (id: string) => request<{ company: any; news: any[] }>(`/companies/${id}/news`),

  // Deals
  listDeals: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ deals: any[] }>(`/deals${q}`);
  },
  createDeal: (data: any) =>
    request<{ deal: any }>('/deals', { method: 'POST', body: JSON.stringify(data) }),
  updateDeal: (id: string, data: any) =>
    request<{ deal: any }>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Tags
  listTags: () => request<{ tags: any[] }>('/tags'),
  createTag: (data: any) =>
    request<{ tag: any }>('/tags', { method: 'POST', body: JSON.stringify(data) }),

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
  approveItem: (id: string) =>
    request<{ ok: boolean }>(`/approval-queue/${id}/approve`, { method: 'POST' }),
  rejectItem: (id: string) =>
    request<{ ok: boolean }>(`/approval-queue/${id}/reject`, { method: 'POST' }),

  // Agent
  listSessions: () => request<{ sessions: any[] }>('/agent/sessions'),
  getSessionMessages: (id: string) =>
    request<{ session: any; messages: any[] }>(`/agent/sessions/${id}/messages`),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/agent/sessions/${id}`, { method: 'DELETE' }),

  // Campaigns
  listCampaigns: () => request<{ campaigns: any[] }>('/campaigns'),
  getCampaign: (id: string) => request<{ campaign: any; recipients: any[] }>(`/campaigns/${id}`),
  createCampaign: (data: any) =>
    request<{ campaign: any }>('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
  sendCampaign: (id: string) =>
    request<{ ok: boolean }>(`/campaigns/${id}/send`, { method: 'POST' }),

  // Admin
  listDlq: (status = 'unresolved') =>
    request<{ entries: any[] }>(`/admin/dlq?status=${status}`),
  replayDlq: (id: string) =>
    request<{ ok: boolean }>(`/admin/dlq/${id}/replay`, { method: 'POST' }),
  getEnrichmentStatus: () =>
    request<{ status: Record<string, unknown> }>('/admin/enrichment-status'),
  getSystemStatus: () => request<{ mode: string; cache_stale: boolean }>('/system/status'),

  // Sync
  getSyncStatus: () => request<any>('/sync/status'),

  // Integrations
  getIntegrationsStatus: () =>
    request<IntegrationsStatusResponse>('/integrations/status'),

  // Imports
  listImports: () => request<{ imports: any[] }>('/imports'),
};

// --- Integration status types (mirrors src/handlers/integrations.ts) ---

export type IntegrationStatus =
  | 'connected'
  | 'not_connected'
  | 'configured'
  | 'not_configured'
  | 'webhook_ready';

export interface IntegrationRow {
  status: IntegrationStatus;
  label: string;
  detail?: string;
  last_sync?: string | null;
  connected_email?: string | null;
  token_healthy?: boolean;
  webhook_url?: string;
}

export interface IntegrationsStatusResponse {
  outlook: IntegrationRow;
  slack: IntegrationRow;
  reversecontact: IntegrationRow;
  firefly: IntegrationRow;
}

export async function streamAgentQuery(
  query: string,
  sessionId: string | null,
  contextEntityType: string | null,
  contextEntityId: string | null,
  file: File | null,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void
): Promise<void> {
  const form = new FormData();
  form.append('query', query);
  if (sessionId) form.append('session_id', sessionId);
  if (contextEntityType) form.append('context_entity_type', contextEntityType);
  if (contextEntityId) form.append('context_entity_id', contextEntityId);
  if (file) form.append('file', file);

  const token = getAuthToken();

  const res = await fetch(`${API_BASE}/agent/query`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });

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
        if (evt.text) onToken(evt.text);
      } catch {
        // skip
      }
    }
  }
  onDone();
}
