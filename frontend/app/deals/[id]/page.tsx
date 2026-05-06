'use client';

import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Check,
  Download,
  FileText,
  Hash,
  Loader2,
  Mail,
  MessageSquareText,
  Send,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { DocumentPreviewModal } from '@/components/document-preview-modal';
import { api } from '@/lib/api';
import { useDealIntelligence } from '@/lib/use-deal-intelligence';

type DealStage = 'new' | 'talking' | 'due_diligence' | 'term_sheet' | 'closed';

const STAGES: Array<{ key: DealStage; label: string }> = [
  { key: 'new', label: 'New' },
  { key: 'talking', label: 'Talking' },
  { key: 'due_diligence', label: 'Due Diligence' },
  { key: 'term_sheet', label: 'Term Sheet' },
  { key: 'closed', label: 'Closed' },
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

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-bg-inset/70 p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-fg">
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
  const [toast, setToast] = React.useState<string | null>(null);
  const [noteText, setNoteText] = React.useState('');
  const [savingNote, setSavingNote] = React.useState(false);
  const [previewDocId, setPreviewDocId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const { intelligence, refresh } = useDealIntelligence(dealId);

  const deal = bundle?.deal;
  const contacts = bundle?.contacts || { theirs: [], ours: [], other: [] };
  const company = bundle?.company;
  const externalContacts = [...(contacts.theirs || []), ...(contacts.other || [])];

  const load = React.useCallback(async () => {
    if (!dealId) return;
    setLoading(true);
    try {
      const [dealRes, docRes, convoRes] = await Promise.all([
        api.getDeal(dealId),
        api.listDocuments({ deal_id: dealId, limit: '50' }),
        api.getDealConversations(dealId, 20),
      ]);
      setBundle(dealRes);
      setDocuments(docRes.documents || []);
      setThreads(convoRes.threads || []);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  React.useEffect(() => { void load(); }, [load]);

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
      <div className="min-h-screen bg-bg text-fg">
        <TopBar title="Deals" />
        <div className="flex h-[70vh] items-center justify-center text-muted">
          <Loader2 className="mr-2 animate-spin" size={18} /> Loading deal
        </div>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="min-h-screen bg-bg text-fg">
        <TopBar title="Deals" />
        <main className="px-6 py-8">
          <button onClick={() => router.push('/deals')} className="inline-flex items-center gap-2 text-sm text-muted hover:text-fg">
            <ArrowLeft size={16} /> Back to deals
          </button>
          <p className="mt-8 text-muted">Deal not found.</p>
        </main>
      </div>
    );
  }

  const stage = normalizeStage(deal.stage);
  const topics = (intelligence?.topics || []).slice(0, 8);
  const sentimentLine = intelligence?.sentiment
    ? `Recent internal tone is ${intelligence.sentiment}${intelligence.conversation_count ? ` across ${intelligence.conversation_count} readable source${intelligence.conversation_count === 1 ? '' : 's'}` : ''}.`
    : 'Recent source messages linked to this deal are shown below when you have access.';

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopBar title="Deals" />
      <main className="px-6 py-6">
        <button onClick={() => router.push('/deals')} className="mb-5 inline-flex items-center gap-2 text-sm text-muted hover:text-fg">
          <ArrowLeft size={16} /> Back to deals
        </button>

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold">{titleFor(deal)}</h1>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
              <span className="rounded-full border border-border px-3 py-1">{FUNDING_LABELS[deal.funding_stage] || 'Funding Stage Unknown'}</span>
              <span className="rounded-full border border-border px-3 py-1">Last Activity {dateLabel(lastActivity(deal))}</span>
              <span className="rounded-full border border-border px-3 py-1">Deal Age {ageLabel(deal.evidence_first_seen_at || deal.created_at)}</span>
              {topics.map(topic => (
                <span key={topic} className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-3 py-1 text-purple-200"><Hash size={11} />{topic}</span>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {stage === 'new' && (
              <>
                <button disabled={busy} onClick={() => void decide('yes')} className="inline-flex items-center gap-2 rounded-md bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300 disabled:opacity-50"><Check size={16} />Yes</button>
                <button disabled={busy} onClick={() => void decide('no')} className="inline-flex items-center gap-2 rounded-md bg-red-500/12 px-3 py-2 text-sm text-red-300 disabled:opacity-50"><X size={16} />No</button>
              </>
            )}
            <select
              value={stage}
              onChange={e => void updateStage(e.target.value as DealStage)}
              disabled={busy}
              className="rounded-md border border-border bg-bg-input px-3 py-2 text-sm outline-none focus:border-purple-400"
            >
              {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <Section title="Intelligence Brief" icon={<Sparkles size={16} className="text-purple-300" />}>
              <p className="text-sm leading-6 text-fg/85">
                {intelligence?.brief_summary || 'MARTy has not generated a current brief yet. As more readable activity is linked to this startup, this will summarize what is happening now with recency bias.'}
              </p>
              <button onClick={refresh} className="mt-4 rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:text-fg">Refresh Brief</button>
            </Section>

            <Section title="Firm Sentiment" icon={<MessageSquareText size={16} className="text-sky-300" />}>
              <p className="mb-4 text-sm text-muted">{sentimentLine}</p>
              <div className="max-h-[460px] space-y-3 overflow-y-auto pr-1">
                {threads.length === 0 ? (
                  <p className="text-sm text-muted">No linked internal conversation window yet.</p>
                ) : threads.map(thread => (
                  <div key={thread.external_thread_id || thread.messages?.[0]?.id || thread.subject} className="rounded-lg border border-border bg-bg-panel/60 p-3">
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-fg">{thread.subject || 'Untitled thread'}</div>
                        <div className="text-xs text-muted">{thread.message_count} message{thread.message_count === 1 ? '' : 's'} · {dateLabel(thread.last_sent_at)}</div>
                      </div>
                      <Mail size={15} className="text-muted" />
                    </div>
                    <div className="space-y-2">
                      {(thread.messages || []).slice(0, 4).map((message: any) => (
                        <div key={message.id} className="rounded-md bg-bg-inset px-3 py-2">
                          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted">
                            <span>{message.sender_name || message.sender_email || 'Unknown sender'}</span>
                            <span>{dateLabel(message.sent_at)}</span>
                          </div>
                          <p className="text-sm leading-5 text-fg/80">
                            {message.can_read_body ? (message.body_preview || 'No preview available.') : 'Private message unavailable.'}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Notes" icon={<FileText size={16} className="text-amber-300" />}>
              <div className="space-y-3">
                {(bundle.notes || []).map((note: any) => (
                  <div key={note.id} className="rounded-md border border-border bg-bg-panel/50 p-3">
                    <p className="whitespace-pre-wrap text-sm leading-5 text-fg/85">{note.content}</p>
                    <div className="mt-2 text-xs text-muted">{note.author_name || 'Team'} · {dateLabel(note.created_at)}</div>
                  </div>
                ))}
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  rows={4}
                  placeholder="Add a note..."
                  className="w-full rounded-md border border-border bg-bg-input px-3 py-2 text-sm outline-none focus:border-purple-400"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button disabled={savingNote || !noteText.trim()} onClick={() => void addNote()} className="rounded-md bg-purple-500/18 px-3 py-2 text-sm text-purple-200 disabled:opacity-50">Save Note</button>
                  <button onClick={() => setToast('Memo generation coming soon')} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-fg"><Sparkles size={15} />Generate Deal Memo</button>
                </div>
              </div>
            </Section>
          </div>

          <aside className="space-y-5">
            <Section title="Lead Source" icon={<Send size={16} className="text-emerald-300" />}>
              <p className="text-sm leading-5 text-fg/85">{deal.lead_source || 'AI-surfaced from internal evidence'}</p>
            </Section>

            <Section title="External Companies & Contacts" icon={<Users size={16} className="text-cyan-300" />}>
              <div className="space-y-3">
                {company && (
                  <div className="rounded-md border border-border bg-bg-panel/50 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium"><Building2 size={14} />{company.name}</div>
                    {company.sector && <div className="mt-1 text-xs text-muted">{company.sector}</div>}
                  </div>
                )}
                {externalContacts.length === 0 ? (
                  <p className="text-sm text-muted">No external contacts linked yet.</p>
                ) : externalContacts.map((contact: any) => (
                  <div key={contact.id} className="rounded-md border border-border bg-bg-panel/50 p-3">
                    <div className="text-sm font-medium">{contact.full_name}</div>
                    <div className="mt-1 text-xs text-muted">{contact.email || contact.job_title || 'External contact'}</div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Documents" icon={<FileText size={16} className="text-rose-300" />}>
              <div className="space-y-3">
                {documents.length === 0 ? (
                  <p className="text-sm text-muted">No documents linked yet.</p>
                ) : documents.map(doc => (
                  <div key={doc.id} className="rounded-md border border-border bg-bg-panel/50 p-3">
                    <div className="text-sm font-medium text-fg">{doc.title || doc.file_name || 'Document'}</div>
                    <div className="mt-1 text-xs text-muted">{doc.document_type || doc.source || 'Document'}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button onClick={() => setPreviewDocId(doc.id)} className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg">Preview</button>
                      <button onClick={() => void downloadDoc(doc)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg"><Download size={12} />Download</button>
                      <button onClick={() => void sendToMarty(doc)} className="inline-flex items-center gap-1 rounded-md bg-purple-500/12 px-2 py-1 text-xs text-purple-200"><Sparkles size={12} />MARTy</button>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </aside>
        </div>
      </main>

      <DocumentPreviewModal docId={previewDocId} onClose={() => setPreviewDocId(null)} />
      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-bg-inset px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
