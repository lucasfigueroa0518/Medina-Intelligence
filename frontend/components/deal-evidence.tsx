// Phase F — Evidence panel + Origin line for the deal detail page.
//
// Renders the linkage trail behind a deal: every conversation, event,
// and Slack channel that's been auto-linked, manually linked, or
// inferred via fallback. Each row shows a "why it's here" reason
// derived from the junction's `source` enum + an unlink button.
//
// ACL invariants (mirror backend): subject/title/timestamps visible
// regardless; body_preview + sender nulled when can_read_body=false
// for conversations.
//
// Wave 3 Intelligence Brief lives directly above this — same prominent
// surface real estate. Evidence is the "show your work" rationale for
// the brief.

'use client';

import React from 'react';
import { Mail, Calendar, Hash, Lock, X, Plus, ExternalLink } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ExpandableText } from '@/components/expandable-text';

// Map junction.source enum → human label + tone. The same mapping is
// used by Citation chips elsewhere.
const SOURCE_LABEL: Record<string, { label: string; tone: 'high' | 'medium' | 'low' | 'manual' }> = {
  // conversation_deals + event_deals
  auto_high:           { label: 'Auto-linked (high confidence)', tone: 'high' },
  auto_medium:         { label: 'Auto-linked (medium confidence)', tone: 'medium' },
  inherited_thread:    { label: 'Inherited via email thread', tone: 'medium' },
  inherited_channel:   { label: 'Inherited via Slack channel', tone: 'medium' },
  inherited_series:    { label: 'Inherited via meeting series', tone: 'medium' },
  llm_classification:  { label: 'LLM classification', tone: 'medium' },
  approval_committed:  { label: 'Approved from proposal', tone: 'high' },
  manual:              { label: 'Manually linked', tone: 'manual' },
  // slack_channel_deals
  channel_name_match:  { label: 'Channel name match', tone: 'medium' },
};

function sourceMeta(source: string) {
  return SOURCE_LABEL[source] ?? { label: source, tone: 'low' as const };
}

const TONE_STYLE: Record<string, { bg: string; fg: string }> = {
  high:    { bg: 'rgba(34,197,94,0.10)',  fg: '#22C55E' },
  medium:  { bg: 'rgba(59,130,246,0.10)', fg: '#3B82F6' },
  low:     { bg: 'rgba(161,161,170,0.10)', fg: '#A1A1AA' },
  manual:  { bg: 'rgba(217,70,168,0.10)', fg: '#D946A8' },
};

/* ─── Citation chip — small clickable label (used here + elsewhere). ── */

export function CitationChip({
  source, confidence, compact = false,
}: { source: string; confidence?: number; compact?: boolean }) {
  const meta = sourceMeta(source);
  const style = TONE_STYLE[meta.tone] ?? TONE_STYLE.low;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'} font-medium uppercase tracking-wider`}
      style={{ background: style.bg, color: style.fg }}
      title={typeof confidence === 'number' ? `${meta.label} · confidence ${confidence.toFixed(2)}` : meta.label}
    >
      {meta.label}
    </span>
  );
}

/* ─── Origin line ─────────────────────────────────────────────────────── */

export interface DealOrigin {
  source_kind: 'conversation' | 'event' | 'manual';
  source_communication_id: string | null;
  source_subject: string | null;
  source_sent_at: string | null;
  source_sender: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  confidence: number | null;
  evidence: string | null;
  can_read_source: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DealOriginLine({ origin }: { origin: DealOrigin | null }) {
  if (!origin) {
    return (
      <div className="text-[11px] text-text-muted/70 italic">
        Origin: not recorded
      </div>
    );
  }

  if (origin.source_kind === 'manual') {
    return (
      <div className="text-[11px] text-text-muted">
        <span className="text-text-muted/70">Origin:</span>{' '}
        Created manually{origin.approved_by_name ? ` by ${origin.approved_by_name}` : ''}{origin.approved_at ? ` on ${fmtDate(origin.approved_at)}` : ''}
      </div>
    );
  }

  const kindLabel = origin.source_kind === 'conversation' ? 'email' : 'meeting';
  const subjectFragment = origin.can_read_source && origin.source_subject
    ? <span className="text-text-secondary">"{origin.source_subject}"</span>
    : <span className="text-text-muted italic">[source not visible to you]</span>;

  return (
    <div className="text-[11px] text-text-muted flex items-center gap-1.5 flex-wrap">
      <span className="text-text-muted/70">Origin:</span>
      <span>Created from {kindLabel} {subjectFragment}</span>
      {origin.source_sent_at && <span>· {fmtDate(origin.source_sent_at)}</span>}
      <span>· auto-detected</span>
      {origin.approved_by_name && <span>· approved by {origin.approved_by_name}</span>}
      {typeof origin.confidence === 'number' && (
        <span className="text-text-muted/60">· confidence {origin.confidence.toFixed(2)}</span>
      )}
    </div>
  );
}

/* ─── Evidence panel ──────────────────────────────────────────────────── */

type EvidenceItem =
  Awaited<ReturnType<typeof api.getDealEvidence>>['evidence'][number];

export function DealEvidencePanel({ dealId }: { dealId: string }) {
  const [data, setData] = React.useState<{
    evidence: EvidenceItem[];
    counts: { conversations: number; events: number; slack_channels: number; total: number };
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const [pendingRemoval, setPendingRemoval] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    api.getDealEvidence(dealId)
      .then(d => { if (alive) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof ApiError ? e.message : 'Evidence unavailable';
        setError(msg);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [dealId, tick]);

  const refresh = React.useCallback(() => setTick(t => t + 1), []);

  const handleUnlink = async (item: EvidenceItem) => {
    setPendingRemoval(item.id);
    try {
      if (item.type === 'conversation') {
        await api.unlinkConversationFromDealEvidence(dealId, item.conversation_id);
      } else if (item.type === 'event') {
        await api.unlinkEventFromDealEvidence(dealId, item.event_id);
      } else {
        await api.unlinkSlackChannelFromDealEvidence(dealId, item.channel_id);
      }
      refresh();
    } catch (e) {
      console.error('[evidence] unlink failed:', e);
      alert(e instanceof Error ? e.message : 'Unlink failed');
    } finally {
      setPendingRemoval(null);
    }
  };

  // Hooks must precede any early return — this useState previously sat
  // below the loading/error returns, so the loading->loaded transition
  // changed the hook count and crashed with "rendered more hooks".
  const [showAdd, setShowAdd] = React.useState(false);

  if (loading) {
    return <div className="text-xs text-text-muted py-6 text-center">Loading evidence...</div>;
  }
  if (error) {
    return <div className="text-xs text-text-muted py-6 text-center italic">{error}</div>;
  }

  const empty = !data || data.evidence.length === 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] text-text-muted flex items-center gap-2">
          {empty ? (
            <span>Conversations, meetings, and Slack channels auto-link as the deal progresses.</span>
          ) : (
            <>
              <span>{data!.counts.total} linked</span>
              {data!.counts.conversations > 0 && <span>· {data!.counts.conversations} {data!.counts.conversations === 1 ? 'email' : 'emails'}</span>}
              {data!.counts.events > 0 && <span>· {data!.counts.events} {data!.counts.events === 1 ? 'meeting' : 'meetings'}</span>}
              {data!.counts.slack_channels > 0 && <span>· {data!.counts.slack_channels} {data!.counts.slack_channels === 1 ? 'Slack channel' : 'Slack channels'}</span>}
            </>
          )}
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="text-[10px] text-accent-magenta hover:text-accent-purple transition-colors flex items-center gap-0.5"
        >
          <Plus size={10} /> Link evidence
        </button>
      </div>

      {showAdd && (
        <AddEvidencePicker
          dealId={dealId}
          onClose={() => setShowAdd(false)}
          onLinked={() => { setShowAdd(false); refresh(); }}
        />
      )}

      {empty ? (
        <div className="text-xs text-text-muted py-6 text-center italic">
          No linked evidence yet.
        </div>
      ) : (
        <div className="space-y-1">
          {data!.evidence.map(item => (
            <EvidenceRow
              key={`${item.type}:${item.id}`}
              item={item}
              onUnlink={() => handleUnlink(item)}
              pending={pendingRemoval === item.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Manual link picker — search + click-to-link ────────────────────── */

function AddEvidencePicker({
  dealId, onClose, onLinked,
}: {
  dealId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [q, setQ] = React.useState('');
  const [type, setType] = React.useState<'all' | 'conversation' | 'event' | 'slack_channel'>('all');
  const [candidates, setCandidates] = React.useState<any[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [linking, setLinking] = React.useState<string | null>(null);

  // Debounced search.
  React.useEffect(() => {
    const t = setTimeout(() => {
      let alive = true;
      setLoading(true);
      api.getDealEvidenceCandidates(dealId, { q, type, limit: 20 })
        .then(r => { if (alive) { setCandidates(r.candidates); setLoading(false); } })
        .catch(() => { if (alive) { setCandidates([]); setLoading(false); } });
      return () => { alive = false; };
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [dealId, q, type]);

  const handleLink = async (c: any) => {
    setLinking(`${c.type}:${c.id}`);
    try {
      if (c.type === 'conversation') {
        await api.linkConversationToDealEvidence(dealId, c.id);
      } else if (c.type === 'event') {
        await api.linkEventToDealEvidence(dealId, c.id);
      } else {
        await api.linkSlackChannelToDealEvidence(dealId, c.id, true);
      }
      onLinked();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Link failed');
      setLinking(null);
    }
  };

  return (
    <div className="mb-3 p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2 mb-2">
        <input
          type="search"
          autoFocus
          placeholder="Search emails, meetings, channels..."
          value={q}
          onChange={e => setQ(e.target.value)}
          className="flex-1 bg-bg-input border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary focus:border-accent-magenta outline-none placeholder:text-text-muted"
        />
        <select
          value={type}
          onChange={e => setType(e.target.value as any)}
          className="bg-bg-input border border-border rounded-lg px-2 py-1.5 text-[11px] text-text-secondary focus:border-accent-magenta outline-none"
        >
          <option value="all">All</option>
          <option value="conversation">Email</option>
          <option value="event">Meeting</option>
          <option value="slack_channel">Slack</option>
        </select>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text-secondary p-1 rounded"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {loading && <div className="text-[11px] text-text-muted py-3 text-center">Searching...</div>}
        {!loading && candidates !== null && candidates.length === 0 && (
          <div className="text-[11px] text-text-muted py-3 text-center italic">
            {q ? 'No matches' : 'Type to search'}
          </div>
        )}
        {!loading && candidates !== null && candidates.map((c: any) => {
          const key = `${c.type}:${c.id}`;
          return (
            <button
              key={key}
              onClick={() => handleLink(c)}
              disabled={linking === key}
              className="w-full flex items-start gap-2 py-2 px-2 -mx-1 rounded-lg text-left hover:bg-white/[0.04] transition-colors disabled:opacity-40"
            >
              <div className="w-6 h-6 rounded flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: 'rgba(255,255,255,0.04)' }}>
                {c.type === 'conversation'
                  ? (c.can_read_body ? <Mail size={11} className="text-blue-400" /> : <Lock size={11} className="text-text-muted" />)
                  : c.type === 'event' ? <Calendar size={11} className="text-cyan-400" />
                  : <Hash size={11} className="text-purple-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary truncate">
                  {c.type === 'conversation' ? c.subject
                    : c.type === 'event' ? c.title
                    : (c.channel_name ? `#${c.channel_name}` : `#channel-${c.id.slice(0, 8)}`)}
                </div>
                <div className="text-[10px] text-text-muted truncate">
                  {c.type === 'conversation' ? `${c.from_name || '(unknown sender)'}${c.sent_at ? ' · ' + fmtDate(c.sent_at) : ''}`
                    : c.type === 'event' ? `${c.event_type || 'meeting'}${c.start_time ? ' · ' + fmtDate(c.start_time) : ''}`
                    : (c.is_member ? 'Bot is in channel' : 'Bot not in channel')}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EvidenceRow({
  item, onUnlink, pending,
}: {
  item: EvidenceItem;
  onUnlink: () => void;
  pending: boolean;
}) {
  const icon =
    item.type === 'conversation'
      ? (item.can_read_body ? <Mail size={14} className="text-blue-400" /> : <Lock size={14} className="text-text-muted" />)
      : item.type === 'event'
      ? <Calendar size={14} className="text-cyan-400" />
      : <Hash size={14} className="text-purple-400" />;

  const title =
    item.type === 'conversation' ? (item.subject || '(no subject)')
    : item.type === 'event' ? item.title
    : (item.channel_name ? `#${item.channel_name}` : `#channel-${item.channel_id.slice(0, 8)}`);

  const timestamp =
    item.type === 'conversation' ? item.sent_at
    : item.type === 'event' ? item.start_time
    : item.linked_at;

  const secondary =
    item.type === 'conversation' ? (item.can_read_body
        ? (item.from_name || item.from_email || null)
        : 'Restricted — you are not a participant')
    : item.type === 'event' ? (item.event_type ? item.event_type.replace(/_/g, ' ') : null)
    : (item.is_member ? 'Bot is in channel' : 'Bot not in channel');

  return (
    <div className="flex items-start gap-3 py-2.5 px-3 -mx-3 rounded-lg transition-colors hover:bg-white/[0.02] group">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: 'rgba(255,255,255,0.04)' }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary truncate">{title}</div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <CitationChip source={item.source} confidence={item.confidence} compact />
          {item.created_by_name && item.source === 'manual' && (
            <span className="text-[10px] text-text-muted">by {item.created_by_name}</span>
          )}
          {secondary && (
            <span className="text-[10px] text-text-muted truncate">{secondary}</span>
          )}
        </div>
        {item.type === 'conversation' && item.body_preview && (
          <ExpandableText
            text={item.body_preview}
            collapsedLines={2}
            minToggleChars={120}
            className="mt-1 text-xs leading-relaxed text-text-muted"
          />
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] text-text-muted mt-1">{fmtDate(timestamp)}</span>
        <button
          onClick={onUnlink}
          disabled={pending}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/[0.05] disabled:opacity-30"
          title="Remove from this deal"
        >
          <X size={12} className="text-text-muted hover:text-red-400 transition-colors" />
        </button>
      </div>
    </div>
  );
}
