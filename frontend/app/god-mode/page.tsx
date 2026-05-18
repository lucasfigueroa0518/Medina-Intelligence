'use client';

import React from 'react';
import { MarkdownMessage } from '@/components/markdown-message';
import { ApiError, api, streamAgentQuery } from '@/lib/api';
import {
  ArrowUp, Paperclip, Plus, Trash2,
  X as XIcon, Pencil, Check, Copy, RefreshCw,
  Search, Database, Globe, FileText,
  CheckCircle2, AlertCircle, ChevronDown, ChevronRight,
  BarChart3, Users, Newspaper, PenLine, List,
} from 'lucide-react';
import { MartyEmblem } from '@/components/marty-emblem';
import { CitationPill } from '@/components/citation-pill';
import { SourcePanel } from '@/components/source-panel';
import { PendingUploadPill, SentUploadPill, formatBytes } from '@/components/chat-upload-pill';
import { UploadPreviewModal } from '@/components/upload-preview-modal';
import { DocumentActions } from '@/components/document-actions';
import { trimPartialCitation, type CitationSource } from '@/lib/citations';
import type { ChatUploadSummary } from '@/lib/api';
import { demoMartySessions, useDemoMode } from '@/lib/demo-mode';

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
  "Is Tony a Vegan?", "Reposting Raul's Instagram Posts",
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

function normalizeMartySentenceSpacing(text: string): string {
  if (!text) return text;
  const fixProse = (part: string) =>
    part.replace(/([a-z0-9\]\)"'`*_])([.!?])([*_~`]*)(?=[A-Z])/g, '$1$2$3 ');
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map(part => part.startsWith('`') ? part : fixProse(part))
    .join('');
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
  status: 'started' | 'executing' | 'done' | 'error' | 'cancelled';
  collapsed: boolean;
  runs?: ToolRun[];
  activeRunId?: string;
  pulseKey?: number;
}

interface ToolRun {
  id: string;
  input?: any;
  result?: any;
  status: 'started' | 'executing' | 'done' | 'error' | 'cancelled';
}

interface DeckJobView {
  id: string;
  assistant_message_id?: string | null;
  status?: 'queued' | 'running' | 'revising' | 'qa_blocked' | 'completed' | 'failed' | 'cancelled' | string;
  phase?: string;
  title?: string;
  status_label?: string;
  revision_round?: number;
  max_revision_rounds?: number;
  artifact_visibility?: 'polished' | 'draft_review' | 'none' | string;
  qa_summary?: {
    status?: string;
    findings?: number;
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
  } | null;
  blocked_reason?: string | null;
  visible_document_cards?: MartyDocumentCard[];
  diagnostic_document_cards?: MartyDocumentCard[];
  qa_findings?: Array<{
    slideId?: string;
    severity?: 'critical' | 'high' | 'medium' | 'low' | string;
    issue?: string;
    requiredFix?: string;
  }>;
  latest_event_message?: string;
  last_event_message?: string;
  last_event_seq?: number;
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
  pendingRequestId?: string;
  justFinished?: boolean;
  toolCalls?: ToolCall[];
  timestamp?: string;
  error?: boolean;
  retryable?: boolean;
  cancelled?: boolean;
  sources?: CitationSource[];
  attachments?: ChatUploadSummary[];
  documentCards?: MartyDocumentCard[];
  deckJobs?: DeckJobView[];
}

interface RunningMartyStream {
  sessionId: string;
  requestId: string;
  runId?: string | null;
  lastSeq?: number;
  assistantMessageId: string;
  abortController?: AbortController | null;
  clientRequestId?: string;
}

type MartyMode = 'fast' | 'max';

const MARTY_MODE_STORAGE_KEY = 'marty_chat_mode';
const MARTY_PENDING_STORAGE_KEY = 'marty_pending';
const MARTY_PENDING_RUNS_STORAGE_KEY = 'marty_pending_runs';

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
  create_document_artifact: FileText, create_deck_artifact: FileText, edit_document_artifact: FileText,
  add_note: FileText, add_deal_action_item: FileText, apply_tag: FileText,
  delete_entity: AlertCircle,
};

function toolLabel(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function toolActionLabel(name: string): string {
  if (name === 'find_documents') return 'Finding documents';
  if (name === 'create_deck_artifact') return 'Creating deck';
  if (name === 'create_document_artifact') return 'Creating document';
  if (name === 'edit_document_artifact') return 'Editing document';
  if (name.startsWith('search')) return 'Searching';
  if (name.startsWith('get')) return 'Loading';
  if (name === 'web_search') return 'Searching the web';
  if (name === 'read_url') return 'Reading page';
  if (name.startsWith('create')) return 'Creating';
  if (name.startsWith('update')) return 'Updating';
  if (name.startsWith('add')) return 'Adding';
  if (name === 'apply_tag') return 'Tagging';
  return 'Processing';
}

function isTerminalToolStatus(status: ToolCall['status']): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

function getToolRuns(tool: ToolCall): ToolRun[] {
  if (tool.runs?.length) return tool.runs;
  return [{
    id: tool.id,
    input: tool.input,
    result: tool.result,
    status: tool.status,
  }];
}

function aggregateToolStatus(runs: ToolRun[]): ToolCall['status'] {
  if (runs.some(run => run.status === 'executing')) return 'executing';
  if (runs.some(run => run.status === 'started')) return 'started';
  if (runs.length > 0 && runs.every(run => run.status === 'cancelled')) return 'cancelled';
  if (runs.length > 0 && runs.every(run => run.status === 'error')) return 'error';
  return 'done';
}

function resultCountForRun(run: ToolRun): number | null {
  const result = run.result;
  if (!result) return null;
  if (result.deck_job) return null;
  if (typeof result.count === 'number') return result.count;
  if (Array.isArray(result.sources)) return result.sources.length;
  if (Array.isArray(result.results)) return result.results.length;
  if (Array.isArray(result.documents)) return result.documents.length;
  if (Array.isArray(result.document_cards)) return result.document_cards.length;
  if (Array.isArray(result.items)) return result.items.length;
  return null;
}

function aggregateResultCount(tool: ToolCall): number | null {
  let total = 0;
  let sawCount = false;
  for (const run of getToolRuns(tool)) {
    const count = resultCountForRun(run);
    if (typeof count === 'number') {
      total += count;
      sawCount = true;
    }
  }
  return sawCount ? total : null;
}

function deckJobFromResult(result: any): DeckJobView | null {
  const job = result?.deck_job || result?.job || null;
  if (!job || typeof job !== 'object') return null;
  const id = String(job.id || result?.deck_job_id || '').trim();
  if (!id) return null;
  return { ...job, id };
}

function deckJobFromTool(tool: ToolCall): DeckJobView | null {
  if (tool.tool !== 'create_deck_artifact') return null;
  const runs = getToolRuns(tool);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const job = deckJobFromResult(runs[i]?.result);
    if (job) return job;
  }
  return deckJobFromResult(tool.result);
}

function isTerminalDeckJob(job: DeckJobView | null | undefined): boolean {
  return ['completed', 'failed', 'qa_blocked', 'cancelled'].includes(String(job?.status || ''));
}

function deckJobStatusLabel(job: DeckJobView | null | undefined): string {
  if (!job) return '';
  if (job.status_label) return job.status_label;
  const phase = String(job.phase || job.status || 'queued').replace(/_/g, ' ');
  if (job.status === 'completed') return 'Deck ready';
  if (job.status === 'qa_blocked') return 'Draft ready: review needed';
  if (job.status === 'failed') return 'Deck render failed';
  if (job.status === 'revising') {
    const round = Math.max(1, Number(job.revision_round || 1));
    const max = Math.max(round, Number(job.max_revision_rounds || 3));
    return `Revision ${round}/${max}: fixing layout`;
  }
  if (job.phase === 'html_render') return 'Building HTML';
  if (job.phase === 'render_qa') return 'Rendering screenshots';
  if (job.phase === 'export') return 'Exporting PDF/PPTX';
  if (job.phase === 'narrative' || job.phase === 'planning') return 'Planning story';
  return `Deck job ${phase}`;
}

function resultNoun(toolName: string): string {
  return toolName === 'find_documents' ? 'documents' : 'results';
}

function upsertToolEvent(toolCalls: ToolCall[], event: any): ToolCall[] {
  if (!event?.tool || !event?.status) return toolCalls;

  const toolName = String(event.tool);
  const existingIndex = toolCalls.findIndex(tool => tool.tool === toolName);
  const createRun = (status: ToolCall['status']): ToolRun => ({
    id: crypto.randomUUID(),
    input: event.input,
    result: event.result,
    status,
  });

  if (existingIndex === -1) {
    const initialStatus = event.status as ToolCall['status'];
    const run = createRun(initialStatus);
    return [
      ...toolCalls,
      {
        id: crypto.randomUUID(),
        tool: toolName,
        input: run.input,
        result: run.result,
        status: run.status,
        collapsed: true,
        runs: [run],
        activeRunId: isTerminalToolStatus(run.status) ? undefined : run.id,
        pulseKey: 0,
      },
    ];
  }

  const next = [...toolCalls];
  const existing = next[existingIndex];
  const runs = getToolRuns(existing).map(run => ({ ...run }));
  let activeRunId = existing.activeRunId;

  if (event.status === 'started') {
    const run = createRun('started');
    runs.push(run);
    activeRunId = run.id;
  } else if (event.status === 'executing') {
    let runIndex = runs.findIndex(run => run.id === activeRunId && !isTerminalToolStatus(run.status));
    if (runIndex < 0) runIndex = runs.findLastIndex(run => !isTerminalToolStatus(run.status));
    if (runIndex < 0) {
      const run = createRun('executing');
      runs.push(run);
      activeRunId = run.id;
    } else {
      runs[runIndex] = {
        ...runs[runIndex],
        status: 'executing',
        input: event.input ?? runs[runIndex].input,
      };
      activeRunId = runs[runIndex].id;
    }
  } else if (event.status === 'done' || event.status === 'error' || event.status === 'cancelled') {
    let runIndex = runs.findIndex(run => run.id === activeRunId && !isTerminalToolStatus(run.status));
    if (runIndex < 0) runIndex = runs.findLastIndex(run => !isTerminalToolStatus(run.status));
    if (runIndex < 0) {
      const run = createRun(event.status);
      runs.push(run);
    } else {
      runs[runIndex] = {
        ...runs[runIndex],
        status: event.status,
        result: event.result,
      };
    }
    activeRunId = undefined;
  }

  const latestRun = runs[runs.length - 1];
  next[existingIndex] = {
    ...existing,
    input: latestRun?.input,
    result: latestRun?.result,
    status: aggregateToolStatus(runs),
    runs,
    activeRunId,
    pulseKey: (existing.pulseKey || 0) + 1,
  };
  return next;
}

function cancelRunningToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls?.length) return toolCalls;
  return toolCalls.map(tool => {
    const runs = getToolRuns(tool).map(run => (
      isTerminalToolStatus(run.status)
        ? run
        : { ...run, status: 'cancelled' as const, result: { ...(run.result || {}), cancelled: true } }
    ));
    return {
      ...tool,
      status: aggregateToolStatus(runs),
      runs,
      activeRunId: undefined,
      pulseKey: (tool.pulseKey || 0) + 1,
    };
  });
}

function toolStatusText(tool: ToolCall): string {
  const runs = getToolRuns(tool);
  const runCount = runs.length;
  const totalCount = aggregateResultCount(tool);
  const suffix = runCount > 1 ? ` across ${runCount} runs` : '';
  const deckJob = deckJobFromTool(tool);

  if ((tool.status === 'started' || tool.status === 'executing') && !deckJob) {
    const priorCount = totalCount !== null ? ` · ${totalCount} ${resultNoun(tool.tool)} so far` : '';
    return `${toolActionLabel(tool.tool)}${runCount > 1 ? ` · ${runCount} runs` : ''}${priorCount}...`;
  }
  if (deckJob) return deckJobStatusLabel(deckJob);
  if (tool.status === 'error') return runCount > 1 ? `${runCount} runs failed` : 'Failed';
  if (tool.status === 'cancelled') return 'Stopped';
  if (totalCount !== null) return `Found ${totalCount} ${resultNoun(tool.tool)}${suffix}`;
  if ((tool.tool === 'create_document_artifact' || tool.tool === 'edit_document_artifact') && tool.result?.document?.file_name) {
    return tool.result.document.file_name;
  }
  if (tool.result?.success) return tool.result.message || 'Done';
  if (tool.result?.summary) return 'Results ready';
  if (tool.result?.contact) return `Loaded ${tool.result.contact.full_name || 'contact'}`;
  if (tool.result?.company) return `Loaded ${tool.result.company.name || 'company'}`;
  if (tool.result?.deal) return `Loaded ${tool.result.deal.title || 'deal'}`;
  if (tool.result?.requires_confirmation) return 'Needs confirmation';
  if (runCount > 1) return `${runCount} runs complete`;
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

function mergeCitationSources(
  existing: CitationSource[] | undefined,
  incoming: CitationSource[] | undefined
): CitationSource[] | undefined {
  const all = [...(existing || []), ...(incoming || [])].filter(s => typeof s?.id === 'number');
  if (all.length === 0) return existing;
  const byId = new Map<number, CitationSource>();
  for (const source of all) {
    byId.set(source.id, { ...byId.get(source.id), ...source });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function readStoredMartyMode(): MartyMode {
  if (typeof window === 'undefined') return 'fast';
  try {
    return localStorage.getItem(MARTY_MODE_STORAGE_KEY) === 'max' ? 'max' : 'fast';
  } catch {
    return 'fast';
  }
}

function parseAgentMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function normalizeHydratedToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls = raw
    .filter(item => item && typeof item === 'object' && typeof item.tool === 'string')
    .map(item => {
      const tool = item as any;
      const runs: ToolRun[] = Array.isArray(tool.runs)
        ? tool.runs
            .filter((run: any) => run && typeof run === 'object')
            .map((run: any) => ({
              id: typeof run.id === 'string' && run.id ? run.id : crypto.randomUUID(),
              input: run.input,
              result: run.result,
              status: ['started', 'executing', 'done', 'error', 'cancelled'].includes(String(run.status))
                ? run.status
                : 'done',
            }))
        : [];
      const fallbackRun: ToolRun = {
        id: typeof tool.id === 'string' && tool.id ? `${tool.id}:run` : crypto.randomUUID(),
        input: tool.input,
        result: tool.result,
        status: ['started', 'executing', 'done', 'error', 'cancelled'].includes(String(tool.status))
          ? tool.status
          : 'done',
      };
      const normalizedRuns = runs.length > 0 ? runs : [fallbackRun];
      const status = aggregateToolStatus(normalizedRuns);
      const latest = normalizedRuns[normalizedRuns.length - 1];
      return {
        id: typeof tool.id === 'string' && tool.id ? tool.id : crypto.randomUUID(),
        tool: String(tool.tool),
        input: latest?.input ?? tool.input,
        result: latest?.result ?? tool.result,
        status,
        collapsed: tool.collapsed !== false,
        runs: normalizedRuns,
        activeRunId: typeof tool.activeRunId === 'string' ? tool.activeRunId : undefined,
        pulseKey: 0,
      } satisfies ToolCall;
    });
  return calls.length > 0 ? calls : undefined;
}

function normalizeDeckJobs(raw: unknown): DeckJobView[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const jobs = raw
    .filter(job => job && typeof job === 'object' && typeof (job as any).id === 'string')
    .map(job => {
      const j = job as any;
      return {
        id: j.id,
        assistant_message_id: j.assistant_message_id || null,
        status: j.status,
        phase: j.phase,
        title: j.title,
        status_label: j.status_label,
        revision_round: typeof j.revision_round === 'number' ? j.revision_round : Number(j.revision_round || 0),
        max_revision_rounds: typeof j.max_revision_rounds === 'number' ? j.max_revision_rounds : Number(j.max_revision_rounds || 3),
        artifact_visibility: j.artifact_visibility || 'none',
        qa_summary: j.qa_summary || null,
        blocked_reason: j.blocked_reason || null,
        visible_document_cards: mergeDocumentCards(undefined, j.visible_document_cards),
        diagnostic_document_cards: mergeDocumentCards(undefined, j.diagnostic_document_cards),
        qa_findings: Array.isArray(j.qa_findings) ? j.qa_findings : [],
        latest_event_message: j.latest_event_message,
        last_event_message: j.last_event_message,
        last_event_seq: typeof j.last_event_seq === 'number' ? j.last_event_seq : Number(j.last_event_seq || 0),
      } satisfies DeckJobView;
    });
  return jobs.length > 0 ? jobs : undefined;
}

function hydrateAgentMessage(m: any): Message {
  const meta = parseAgentMetadata(m.metadata);
  const running = m.role === 'assistant' && meta.status === 'running';
  const toolCalls = normalizeHydratedToolCalls(meta?.tool_calls);
  const deckJobs = normalizeDeckJobs(meta?.deck_jobs);
  const deckVisibleCards = mergeDocumentCards(undefined, deckJobs?.flatMap(job => job.visible_document_cards || []));
  const documentCards = mergeDocumentCards(mergeDocumentCards(undefined, meta?.document_cards), deckVisibleCards);
  return {
    id: m.id,
    role: m.role,
    content: m.role === 'assistant' ? normalizeMartySentenceSpacing(m.content || '') : (m.content || ''),
    timestamp: m.created_at,
    attachments: m.attachments || undefined,
    sources: m.sources || undefined,
    documentCards,
    toolCalls,
    deckJobs,
    cancelled: !!meta.cancelled || meta.status === 'cancelled',
    streaming: running,
    pendingRequestId: running && typeof meta.request_id === 'string' ? meta.request_id : undefined,
    error: meta.status === 'error',
    retryable: meta.status === 'error' ? true : undefined,
  };
}

function hydrateAgentMessages(rows: any[]): Message[] {
  return rows.map(hydrateAgentMessage);
}

function preserveHydratedLocalUiState(serverMessages: Message[], localMessages: Message[]): Message[] {
  const localById = new Map(localMessages.map(message => [message.id, message]));
  return serverMessages.map(serverMessage => {
    const local = localById.get(serverMessage.id);
    if (!local?.toolCalls?.length || !serverMessage.toolCalls?.length) return serverMessage;
    const localByTool = new Map(local.toolCalls.map(tool => [tool.id || tool.tool, tool]));
    const localByName = new Map(local.toolCalls.map(tool => [tool.tool, tool]));
    return {
      ...serverMessage,
      toolCalls: serverMessage.toolCalls.map(tool => {
        const localTool = localByTool.get(tool.id || tool.tool) || localByName.get(tool.tool);
        return localTool ? { ...tool, collapsed: localTool.collapsed } : tool;
      }),
    };
  });
}

function getRunningAssistantMessage(messages: Message[]): Message | undefined {
  return [...messages].reverse().find(m => m.role === 'assistant' && m.streaming && m.pendingRequestId);
}

function isSessionNotFoundError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 404 && (error.code === 'SESSION_NOT_FOUND' || error.message.includes('SESSION_NOT_FOUND'));
  }
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('SESSION_NOT_FOUND');
}

type AgentSendErrorOptions = {
  retryable?: boolean;
  code?: string;
  sessionId?: string | null;
  requestId?: string | null;
};

function DocumentCardList({
  cards,
  sessionId,
  onDocumentAttached,
}: {
  cards?: MartyDocumentCard[];
  sessionId?: string | null;
  onDocumentAttached?: (result: { upload_id: string; session_id: string; summary: ChatUploadSummary }) => void;
}) {
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
                  sessionId={sessionId}
                  onSentToMarty={onDocumentAttached}
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

function DeckJobProgress({ job }: { job: DeckJobView }) {
  const status = String(job.status || '');
  const blocked = status === 'qa_blocked';
  const failed = status === 'failed';
  const completed = status === 'completed';
  const active = !isTerminalDeckJob(job);
  const round = Number(job.revision_round || 0);
  const maxRounds = Number(job.max_revision_rounds || 3);
  const qa = job.qa_summary;
  const latestMessage = job.latest_event_message || job.last_event_message || '';
  const findings = (job.qa_findings || []).slice(0, 3);
  const diagnostics = (job.diagnostic_document_cards || []).slice(0, 5);
  const statusTone = failed
    ? 'border-semantic-error/25 bg-semantic-error/5 text-semantic-error'
    : blocked
      ? 'border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#F59E0B]'
      : completed
        ? 'border-semantic-success/25 bg-semantic-success/5 text-semantic-success'
        : 'border-accent-magenta/25 bg-accent-magenta/5 text-accent-magenta';

  return (
    <div className={`rounded-lg border p-3 ${statusTone}`}>
      <div className="flex items-center gap-2">
        {active ? <MartyEmblem size={16} animate /> : completed ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{deckJobStatusLabel(job)}</div>
          {job.title && <div className="mt-0.5 truncate text-[11px] text-text-muted">{job.title}</div>}
        </div>
        {round > 0 && (
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-text-secondary">
            {Math.min(round, maxRounds)}/{maxRounds}
          </span>
        )}
      </div>
      {latestMessage && active && (
        <div className="mt-2 text-[11px] leading-relaxed text-text-secondary">{latestMessage}</div>
      )}
      {qa && (
        <div className="mt-2 grid grid-cols-4 gap-1.5 text-center text-[10px] text-text-secondary">
          <div className="rounded border border-white/[0.05] bg-bg-root/60 px-1.5 py-1">Critical {qa.critical || 0}</div>
          <div className="rounded border border-white/[0.05] bg-bg-root/60 px-1.5 py-1">High {qa.high || 0}</div>
          <div className="rounded border border-white/[0.05] bg-bg-root/60 px-1.5 py-1">Med {qa.medium || 0}</div>
          <div className="rounded border border-white/[0.05] bg-bg-root/60 px-1.5 py-1">Low {qa.low || 0}</div>
        </div>
      )}
      {blocked && (
        <div className="mt-2 text-[11px] leading-relaxed text-text-secondary">
          {job.blocked_reason || 'A usable draft deck is available, but visual/export QA needs review before treating it as polished.'}
        </div>
      )}
      {blocked && findings.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {findings.map((finding, index) => (
            <div key={`${finding.slideId || 'slide'}-${index}`} className="rounded border border-[#F59E0B]/20 bg-bg-root/50 px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
              <span className="font-semibold text-text-primary">{finding.slideId || 'Slide'}</span>
              {finding.issue ? `: ${finding.issue}` : ''}
              {finding.requiredFix ? <span className="text-text-muted"> · {finding.requiredFix}</span> : null}
            </div>
          ))}
        </div>
      )}
      {blocked && diagnostics.length > 0 && (
        <div className="mt-2 rounded border border-white/[0.05] bg-bg-root/45 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">Diagnostics</div>
          <div className="space-y-1">
            {diagnostics.map(card => (
              <div key={card.document_id} className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-secondary">
                <FileText size={12} className="shrink-0 text-text-muted" />
                <span className="truncate">{card.title || card.file_name || 'Diagnostic file'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DeckProductionPanel({ jobs }: { jobs?: DeckJobView[] }) {
  const normalized = (jobs || []).filter(job => job?.id);
  if (normalized.length === 0) return null;
  const active = normalized.find(job => !isTerminalDeckJob(job));
  const latest = active || normalized[normalized.length - 1];
  const completedCards = mergeDocumentCards(undefined, latest.visible_document_cards);

  return (
    <div className="mb-4 rounded-xl border border-[#8B5CF6]/25 bg-[#0F0D16]/80 p-3 shadow-[0_0_30px_rgba(139,92,246,0.08)]">
      <div className="mb-2 flex items-center gap-2">
        {!isTerminalDeckJob(latest) ? <MartyEmblem size={18} animate /> : latest.status === 'completed' ? <CheckCircle2 size={16} className="text-semantic-success" /> : latest.status === 'qa_blocked' ? <AlertCircle size={16} className="text-[#F59E0B]" /> : <AlertCircle size={16} className="text-semantic-error" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-text-primary" style={{ fontFamily: "'DM Sans', sans-serif" }}>
            Deck Production
          </div>
          <div className="truncate text-[11px] text-text-muted">{latest.title || 'Presentation deck'}</div>
        </div>
        {latest.revision_round ? (
          <span className="rounded-full border border-accent-magenta/20 bg-accent-magenta/10 px-2 py-0.5 text-[10px] font-semibold text-accent-magenta">
            {Math.min(Number(latest.revision_round), Number(latest.max_revision_rounds || 3))}/{Number(latest.max_revision_rounds || 3)}
          </span>
        ) : null}
      </div>
      <DeckJobProgress job={latest} />
      {latest.status === 'completed' && completedCards?.length ? (
        <div className="mt-3 text-[11px] text-text-muted">
          Polished downloads are available in the document cards below.
        </div>
      ) : null}
      {latest.status === 'qa_blocked' && completedCards?.length ? (
        <div className="mt-3 text-[11px] text-text-muted">
          Draft-review downloads are available in the document cards below. Use them as working files until visual QA is cleared.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolCallCard
// ---------------------------------------------------------------------------

function ToolCallCard({ tool, onToggle }: { tool: ToolCall; onToggle: () => void }) {
  const Icon = TOOL_ICONS[tool.tool] || FileText;
  const deckJob = deckJobFromTool(tool);
  const isDeckActive = Boolean(deckJob && !isTerminalDeckJob(deckJob));
  const isDeckBlocked = deckJob?.status === 'qa_blocked';
  const isRunning = tool.status === 'started' || tool.status === 'executing' || isDeckActive;
  const isError = tool.status === 'error' || deckJob?.status === 'failed';
  const isCancelled = tool.status === 'cancelled';
  const isDone = tool.status === 'done';
  const runs = getToolRuns(tool);
  const totalCount = aggregateResultCount(tool);

  return (
    <div className={`tool-slide-in rounded-lg border my-2 overflow-hidden transition-all ${
      isError ? 'border-semantic-error/30 bg-semantic-error/5' :
      isDeckBlocked ? 'border-[#F59E0B]/30 bg-[#F59E0B]/5' :
      isCancelled ? 'border-text-muted/20 bg-white/[0.02]' :
      isRunning ? 'border-[#8B5CF6]/30 tool-shimmer' :
      'border-border bg-[#111114]/80 backdrop-blur-sm'
    }`}>
      <button onClick={onToggle} className="flex items-center gap-2 w-full px-3 py-2 text-left">
        {isRunning ? (
          <MartyEmblem size={16} animate />
        ) : isError ? (
          <AlertCircle size={14} className="text-semantic-error shrink-0" />
        ) : isDeckBlocked ? (
          <AlertCircle size={14} className="text-[#F59E0B] shrink-0" />
        ) : isCancelled ? (
          <span className="h-3.5 w-3.5 rounded-[3px] bg-text-muted/70 shrink-0" />
        ) : (
          <CheckCircle2 size={14} className="text-semantic-success shrink-0 check-pop" />
        )}
        <Icon size={14} className={isRunning ? 'text-[#8B5CF6]' : 'text-text-muted'} style={{ flexShrink: 0 }} />
        <span className="text-xs text-text-secondary flex-1 truncate" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
          {toolLabel(tool.tool)}
        </span>
        {runs.length > 1 && (
          <span className="rounded-full border border-accent-magenta/20 bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent-magenta">
            {runs.length}x
          </span>
        )}
        {totalCount !== null && runs.length > 1 && (
          <span className="hidden sm:inline rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-text-muted">
            {totalCount} total
          </span>
        )}
        <span className={`text-[10px] ${
          isError ? 'text-semantic-error' : isDeckBlocked ? 'text-[#F59E0B]' : isRunning ? 'text-text-muted' : isDone ? 'text-semantic-success' : isCancelled ? 'text-text-muted' : 'text-text-muted'
        }`} style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
          {isDone && !isRunning && !isError && '\u2713 '}{toolStatusText(tool)}
        </span>
        {tool.collapsed ? <ChevronRight size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
      </button>
      {!tool.collapsed && (
        <div className="border-t border-border/50 px-3 py-2 space-y-1.5">
          {deckJob && <DeckJobProgress job={deckJob} />}
          {runs.map((run, index) => (
            <div key={run.id} className="rounded-md border border-white/[0.04] bg-white/[0.02] p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="text-[9px] uppercase text-text-muted font-semibold tracking-wider">
                  Run {index + 1}
                </div>
                <div className={`text-[10px] ${
                  run.status === 'error' ? 'text-semantic-error' :
                  run.status === 'done' ? 'text-semantic-success' :
                  run.status === 'cancelled' ? 'text-text-muted' :
                  'text-text-muted'
                }`}>
                  {run.status === 'done' && resultCountForRun(run) !== null
                    ? `Found ${resultCountForRun(run)} ${resultNoun(tool.tool)}`
                    : run.status}
                </div>
              </div>
              {run.input && (
                <div className="mb-1.5">
                  <div className="text-[9px] uppercase text-text-muted font-semibold tracking-wider mb-0.5">Input</div>
                  <pre className="text-[11px] text-text-secondary bg-bg-root rounded p-2 overflow-x-auto max-h-32">
                    {JSON.stringify(run.input, null, 2)}
                  </pre>
                </div>
              )}
              {run.result && (
                <div>
                  <div className="text-[9px] uppercase text-text-muted font-semibold tracking-wider mb-0.5">Result</div>
                  <pre className="text-[11px] text-text-secondary bg-bg-root rounded p-2 overflow-x-auto max-h-48">
                    {JSON.stringify(run.result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
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
                {session._running ? 'Working...' : formatRelative(session.last_activity_at)}
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
  const demoMode = useDemoMode();
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
  const activeSessionIdRef = React.useRef<string | null>(null);
  const streamSessionIdRef = React.useRef<string | null>(null);
  const streamRequestIdRef = React.useRef<string | null>(null);
  const streamAssistantMessageIdRef = React.useRef<string | null>(null);
  const streamAbortControllerRef = React.useRef<AbortController | null>(null);
  const sessionDraftsRef = React.useRef<Record<string, Message[]>>({});
  const provisionalSessionIdsRef = React.useRef<Set<string>>(new Set());
  const deletedSessionIdsRef = React.useRef<Set<string>>(new Set());
  const runningStreamsRef = React.useRef<Record<string, RunningMartyStream>>({});
  const deckJobPollersRef = React.useRef<Record<string, { stopped: boolean; lastSeq: number }>>({});
  const locallyCancelledRequestIdsRef = React.useRef<Set<string>>(new Set());
  const messagesSnapshotRef = React.useRef<Message[]>([]);
  const streamingRef = React.useRef(false);
  const skipNextFetchRef = React.useRef(false);
  const [runningSessionIds, setRunningSessionIds] = React.useState<string[]>([]);

  const [sidebarSearch, setSidebarSearch] = React.useState('');
  const [mobileSessionsOpen, setMobileSessionsOpen] = React.useState(false);
  const [copiedMsgId, setCopiedMsgId] = React.useState<string | null>(null);
  const [placeholderText, setPlaceholderText] = React.useState('Ask MARTy anything...');
  const [martyMode, setMartyMode] = React.useState<MartyMode>(readStoredMartyMode);
  const deepDive = martyMode === 'max';
  const maxModeShortcut = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '⌘⇧D' : 'Ctrl⇧D';

  React.useEffect(() => {
    try {
      localStorage.setItem(MARTY_MODE_STORAGE_KEY, martyMode);
    } catch { /* ignore */ }
  }, [martyMode]);

  // Fix 4: Explicit isThinking state — only cleared on first text token
  const [isThinking, setIsThinking] = React.useState(false);

  // MARTy Wave 1 cancellation. The server emits a request_id as the first
  // stream event; we POST it to /api/agent/cancel on stop / Esc / Cmd+Backspace.
  // Stored in a ref because we don't need React renders when it changes.
  const activeRequestIdRef = React.useRef<string | null>(null);
  const cancelledLocallyRef = React.useRef(false);

  const syncRunningIndicators = React.useCallback(() => {
    const ids = Object.keys(runningStreamsRef.current);
    const runs = Object.values(runningStreamsRef.current);
    const activeId = activeSessionIdRef.current;
    const activeRun = activeId ? runningStreamsRef.current[activeId] : null;
    const fallbackRun = ids.length === 1 ? runningStreamsRef.current[ids[0]] : null;
    const visibleRun = activeRun || fallbackRun || null;

    setRunningSessionIds(ids);
    setStreaming(ids.length > 0);
    streamingRef.current = ids.length > 0;
    if (visibleRun) {
      streamSessionIdRef.current = visibleRun.sessionId;
      streamRequestIdRef.current = visibleRun.requestId;
      streamAssistantMessageIdRef.current = visibleRun.assistantMessageId;
      streamAbortControllerRef.current = visibleRun.abortController || null;
      activeRequestIdRef.current = activeRun ? activeRun.requestId : null;
    } else {
      streamSessionIdRef.current = null;
      streamRequestIdRef.current = null;
      streamAssistantMessageIdRef.current = null;
      streamAbortControllerRef.current = null;
      activeRequestIdRef.current = null;
    }
    try {
      if (runs.length > 0) {
        const pendingRuns = runs.map(run => ({
          sessionId: run.sessionId,
          requestId: run.requestId,
          runId: run.runId || null,
          lastSeq: run.lastSeq || 0,
        }));
        localStorage.setItem(MARTY_PENDING_RUNS_STORAGE_KEY, JSON.stringify(pendingRuns));
        localStorage.setItem(MARTY_PENDING_STORAGE_KEY, JSON.stringify(pendingRuns[0]));
        window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: true } }));
      } else {
        localStorage.removeItem(MARTY_PENDING_RUNS_STORAGE_KEY);
        localStorage.removeItem(MARTY_PENDING_STORAGE_KEY);
        window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: false } }));
      }
    } catch { /* ignore */ }
  }, []);

  const registerRunningStream = React.useCallback((run: RunningMartyStream) => {
    runningStreamsRef.current = { ...runningStreamsRef.current, [run.sessionId]: run };
    syncRunningIndicators();
  }, [syncRunningIndicators]);

  const clearRunningStream = React.useCallback((sessionId: string | null | undefined, requestId?: string | null) => {
    if (!sessionId) return;
    const current = runningStreamsRef.current[sessionId];
    if (!current) return;
    if (requestId && current.requestId !== requestId && current.clientRequestId !== requestId) return;
    const next = { ...runningStreamsRef.current };
    delete next[sessionId];
    runningStreamsRef.current = next;
    syncRunningIndicators();
  }, [syncRunningIndicators]);

  const cancelSessionStream = React.useCallback((targetSessionId?: string | null): string | null => {
    const sessionId = targetSessionId || activeSessionIdRef.current || streamSessionIdRef.current;
    if (!sessionId) return null;
    const run = runningStreamsRef.current[sessionId];
    const reqId = run?.requestId || (streamSessionIdRef.current === sessionId ? streamRequestIdRef.current : null);
    const assistantMessageId = run?.assistantMessageId || (streamSessionIdRef.current === sessionId ? streamAssistantMessageIdRef.current : null);
    if (!reqId) return null;
    cancelledLocallyRef.current = true;
    locallyCancelledRequestIdsRef.current.add(reqId);
    if (run?.clientRequestId) locallyCancelledRequestIdsRef.current.add(run.clientRequestId);
    api.cancelAgentQuery({ request_id: reqId, run_id: run?.runId || null, session_id: sessionId }).catch(() => {});
    run?.abortController?.abort();

    if (sessionId) {
      const markCancelled = (current: Message[]) => current.map(msg => {
        const isTarget = assistantMessageId ? msg.id === assistantMessageId : (msg.role === 'assistant' && msg.streaming);
        if (!isTarget) return msg;
        return {
          ...msg,
          content: msg.content || '_(stopped)_',
          streaming: false,
          cancelled: true,
          toolCalls: cancelRunningToolCalls(msg.toolCalls),
        };
      });
      const current = sessionDraftsRef.current[sessionId]
        || (activeSessionIdRef.current === sessionId ? messagesSnapshotRef.current : []);
      const next = markCancelled(current);
      sessionDraftsRef.current = { ...sessionDraftsRef.current, [sessionId]: next };
      if (activeSessionIdRef.current === sessionId) setMessages(next);
    }

    clearRunningStream(sessionId, reqId);
    if (activeSessionIdRef.current === sessionId) setIsThinking(false);
    if (pendingSessionIdRef.current === sessionId) pendingSessionIdRef.current = null;
    if (liveSessionIdRef.current === sessionId) liveSessionIdRef.current = null;
    try {
      const nextRunningIds = Object.keys(runningStreamsRef.current);
      if (nextRunningIds.length === 0) {
        localStorage.removeItem(MARTY_PENDING_STORAGE_KEY);
        window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: false } }));
      }
    } catch { /* ignore */ }
    return reqId;
  }, [clearRunningStream]);

  const cancelActiveStream = React.useCallback((): string | null => (
    cancelSessionStream(activeSessionIdRef.current || streamSessionIdRef.current)
  ), [cancelSessionStream]);

  // Global Esc / Cmd+Backspace cancel while streaming. Esc only fires when
  // no input/textarea is focused so it doesn't fight with the input's own
  // Escape behavior. Cmd+Backspace works regardless (power-user shortcut).
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const activeId = activeSessionIdRef.current || streamSessionIdRef.current;
      const activeRun = activeId ? runningStreamsRef.current[activeId] : null;
      if (!activeRun?.requestId) return;
      const target = e.target as HTMLElement | null;
      const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape' && !inField) {
        e.preventDefault();
        cancelSessionStream(activeRun.sessionId);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
        e.preventDefault();
        cancelSessionStream(activeRun.sessionId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [cancelSessionStream]);

  // Citation source side panel
  const [activeSource, setActiveSource] = React.useState<CitationSource | null>(null);
  const activeSourceMessageIdRef = React.useRef<string | null>(null);

  const showToast = React.useCallback((msg: string) => {
    setUploadToast(msg);
    setTimeout(() => setUploadToast(null), 3500);
  }, []);

  const syncSessionUploadState = React.useCallback((uploads: ChatUploadSummary[]) => {
    setSessionUploads(uploads);
    setBytesTotal(uploads.reduce((acc, u) => acc + u.size_bytes, 0));
    setBytesUsed(uploads.filter(u => u.in_context).reduce((acc, u) => acc + u.size_bytes, 0));
  }, []);

  const handleDocumentAttachedToMarty = React.useCallback((result: { upload_id: string; session_id: string; summary: ChatUploadSummary }) => {
    setActiveSessionId(result.session_id);
    setSessionUploads(prev => [...prev.filter(u => u.id !== result.summary.id), result.summary]);
    api.listSessionUploads(result.session_id).then(d => {
      syncSessionUploadState(d.uploads);
    }).catch(() => { /* keep optimistic attachment */ });
    showToast(`${result.summary.filename} added to this MARTy conversation.`);
  }, [showToast, syncSessionUploadState]);

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

  React.useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    syncRunningIndicators();
    const activeDraft = activeSessionId ? sessionDraftsRef.current[activeSessionId] : null;
    const runningMessage = activeDraft ? getRunningAssistantMessage(activeDraft) : null;
    setIsThinking(Boolean(activeSessionId && runningStreamsRef.current[activeSessionId] && !runningMessage?.content));
  }, [activeSessionId, syncRunningIndicators]);

  React.useEffect(() => {
    messagesSnapshotRef.current = messages;
  }, [messages]);

  const sortSidebarSessions = React.useCallback((items: any[]) => {
    return [...items].sort((a, b) => {
      const at = Date.parse(a.last_activity_at || a.created_at || '') || 0;
      const bt = Date.parse(b.last_activity_at || b.created_at || '') || 0;
      return bt - at;
    });
  }, []);

  const upsertSessionInSidebar = React.useCallback((session: any) => {
    if (!session?.id) return;
    setSessions(prev => {
      if (deletedSessionIdsRef.current.has(session.id)) return prev;
      const existing = prev.find(s => s.id === session.id);
      const merged = {
        ...(existing || {}),
        ...session,
        title: session.title || existing?.title,
        last_activity_at: session.last_activity_at || new Date().toISOString(),
        created_at: session.created_at || existing?.created_at || session.last_activity_at || new Date().toISOString(),
      };
      const next = [merged, ...prev.filter(s => s.id !== merged.id)];
      return sortSidebarSessions(next);
    });
  }, [sortSidebarSessions]);

  const mergeSessionsFromServer = React.useCallback((serverSessions: any[]) => {
    setSessions(prev => {
      const serverById = new Map<string, any>();
      for (const session of serverSessions || []) {
        if (!session?.id || deletedSessionIdsRef.current.has(session.id)) continue;
        serverById.set(session.id, session);
      }

      const mergedById = new Map<string, any>();
      for (const existing of prev) {
        if (!existing?.id || deletedSessionIdsRef.current.has(existing.id)) continue;
        const server = serverById.get(existing.id);
        if (server) {
          mergedById.set(existing.id, {
            ...existing,
            ...server,
            title: server.title || existing.title,
            created_at: server.created_at || existing.created_at,
            last_activity_at: server.last_activity_at || existing.last_activity_at,
            _optimistic: false,
          });
          serverById.delete(existing.id);
          continue;
        }

        const hasLocalDraft = Array.isArray(sessionDraftsRef.current[existing.id]);
        const isLive = Boolean(runningStreamsRef.current[existing.id])
          || existing.id === activeSessionIdRef.current
          || provisionalSessionIdsRef.current.has(existing.id)
          || existing._optimistic;
        if (hasLocalDraft || isLive) {
          mergedById.set(existing.id, existing);
        }
      }

      for (const server of serverById.values()) {
        mergedById.set(server.id, { ...server, _optimistic: false });
      }

      return sortSidebarSessions(Array.from(mergedById.values()));
    });
  }, [sortSidebarSessions]);

  const removeSessionFromSidebar = React.useCallback((sessionId: string) => {
    deletedSessionIdsRef.current.add(sessionId);
    provisionalSessionIdsRef.current.delete(sessionId);
    const nextDrafts = { ...sessionDraftsRef.current };
    delete nextDrafts[sessionId];
    sessionDraftsRef.current = nextDrafts;
    setSessions(prev => prev.filter(s => s.id !== sessionId));
  }, []);

  const optimisticSessionTitle = React.useCallback((text: string) => {
    const cleaned = text
      .replace(/\s+/g, ' ')
      .replace(/^(please|can you|could you|i need you to|i need to)\s+/i, '')
      .trim();
    return cleaned ? cleaned.slice(0, 72) : 'New Session';
  }, []);

  const updateSessionDraft = React.useCallback((
    sessionId: string,
    updater: Message[] | ((current: Message[]) => Message[])
  ) => {
    const current = sessionDraftsRef.current[sessionId]
      || (activeSessionIdRef.current === sessionId ? messagesSnapshotRef.current : []);
    const next = typeof updater === 'function' ? updater(current) : updater;
    sessionDraftsRef.current = { ...sessionDraftsRef.current, [sessionId]: next };
    if (activeSessionIdRef.current === sessionId) {
      setMessages(next);
    }
    return next;
  }, []);

  const mergeDeckJobIntoSession = React.useCallback((
    sessionId: string,
    job: DeckJobView,
    events: Array<{ seq: number; event_type: string; payload: any; created_at: string }>
  ) => {
    const visibleCards = mergeDocumentCards(undefined, job.visible_document_cards);
    const latestEventMessage = [...(events || [])]
      .reverse()
      .map(event => event?.payload?.message)
      .find(message => typeof message === 'string' && message.trim());
    const jobWithEvent: DeckJobView = latestEventMessage
      ? { ...job, latest_event_message: latestEventMessage }
      : job;
    updateSessionDraft(sessionId, current => current.map(msg => {
      let changed = false;
      const targetsThisMessage = !job.assistant_message_id || job.assistant_message_id === msg.id;
      const existingDeckJobs = msg.deckJobs || [];
      const deckJobIndex = existingDeckJobs.findIndex(existing => existing.id === job.id);
      const deckJobs = deckJobIndex >= 0
        ? existingDeckJobs.map(existing => existing.id === job.id ? { ...existing, ...jobWithEvent } : existing)
        : [...existingDeckJobs, jobWithEvent];
      const toolCalls = (msg.toolCalls || []).map(tool => {
        if (tool.tool !== 'create_deck_artifact') return tool;
        let toolChanged = false;
        const runs = getToolRuns(tool).map(run => {
          const existing = deckJobFromResult(run.result);
          if (!existing || existing.id !== job.id) return run;
          changed = true;
          toolChanged = true;
          return {
            ...run,
            result: {
              ...(run.result || {}),
              deck_job_id: jobWithEvent.id,
              deck_job: jobWithEvent,
              deck_job_events: events.slice(-20),
            },
          };
        });
        const existing = deckJobFromResult(tool.result);
        const result = existing?.id === job.id
          ? { ...(tool.result || {}), deck_job_id: jobWithEvent.id, deck_job: jobWithEvent, deck_job_events: events.slice(-20) }
          : tool.result;
        if (existing?.id === job.id) {
          changed = true;
          toolChanged = true;
        }
        return {
          ...tool,
          result,
          runs,
          pulseKey: (tool.pulseKey || 0) + (toolChanged ? 1 : 0),
        };
      });
      const shouldAttachToMessage = changed
        || deckJobIndex >= 0
        || (targetsThisMessage && msg.role === 'assistant' && msg.id === current[current.length - 1]?.id);
      if (!shouldAttachToMessage) return msg;
      return {
        ...msg,
        toolCalls,
        deckJobs,
        documentCards: visibleCards?.length ? mergeDocumentCards(msg.documentCards, visibleCards) : msg.documentCards,
      };
    }));
  }, [updateSessionDraft]);

  const startDeckJobPolling = React.useCallback((sessionId: string, jobId: string, initialSeq = 0) => {
    if (!jobId || deckJobPollersRef.current[jobId]) return;
    const poller = { stopped: false, lastSeq: Math.max(0, Number(initialSeq || 0)) };
    deckJobPollersRef.current[jobId] = poller;

    const loop = async () => {
      while (!poller.stopped) {
        try {
          const result = await api.getDeckJobEvents(jobId, poller.lastSeq, 25_000);
          if (poller.stopped) break;
          if (typeof result.latest_seq === 'number') poller.lastSeq = Math.max(poller.lastSeq, result.latest_seq);
          if (result.job) {
            mergeDeckJobIntoSession(sessionId, result.job as DeckJobView, result.events || []);
            if (isTerminalDeckJob(result.job as DeckJobView)) break;
          }
        } catch {
          await new Promise(resolve => setTimeout(resolve, 2500));
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 600));
      }
      delete deckJobPollersRef.current[jobId];
    };
    void loop();
  }, [mergeDeckJobIntoSession]);

  React.useEffect(() => {
    const sessionMessages: Record<string, Message[]> = { ...sessionDraftsRef.current };
    if (activeSessionId) sessionMessages[activeSessionId] = messagesSnapshotRef.current;
    for (const [sessionId, draftMessages] of Object.entries(sessionMessages)) {
      for (const msg of draftMessages || []) {
        for (const job of msg.deckJobs || []) {
          if (job && !isTerminalDeckJob(job)) startDeckJobPolling(sessionId, job.id, job.last_event_seq || 0);
        }
        for (const tool of msg.toolCalls || []) {
          const job = deckJobFromTool(tool);
          if (job && !isTerminalDeckJob(job)) startDeckJobPolling(sessionId, job.id, job.last_event_seq || 0);
        }
      }
    }
  }, [activeSessionId, messages, startDeckJobPolling]);

  React.useEffect(() => {
    return () => {
      Object.values(deckJobPollersRef.current).forEach(poller => {
        poller.stopped = true;
      });
      deckJobPollersRef.current = {};
    };
  }, []);

  const selectSession = React.useCallback((sessionId: string) => {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setMobileSessionsOpen(false);
    const draft = sessionDraftsRef.current[sessionId];
    if (draft) {
      setMessages(draft);
      skipNextFetchRef.current = provisionalSessionIdsRef.current.has(sessionId) || Boolean(runningStreamsRef.current[sessionId]);
    } else {
      setMessages([]);
    }
  }, []);

  const startNewSessionView = React.useCallback(() => {
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    setMessages([]);
    setSessionUploads([]);
    setBytesUsed(0);
    setBytesTotal(0);
    setPendingUploads([]);
    setMobileSessionsOpen(false);
    setShowSparkles(true);
    setTimeout(() => setShowSparkles(false), 1200);
  }, []);

  // Fix 1: Agile auto-scroll — respect user's scroll position
  const userScrolledUpRef = React.useRef(false);

  const applyServerMessages = React.useCallback((rows: any[], sessionIdForPending?: string | null) => {
    const targetSessionId = sessionIdForPending || activeSessionIdRef.current;
    const localMessages = targetSessionId
      ? (sessionDraftsRef.current[targetSessionId] || (activeSessionIdRef.current === targetSessionId ? messagesSnapshotRef.current : []))
      : messagesSnapshotRef.current;
    const nextMessages = preserveHydratedLocalUiState(hydrateAgentMessages(rows), localMessages);
    const runningMessage = getRunningAssistantMessage(nextMessages);
    const existingRun = targetSessionId ? runningStreamsRef.current[targetSessionId] : null;
    if (targetSessionId && !runningMessage?.pendingRequestId && existingRun?.abortController) {
      return getRunningAssistantMessage(sessionDraftsRef.current[targetSessionId] || messagesSnapshotRef.current) || runningMessage;
    }
    if (sessionIdForPending) {
      sessionDraftsRef.current = { ...sessionDraftsRef.current, [sessionIdForPending]: nextMessages };
    }
    if (!sessionIdForPending || activeSessionIdRef.current === sessionIdForPending) {
      setMessages(nextMessages);
    }
    if (runningMessage?.pendingRequestId) {
      if (targetSessionId) {
        registerRunningStream({
          sessionId: targetSessionId,
          requestId: runningMessage.pendingRequestId,
          assistantMessageId: runningMessage.id,
        });
      }
      if (targetSessionId && activeSessionIdRef.current === targetSessionId) {
        setIsThinking(!runningMessage.content);
      }
    } else if (targetSessionId) {
      clearRunningStream(targetSessionId);
      if (activeSessionIdRef.current === targetSessionId) setIsThinking(false);
    }
    return runningMessage;
  }, [clearRunningStream, registerRunningStream]);

  const refreshSessionFromServer = React.useCallback(async (sessionId: string) => {
    const d = await api.getSessionMessages(sessionId);
    const runningMessage = applyServerMessages(d.messages, sessionId);
    if (!runningMessage?.pendingRequestId && activeSessionIdRef.current === sessionId) {
      setIsThinking(false);
    }
    api.listSessions().then(d2 => mergeSessionsFromServer(d2.sessions)).catch(() => {});
    return runningMessage;
  }, [applyServerMessages, mergeSessionsFromServer]);

  React.useEffect(() => {
    document.title = 'MARTy \u2014 Medina Intelligence';
    setSessionsLoading(true);
    if (demoMode) {
      setSessions(demoMartySessions);
      setSessionsLoading(false);
    } else {
      api.listSessions().then(d => { mergeSessionsFromServer(d.sessions); setSessionsLoading(false); }).catch(() => setSessionsLoading(false));
    }
    const t = setTimeout(() => setShowSparkles(false), 1200);

    try {
      const pendingRunsRaw = localStorage.getItem(MARTY_PENDING_RUNS_STORAGE_KEY);
      const legacyPendingRaw = localStorage.getItem(MARTY_PENDING_STORAGE_KEY);
      const pendingRuns = pendingRunsRaw
        ? JSON.parse(pendingRunsRaw)
        : legacyPendingRaw
          ? [JSON.parse(legacyPendingRaw)]
          : [];
      if (!demoMode && Array.isArray(pendingRuns) && pendingRuns.length > 0) {
        let adoptedFirstSession = false;
        for (const pendingRun of pendingRuns) {
          const sessionId = pendingRun?.sessionId;
          if (!sessionId || deletedSessionIdsRef.current.has(sessionId)) continue;
          if (!adoptedFirstSession) {
            setActiveSessionId(sessionId);
            adoptedFirstSession = true;
          }
          api.getSessionMessages(sessionId).then(d => {
            applyServerMessages(d.messages, sessionId);
          }).catch(e => {
            clearRunningStream(sessionId);
            if (isSessionNotFoundError(e)) {
              upsertSessionInSidebar({
                id: sessionId,
                title: 'Repairing session...',
                last_activity_at: new Date().toISOString(),
              });
              updateSessionDraft(sessionId, current => current.length > 0 ? current : [{
                id: crypto.randomUUID(),
                role: 'assistant',
                content: 'This chat is repairing its server record. Your visible draft is preserved; retry once the session list refreshes.',
                error: true,
                retryable: true,
              }]);
              api.listSessions().then(d => mergeSessionsFromServer(d.sessions)).catch(() => {});
            }
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
        if (!demoMode && incomingSession) {
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
  }, [applyServerMessages, clearRunningStream, demoMode, mergeSessionsFromServer, removeSessionFromSidebar]);

  React.useEffect(() => {
    if (!activeSessionId && messages.length === 0) {
      setEmptyMounted(false);
      requestAnimationFrame(() => setEmptyMounted(true));
    }
  }, [activeSessionId, messages.length]);

  streamingRef.current = streaming;

  React.useEffect(() => {
    if (demoMode) {
      if (activeSessionId) {
        const demoSession = demoMartySessions.find(s => s.id === activeSessionId);
        setMessages(((demoSession as any)?.demoMessages || []) as Message[]);
      } else {
        setMessages([]);
      }
      setSessionUploads([]);
      setBytesUsed(0);
      setBytesTotal(0);
      setPendingUploads([]);
      return;
    }
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false;
      return;
    }
    if (activeSessionId) {
      const draft = sessionDraftsRef.current[activeSessionId];
      const isProvisional = provisionalSessionIdsRef.current.has(activeSessionId);
      const isRunningLocally = Boolean(runningStreamsRef.current[activeSessionId]?.abortController);
      if (draft) {
        setMessages(draft);
      }
      if (!isProvisional && !isRunningLocally) {
        api.getSessionMessages(activeSessionId).then(d => {
          applyServerMessages(d.messages, activeSessionId);
          if (d.session) upsertSessionInSidebar(d.session);
        }).catch(e => {
        if (isSessionNotFoundError(e)) {
          const missingSessionId = activeSessionId;
          clearRunningStream(missingSessionId);
          upsertSessionInSidebar({
            id: missingSessionId,
            title: sessions.find(s => s.id === missingSessionId)?.title || 'Repairing session...',
            last_activity_at: new Date().toISOString(),
          });
          updateSessionDraft(missingSessionId, current => current.length > 0 ? current : [{
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'This chat is temporarily unavailable on the server. I kept it visible here while MARTy repairs or refreshes the session list.',
            error: true,
            retryable: true,
          }]);
          api.listSessions().then(d => mergeSessionsFromServer(d.sessions)).catch(() => {});
        }
        });
      }
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
  }, [activeSessionId, applyServerMessages, clearRunningStream, demoMode, mergeSessionsFromServer, removeSessionFromSidebar, upsertSessionInSidebar]);

  React.useEffect(() => {
    if (demoMode || !activeSessionId) return;
    const runningMessage = getRunningAssistantMessage(messages);
    if (!runningMessage?.pendingRequestId) return;
    if (runningStreamsRef.current[activeSessionId]?.abortController) return;

    let stopped = false;
    const refreshPendingTurn = async () => {
      try {
        const d = await api.getSessionMessages(activeSessionId);
        if (stopped) return;
        const nextMessages = hydrateAgentMessages(d.messages);
        const stillRunning = getRunningAssistantMessage(nextMessages);
        sessionDraftsRef.current = { ...sessionDraftsRef.current, [activeSessionId]: nextMessages };
        if (activeSessionIdRef.current === activeSessionId) setMessages(nextMessages);
        if (stillRunning?.pendingRequestId) {
          registerRunningStream({
            sessionId: activeSessionId,
            requestId: stillRunning.pendingRequestId,
            assistantMessageId: stillRunning.id,
          });
          if (activeSessionIdRef.current === activeSessionId) setIsThinking(true);
          return;
        }
        clearRunningStream(activeSessionId);
        if (activeSessionIdRef.current === activeSessionId) setIsThinking(false);
        api.listSessions().then(d2 => mergeSessionsFromServer(d2.sessions)).catch(() => {});
      } catch (e) {
        if (isSessionNotFoundError(e)) {
          const missingSessionId = activeSessionId;
          clearRunningStream(missingSessionId);
          if (activeSessionIdRef.current === missingSessionId) setIsThinking(false);
          upsertSessionInSidebar({
            id: missingSessionId,
            title: sessions.find(s => s.id === missingSessionId)?.title || 'Repairing session...',
            last_activity_at: new Date().toISOString(),
          });
          updateSessionDraft(missingSessionId, current => current.length > 0 ? current : [{
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'This chat is repairing its server state. I kept the local transcript visible instead of dropping it from the sidebar.',
            error: true,
            retryable: true,
          }]);
          api.listSessions().then(d2 => mergeSessionsFromServer(d2.sessions)).catch(() => {});
          return;
        }
        // Keep the visible pending state. A later poll or manual refresh can
        // recover the finalized assistant turn.
      }
    };

    const timer = window.setInterval(refreshPendingTurn, 2500);
    refreshPendingTurn();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeSessionId, clearRunningStream, demoMode, mergeSessionsFromServer, messages, registerRunningStream, removeSessionFromSidebar]);

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
      if (demoMode) {
        removeSessionFromSidebar(sessionId);
        if (activeSessionId === sessionId) { setActiveSessionId(null); setMessages([]); }
        return;
      }
      await api.deleteSession(sessionId);
      removeSessionFromSidebar(sessionId);
      if (activeSessionId === sessionId) { setActiveSessionId(null); setMessages([]); }
    } catch { /* ignore */ }
    finally { setDeletingId(null); setDeleteConfirmId(null); }
  }

  async function handleRenameSession(sessionId: string) {
    const trimmed = editTitleValue.trim();
    if (!trimmed) { setEditingTitleId(null); return; }
    try {
      if (demoMode) {
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title: trimmed } : s));
        return;
      }
      await api.renameSession(sessionId, trimmed);
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title: trimmed } : s));
    } catch { /* ignore */ }
    finally { setEditingTitleId(null); }
  }

  function handleCopyMessage(msgId: string, content: string) {
    const role = messages.find(m => m.id === msgId)?.role;
    navigator.clipboard.writeText(role === 'assistant' ? normalizeMartySentenceSpacing(content) : content);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId(null), 2000);
  }

  function retryFrom(assistantMsgId: string) {
    if (activeSessionId && runningSessionIds.includes(activeSessionId)) return;
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
    const trimmedQuery = queryText.trim();
    if (!trimmedQuery) return;

    // Blue-chip interrupt behavior: a new prompt steers only the current chat.
    // Background chats keep running so users can work across sessions.
    let interruptRequestId: string | null = null;
    const activeRun = activeSessionId ? runningStreamsRef.current[activeSessionId] : null;
    if (activeRun?.requestId) {
      interruptRequestId = cancelSessionStream(activeSessionId);
    }

    // Trust the server before accepting a new turn. A previous MAX request can
    // keep working after the browser stream has dropped; if so, treat this
    // prompt as a server-side interrupt and continue with the replacement turn.
    if (!demoMode && activeSessionId) {
      try {
        const d = await api.getSessionMessages(activeSessionId);
        const serverMessages = hydrateAgentMessages(d.messages);
        const runningMessage = getRunningAssistantMessage(serverMessages);
        if (runningMessage?.pendingRequestId) {
          applyServerMessages(d.messages, activeSessionId);
          interruptRequestId = cancelSessionStream(activeSessionId) || runningMessage.pendingRequestId;
        }
      } catch {
        // Existing recovery paths handle stale sessions below.
      }
    }

    cancelledLocallyRef.current = false;
    lastSentQueryRef.current = trimmedQuery;

    // Fix 4: Set isThinking immediately on send
    setIsThinking(true);

    setSendPulse(true);
    setTimeout(() => setSendPulse(false), 300);

    // Reset scroll lock on new message
    userScrolledUpRef.current = false;

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const clientRequestId = crypto.randomUUID();
    const abortController = new AbortController();
    const now = new Date().toISOString();
    const creatingNewSession = !activeSessionId;
    let requestSessionId: string | null = activeSessionId || crypto.randomUUID();

    // Snapshot pending uploads for this turn — only those that finished
    // uploading without error make it into the message bubble + the request.
    const turnUploads = pendingUploads
      .filter(u => u.serverId && u.summary && !u.failed)
      .map(u => u.summary!) as ChatUploadSummary[];
    const uploadIds = turnUploads.map(u => u.id);

    const baseMessages = !creatingNewSession && activeSessionId
      ? (sessionDraftsRef.current[activeSessionId] || messagesSnapshotRef.current)
      : messagesSnapshotRef.current;
    const optimisticMessages = [
      ...baseMessages,
      { id: userMsgId, role: 'user', content: trimmedQuery, timestamp: now,
        attachments: turnUploads.length > 0 ? turnUploads : undefined },
      { id: assistantMsgId, role: 'assistant', content: '', streaming: true, toolCalls: [], timestamp: now, pendingRequestId: clientRequestId },
    ] as Message[];
    setMessages(optimisticMessages);
    setInput('');
    setPlaceholderText('Ask MARTy anything...');

    if (!demoMode && creatingNewSession && requestSessionId) {
      const provisionalSession = {
        id: requestSessionId,
        title: optimisticSessionTitle(trimmedQuery),
        last_activity_at: now,
        created_at: now,
        _optimistic: true,
      };
      provisionalSessionIdsRef.current.add(requestSessionId);
      sessionDraftsRef.current = { ...sessionDraftsRef.current, [requestSessionId]: optimisticMessages };
      activeSessionIdRef.current = requestSessionId;
      setActiveSessionId(requestSessionId);
      pendingSessionIdRef.current = requestSessionId;
      liveSessionIdRef.current = requestSessionId;
      upsertSessionInSidebar(provisionalSession);
      try {
        localStorage.setItem(MARTY_PENDING_STORAGE_KEY, JSON.stringify({ sessionId: requestSessionId, requestId: clientRequestId }));
        window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: true } }));
      } catch { /* ignore */ }
    }

    if (!demoMode && requestSessionId) {
      registerRunningStream({
        sessionId: requestSessionId,
        requestId: clientRequestId,
        assistantMessageId: assistantMsgId,
        abortController,
        clientRequestId,
      });
    }

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    const file = attachedFile;
    const isDeepDive = deepDive;
    setAttachedFile(null);
    setPendingUploads([]);

    if (demoMode) {
      window.setTimeout(() => {
        setIsThinking(false);
        setMessages(m => m.map(msg =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                content: 'Demo mode is using safe synthetic data for filming. No production emails, documents, contacts, deals, or chat sessions were queried or changed.',
                streaming: false,
                justFinished: true,
              }
            : msg
        ));
        setStreaming(false);
        setTimeout(() => {
          setMessages(m => m.map(msg =>
            msg.id === assistantMsgId ? { ...msg, justFinished: false } : msg
          ));
        }, 1000);
      }, 450);
      return;
    }

    try {
      if (creatingNewSession) {
        const provisionalId = requestSessionId!;
        const created = await api.createSession({ client_session_id: provisionalId });
        requestSessionId = created.session.id as string;
        const confirmedSessionId = requestSessionId;
        provisionalSessionIdsRef.current.delete(provisionalId);
        liveSessionIdRef.current = confirmedSessionId;
        pendingSessionIdRef.current = confirmedSessionId;
        const establishedAt = new Date().toISOString();
        if (confirmedSessionId !== provisionalId) {
          const draft = sessionDraftsRef.current[provisionalId];
          const provisionalRun = runningStreamsRef.current[provisionalId];
          if (draft) {
            const nextDrafts = { ...sessionDraftsRef.current, [confirmedSessionId]: draft };
            delete nextDrafts[provisionalId];
            sessionDraftsRef.current = nextDrafts;
          }
          if (provisionalRun) {
            const nextRuns = { ...runningStreamsRef.current };
            delete nextRuns[provisionalId];
            runningStreamsRef.current = nextRuns;
            registerRunningStream({ ...provisionalRun, sessionId: confirmedSessionId });
          }
          setSessions(prev => prev.filter(s => s.id !== provisionalId));
          if (activeSessionIdRef.current === provisionalId) {
            activeSessionIdRef.current = confirmedSessionId;
            setActiveSessionId(confirmedSessionId);
          }
        }
        upsertSessionInSidebar({
          ...created.session,
          title: created.session.title || optimisticSessionTitle(trimmedQuery),
          last_activity_at: created.session.last_activity_at || establishedAt,
          created_at: created.session.created_at || establishedAt,
          _optimistic: false,
        });
        sessionDraftsRef.current = { ...sessionDraftsRef.current, [confirmedSessionId]: optimisticMessages };
        if (activeSessionIdRef.current === provisionalId || activeSessionIdRef.current === confirmedSessionId) {
          activeSessionIdRef.current = confirmedSessionId;
          setActiveSessionId(confirmedSessionId);
        }
        localStorage.setItem(MARTY_PENDING_STORAGE_KEY, JSON.stringify({ sessionId: confirmedSessionId, requestId: clientRequestId }));
        window.dispatchEvent(new CustomEvent('marty-pending-change', { detail: { pending: true } }));
      } else {
        upsertSessionInSidebar({
          id: requestSessionId,
          title: sessions.find(s => s.id === requestSessionId)?.title,
          last_activity_at: now,
          created_at: sessions.find(s => s.id === requestSessionId)?.created_at || now,
        });
        sessionDraftsRef.current = { ...sessionDraftsRef.current, [requestSessionId as string]: optimisticMessages };
      }
      registerRunningStream({
        sessionId: requestSessionId!,
        requestId: clientRequestId,
        assistantMessageId: assistantMsgId,
        abortController,
        clientRequestId,
      });

      await streamAgentQuery(
        trimmedQuery, requestSessionId, null, null, file, isDeepDive,
        token => {
          if (typeof token === 'string') {
            if (activeSessionIdRef.current === requestSessionId) setIsThinking(false);
            updateSessionDraft(requestSessionId!, m => m.map(msg =>
              msg.id === assistantMsgId ? { ...msg, content: msg.content + token } : msg
            ));
          }
        },
        () => {
          const finalSessionId = requestSessionId!;
          const activeRun = runningStreamsRef.current[finalSessionId];
          const actualRequestId = activeRun?.requestId || clientRequestId;
          const wasCancelled = locallyCancelledRequestIdsRef.current.has(clientRequestId)
            || locallyCancelledRequestIdsRef.current.has(actualRequestId);
          locallyCancelledRequestIdsRef.current.delete(clientRequestId);
          locallyCancelledRequestIdsRef.current.delete(actualRequestId);
          cancelledLocallyRef.current = false;
          clearRunningStream(finalSessionId, clientRequestId);
          if (activeSessionIdRef.current === finalSessionId) setIsThinking(false);
          updateSessionDraft(requestSessionId!, m => m.map(msg => {
            if (msg.id !== assistantMsgId) return msg;
            if (wasCancelled) {
              const placeholder = normalizeMartySentenceSpacing(msg.content || '_(cancelled before MARTy started generating)_');
              return { ...msg, content: placeholder, streaming: false, pendingRequestId: undefined, cancelled: true, toolCalls: cancelRunningToolCalls(msg.toolCalls) };
            }
            if (!msg.content && (!msg.toolCalls || msg.toolCalls.length === 0)) {
              return { ...msg, content: 'Something went wrong — no response was received. Please try again.', streaming: false, pendingRequestId: undefined, error: true };
            }
            return { ...msg, content: normalizeMartySentenceSpacing(msg.content), streaming: false, pendingRequestId: undefined, justFinished: true };
          }));
          if (pendingSessionIdRef.current === finalSessionId) {
            pendingSessionIdRef.current = null;
          }
          if (liveSessionIdRef.current === finalSessionId) {
            liveSessionIdRef.current = null;
          }
          api.listSessions().then(d => mergeSessionsFromServer(d.sessions));
          setTimeout(() => {
            updateSessionDraft(requestSessionId!, m => m.map(msg =>
              msg.id === assistantMsgId ? { ...msg, justFinished: false } : msg
            ));
          }, 1000);
        },
        (err, opts: AgentSendErrorOptions = {}) => {
          const finalSessionId = requestSessionId!;
          const activeRun = runningStreamsRef.current[finalSessionId];
          const actualRequestId = opts.requestId || activeRun?.requestId || clientRequestId;
          const wasLocallyCancelled = opts.code === 'CLIENT_ABORT'
            || locallyCancelledRequestIdsRef.current.has(clientRequestId)
            || locallyCancelledRequestIdsRef.current.has(actualRequestId);
          if (wasLocallyCancelled) {
            locallyCancelledRequestIdsRef.current.delete(clientRequestId);
            locallyCancelledRequestIdsRef.current.delete(actualRequestId);
            cancelledLocallyRef.current = false;
            clearRunningStream(finalSessionId, actualRequestId);
            if (activeSessionIdRef.current === finalSessionId) setIsThinking(false);
            updateSessionDraft(requestSessionId!, m => m.map(msg =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: msg.content || '_(stopped)_',
                    streaming: false,
                    pendingRequestId: undefined,
                    cancelled: true,
                    toolCalls: cancelRunningToolCalls(msg.toolCalls),
                  }
                : msg
            ));
            if (pendingSessionIdRef.current === finalSessionId) pendingSessionIdRef.current = null;
            if (liveSessionIdRef.current === finalSessionId) liveSessionIdRef.current = null;
            return;
          }
          const staleSession = opts.code === 'SESSION_NOT_FOUND' || err.includes('SESSION_NOT_FOUND') || err.includes('no longer exists');
          const serverMayHaveAcceptedTurn = Boolean(
            opts.sessionId
            && (opts.code === 'NETWORK_ERROR' || opts.code === 'STREAM_INTERRUPTED' || opts.code === 'AGENT_TURN_RUNNING')
          );
          clearRunningStream(finalSessionId, actualRequestId);
          if (activeSessionIdRef.current === finalSessionId) setIsThinking(false);
          updateSessionDraft(requestSessionId!, m => m.map(msg =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  content: msg.content || (serverMayHaveAcceptedTurn
                    ? 'Re-syncing MARTy with the server...'
                    : staleSession
                    ? 'That MARTy session was stale. I cleared it so you can retry in a clean session.'
                    : err),
                  streaming: false,
                  pendingRequestId: undefined,
                  error: !msg.content,
                  retryable: opts?.retryable !== false,
                }
              : msg
          ));
          if (serverMayHaveAcceptedTurn && opts.sessionId) {
            refreshSessionFromServer(opts.sessionId).catch(() => {
              updateSessionDraft(requestSessionId!, m => m.map(msg =>
                msg.id === assistantMsgId
                  ? { ...msg, content: err, streaming: false, error: true, retryable: opts.retryable !== false }
                  : msg
              ));
              if (activeSessionIdRef.current === finalSessionId) setIsThinking(false);
              clearRunningStream(finalSessionId);
            });
          }
          if (staleSession) {
            if (requestSessionId) {
              upsertSessionInSidebar({
                id: requestSessionId,
                title: sessions.find(s => s.id === requestSessionId)?.title || optimisticSessionTitle(trimmedQuery),
                last_activity_at: new Date().toISOString(),
              });
              updateSessionDraft(requestSessionId, m => m.map(msg =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      content: msg.content || 'This chat hit a session repair path. I kept it visible so you can retry without losing the thread.',
                      streaming: false,
                      pendingRequestId: undefined,
                      error: true,
                      retryable: true,
                    }
                  : msg
              ));
            }
            api.listSessions().then(d => mergeSessionsFromServer(d.sessions)).catch(() => {});
          }
          if (pendingSessionIdRef.current === finalSessionId) pendingSessionIdRef.current = null;
          if (liveSessionIdRef.current === finalSessionId) liveSessionIdRef.current = null;
        },
        (event: any) => {
          if (event.type === 'session' && event.session_id) {
            if (event.session_id !== requestSessionId) {
              const previousSessionId = requestSessionId;
              const draft = previousSessionId ? sessionDraftsRef.current[previousSessionId] : undefined;
              const previousRun = previousSessionId ? runningStreamsRef.current[previousSessionId] : undefined;
              if (draft) {
                const nextDrafts: Record<string, Message[]> = { ...sessionDraftsRef.current, [event.session_id]: draft };
                delete nextDrafts[previousSessionId!];
                sessionDraftsRef.current = nextDrafts;
              }
              if (previousRun && previousSessionId) {
                const nextRuns = { ...runningStreamsRef.current };
                delete nextRuns[previousSessionId];
                runningStreamsRef.current = nextRuns;
                registerRunningStream({ ...previousRun, sessionId: event.session_id });
              }
              requestSessionId = event.session_id;
              upsertSessionInSidebar({ id: event.session_id, title: optimisticSessionTitle(trimmedQuery), last_activity_at: new Date().toISOString() });
              if (previousSessionId && activeSessionIdRef.current === previousSessionId) {
                activeSessionIdRef.current = event.session_id;
                setActiveSessionId(event.session_id);
              }
            }
            liveSessionIdRef.current = event.session_id;
            if (!activeSessionIdRef.current || event.session_id !== requestSessionId) {
              pendingSessionIdRef.current = event.session_id;
            }
            registerRunningStream({
              sessionId: event.session_id,
              requestId: runningStreamsRef.current[event.session_id]?.requestId || clientRequestId,
              runId: runningStreamsRef.current[event.session_id]?.runId || null,
              lastSeq: runningStreamsRef.current[event.session_id]?.lastSeq || 0,
              assistantMessageId: assistantMsgId,
              abortController,
              clientRequestId,
            });
            return;
          }
          if (event.type === 'request' && event.request_id) {
            if (locallyCancelledRequestIdsRef.current.has(clientRequestId)) {
              locallyCancelledRequestIdsRef.current.add(event.request_id);
            }
            cancelledLocallyRef.current = false;
            registerRunningStream({
              sessionId: requestSessionId!,
              requestId: event.request_id,
              runId: runningStreamsRef.current[requestSessionId!]?.runId || null,
              lastSeq: runningStreamsRef.current[requestSessionId!]?.lastSeq || 0,
              assistantMessageId: assistantMsgId,
              abortController,
              clientRequestId,
            });
            return;
          }
          if (event.type === 'run' && event.run_id) {
            registerRunningStream({
              sessionId: event.session_id || requestSessionId!,
              requestId: event.request_id || runningStreamsRef.current[requestSessionId!]?.requestId || clientRequestId,
              runId: event.run_id,
              assistantMessageId: assistantMsgId,
              abortController,
              clientRequestId,
            });
            return;
          }
          if (event.type === 'sources') {
            const sources = (event.sources || []) as CitationSource[];
            updateSessionDraft(requestSessionId!, m => m.map(msg =>
              msg.id === assistantMsgId ? { ...msg, sources } : msg
            ));
            return;
          }
          if (event.type === 'sources_delta') {
            const incoming = (event.sources || []) as CitationSource[];
            updateSessionDraft(requestSessionId!, m => m.map(msg =>
              msg.id === assistantMsgId ? { ...msg, sources: mergeCitationSources(msg.sources, incoming) } : msg
            ));
            return;
          }
          if (event.type === 'attachments') {
            const sessionAtt = (event.session_attachments || []) as ChatUploadSummary[];
            const turnAtt = (event.turn_attachments || []) as ChatUploadSummary[];
            if (activeSessionIdRef.current === requestSessionId) {
              setSessionUploads(sessionAtt);
              setBytesUsed(event.bytes_used || 0);
              setBytesTotal(event.bytes_total || 0);
            }
            // Replace the optimistic snapshot we set on send with the
            // server's authoritative list (in_context flag is computed
            // server-side and may differ from what the client guessed).
            if (turnAtt.length > 0) {
              updateSessionDraft(requestSessionId!, m => m.map(msg =>
                msg.id === userMsgId ? { ...msg, attachments: turnAtt } : msg
              ));
            }
            return;
          }
          if (event.type === 'document_cards') {
            const incoming = mergeDocumentCards(undefined, event.document_cards);
            if (incoming?.length) {
              updateSessionDraft(requestSessionId!, m => m.map(msg =>
                msg.id === assistantMsgId
                  ? { ...msg, documentCards: mergeDocumentCards(msg.documentCards, incoming) }
                  : msg
              ));
            }
            return;
          }
          updateSessionDraft(requestSessionId!, m => m.map(msg => {
            if (msg.id !== assistantMsgId) return msg;
            const toolCalls = upsertToolEvent(msg.toolCalls || [], event);
            const rawDeckJob = deckJobFromResult(event.result);
            const deckJob = rawDeckJob ? { ...rawDeckJob, assistant_message_id: rawDeckJob.assistant_message_id || assistantMsgId } : null;
            const deckJobs = deckJob
              ? (() => {
                  const existing = msg.deckJobs || [];
                  return existing.some(job => job.id === deckJob.id)
                    ? existing.map(job => job.id === deckJob.id ? { ...job, ...deckJob } : job)
                    : [...existing, deckJob];
                })()
              : msg.deckJobs;
            const documentCards = event.result?.document_cards
              ? mergeDocumentCards(msg.documentCards, event.result.document_cards)
              : msg.documentCards;
            return { ...msg, toolCalls, deckJobs, documentCards };
          }));
        },
        uploadIds.length > 0 ? uploadIds : undefined,
        { clientRequestId, interruptRequestId, abortSignal: abortController.signal },
      );
    } catch (e) {
      const finalSessionId = requestSessionId;
      if (finalSessionId && activeSessionIdRef.current === finalSessionId) setIsThinking(false);
      const markFailed = (m: Message[]) => m.map(msg =>
        msg.id === assistantMsgId
          ? {
              ...msg,
              content: msg.content || ((e as Error).message || 'I ran into a problem with that question. Try again or rephrase.'),
              streaming: false,
              pendingRequestId: undefined,
              error: !msg.content,
              retryable: true,
            }
          : msg
      );
      if (requestSessionId) updateSessionDraft(requestSessionId, markFailed);
      else setMessages(markFailed);
      if (finalSessionId) clearRunningStream(finalSessionId, clientRequestId);
      if (pendingSessionIdRef.current === finalSessionId) pendingSessionIdRef.current = null;
      if (liveSessionIdRef.current === finalSessionId) liveSessionIdRef.current = null;
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
  const activeSessionIsStreaming = Boolean(activeSessionId && runningSessionIds.includes(activeSessionId));
  const showStopButton = activeSessionIsStreaming && !hasInput;
  const canSend = hasInput;

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
            onClick={startNewSessionView}
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
                        session={{ ...s, _running: runningSessionIds.includes(s.id) }}
                        isActive={activeSessionId === s.id}
                        index={idx}
                        onSelect={() => selectSession(s.id)}
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
            onClick={() => { startNewSessionView(); inputRef.current?.focus(); }}
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
                          <ToolCallCard key={`${tc.id}-${tc.pulseKey || 0}`} tool={tc}
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

                    {m.streaming && activeSessionIsStreaming && isThinking && (
                      <ThinkingIndicator />
                    )}

                    {m.deckJobs && m.deckJobs.length > 0 && (
                      <DeckProductionPanel jobs={m.deckJobs} />
                    )}

                    {m.documentCards && m.documentCards.length > 0 && (
                      <DocumentCardList
                        cards={m.documentCards}
                        sessionId={activeSessionId}
                        onDocumentAttached={handleDocumentAttachedToMarty}
                      />
                    )}

                    {m.content && m.error ? (
                      <ErrorCard message={m.content} retryable={m.retryable !== false} onRetry={() => retryFrom(m.id)} />
                    ) : m.content ? (
                      <div className="relative">
                        <div className={`border-l-2 ${m.cancelled ? 'border-text-muted/40' : 'border-[#8B5CF6]/30'} pl-4`}>
                          {!m.streaming && <TableOfContents content={m.content} />}
                          <MarkdownMessage
                            content={normalizeMartySentenceSpacing(m.streaming ? trimPartialCitation(m.content) : m.content)}
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

              {/* MARTy mode — explicit, persisted choice */}
              <div
                className="relative shrink-0"
                title={`MARTy mode. Agile is concise; MAX performs the widest data sweep (${maxModeShortcut}).`}
              >
                <Search
                  size={15}
                  strokeWidth={2.25}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: deepDive ? '#A855F7' : 'rgba(255,255,255,0.48)' }}
                />
                <select
                  value={martyMode}
                  onChange={e => setMartyMode(e.target.value === 'max' ? 'max' : 'fast')}
                  aria-label="MARTy mode"
                  className="h-9 appearance-none rounded-lg border outline-none transition-all"
                  style={{
                    width: 92,
                    paddingLeft: 31,
                    paddingRight: 26,
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 12,
                    fontWeight: 700,
                    color: deepDive ? '#D8B4FE' : 'rgba(255,255,255,0.76)',
                    background: deepDive ? 'rgba(168,85,247,0.14)' : 'rgba(255,255,255,0.04)',
                    borderColor: deepDive ? 'rgba(168,85,247,0.38)' : 'rgba(255,255,255,0.08)',
                    boxShadow: deepDive ? '0 0 12px rgba(168,85,247,0.18)' : 'none',
                  }}
                >
                  <option value="fast">Agile</option>
                  <option value="max">MAX</option>
                </select>
                <ChevronDown
                  size={13}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: 'rgba(255,255,255,0.42)' }}
                />
              </div>

              {/* Textarea — flex-1, auto-resizes */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
                  if (e.key === 'd' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
                    e.preventDefault();
                    setMartyMode(mode => mode === 'max' ? 'fast' : 'max');
                  }
                }}
                placeholder={deepDive ? 'MAX mode — sweeping across everything...' : placeholderText}
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
              {showStopButton ? (
                <button
                  onClick={cancelActiveStream}
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
                  disabled={!canSend}
                  title={activeSessionIsStreaming ? 'Stop current response and send' : 'Send'}
                  className="w-9 h-9 flex items-center justify-center shrink-0 transition-all"
                  style={{
                    borderRadius: 10,
                    background: canSend
                      ? 'linear-gradient(135deg, #A855F7 0%, #EC4899 100%)'
                      : 'rgba(255,255,255,0.08)',
                    cursor: canSend ? 'pointer' : 'not-allowed',
                    transform: sendPulse ? 'scale(0.95)' : 'scale(1)',
                  }}
                  onMouseEnter={e => { if (canSend) { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.15)'; (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)'; } }}
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
