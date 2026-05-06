'use client';

import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Building2,
  Check,
  Clock,
  Download,
  FileText,
  Loader2,
  Mail,
  MessageSquareText,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  Users,
  X,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { DocumentPreviewModal } from '@/components/document-preview-modal';
import { ApiError, api } from '@/lib/api';
import { useDealIntelligence } from '@/lib/use-deal-intelligence';
import {
  MomentumSparkline,
  RiskFlag,
  SentimentIndicator,
  TopicChips,
} from '@/components/deal-intelligence';

type DealStage = 'new' | 'talking' | 'due_diligence' | 'term_sheet' | 'closed';

const STAGES: Array<{ key: DealStage; label: string; color: string }> = [
  { key: 'new', label: 'New', color: '#D946A8' },
  { key: 'talking', label: 'Talking', color: '#3B82F6' },
  { key: 'due_diligence', label: 'Due Diligence', color: '#EAB308' },
  { key: 'term_sheet', label: 'Term Sheet', color: '#F97316' },
  { key: 'closed', label: 'Closed', color: '#22C55E' },
];

const FUNDING_LABELS: Record<string, string> = {
  pre_seed: 'Pre-Seed',
  seed: 'Seed',
  series_a: 'Series A',
  series_b: 'Series B',
  series_c: 'Series C',
  series_d: 'Series D',
  series_e_plus: 'Series E+',
  growth: 'Growth',
  bridge: 'Bridge',
  secondary: 'Secondary',
  debt: 'Debt',
  unknown: 'Unknown Stage',
};

function normalizeStage(stage: string | null | undefined): DealStage {
  return STAGES.some(s => s.key === stage) ? stage as DealStage : 'talking';
}

function titleFor(deal: any): string {
  return deal?.company_name || deal?.title || 'Untitled startup';
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return 'No activity';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return 'No activity';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

function ageLabel(value: string | null | undefined): string {
  if (!value) return 'New';
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return 'New';
  const days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function lastActivity(deal: any): string | null {
  return deal?.last_inferred_activity_date || deal?.evidence_last_seen_at || deal?.last_activity_date || deal?.updated_at || deal?.created_at || null;
}

function fmtRel(iso: string | null | undefined): string {
  if (!iso) return '--';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '--';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function stageConfig(stage: DealStage) {
  return STAGES.find(s => s.key === stage) || STAGES[1];
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function dealLoadMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Deal not found. It may have been deleted or moved.';
    if (error.status >= 500) return 'Deal details are temporarily unavailable. Try again in a moment.';
    return error.message || 'Deal could not be loaded.';
  }
  return 'Deal could not be loaded.';
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section
      className="card"
      style={{ background: 'rgba(17,17,20,0.55)', backdropFilter: 'blur(12px)' }}
    >
      <div className="mb-3 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

export default function DealDetailPage() {
  const params = useParams();
  const router = useRouter();
  const dealId = String(params.id || '');
  const [bundle, setBundle] = React.useState<any | null>(null);
  const [documents, setDocuments] = React.useState<any[]>([]);
  const [threads, setThreads] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [supportingLoading, setSupportingLoading] = React.useState(false);
  const [dealLoadError, setDealLoadError] = React.useState<string | null>(null);
  const [documentsError, setDocumentsError] = React.useState<string | null>(null);
  const [threadsError, setThreadsError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [noteText, setNoteText] = React.useState('');
  const [savingNote, setSavingNote] = React.useState(false);
  const [previewDocId, setPreviewDocId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const { intelligence, refresh } = useDealIntelligence(dealId);
  const loadSeqRef = React.useRef(0);

  const deal = bundle?.deal;
  const contacts = bundle?.contacts || { theirs: [], ours: [], other: [] };
  const company = bundle?.company;
  const externalContacts = [...(contacts.theirs || []), ...(contacts.other || [])];

  const load = React.useCallback(async () => {
    if (!dealId) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setSupportingLoading(false);
    setDealLoadError(null);
    setDocumentsError(null);
    setThreadsError(null);
    setDocuments([]);
    setThreads([]);
    try {
      const dealRes = await api.getDeal(dealId);
      if (seq !== loadSeqRef.current) return;
      setBundle(dealRes);
    } catch (e: any) {
      if (seq !== loadSeqRef.current) return;
      setBundle(null);
      setDocuments([]);
      setThreads([]);
      setDealLoadError(dealLoadMessage(e));
      setLoading(false);
      return;
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }

    if (seq !== loadSeqRef.current) return;
    setSupportingLoading(true);
    const [docRes, convoRes] = await Promise.allSettled([
      api.listDocuments({ deal_id: dealId, limit: '50' }),
      api.getDealConversations(dealId, 20),
    ]);

    if (seq !== loadSeqRef.current) return;
    if (docRes.status === 'fulfilled') {
      setDocuments(docRes.value.documents || []);
    } else {
      setDocuments([]);
      setDocumentsError(docRes.reason?.message || 'Documents are temporarily unavailable.');
    }

    if (convoRes.status === 'fulfilled') {
      setThreads(convoRes.value.threads || []);
    } else {
      setThreads([]);
      setThreadsError(convoRes.reason?.message || 'Firm sentiment is temporarily unavailable.');
    }
    setSupportingLoading(false);
  }, [dealId]);

  React.useEffect(() => {
    void load();
    return () => { loadSeqRef.current += 1; };
  }, [load]);

  React.useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function updateStage(stage: DealStage) {
    setBusy(true);
    try {
      await api.updateDeal(dealId, { stage });
      await load();
      setToast('Stage updated');
    } catch (e: any) {
      setToast(e?.message || 'Stage update failed');
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'yes' | 'no' | 'delete') {
    setBusy(true);
    try {
      await api.bulkDecideDeals({ deal_ids: [dealId], decision });
      if (decision === 'yes') {
        await load();
        setToast('Moved to Talking');
      } else {
        router.push('/deals');
      }
    } catch (e: any) {
      setToast(e?.message || 'Decision failed');
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await api.createDealNote(dealId, { content: noteText.trim() });
      setNoteText('');
      await load();
      setToast('Note added');
    } catch (e: any) {
      setToast(e?.message || 'Note failed');
    } finally {
      setSavingNote(false);
    }
  }

  async function downloadDoc(doc: any) {
    try {
      const res = await api.getDocument(doc.id);
      if (res.downloadUrl) window.open(res.downloadUrl, '_blank');
    } catch (e: any) {
      setToast(e?.message || 'Download failed');
    }
  }

  async function sendToMarty(doc: any) {
    try {
      const res = await api.attachDocumentToChat(doc.id);
      router.push(`/god-mode?session_id=${encodeURIComponent(res.session_id)}&attach_upload=${encodeURIComponent(res.upload_id)}`);
    } catch (e: any) {
      setToast(e?.message || 'Send to MARTy failed');
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex flex-col bg-bg-root text-text-primary">
        <TopBar title="Deal Pipeline" />
        <div className="flex h-[70vh] items-center justify-center text-text-secondary">
          <Loader2 className="mr-2 animate-spin" size={18} /> Loading deal...
        </div>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="flex-1 flex flex-col bg-bg-root text-text-primary">
        <TopBar
          title="Deal Pipeline"
          breadcrumb={
            <div className="text-sm text-text-muted">
              <Link href="/deals" className="hover:text-text-primary">Deals</Link>
              <span className="mx-1.5">/</span>
              <span className="text-text-secondary">Unavailable</span>
            </div>
          }
        />
        <main className="flex-1 p-6 lg:p-8">
          <button
            onClick={() => router.push('/deals')}
            className="mb-6 inline-flex items-center gap-2 text-sm text-text-muted hover:text-text-primary"
          >
            <ArrowLeft size={16} /> Back to deals
          </button>
          <div
            className="card max-w-xl"
            style={{ background: 'rgba(17,17,20,0.55)', backdropFilter: 'blur(12px)' }}
          >
            <div className="mb-2 text-sm font-medium text-text-primary">Deal details are temporarily unavailable</div>
            <p className="text-sm leading-6 text-text-secondary">{dealLoadError || 'Deal not found.'}</p>
          </div>
        </main>
      </div>
    );
  }

  const stage = normalizeStage(deal.stage);
  const stageCfg = stageConfig(stage);
  const stageColor = stageCfg.color;
  const dealAgeSource = deal.evidence_first_seen_at || deal.created_at;
  const activityIso = lastActivity(deal);
  const dealAgeText = ageLabel(dealAgeSource);
  const dealAgePulse = dealAgeText.endsWith(' days')
    ? { value: dealAgeText.replace(' days', ''), unit: 'days' }
    : dealAgeText.endsWith(' day')
      ? { value: dealAgeText.replace(' day', ''), unit: 'day' }
      : { value: dealAgeText, unit: '' };
  const topics = (intelligence?.topics || []).slice(0, 8);
  const sentimentLine = intelligence?.sentiment
    ? `Recent internal tone is ${intelligence.sentiment}${intelligence.conversation_count ? ` across ${intelligence.conversation_count} readable source${intelligence.conversation_count === 1 ? '' : 's'}` : ''}.`
    : 'Recent source messages linked to this deal are shown below when you have access.';

  return (
    <div className="flex-1 overflow-auto bg-bg-root text-text-primary">
      <TopBar
        title="Deal Pipeline"
        breadcrumb={
          <div className="text-sm text-text-muted">
            <Link href="/deals" className="hover:text-text-primary">Deals</Link>
            <span className="mx-1.5">/</span>
            <span className="text-text-secondary">{titleFor(deal)}</span>
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {stage === 'new' && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void decide('yes')}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all hover:scale-[1.03] disabled:opacity-40"
                  style={{ background: 'rgba(34,197,94,0.12)', color: '#4ADE80', border: '1px solid rgba(34,197,94,0.25)' }}
                >
                  <Check size={13} /> Yes
                </button>
                <button
                  disabled={busy}
                  onClick={() => void decide('no')}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all hover:scale-[1.03] disabled:opacity-40"
                  style={{ background: 'rgba(239,68,68,0.12)', color: '#F87171', border: '1px solid rgba(239,68,68,0.25)' }}
                >
                  <X size={13} /> No
                </button>
              </>
            )}
            <select
              value={stage}
              onChange={e => void updateStage(e.target.value as DealStage)}
              disabled={busy}
              className="bg-bg-input border border-border rounded-lg px-3 py-1.5 text-xs text-text-secondary focus:border-accent-magenta outline-none disabled:opacity-40"
            >
              {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
        }
      />

      <div className="px-8 py-5 border-b border-border" style={{ background: 'rgba(17,17,20,0.6)' }}>
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-xl bg-brand-gradient flex items-center justify-center text-white shrink-0 shadow-lg shadow-accent-magenta/10">
            <Target size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl leading-tight text-text-primary">{titleFor(deal)}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {company && (
                <Link href={`/companies/${company.id}`} className="text-sm text-accent-magenta hover:underline flex items-center gap-1">
                  <Building2 size={13} />
                  {company.name}
                </Link>
              )}
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider font-accent"
                style={{
                  background: hexToRgba(stageColor, 0.12),
                  color: stageColor,
                  border: `1px solid ${hexToRgba(stageColor, 0.25)}`,
                }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: stageColor }} />
                {stageCfg.label}
              </span>
            </div>
            {deal.lead_source && (
              <div className="mt-1.5 text-xs text-text-muted flex items-center gap-1">
                <Send size={11} /> Lead source: {deal.lead_source}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-border">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Funding Stage</div>
            <span
              className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold font-accent"
              style={{ background: 'rgba(255,255,255,0.045)', color: '#D4D4D8', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              {FUNDING_LABELS[deal.funding_stage] || 'Stage Unknown'}
            </span>
          </div>
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Last Activity</div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold tabular-nums font-accent">{fmtRel(activityIso)}</span>
              <Clock size={12} className="text-text-muted" />
            </div>
            <div className="text-[9px] text-text-muted mt-1">{dateLabel(activityIso)}</div>
          </div>
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Deal Age</div>
            <div className="flex items-end gap-1">
              <span className="text-2xl font-semibold tabular-nums font-accent">{dealAgePulse.value}</span>
              {dealAgePulse.unit && <span className="text-[10px] text-text-muted mb-1">{dealAgePulse.unit}</span>}
            </div>
            <div className="text-[9px] text-text-muted mt-1">since {dateLabel(dealAgeSource)}</div>
          </div>
          <div className="px-5 py-4 border-r border-b sm:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Sentiment</div>
            <SentimentIndicator intelligence={intelligence} size="detail" />
          </div>
          <div className="px-5 py-4">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Active Topics</div>
            {topics.length > 0 ? (
              <TopicChips intelligence={intelligence} size="detail" />
            ) : (
              <span className="text-xs text-text-muted">No topics yet</span>
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-border bg-white/[0.015]">
        <div className="px-8 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">
              <Sparkles size={12} className="text-accent-magenta" />
              Intelligence Brief
            </div>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          <p className="max-w-5xl text-sm leading-6 text-text-secondary">
            {intelligence?.brief_summary || 'MARTy has not generated a current brief yet. As more readable activity is linked to this startup, this will summarize what is happening now with recency bias.'}
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-text-muted">Momentum</div>
              <MomentumSparkline intelligence={intelligence} size="detail" />
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-text-muted">Risk Signal</div>
              <RiskFlag intelligence={intelligence} size="detail" />
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-text-muted">Evidence Window</div>
              <div className="text-xs text-text-secondary">
                {supportingLoading ? 'Refreshing linked evidence...' : `${threads.length} thread${threads.length === 1 ? '' : 's'} · ${documents.length} document${documents.length === 1 ? '' : 's'}`}
              </div>
            </div>
          </div>
        </div>
      </div>

      <main className="p-6 lg:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 space-y-5">
            <Section title="Firm Sentiment" icon={<MessageSquareText size={12} className="text-sky-300" />}>
              <p className="mb-4 text-sm leading-6 text-text-secondary">{sentimentLine}</p>
              <div className="max-h-[460px] space-y-3 overflow-y-auto pr-1">
                {threadsError ? (
                  <p className="text-sm text-amber-200">{threadsError}</p>
                ) : supportingLoading && threads.length === 0 ? (
                  <p className="text-sm text-text-muted">Loading linked conversation window...</p>
                ) : threads.length === 0 ? (
                  <p className="text-sm text-text-muted">No linked internal conversation window yet.</p>
                ) : threads.map(thread => (
                  <div
                    key={thread.external_thread_id || thread.messages?.[0]?.id || thread.subject}
                    className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-text-primary">{thread.subject || 'Untitled thread'}</div>
                        <div className="mt-0.5 text-xs text-text-muted">
                          {thread.message_count} message{thread.message_count === 1 ? '' : 's'} · {dateLabel(thread.last_sent_at)}
                        </div>
                      </div>
                      <Mail size={15} className="shrink-0 text-text-muted" />
                    </div>
                    <div className="space-y-2">
                      {(thread.messages || []).slice(0, 4).map((message: any) => (
                        <div key={message.id} className="rounded-lg bg-bg-input/70 px-3 py-2">
                          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
                            <span className="truncate">{message.sender_name || message.sender_email || 'Unknown sender'}</span>
                            <span className="shrink-0">{dateLabel(message.sent_at)}</span>
                          </div>
                          <p className="text-sm leading-5 text-text-secondary">
                            {message.can_read_body ? (message.body_preview || 'No preview available.') : 'Private message unavailable.'}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Notes" icon={<FileText size={12} className="text-amber-300" />}>
              <div className="space-y-3">
                {(bundle.notes || []).length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-text-muted">
                    No team notes yet.
                  </div>
                )}
                {(bundle.notes || []).map((note: any) => (
                  <div key={note.id} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                    <p className="whitespace-pre-wrap text-sm leading-6 text-text-secondary">{note.content}</p>
                    <div className="mt-2 text-xs text-text-muted">{note.author_name || 'Team'} · {dateLabel(note.created_at)}</div>
                  </div>
                ))}
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  rows={4}
                  placeholder="Add a note..."
                  className="w-full rounded-xl border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-magenta"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    disabled={savingNote || !noteText.trim()}
                    onClick={() => void addNote()}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-accent-magenta transition-all disabled:opacity-40"
                    style={{ background: 'rgba(217,70,168,0.12)', border: '1px solid rgba(217,70,168,0.20)' }}
                  >
                    Save Note
                  </button>
                  <button
                    onClick={() => setToast('Memo generation coming soon')}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:text-text-primary"
                  >
                    <Sparkles size={15} /> Generate Deal Memo
                  </button>
                </div>
              </div>
            </Section>
          </div>

          <aside className="lg:col-span-5 space-y-5">
            <Section title="Lead Source" icon={<Send size={12} className="text-emerald-300" />}>
              <p className="text-sm leading-6 text-text-secondary">{deal.lead_source || 'AI-surfaced from internal evidence'}</p>
            </Section>

            <Section title="External Companies & Contacts" icon={<Users size={12} className="text-cyan-300" />}>
              <div className="space-y-3">
                {company && (
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <Building2 size={14} /> {company.name}
                    </div>
                    {company.sector && <div className="mt-1 text-xs text-text-muted">{company.sector}</div>}
                  </div>
                )}
                {externalContacts.length === 0 ? (
                  <p className="text-sm text-text-muted">No external contacts linked yet.</p>
                ) : externalContacts.map((contact: any) => (
                  <div key={contact.id} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                    <div className="text-sm font-medium text-text-primary">{contact.full_name}</div>
                    <div className="mt-1 text-xs text-text-muted">{contact.email || contact.job_title || 'External contact'}</div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Documents" icon={<FileText size={12} className="text-rose-300" />}>
              <div className="space-y-3">
                {documentsError ? (
                  <p className="text-sm text-amber-200">{documentsError}</p>
                ) : supportingLoading && documents.length === 0 ? (
                  <p className="text-sm text-text-muted">Loading linked documents...</p>
                ) : documents.length === 0 ? (
                  <p className="text-sm text-text-muted">No documents linked yet.</p>
                ) : documents.map(doc => (
                  <div key={doc.id} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                    <div className="text-sm font-medium text-text-primary">{doc.title || doc.file_name || 'Document'}</div>
                    <div className="mt-1 text-xs text-text-muted">{doc.document_type || doc.source || 'Document'}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => setPreviewDocId(doc.id)}
                        className="rounded-lg border border-border px-2 py-1 text-xs text-text-muted hover:text-text-primary"
                      >
                        Preview
                      </button>
                      <button
                        onClick={() => void downloadDoc(doc)}
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-text-muted hover:text-text-primary"
                      >
                        <Download size={12} /> Download
                      </button>
                      <button
                        onClick={() => void sendToMarty(doc)}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-accent-magenta"
                        style={{ background: 'rgba(217,70,168,0.12)', border: '1px solid rgba(217,70,168,0.18)' }}
                      >
                        <Sparkles size={12} /> MARTy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </aside>
        </div>
      </main>

      <DocumentPreviewModal docId={previewDocId} onClose={() => setPreviewDocId(null)} />
      {toast && (() => {
        const isError = /fail|error/i.test(toast);
        return (
          <div
            className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
            style={{
              background: '#1A1A1F',
              border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`,
              borderLeft: `3px solid ${isError ? '#EF4444' : '#22C55E'}`,
            }}
          >
            <div className="text-sm text-text-primary">{toast}</div>
          </div>
        );
      })()}
    </div>
  );
}
