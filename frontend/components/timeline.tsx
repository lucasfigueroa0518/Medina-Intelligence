'use client';

import React from 'react';
import {
  Calendar,
  MailOpen,
  Send,
  Lock,
  Hash,
  CheckSquare,
  FileText,
  Paperclip,
} from 'lucide-react';
import { ExpandableText } from '@/components/expandable-text';

export interface TimelineEntry {
  id: string;
  type: 'event' | 'conversation' | 'task' | 'document';
  subtype?: string;
  title: string;
  timestamp: string;
  body_preview?: string | null;
  canReadContent?: boolean;
  from_email?: string;
  external_thread_id?: string | null;
  participant_user_ids?: string;
  has_attachments?: number;
  attachment_count?: number;
  attachment_names?: string[];
  occurrence_count?: number;
  thread_count?: number;
}

interface TimelineProps {
  entries: TimelineEntry[];
  loading?: boolean;
}

export function Timeline({ entries, loading }: TimelineProps) {
  const [filter, setFilter] = React.useState<'all' | 'emails' | 'meetings' | 'tasks' | 'documents'>(
    'all'
  );

  const dedupedEntries = React.useMemo(() => dedupeTimelineEntries(entries), [entries]);

  const filtered = dedupedEntries.filter(e => {
    if (filter === 'all') return true;
    if (filter === 'emails') return e.type === 'conversation';
    if (filter === 'meetings') return e.type === 'event';
    if (filter === 'tasks') return e.type === 'task';
    if (filter === 'documents') return e.type === 'document';
    return true;
  });

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 bg-bg-surface animate-pulse rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2 mb-6">
        {['all', 'emails', 'meetings', 'tasks', 'documents'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f as any)}
            className={`px-4 py-1.5 rounded-full text-xs capitalize ${
              filter === f
                ? 'bg-brand-gradient text-white'
                : 'bg-bg-surface border border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="card text-center py-12 text-text-secondary">No activity yet</div>
      ) : (
        <div className="relative pl-6 border-l border-border space-y-4">
          {filtered.map(entry => (
            <TimelineEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function normalizedTimelineTitle(title?: string | null): string {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function timelineDay(timestamp?: string | null): string {
  return String(timestamp || '').slice(0, 10);
}

function mergeEntryCounts(existing: TimelineEntry, incoming: TimelineEntry): TimelineEntry {
  const countField = incoming.type === 'event' ? 'occurrence_count' : 'thread_count';
  const count = (existing[countField] ?? 1) + (incoming[countField] ?? 1);
  if (String(incoming.timestamp) > String(existing.timestamp)) {
    return { ...incoming, [countField]: count };
  }
  return { ...existing, [countField]: count };
}

function dedupeTimelineEntries(entries: TimelineEntry[]): TimelineEntry[] {
  const grouped = new Map<string, TimelineEntry>();
  const passthrough: TimelineEntry[] = [];

  for (const entry of entries) {
    let key: string | null = null;
    if (entry.type === 'event') {
      key = `event:${normalizedTimelineTitle(entry.title)}:${timelineDay(entry.timestamp)}`;
    } else if (entry.type === 'conversation' && entry.external_thread_id) {
      key = `conversation:${entry.external_thread_id}`;
    }

    if (!key) {
      passthrough.push(entry);
      continue;
    }

    const existing = grouped.get(key);
    grouped.set(key, existing ? mergeEntryCounts(existing, entry) : entry);
  }

  return [...grouped.values(), ...passthrough]
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function TimelineEntryRow({ entry }: { entry: TimelineEntry }) {
  const isRestrictedEmail =
    entry.type === 'conversation' && entry.canReadContent === false;

  const iconMap: Record<string, React.ReactNode> = {
    event: <Calendar size={16} className="text-accent-purple" />,
    conversation: isRestrictedEmail ? (
      <Lock size={14} className="text-text-muted" />
    ) : entry.subtype === 'outlook' ? (
      <MailOpen size={16} className="text-semantic-info" />
    ) : (
      <Hash size={16} className="text-semantic-warning" />
    ),
    task: <CheckSquare size={16} className="text-semantic-success" />,
    document: <FileText size={16} className="text-text-secondary" />,
  };

  return (
    <div
      className={`card ${
        isRestrictedEmail ? 'opacity-60' : ''
      } relative`}
    >
      <div className="absolute -left-[29px] top-4 w-6 h-6 rounded-full bg-bg-surface border border-border flex items-center justify-center">
        {iconMap[entry.type] || null}
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-primary font-medium">{entry.title}</div>
          {isRestrictedEmail ? (
            <div className="text-xs text-text-muted italic mt-1">
              You are not a participant in this email
            </div>
          ) : entry.body_preview ? (
            <ExpandableText
              text={entry.body_preview}
              collapsedLines={2}
              minToggleChars={140}
              className="mt-1 text-sm leading-relaxed text-text-secondary"
            />
          ) : null}
          {entry.has_attachments && entry.attachment_count ? (
            <div className="flex items-center gap-1.5 mt-1.5">
              <Paperclip size={11} className="text-text-muted" />
              <span className="text-[11px] text-text-muted">
                {entry.attachment_count} attachment{entry.attachment_count !== 1 ? 's' : ''}
              </span>
              {entry.attachment_names && entry.attachment_names.length > 0 && (
                <span className="text-[10px] text-text-muted/60 truncate max-w-[300px]">
                  — {entry.attachment_names.slice(0, 3).join(', ')}
                  {entry.attachment_names.length > 3 ? ` +${entry.attachment_names.length - 3}` : ''}
                </span>
              )}
            </div>
          ) : null}
          {entry.type === 'event' && entry.occurrence_count && entry.occurrence_count > 1 ? (
            <div className="mt-1.5 text-[11px] text-text-muted">
              {entry.occurrence_count} similar calendar entries grouped
            </div>
          ) : null}
          {entry.type === 'conversation' && entry.thread_count && entry.thread_count > 1 ? (
            <div className="mt-1.5 text-[11px] text-text-muted">
              {entry.thread_count} messages in this thread
            </div>
          ) : null}
        </div>
        <div className="text-xs text-text-muted whitespace-nowrap">
          {formatRelativeDate(entry.timestamp)}
        </div>
      </div>
    </div>
  );
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString();
}
