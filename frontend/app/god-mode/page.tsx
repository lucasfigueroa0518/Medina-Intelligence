'use client';

import React from 'react';
import { MarkdownMessage } from '@/components/markdown-message';
import { api, streamAgentQuery } from '@/lib/api';
import {
  ArrowUp, Paperclip, Plus, Trash2,
  X as XIcon, Pencil, Check, Copy, RefreshCw,
  Search, Database, Globe, FileText,
  CheckCircle2, AlertCircle, ChevronDown, ChevronRight,
  BarChart3, Users, Newspaper, PenLine, List, Radar,
} from 'lucide-react';
import { MartyEmblem } from '@/components/marty-emblem';
import { CitationPill } from '@/components/citation-pill';
import { SourcePanel } from '@/components/source-panel';
import { PendingUploadPill, SentUploadPill, formatBytes } from '@/components/chat-upload-pill';
import { UploadPreviewModal } from '@/components/upload-preview-modal';
import { DocumentActions } from '@/components/document-actions';
import { trimPartialCitation, type CitationSource } from '@/lib/citations';
import type { ChatUploadSummary } from '@/lib/api';

// ---------------------------------------------------------------------------
// Thinking verbs (crossfade)
// ---------------------------------------------------------------------------

const THINKING_VERBS = [
  "Sourcing deals", "Running the numbers", "Sizing the opportunity",
  "Stress-testing the thesis", "Modeling the upside", "Underwriting the risk",
  "Benchmarking comps", "Digging into the cap table", "Working the network",
  "Cross-referencing connections", "Mapping the landscape", "Tracing the money trail",
  "Pulling the thread", "Connecting the dots", "Doing the due diligence",
  "Combing through the data room", "Scanning the market", "Checking the pulse",
  "Reading the tea leaves", "Crunching alpha", "Triangulating signals",
  "Heating things up", "Making moves", "Building bridges",
  "Turning over stones", "Riding the wave", "Cutting through the noise",
  "Sharpening the brief", "Assembling the picture", "Locking in the signal",
  "Shining Manny's shoes", "Helping Raul pick his outfit", "Ordering lunch for Tony",
  "Helping Alvaro with Due Diligence", "Building firewalls for Adam",
];

function useThinkingVerb(active: boolean) {
  const [display, setDisplay] = React.useState({ text: '', phase: 'enter' as 'enter' | 'exit' });

  React.useEffect(() => {
    if (!active) return;
    const pick = () => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
    setDisplay({ text: pick(), phase: 'enter' });

    const interval = setInterval(() => {
      setDisplay(d => ({ text: d.text, phase: 'exit' }));
      setTimeout(() => setDisplay({ text: pick(), phase: 'enter' }), 400);
    }, 3000);
    return () => clearInterval(interval);
  }, [active]);

  return display;
}

// ---------------------------------------------------------------------------
// Sparkles (logo entrance)
// ---------------------------------------------------------------------------

function Sparkles({ active }: { active: boolean }) {
  if (!active) return null;
  const positions = [
    { '--sx': '-12px', '--sy': '-14px' },
    { '--sx': '14px', '--sy': '-10px' },
    { '--sx': '-10px', '--sy': '12px' },
    { '--sx': '12px', '--sy': '14px' },
  ] as any[];
  return (
    <>
      {positions.map((style, i) => (
        <span key={i} className="sparkle-dot" style={{ ...style, animationDelay: `${i * 80}ms`, top: '50%', left: '50%' }} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Thinking indicator
// ---------------------------------------------------------------------------

function ThinkingIndicator() {
  const verb = useThinkingVerb(true);

  return (
    <div className="flex items-center gap-3 py-3">
      <MartyEmblem size={28} animate />
      <div className="flex items-center gap-0">
        <span
          key={verb.text}
          className={`thinking-text text-sm ${verb.phase === 'enter' ? 'verb-crossfade-enter' : 'verb-crossfade-exit'}`}
        >
          {verb.text}
        </span>
        <span className="flex ml-0.5 gap-[2px]">
          {[0, 0.2, 0.4].map((delay, i) => (
            <span key={i} className="thinking-dot text-sm" style={{ fontFamily: "'Exo 2', sans-serif", fontWeight: 600, color: '#EC4899', animationDelay: `${delay}s` }}>.</span>
          ))}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  tool: string;
  input?: any;
  result?: any;
  status: 'started' | 'executing' | 'done' | 'error';
  collapsed: boolean;
}

interface MartyDocumentCard {
  document_id: string;
  title: string;
  file_name?: string | null;
  mime_type?: string | null;
  document_type?: string | null;
  mode?: 'compact' | 'dominant';
  reason?: string;
  excerpt?: string;
  confidence?: number;
  source?: string | null;
  date?: string | null;
  actions?: {
    preview?: boolean;
    download?: boolean;
    send_to_marty?: boolean;
  };
  generated?: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  justFinished?: boolean;
  toolCalls?: ToolCall[];
  timestamp?: string;
  error?: boolean;
  retryable?: boolean;
  cancelled?: boolean;
  sources?: CitationSource[];
  attachments?: ChatUploadSummary[];
  documentCards?: MartyDocumentCard[];
}

// Selected/in-flight uploads (state local to the input bar before send).
interface PendingUpload {
  // Local key — stable from selection until upload completes.
  localId: string;
  file: File;
  uploadType: import('@/lib/api').ChatUploadType;
  saveToDocuments: boolean;
  uploading: boolean;
  // Server-assigned id once the upload-file endpoint returns.
  serverId?: string;
  // Server-side preview-friendly summary.
  summary?: ChatUploadSummary;
  failed?: string | null;
}

const ACCEPTED_FILE_EXTS = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.xls,.pptx,.csv,.txt,.md,.json';
const MAX_PENDING_UPLOADS = 5;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function detectClientUploadType(file: File): import('@/lib/api').ChatUploadType | null {
  const mt = (file.type || '').toLowerCase();
  if (mt === 'application/pdf') return 'pdf';
  if (mt.startsWith('image/')) return 'image';
  if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'document';
  if (mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mt === 'application/vnd.ms-excel') return 'spreadsheet';
  if (mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'presentation';
  if (mt === 'text/csv') return 'data';
  if (mt === 'application/json') return 'data';
  if (mt.startsWith('text/')) return 'text';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'pdf': return 'pdf';
    case 'png': case 'jpg': case 'jpeg': case 'webp': case 'gif': return 'image';
    case 'docx': return 'document';
    case 'xlsx': case 'xls': return 'spreadsheet';
    case 'pptx': return 'presentation';
    case 'csv': case 'json': return 'data';
    case 'txt': case 'md': return 'text';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Suggestion cards
// ---------------------------------------------------------------------------

const SUGGESTION_CARDS = [
  {
    icon: BarChart3,
    title: 'Pipeline briefing',
    subtitle: 'Deal status, action items, and next steps',
    prompt: 'Give me a pipeline briefing — deal statuses, open action items, and what needs attention',
  },
  {
    icon: Users,
    title: 'Contact catch-up',
    subtitle: 'Who needs attention and follow-ups',
    prompt: "Who haven't I been in touch with recently? Any overdue follow-ups or contacts that need attention?",
  },
  {
    icon: Newspaper,
    title: 'Market pulse',
    subtitle: 'News and trends in your sectors',
    prompt: 'Search the web for the latest news in AI marketing, MarTech, and venture capital. Also check for any recent news about companies in our pipeline. Give me a market intelligence briefing.',
  },
  {
    icon: PenLine,
    title: 'Draft something',
    subtitle: 'Emails, memos, or meeting prep',
    prompt: '__focus_input__',
  },
];

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning. What are we working on?';
  if (h < 17) return 'Good afternoon. What do you need?';
  return 'Good evening. How can I help?';
}

// ---------------------------------------------------------------------------
// Time grouping
// ---------------------------------------------------------------------------

function groupSessionsByTime(sessions: any[]) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfDay - 86400000;
  const startOfWeek = startOfDay - now.getDay() * 86400000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const groups: { label: string; sessions: any[] }[] = [
    { label: 'Today', sessions: [] },
    { label: 'Yesterday', sessions: [] },
    { label: 'This Week', sessions: [] },
    { label: 'This Month', sessions: [] },
    { label: 'Older', sessions: [] },
  ];

  for (const s of sessions) {
    const t = new Date(s.last_activity_at).getTime();
    if (t >= startOfDay) groups[0].sessions.push(s);
    else if (t >= startOfYesterday) groups[1].sessions.push(s);
    else if (t >= startOfWeek) groups[2].sessions.push(s);
    else if (t >= startOfMonth) groups[3].sessions.push(s);
    else groups[4].sessions.push(s);
  }

  return groups.filter(g => g.sessions.length > 0);
}

// ---------------------------------------------------------------------------
// Header extraction + TOC
// ---------------------------------------------------------------------------

function extractHeaders(content: string): { level: number; text: string; id: string }[] {
  const headers: { level: number; text: string; id: string }[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^(#{1,4})\s+(.+)/);
    if (match) {
      const text = match[2].replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
      headers.push({
        level: match[1].length,
        text,
        id: text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      });
    }
  }
  return headers;
}

function TableOfContents({ content }: { content: string }) {
  const headers = extractHeaders(content);
  if (headers.length < 3) return null;

  return (
    <div className="toc-container sticky top-0 z-10 bg-bg-root/80 backdrop-blur-sm border-b border-border/30 py-2.5 px-4 mb-3 rounded-t-lg">
      <div className="flex items-center gap-1.5 mb-1.5">
        <List size={10} className="text-text-muted" />
        <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold" style={{ fontFamily: "'Exo 2', sans-serif" }}>Contents</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {headers.map((h, i) => (
          <a
            key={i}
            href={`#${h.id}`}
            className="text-xs text-text-secondary hover:text-accent-magenta transition-colors"
            style={{ paddingLeft: h.level > 1 ? `${(h.level - 1) * 8}px` : undefined }}
            onClick={e => {
              e.preventDefault();
              document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >
            {h.text}
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, typeof Search> = {
  search_contacts: Search, search_companies: Search, search_deals: Search,
  search_conversations: Search, find_documents: FileText,
  get_contact_detail: Database, get_company_detail: Database, get_deal_detail: Database,
  web_search: Globe, read_url: Globe,
  create_contact: FileText, update_contact: FileText,
  create_company: FileText, update_company: FileText,
  create_deal: FileText, update_deal: FileText,
  create_document_artifact: FileText, edit_document_artifact: FileText,
  add_note: FileText, add_deal_action_item: FileText, apply_tag: FileText,
  delete_entity: AlertCircle,
};

function toolLabel(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function toolStatusText(tool: ToolCall): string {
  if (tool.status === 'started' || tool.status === 'executing') {
    const action = tool.tool === 'find_documents' ? 'Finding documents' :
      tool.tool === 'create_document_artifact' ? 'Creating document' :
      tool.tool === 'edit_document_artifact' ? 'Editing document' :
      tool.tool.startsWith('search') ? 'Searching' :
      tool.tool.startsWith('get') ? 'Loading' :
      tool.tool === 'web_search' ? 'Searching the web' :
      tool.tool === 'read_url' ? 'Reading page' :
      tool.tool.startsWith('create') ? 'Creating' :
      tool.tool.startsWith('update') ? 'Updating' :
      tool.tool.startsWith('add') ? 'Adding' :
      tool.tool === 'apply_tag' ? 'Tagging' : 'Processing';
    return `${action}...`;
  }
  if (tool.status === 'error') return 'Failed';
  if (tool.tool === 'find_documents' && tool.result?.count !== undefined) return `Found ${tool.result.count} documents`;
  if ((tool.tool === 'create_document_artifact' || tool.tool === 'edit_document_artifact') && tool.result?.document?.file_name) {
    return tool.result.document.file_name;
  }
  if (tool.result?.count !== undefined) return `Found ${tool.result.count} results`;
  if (tool.result?.success) return tool.result.message || 'Done';
  if (tool.result?.summary) return 'Results ready';
  if (tool.result?.contact) return `Loaded ${tool.result.contact.full_name || 'contact'}`;
  if (tool.result?.company) return `Loaded ${tool.result.company.name || 'company'}`;
  if (tool.result?.deal) return `Loaded ${tool.result.deal.title || 'deal'}`;
  if (tool.result?.requires_confirmation) return 'Needs confirmation';
  return 'Done';
}

function mergeDocumentCards(
  existing: MartyDocumentCard[] | undefined,
  incoming: MartyDocumentCard[] | undefined
): MartyDocumentCard[] | undefined {
  const all = [...(existing || []), ...(incoming || [])].filter(c => c?.document_id && c?.title);
  if (all.length === 0) return undefined;

  function canonicalCardKey(card: MartyDocumentCard): string {
    const raw = (card.file_name || card.title || card.document_id)
      .toLowerCase()
      .replace(/\.(pdf|pptx?|docx?|xlsx?|csv)$/i, '')
      .replace(/\b(copy|final|draft|execution copy|redline|signed)\b/g, '')
      .replace(/\bv(?:ersion)?[\s_-]?\d+\b/g, '')
      .replace(/[_\-\s]*\(\d+\)\s*/g, ' ')
      .replace(/\b\d{4}[-_ ]?\d{2}[-_ ]?\d{2}\b/g, '')
      .replace(/\b\d{8}\b/g, '')
      .replace(/\b\d{1,2}[-_ ]\d{1,2}[-_ ]\d{2,4}\b/g, '');
    const compact = raw.replace(/[^a-z0-9]+/g, '');
    return compact ? `title:${compact}` : `id:${card.document_id}`;
  }

  const byKey = new Map<string, MartyDocumentCard>();
  for (const card of all) {
    const key = canonicalCardKey(card);
    const prior = byKey.get(key);
    const merged: MartyDocumentCard = {
      ...prior,
      ...card,
      mode: prior?.mode === 'dominant' || card.mode === 'dominant' ? 'dominant' : (card.mode || prior?.mode || 'compact'),
      actions: {
        preview: card.actions?.preview ?? prior?.actions?.preview ?? true,
        download: card.actions?.download ?? prior?.actions?.download ?? true,
        send_to_marty: card.actions?.send_to_marty ?? prior?.actions?.send_to_marty ?? true,
      },
    };
    const priorConfidence = prior?.confidence ?? 0;
    const nextConfidence = card.confidence ?? 0;
    if (!prior || nextConfidence >= priorConfidence) byKey.set(key, merged);
  }
  return [...byKey.values()];
}

function DocumentCardList({ cards }: { cards?: MartyDocumentCard[] }) {
  const normalized = mergeDocumentCards(undefined, cards) || [];
  if (normalized.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {normalized.map(card => {
        const dominant = card.mode === 'dominant';
        const title = card.title || card.file_name || 'Document';
        const meta = [
          card.generated ? 'Created by MARTy' : card.document_type?.replace(/_/g, ' '),
          card.file_name,
          card.source,
        ].filter(Boolean).join(' · ');
        return (
          <div
            key={card.document_id}
            className={`rounded-xl border bg-[#111114]/85 backdrop-blur-sm ${
              dominant ? 'border-accent-magenta/25 p-4 shadow-[0_0_30px_rgba(236,72,153,0.08)]' : 'border-border/70 p-3'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                dominant ? 'bg-accent-magenta/15 text-accent-magenta' : 'bg-white/[0.04] text-text-muted'
              }`}>
                <FileText size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="truncate text-sm font-semibold text-text-primary" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                    {title}
                  </div>
                  {card.confidence !== undefined && (
                    <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-text-muted">
                      {Math.round(card.confidence * 100)}% match
                    </span>
                  )}
                </div>
                {meta && <div className="mt-0.5 truncate text-xs text-text-muted">{meta}</div>}
                {(dominant || card.reason) && card.reason && (
                  <div className="mt-2 text-xs text-text-secondary">{card.reason}</div>
                )}
                {dominant && card.excerpt && (
                  <div className="mt-2 line-clamp-3 text-xs leading-relaxed text-text-muted">{card.excerpt}</div>
                )}
              </div>
              <div className="shrink-0">
                <DocumentActions
                  doc={{
                    id: card.document_id,
                    title,
                    file_name: card.file_name || title,
                    extracted_text_preview: card.excerpt || null,
                  }}
                  variant={dominant ? 'compact' : 'icon'}
                  showPreview={card.actions?.preview !== false}
                  showDownload={card.actions?.download !== false}
                  showSendToMarty={card.actions?.send_to_marty !== false}
                  onError={(message) => console.warn('[MARTy document card]', message)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolCallCard
// ---------------------------------------------------------------------------

function ToolCallCard({ tool, onToggle }: { tool: ToolCall; onToggle: () => void }) {
  const Icon = TOOL_ICONS[tool.tool] || FileText;
  const isRunning = tool.status === 'started' || tool.status === 'executing';
  const isError = tool.status === 'error';
  const isDone = tool.status === 'done';

  return (
    <div className={`tool-slide-in rounded-lg border my-2 overflow-hidden transition-all ${
      isError ? 'border-semantic-error/30 bg-semantic-error/5' :
      isRunning ? 'border-[#8B5CF6]/30 tool-shimmer' :
      'border-border bg-[#111114]/80 backdrop-blur-sm'
    }`}>
      <button onClick={onToggle} className="flex items-center gap-2 w-full px-3 py-2 text-left">
        {isRunning ? (
          <MartyEmblem size={16} animate />
        ) : isError ? (
          <AlertCircle size={14} className="text-semantic-error shrink-0" />
        ) : (
          <CheckCircle2 size={14} className="text-semantic-success shrink-0 check-pop" />
        )}
        <Icon size={14} className={isRunning ? 'text-[#8B5CF6]' : 'text-text-muted'} style={{ flexShrink: 0 }} />
        <span className="text-xs text-text-secondary flex-1 truncate" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
          {toolLabel(tool.tool)}
        </span>
        <span className={`text-[10px] ${
          isError ? 'text-semantic-error' : isDone ? 'text-semantic-success' : 'text-text-muted'
        }`} style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
          {isDone && '\u2713 '}{toolStatusText(tool)}
        </span>
        {tool.collapsed ? <ChevronRight size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
      </button>
      {!tool.collapsed && (
        <div className="border-t border-border/50 px-3 py-2 space-y-1.5">
          {tool.input && (
            <div>
              <div className="text-[9px] uppercase text-text-muted font-semibold tracking-wider mb-0.5">Input</div>
              <pre className="text-[11px] text-text-secondary bg-bg-root rounded p-2 overflow-x-auto max-h-32">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.result && (
            <div>
              <div className="text-[9px] uppercase text-text-muted font-semibold tracking-wider mb-0.5">Result</div>
              <pre className="text-[11px] text-text-secondary bg-bg-root rounded p-2 overflow-x-auto max-h-48">
                {JSON.stringify(tool.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error card
// ---------------------------------------------------------------------------

function ErrorCard({ message, retryable = true, onRetry }: { message: string; retryable?: boolean; onRetry: () => void }) {
  // Strip any leading "Error:" / "NNN:" prefix and JSON-ish payloads that may
  // have leaked from earlier failure paths. Falls back to a generic message
  // if we can't recover anything human-readable.
  const cleaned = (() => {
    const trimmed = message.replace(/^Error:\s*/i, '').replace(/^\d{3}:\s*/, '').trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed.message || parsed.error || 'I ran into a problem with that question. Try again or rephrase.';
      } catch {
        return 'I ran into a problem with that question. Try again or rephrase.';
      }
    }
    return trimmed || 'I ran into a problem with that question. Try again or rephrase.';
  })();

  return (
    <div className="error-card rounded-xl border border-semantic-error/20 bg-semantic-error/5 backdrop-blur-sm p-4 max-w-md">
      <div className="flex items-center gap-2 mb-2">
        <AlertCircle size={16} className="text-semantic-error shrink-0" />
        <span className="text-sm font-medium text-semantic-error" style={{ fontFamily: "'DM Sans', sans-serif" }}>
          Something went wrong
        </span>
      </div>
      <p className="text-xs text-text-secondary mb-3" style={{ fontFamily: "'DM Sans', sans-serif" }}>
        {cleaned}
      </p>
      {retryable && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-semantic-error/30 text-semantic-error text-xs hover:bg-semantic-error/10 transition-all hover:scale-[1.02] active:scale-[0.98]"
        >
          <RefreshCw size={12} /> Try again
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session item component
// ---------------------------------------------------------------------------

function SessionItem({
  session,
  isActive,
  index,
  onSelect,
  onDelete,
  onRename,
  deleteConfirmId,
  setDeleteConfirmId,
  deletingId,
  editingTitleId,
  setEditingTitleId,
  editTitleValue,
  setEditTitleValue,
}: {
  session: any;
  isActive: boolean;
  index: number;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
  deleteConfirmId: string | null;
  setDeleteConfirmId: (id: string | null) => void;
  deletingId: string | null;
  editingTitleId: string | null;
  setEditingTitleId: (id: string | null) => void;
  editTitleValue: string;
  setEditTitleValue: (v: string) => void;
}) {
  return (
    <div
      className={`session-stagger relative group transition-colors ${
        isActive
          ? 'bg-white/[0.04] border-l-2 border-l-[#8B5CF6]'
          : 'hover:bg-white/[0.02]'
      }`}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {deleteConfirmId === session.id && (
        <div className="absolute inset-0 z-10 flex items-center justify-center px-3"
          style={{ background: 'rgba(9,9,11,0.92)', backdropFilter: 'blur(4px)' }}>
          <div className="text-center">
            <div className="text-xs text-text-secondary mb-2">Delete this conversation?</div>
            <div className="flex gap-2 justify-center">
              <button onClick={() => setDeleteConfirmId(null)}
                className="px-2.5 py-1 rounded text-[10px] text-text-muted hover:text-text-primary transition-colors"
                disabled={deletingId === session.id}>Cancel</button>
              <button onClick={onDelete}
                className="px-2.5 py-1 rounded text-[10px] font-medium text-semantic-error hover:bg-semantic-error/10 transition-colors"
                disabled={deletingId === session.id}>
                {deletingId === session.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={onSelect} className="flex-1 text-left min-w-0">
          {editingTitleId === session.id ? (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <input
                className="bg-bg-input border border-border rounded px-2 py-0.5 text-sm text-text-primary w-full outline-none focus:border-accent-magenta"
                value={editTitleValue}
                onChange={e => setEditTitleValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') onRename(); if (e.key === 'Escape') setEditingTitleId(null); }}
                autoFocus
              />
              <button onClick={onRename} className="text-semantic-success hover:text-semantic-success/80 shrink-0">
                <Check size={14} />
              </button>
            </div>
          ) : (
            <>
              <div className="text-sm text-text-primary truncate" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
                {session.title || 'New Session'}
              </div>
              <div className="text-[10px] text-text-muted mt-0.5" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 400 }}>
                {formatRelative(session.last_activity_at)}
              </div>
            </>
          )}
        </button>

        {editingTitleId !== session.id && (
          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={e => { e.stopPropagation(); setEditingTitleId(session.id); setEditTitleValue(session.title || ''); }}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors" title="Rename">
              <Pencil size={12} />
            </button>
            <button onClick={e => { e.stopPropagation(); setDeleteConfirmId(session.id); }}
              className="p-1 rounded text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors" title="Delete">
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function GodModePage() {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [sessionsLoading, setSessionsLoading] = React.useState(true);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const [attachedFile, setAttachedFile] = React.useState<File | null>(null);
  const [pendingUploads, setPendingUploads] = React.useState<PendingUpload[]>([]);
  const [sessionUploads, setSessionUploads] = React.useState<ChatUploadSummary[]>([]);
  const [bytesUsed, setBytesUsed] = React.useState(0);
  const [bytesTotal, setBytesTotal] = React.useState(0);
  const [previewUpload, setPreviewUpload] = React.useState<ChatUploadSummary | null>(null);
  const [uploadToast, setUploadToast] = React.useState<string | null>(null);
  const messagesRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const lastSentQueryRef = React.useRef('');

  const [deleteConfirmId, setDeleteConfirmId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = React.useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = React.useState('');

  const [sendPulse, setSendPulse] = React.useState(false);
  const [showSparkles, setShowSparkles] = React.useState(true);
  const [emptyMounted, setEmptyMounted] = React.useState(false);
  const liveSessionIdRef = React.useRef<string | null>(null);
  const pendingSessionIdRef = React.useRef<string | null>(null);
  const streamingRef = React.useRef(false);
  const skipNextFetchRef = React.useRef(false);

  const [sidebarSearch, setSidebarSearch] = React.useState('');
  const [mobileSessionsOpen, setMobileSessionsOpen] = React.useState(false);
  const [copiedMsgId, setCopiedMsgId] = React.useState<string | null>(null);
  const [placeholderText, setPlaceholderText] = React.useState('Ask MARTy anything...');
  const [deepDive, setDeepDive] = React.useState(false);

  // Fix 4: Explicit isThinking state — only cleared on first text token
  const [isThinking, setIsThinking] = React.useState(false);

  // MARTy Wave 1 cancellation. The server emits a request_id as the first
  // stream event; we POST it to /api/agent/cancel on stop / Esc / Cmd+Backspace.
  // Stored in a ref because we don't need React renders when it changes.
  const activeRequestIdRef = React.useRef<string | null>(null);
  const cancelledLocallyRef = React.useRef(false);

  const cancelActiveStream = React.useCallback(() => {
    const reqId = activeRequestIdRef.current;
    if (!reqId) return;
    cancelledLocallyRef.current = true;
    api.cancelAgentQuery(reqId);
  }, []);

  // Global Esc / Cmd+Backspace cancel while streaming. Esc only fires when
  // no input/textarea is focused so it doesn't fight with the input's own
  // Escape behavior. Cmd+Backspace works regardless (power-user shortcut).
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!streamingRef.current || !activeRequestIdRef.current) return;
      const target = e.target as HTMLElement | null;
      const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape' && !inField) {
        e.preventDefault();
        cancelActiveStream();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
        e.preventDefault();
        cancelActiveStream();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [cancelActiveStream]);

  // Citation source side panel
  const [activeSource, setActiveSource] = React.useState<CitationSource | null>(null);
  const activeSourceMessageIdRef = React.useRef<string | null>(null);

  const showToast = React.useCallback((msg: string) => {
    setUploadToast(msg);
    setTimeout(() => setUploadToast(null), 3500);
  }, []);

  const handleFilesPicked = React.useCallback(async (selected: File[]) => {
    if (selected.length === 0) return;
    const slotsLeft = MAX_PENDING_UPLOADS - pendingUploads.length;
    if (slotsLeft <= 0) {
      showToast(`Maximum ${MAX_PENDING_UPLOADS} files per message.`);
      return;
    }
    const accepted: PendingUpload[] = [];
    let rejectedTooLarge = 0;
    let rejectedUnsupported = 0;
    let truncated = false;
    for (const f of selected) {
      if (accepted.length >= slotsLeft) { truncated = true; break; }
      const type = detectClientUploadType(f);
      if (!type) { rejectedUnsupported++; continue; }
      if (f.size > MAX_FILE_BYTES) { rejectedTooLarge++; continue; }
      if (type === 'image' && f.size > Math.floor(5 * 1024 * 1024 * 0.75)) { rejectedTooLarge++; continue; }
      accepted.push({
        localId: crypto.randomUUID(),
        file: f,
        uploadType: type,
        saveToDocuments: false,
        uploading: true,
      });
    }
    if (rejectedUnsupported > 0) showToast(`${rejectedUnsupported} unsupported file${rejectedUnsupported === 1 ? '' : 's'} skipped.`);
    if (rejectedTooLarge > 0) showToast(`${rejectedTooLarge} file${rejectedTooLarge === 1 ? '' : 's'} too large (max 32 MB; images max 3.5 MB).`);
    if (truncated) showToast(`Only the first ${slotsLeft} were added (max ${MAX_PENDING_UPLOADS} per message).`);
    if (accepted.length === 0) return;

    setPendingUploads(prev => [...prev, ...accepted]);

    // One upload request per file so a single oversize file doesn't sink the
    // whole batch on the server side. The endpoint accepts up to 5 anyway.
    for (const p of accepted) {
      try {
        const result = await api.uploadChatFiles([p.file], {
          sessionId: liveSessionIdRef.current ?? activeSessionId ?? null,
          saveToDocuments: p.saveToDocuments,
        });
        const summary = result.uploads[0];
        setPendingUploads(prev => prev.map(u =>
          u.localId === p.localId
            ? { ...u, uploading: false, serverId: summary.id, summary }
            : u
        ));
      } catch (e: any) {
        setPendingUploads(prev => prev.map(u =>
          u.localId === p.localId ? { ...u, uploading: false, failed: e?.message || 'Upload failed' } : u
        ));
        showToast(e?.message || 'Upload failed.');
      }
    }
  }, [pendingUploads.length, activeSessionId, showToast]);

  const togglePendingSave = React.useCallback((localId: string) => {
    setPendingUploads(prev => prev.map(u => {
      if (u.localId !== localId) return u;
      // Only allow toggling before upload completes — once saved server-side
      // there's no in-place flip.
      if (u.serverId) return u;
      return { ...u, saveToDocuments: !u.saveToDocuments };
    }));
  }, []);

  const removePending = React.useCallback((localId: string) => {
    setPendingUploads(prev => prev.filter(u => u.localId !== localId));
  }, []);

  const handleCitationClick = React.useCallback(
    (messageId: string) => (source: CitationSource) => {
      activeSourceMessageIdRef.current = messageId;
      setActiveSource(source);
      api.logCitationClick({
        message_id: messageId,
        source_id: source.id,
        source_type: source.type,
        source_table: source.source_table,
        source_row_id: source.source_id,
      });
    },
    []
  );

  // Fix 1: Smart auto-scroll — respect user's scroll position
  const userScrolledUpRef = React.useRef(false);

  React.useEffect(() => {
    document.title = 'MARTy \u2014 Medina Intelligence';
    setSessionsLoading(true);
    api.listSessions().then(d => { setSessions(d.sessions); setSessionsLoading(false); }).catch(() => setSessionsLoading(false));
    const t = setTimeout(() => setShowSparkles(false), 1200);

    try {
      const pending = localStorage.getItem('marty_pending');
      if (pending) {
        const { sessionId } = JSON.parse(pending);
        if (sessionId) {
          setActiveSessionId(sessionId);
          api.getSessionMessages(sessionId).then(d => {
            setMessages(d.messages.map((m: any) => ({
              id: m.id, role: m.role, content: m.content, timestamp: m.created_at, sources: m.sources || undefined,
            })));
            localStorage.removeItem('marty_pending');
            window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: false } }));
          }).catch(() => {
            localStorage.removeItem('marty_pending');
          });
        }
      }
    } catch { /* ignore corrupt localStorage */ }

    // Wave 5 Phase H — Send-to-MARTy URL-param consumer. Backend's
    // attach-document endpoint creates the chat_uploads row and redirects
    // here with ?session_id=<id>&attach_upload=<id>. Adopt the session,
    // refresh its uploads, and let listSessionUploads pick up the new
    // attachment as a pending in-context pill above the chat input.
    try {
      if (typeof window !== 'undefined') {
        const sp = new URLSearchParams(window.location.search);
        const incomingSession = sp.get('session_id');
        const incomingUpload = sp.get('attach_upload');
        if (incomingSession) {
          setActiveSessionId(incomingSession);
          if (incomingUpload) {
            // listSessionUploads runs on activeSessionId change; the
            // attachment will surface there. Strip the query params so
            // refresh doesn't re-trigger.
            const url = new URL(window.location.href);
            url.searchParams.delete('session_id');
            url.searchParams.delete('attach_upload');
            window.history.replaceState({}, '', url.toString());
          }
        }
      }
    } catch { /* ignore */ }

    return () => clearTimeout(t);
  }, []);

  React.useEffect(() => {
    if (!activeSessionId && messages.length === 0) {
      setEmptyMounted(false);
      requestAnimationFrame(() => setEmptyMounted(true));
    }
  }, [activeSessionId, messages.length]);

  streamingRef.current = streaming;

  React.useEffect(() => {
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false;
      return;
    }
    if (activeSessionId && !streamingRef.current) {
      api.getSessionMessages(activeSessionId).then(d => {
        if (!streamingRef.current) {
          setMessages(d.messages.map((m: any) => {
            // Pull cancelled flag out of the JSON metadata column.
            let cancelled = false;
            let documentCards: MartyDocumentCard[] | undefined;
            if (m.metadata) {
              try {
                const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata;
                cancelled = !!meta?.cancelled;
                documentCards = mergeDocumentCards(undefined, meta?.document_cards);
              } catch { /* ignore malformed metadata */ }
            }
            return {
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: m.created_at,
              attachments: m.attachments || undefined,
              sources: m.sources || undefined,
              documentCards,
              cancelled,
            };
          }));
        }
      });
      api.listSessionUploads(activeSessionId).then(d => {
        setSessionUploads(d.uploads);
        setBytesTotal(d.uploads.reduce((acc, u) => acc + u.size_bytes, 0));
        setBytesUsed(d.uploads.filter(u => u.in_context).reduce((acc, u) => acc + u.size_bytes, 0));
      }).catch(() => { /* ignore */ });
    } else if (!activeSessionId) {
      setMessages([]);
      setSessionUploads([]);
      setBytesUsed(0);
      setBytesTotal(0);
      setPendingUploads([]);
    }
  }, [activeSessionId]);

  // Fix 1: Auto-scroll only when user hasn't scrolled up
  React.useEffect(() => {
    if (!userScrolledUpRef.current) {
      messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  function handleMessagesScroll() {
    const el = messagesRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledUpRef.current = !atBottom;
  }

  const filteredSessions = React.useMemo(() => {
    if (!sidebarSearch.trim()) return sessions;
    const q = sidebarSearch.toLowerCase();
    return sessions.filter(s => (s.title || '').toLowerCase().includes(q));
  }, [sessions, sidebarSearch]);

  const sessionGroups = React.useMemo(() => groupSessionsByTime(filteredSessions), [filteredSessions]);

  async function handleDeleteSession(sessionId: string) {
    setDeletingId(sessionId);
    try {
      await api.deleteSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (activeSessionId === sessionId) { setActiveSessionId(null); setMessages([]); }
    } catch { /* ignore */ }
    finally { setDeletingId(null); setDeleteConfirmId(null); }
  }

  async function handleRenameSession(sessionId: string) {
    const trimmed = editTitleValue.trim();
    if (!trimmed) { setEditingTitleId(null); return; }
    try {
      await api.renameSession(sessionId, trimmed);
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title: trimmed } : s));
    } catch { /* ignore */ }
    finally { setEditingTitleId(null); }
  }

  function handleCopyMessage(msgId: string, content: string) {
    navigator.clipboard.writeText(content);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId(null), 2000);
  }

  function retryFrom(assistantMsgId: string) {
    if (streaming) return;
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 1) return;
    const userMsg = messages[idx - 1];
    if (userMsg?.role !== 'user') return;
    setMessages(m => m.slice(0, idx));
    sendMessage(userMsg.content);
  }

  // Fix 2: Auto-resize textarea
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  }

  const sendMessage = async (queryText: string) => {
    if (!queryText || streaming) return;
    setStreaming(true);
    lastSentQueryRef.current = queryText;

    // Fix 4: Set isThinking immediately on send
    setIsThinking(true);

    setSendPulse(true);
    setTimeout(() => setSendPulse(false), 300);

    // Reset scroll lock on new message
    userScrolledUpRef.current = false;

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Snapshot pending uploads for this turn — only those that finished
    // uploading without error make it into the message bubble + the request.
    const turnUploads = pendingUploads
      .filter(u => u.serverId && u.summary && !u.failed)
      .map(u => u.summary!) as ChatUploadSummary[];
    const uploadIds = turnUploads.map(u => u.id);

    setMessages(m => [
      ...m,
      { id: userMsgId, role: 'user', content: queryText, timestamp: now,
        attachments: turnUploads.length > 0 ? turnUploads : undefined },
      { id: assistantMsgId, role: 'assistant', content: '', streaming: true, toolCalls: [], timestamp: now },
    ]);
    setInput('');
    setPlaceholderText('Ask MARTy anything...');

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    const file = attachedFile;
    const isDeepDive = deepDive;
    setAttachedFile(null);
    setDeepDive(false);
    setPendingUploads([]);

    try {
      await streamAgentQuery(
        queryText, activeSessionId ?? liveSessionIdRef.current, null, null, file, isDeepDive,
        token => {
          if (typeof token === 'string') {
            setIsThinking(false);
            setMessages(m => m.map(msg =>
              msg.id === assistantMsgId ? { ...msg, content: msg.content + token } : msg
            ));
          }
        },
        () => {
          const wasCancelled = cancelledLocallyRef.current;
          cancelledLocallyRef.current = false;
          activeRequestIdRef.current = null;
          setIsThinking(false);
          setMessages(m => m.map(msg => {
            if (msg.id !== assistantMsgId) return msg;
            if (wasCancelled) {
              const placeholder = msg.content || '_(cancelled before MARTy started generating)_';
              return { ...msg, content: placeholder, streaming: false, cancelled: true };
            }
            if (!msg.content && (!msg.toolCalls || msg.toolCalls.length === 0)) {
              return { ...msg, content: 'Something went wrong — no response was received. Please try again.', streaming: false, error: true };
            }
            return { ...msg, streaming: false, justFinished: true };
          }));
          setStreaming(false);
          if (pendingSessionIdRef.current) {
            skipNextFetchRef.current = true;
            setActiveSessionId(pendingSessionIdRef.current);
            pendingSessionIdRef.current = null;
          }
          liveSessionIdRef.current = null;
          localStorage.removeItem('marty_pending');
          window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: false } }));
          api.listSessions().then(d => setSessions(d.sessions));
          setTimeout(() => {
            setMessages(m => m.map(msg =>
              msg.id === assistantMsgId ? { ...msg, justFinished: false } : msg
            ));
          }, 1000);
        },
        (err, opts) => {
          setIsThinking(false);
          setMessages(m => m.map(msg =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  content: msg.content || err,
                  streaming: false,
                  error: !msg.content,
                  retryable: opts?.retryable !== false,
                }
              : msg
          ));
          setStreaming(false);
          if (pendingSessionIdRef.current) {
            setActiveSessionId(pendingSessionIdRef.current);
            pendingSessionIdRef.current = null;
          }
          liveSessionIdRef.current = null;
          localStorage.removeItem('marty_pending');
          window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: false } }));
        },
        (event: any) => {
          if (event.type === 'session' && event.session_id) {
            liveSessionIdRef.current = event.session_id;
            if (!activeSessionId) {
              pendingSessionIdRef.current = event.session_id;
            }
            localStorage.setItem('marty_pending', JSON.stringify({ sessionId: event.session_id }));
            window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: true } }));
            return;
          }
          if (event.type === 'request' && event.request_id) {
            activeRequestIdRef.current = event.request_id;
            cancelledLocallyRef.current = false;
            return;
          }
          if (event.type === 'sources') {
            const sources = (event.sources || []) as CitationSource[];
            setMessages(m => m.map(msg =>
              msg.id === assistantMsgId ? { ...msg, sources } : msg
            ));
            return;
          }
          if (event.type === 'attachments') {
            const sessionAtt = (event.session_attachments || []) as ChatUploadSummary[];
            const turnAtt = (event.turn_attachments || []) as ChatUploadSummary[];
            setSessionUploads(sessionAtt);
            setBytesUsed(event.bytes_used || 0);
            setBytesTotal(event.bytes_total || 0);
            // Replace the optimistic snapshot we set on send with the
            // server's authoritative list (in_context flag is computed
            // server-side and may differ from what the client guessed).
            if (turnAtt.length > 0) {
              setMessages(m => m.map(msg =>
                msg.id === userMsgId ? { ...msg, attachments: turnAtt } : msg
              ));
            }
            return;
          }
          if (event.type === 'document_cards') {
            const incoming = mergeDocumentCards(undefined, event.document_cards);
            if (incoming?.length) {
              setMessages(m => m.map(msg =>
                msg.id === assistantMsgId
                  ? { ...msg, documentCards: mergeDocumentCards(msg.documentCards, incoming) }
                  : msg
              ));
            }
            return;
          }
          setMessages(m => m.map(msg => {
            if (msg.id !== assistantMsgId) return msg;
            const toolCalls = [...(msg.toolCalls || [])];
            if (event.status === 'started') {
              const last = toolCalls[toolCalls.length - 1];
              if (!last || last.tool !== event.tool || last.status === 'done' || last.status === 'error') {
                toolCalls.push({ id: crypto.randomUUID(), tool: event.tool, status: 'started', collapsed: true });
              }
            } else if (event.status === 'executing') {
              const last = toolCalls.findLast(tc => tc.tool === event.tool && tc.status !== 'done' && tc.status !== 'error');
              if (last) { last.status = 'executing'; last.input = event.input; }
            } else if (event.status === 'done' || event.status === 'error') {
              const last = toolCalls.findLast(tc => tc.tool === event.tool && tc.status !== 'done' && tc.status !== 'error');
              if (last) { last.status = event.status; last.result = event.result; }
            }
            const documentCards = event.result?.document_cards
              ? mergeDocumentCards(msg.documentCards, event.result.document_cards)
              : msg.documentCards;
            return { ...msg, toolCalls, documentCards };
          }));
        },
        uploadIds.length > 0 ? uploadIds : undefined,
      );
    } catch (e) {
      setIsThinking(false);
      setMessages(m => m.map(msg =>
        msg.id === assistantMsgId
          ? {
              ...msg,
              content: msg.content || ((e as Error).message || 'I ran into a problem with that question. Try again or rephrase.'),
              streaming: false,
              error: !msg.content,
              retryable: true,
            }
          : msg
      ));
      setStreaming(false);
      if (pendingSessionIdRef.current) {
        setActiveSessionId(pendingSessionIdRef.current);
        pendingSessionIdRef.current = null;
      }
      liveSessionIdRef.current = null;
      localStorage.removeItem('marty_pending');
      window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: false } }));
    }
  };

  function handleSuggestionClick(card: typeof SUGGESTION_CARDS[0]) {
    if (card.prompt === '__focus_input__') {
      setPlaceholderText('What would you like me to draft?');
      setInput('');
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      sendMessage(card.prompt);
    }
  }

  const isEmptyState = messages.length === 0;
  const hasInput = input.trim().length > 0;

  return (
    <div className="h-full flex overflow-hidden">
      {mobileSessionsOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setMobileSessionsOpen(false)}
        />
      )}
      {/* Sessions sidebar */}
      <aside
        className={`fixed md:relative inset-y-0 left-0 z-50 md:z-auto w-[84vw] max-w-[320px] md:w-[280px] md:max-w-none bg-bg-inset border-r border-border flex flex-col shrink-0 transition-transform duration-200 ${
          mobileSessionsOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {/* Fix 3: MARTy's own identity in sessions sidebar */}
        <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <MartyEmblem size={22} />
            <span className="text-sm text-text-primary" style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>
              MARTy
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMobileSessionsOpen(false)}
            className="md:hidden h-9 w-9 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-white/[0.05]"
            aria-label="Close sessions"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="px-4 pb-3">
          <button
            onClick={() => { setActiveSessionId(null); setMessages([]); setMobileSessionsOpen(false); setShowSparkles(true); setTimeout(() => setShowSparkles(false), 1200); }}
            className="new-session-btn btn-secondary w-full flex items-center justify-center gap-2"
          >
            <Plus size={16} /> New Session
          </button>
        </div>

        <div className="px-4 pb-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={sidebarSearch}
              onChange={e => setSidebarSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-full bg-bg-surface border border-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-text-primary placeholder-text-muted outline-none focus:border-[#8B5CF6]/50 transition-colors"
              style={{ fontFamily: "'DM Sans', sans-serif" }}
            />
            {sidebarSearch && (
              <button onClick={() => setSidebarSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary">
                <XIcon size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessionsLoading ? (
            <div className="space-y-2 px-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="animate-pulse">
                  <div className="h-4 bg-bg-surface rounded w-3/4 mb-1.5" />
                  <div className="h-3 bg-bg-surface rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-text-muted">
              {sidebarSearch ? 'No matching sessions' : 'No conversations yet'}
            </div>
          ) : (
            sessionGroups.map(group => {
              let runningIndex = 0;
              return (
                <div key={group.label}>
                  <div className="px-4 pt-3 pb-1">
                    <span className="sidebar-group-label">{group.label}</span>
                  </div>
                  {group.sessions.map(s => {
                    const idx = runningIndex++;
                    return (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={activeSessionId === s.id}
                        index={idx}
                        onSelect={() => { setActiveSessionId(s.id); setMobileSessionsOpen(false); }}
                        onDelete={() => handleDeleteSession(s.id)}
                        onRename={() => handleRenameSession(s.id)}
                        deleteConfirmId={deleteConfirmId}
                        setDeleteConfirmId={setDeleteConfirmId}
                        deletingId={deletingId}
                        editingTitleId={editingTitleId}
                        setEditingTitleId={setEditingTitleId}
                        editTitleValue={editTitleValue}
                        setEditTitleValue={setEditTitleValue}
                      />
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Fix 1: Chat area — relative container, never scrolls, only messages-container scrolls */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        <div className="md:hidden h-14 px-4 border-b border-border bg-bg-root flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={() => setMobileSessionsOpen(true)}
            className="h-10 px-3 rounded-lg border border-border text-sm text-text-secondary flex items-center gap-2"
          >
            <List size={16} /> Sessions
          </button>
          <button
            type="button"
            onClick={() => { setActiveSessionId(null); setMessages([]); setShowSparkles(true); setTimeout(() => setShowSparkles(false), 1200); inputRef.current?.focus(); }}
            className="h-10 px-3 rounded-lg bg-accent-magenta/15 text-accent-magenta text-sm"
          >
            New
          </button>
        </div>
        {/* Messages — the ONLY scrollable element */}
        <div
          ref={messagesRef}
          onScroll={handleMessagesScroll}
          className="flex-1 overflow-y-auto px-4 md:px-8 py-4 md:py-6"
          style={{ paddingBottom: 140 }}
        >
          {isEmptyState ? (
            <div className="h-full flex flex-col items-center justify-center">
              {/* Fix 3: MARTy's own emblem */}
              <div className="relative logo-entrance mb-6">
                <MartyEmblem size={56} animate />
                <div className="absolute inset-0 bg-[#8B5CF6]/10 blur-2xl rounded-full -z-10" />
                <Sparkles active={showSparkles} />
              </div>

              <div className="text-4xl md:text-[48px] text-text-primary text-center mb-2 leading-tight" style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700 }}>
                MARTy
              </div>

              <div className="greet-fade text-sm text-text-muted text-center mb-10" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 400, animationDelay: '300ms' }}>
                {getGreeting()}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl w-full mb-10">
                {SUGGESTION_CARDS.map((card, i) => {
                  const CardIcon = card.icon;
                  const isWide = i === 0 || i === 3;
                  return (
                    <button
                      key={card.title}
                      onClick={() => handleSuggestionClick(card)}
                      className={`suggestion-card-glass card-stagger group/card flex items-start gap-3 p-4 rounded-xl text-left ${
                        isWide ? 'sm:col-span-2' : 'sm:col-span-1'
                      }`}
                      style={{ animationDelay: emptyMounted ? `${i * 100}ms` : '0ms' }}
                    >
                      <div className="w-9 h-9 rounded-lg bg-[#8B5CF6]/10 flex items-center justify-center shrink-0 mt-0.5">
                        <CardIcon size={17} className="text-[#A855F7]" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm text-text-primary mb-0.5" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
                          {card.title}
                        </div>
                        <div className="text-xs text-text-muted" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 400 }}>
                          {card.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="text-[12px] text-text-muted/50 text-center" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                MARTy can search your CRM &middot; read emails &amp; Slack &middot; update contacts &amp; deals &middot; research the web
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-5">
              {messages.map(m =>
                m.role === 'user' ? (
                  <div key={m.id} className="flex justify-end group/msg msg-slide-in">
                    <div className="relative max-w-[92%] md:max-w-[75%]">
                      {m.attachments && m.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 justify-end mb-2">
                          {m.attachments.map(a => (
                            <SentUploadPill
                              key={a.id}
                              upload={a}
                              onClick={(u) => {
                                if (u.saved_to_documents && u.saved_document_id) {
                                  window.location.href = `/documents/${u.saved_document_id}`;
                                  return;
                                }
                                setPreviewUpload(u);
                              }}
                            />
                          ))}
                        </div>
                      )}
                      <div className="bg-bg-surface rounded-2xl rounded-br-sm px-5 py-3">
                        <div className="text-sm text-text-primary whitespace-pre-wrap" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 400 }}>
                          {m.content}
                        </div>
                        {m.timestamp && (
                          <div className="text-[10px] text-text-muted/60 mt-1.5 text-right">{formatTimestamp(m.timestamp)}</div>
                        )}
                      </div>
                      <div className="absolute -bottom-2 right-2 flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 z-10"
                        style={{ background: 'rgba(17,17,20,0.85)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '3px 6px' }}>
                        <button
                          onClick={() => handleCopyMessage(m.id, m.content)}
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary transition-all ${copiedMsgId === m.id ? 'action-pop' : ''}`}
                        >
                          {copiedMsgId === m.id ? <><Check size={11} className="text-semantic-success" /> Copied</> : <><Copy size={11} /> Copy</>}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="max-w-full md:max-w-[85%] group/msg msg-slide-in-left">
                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <div className="mb-2">
                        {m.toolCalls.map((tc, idx) => (
                          <ToolCallCard key={tc.id} tool={tc}
                            onToggle={() => {
                              setMessages(msgs => msgs.map(msg => {
                                if (msg.id !== m.id) return msg;
                                const toolCalls = [...(msg.toolCalls || [])];
                                toolCalls[idx] = { ...toolCalls[idx], collapsed: !toolCalls[idx].collapsed };
                                return { ...msg, toolCalls };
                              }));
                            }}
                          />
                        ))}
                      </div>
                    )}

                    {m.streaming && isThinking && (
                      <ThinkingIndicator />
                    )}

                    {m.documentCards && m.documentCards.length > 0 && (
                      <DocumentCardList cards={m.documentCards} />
                    )}

                    {m.content && m.error ? (
                      <ErrorCard message={m.content} retryable={m.retryable !== false} onRetry={() => retryFrom(m.id)} />
                    ) : m.content ? (
                      <div className="relative">
                        <div className={`border-l-2 ${m.cancelled ? 'border-text-muted/40' : 'border-[#8B5CF6]/30'} pl-4`}>
                          {!m.streaming && <TableOfContents content={m.content} />}
                          <MarkdownMessage
                            content={m.streaming ? trimPartialCitation(m.content) : m.content}
                            sources={m.sources}
                            onCitationClick={handleCitationClick(m.id)}
                          />
                          {m.cancelled && (
                            <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-text-muted/15 text-text-muted" style={{ fontFamily: "'Exo 2', sans-serif" }}>
                              <span style={{ width: 6, height: 6, background: 'currentColor', borderRadius: 1 }} />
                              Cancelled
                            </div>
                          )}
                          {!m.streaming && m.sources && m.sources.length > 0 && (() => {
                            // Only show sources that were actually cited inline.
                            const cited = new Set<number>();
                            const re = /\[\^(\d+)\]/g;
                            let mm: RegExpExecArray | null;
                            while ((mm = re.exec(m.content)) !== null) cited.add(parseInt(mm[1], 10));
                            const used = (m.sources || []).filter(s => cited.has(s.id));
                            if (used.length === 0) return null;
                            return (
                              <div className="mt-4 pt-3 border-t border-border/30">
                                <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-2" style={{ fontFamily: "'Exo 2', sans-serif" }}>
                                  Sources
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {used.map(s => (
                                    <CitationPill
                                      key={s.id}
                                      sourceId={s.id}
                                      source={s}
                                      variant="footer"
                                      onClick={handleCitationClick(m.id)}
                                    />
                                  ))}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                        {m.justFinished && <div className="response-done-line mt-2 ml-4" />}

                        {!m.streaming && (
                          <div className="absolute -bottom-2 right-2 flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 z-10"
                            style={{ background: 'rgba(17,17,20,0.85)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '3px 6px' }}>
                            {m.timestamp && (
                              <span className="text-[10px] text-text-muted/40 px-1">{formatTimestamp(m.timestamp)}</span>
                            )}
                            <button
                              onClick={() => handleCopyMessage(m.id, m.content)}
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary transition-all ${copiedMsgId === m.id ? 'action-pop' : ''}`}
                            >
                              {copiedMsgId === m.id ? <><Check size={11} className="text-semantic-success" /> Copied</> : <><Copy size={11} /> Copy</>}
                            </button>
                            <button
                              onClick={() => retryFrom(m.id)}
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary transition-colors"
                            >
                              <RefreshCw size={11} /> Retry
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* Fix 1+2: Floating prompt bar — absolutely positioned, doesn't take layout space */}
        <div className="absolute bottom-3 md:bottom-8 left-3 right-3 md:left-10 md:right-10 z-10">
          {/* Session attachment indicator — shows what MARTy currently sees */}
          {sessionUploads.length > 0 && (
            <div className="mb-2 flex flex-wrap md:flex-nowrap items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5 text-[11px]" style={{ fontFamily: "'DM Sans', sans-serif" }}>
              <Paperclip size={12} className="text-text-muted shrink-0" />
              <span className="text-text-muted shrink-0">In this conversation:</span>
              <div className="flex flex-wrap gap-1 min-w-0 flex-1">
                {sessionUploads.map(u => (
                  <button
                    key={u.id}
                    onClick={() => setPreviewUpload(u)}
                    className={`text-text-secondary hover:text-text-primary truncate max-w-[180px] ${u.in_context ? '' : 'opacity-50'}`}
                    title={u.in_context ? u.filename : `${u.filename} — out of context (re-attach to use)`}
                  >
                    {u.filename}{u.in_context ? '' : ' ·'}<span className="text-text-muted">{u.in_context ? '' : ' out'}</span>
                  </button>
                )).reduce<React.ReactNode[]>((acc, el, i) => {
                  if (i > 0) acc.push(<span key={`sep-${i}`} className="text-text-muted">,</span>);
                  acc.push(el);
                  return acc;
                }, [])}
              </div>
              <span className="text-text-muted shrink-0 md:ml-auto">
                {sessionUploads.length} of 5 — {formatBytes(bytesUsed)} / 50 MB
              </span>
            </div>
          )}
          {/* Pending uploads (selected but not yet sent) */}
          {pendingUploads.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingUploads.map(p => (
                <PendingUploadPill
                  key={p.localId}
                  filename={p.file.name}
                  sizeBytes={p.file.size}
                  uploadType={p.uploadType}
                  uploading={p.uploading}
                  failed={p.failed}
                  saveToDocuments={p.saveToDocuments}
                  onToggleSave={() => togglePendingSave(p.localId)}
                  onRemove={() => removePending(p.localId)}
                />
              ))}
            </div>
          )}
          {/* Toast */}
          {uploadToast && (
            <div className="mb-2 px-3 py-2 rounded-lg bg-semantic-error/15 border border-semantic-error/30 text-semantic-error text-xs"
              style={{ fontFamily: "'DM Sans', sans-serif" }}>
              {uploadToast}
            </div>
          )}
          <div className="floating-input-bar" style={{ padding: '12px 16px' }}>
            <div className="flex items-center gap-3">
              {/* Paperclip — fixed 36x36, multi-select */}
              <label className="w-9 h-9 flex items-center justify-center rounded-lg cursor-pointer shrink-0 transition-colors"
                style={{ color: 'rgba(255,255,255,0.5)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.9)'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.5)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                <Paperclip size={18} />
                <input
                  type="file"
                  multiple
                  className="hidden"
                  accept={ACCEPTED_FILE_EXTS}
                  onChange={e => {
                    const files = Array.from(e.target.files || []);
                    handleFilesPicked(files);
                    e.target.value = '';
                  }}
                />
              </label>

              {/* Deep Dive toggle */}
              <button
                onClick={() => setDeepDive(d => !d)}
                title={`Deep Dive — exhaustive search across all data (${navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}⇧D)`}
                className="w-9 h-9 flex items-center justify-center rounded-lg shrink-0 transition-all"
                style={{
                  color: deepDive ? '#A855F7' : 'rgba(255,255,255,0.4)',
                  background: deepDive ? 'rgba(168,85,247,0.15)' : 'transparent',
                  boxShadow: deepDive ? '0 0 12px rgba(168,85,247,0.3)' : 'none',
                }}
              >
                <Radar size={18} />
              </button>

              {/* Textarea — flex-1, auto-resizes */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
                  if (e.key === 'd' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); setDeepDive(d => !d); }
                }}
                placeholder={deepDive ? 'Deep dive — searching everything...' : placeholderText}
                onBlur={() => {
                  setTimeout(() => {
                    if (document.activeElement !== inputRef.current) {
                      setPlaceholderText('Ask MARTy anything...');
                    }
                  }, 150);
                }}
                rows={1}
                className="flex-1 resize-none bg-transparent border-none outline-none"
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontWeight: 400,
                  fontSize: 15,
                  lineHeight: 1.5,
                  color: '#ffffff',
                  minHeight: 24,
                  maxHeight: 200,
                  padding: '6px 0',
                  overflowY: 'auto',
                }}
              />

              {/* Send button — fixed 36x36 */}
              {streaming ? (
                <button
                  onClick={cancelActiveStream}
                  disabled={!activeRequestIdRef.current}
                  title="Stop generating (Esc, ⌘⌫)"
                  aria-label="Stop generating"
                  className="w-9 h-9 flex items-center justify-center shrink-0 transition-all"
                  style={{
                    borderRadius: 10,
                    background: '#27272A',
                    border: '1px solid rgba(255,255,255,0.18)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#3F3F46'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#27272A'; }}
                >
                  <span style={{ width: 10, height: 10, background: '#FAFAFA', borderRadius: 2, display: 'inline-block' }} />
                </button>
              ) : (
                <button
                  onClick={() => sendMessage(input)}
                  disabled={!hasInput}
                  className="w-9 h-9 flex items-center justify-center shrink-0 transition-all"
                  style={{
                    borderRadius: 10,
                    background: hasInput
                      ? 'linear-gradient(135deg, #A855F7 0%, #EC4899 100%)'
                      : 'rgba(255,255,255,0.08)',
                    cursor: hasInput ? 'pointer' : 'not-allowed',
                    transform: sendPulse ? 'scale(0.95)' : 'scale(1)',
                  }}
                  onMouseEnter={e => { if (hasInput) { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.15)'; (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)'; } }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = ''; (e.currentTarget as HTMLElement).style.transform = ''; }}
                >
                  <ArrowUp size={18} color="#ffffff" />
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      <SourcePanel source={activeSource} onClose={() => setActiveSource(null)} />
      <UploadPreviewModal upload={previewUpload} onClose={() => setPreviewUpload(null)} />
    </div>
  );
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (diff < min) return 'Just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < day * 7) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatTimestamp(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
