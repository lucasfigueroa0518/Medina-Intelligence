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
} from 'lucide-react';

export interface TimelineEntry {
  id: string;
  type: 'event' | 'conversation' | 'task' | 'document';
  subtype?: string;
  title: string;
  timestamp: string;
  body_preview?: string | null;
  canReadContent?: boolean;
  from_email?: string;
  participant_user_ids?: string;
}

interface TimelineProps {
  entries: TimelineEntry[];
  loading?: boolean;
}

export function Timeline({ entries, loading }: TimelineProps) {
  const [filter, setFilter] = React.useState<'all' | 'emails' | 'meetings' | 'tasks' | 'documents'>(
    'all'
  );

  const filtered = entries.filter(e => {
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
            <div className="text-sm text-text-secondary mt-1 line-clamp-2">
              {entry.body_preview}
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
