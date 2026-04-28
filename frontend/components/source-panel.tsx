'use client';

import React from 'react';
import { X, ExternalLink, Mail, Calendar, FileText, Hash, Newspaper, User, Building2, ArrowUpRight } from 'lucide-react';
import type { CitationSource, CitationSourceType } from '@/lib/citations';

const ICON_FOR_TYPE: Record<CitationSourceType, typeof Mail> = {
  email: Mail,
  meeting: Calendar,
  document: FileText,
  contact: User,
  company: Building2,
  slack: Hash,
  news: Newspaper,
};

const TYPE_LABEL: Record<CitationSourceType, string> = {
  email: 'Email',
  meeting: 'Meeting',
  document: 'Document',
  contact: 'Contact',
  company: 'Company',
  slack: 'Slack',
  news: 'News',
};

export function SourcePanel({
  source,
  onClose,
}: {
  source: CitationSource | null;
  onClose: () => void;
}) {
  // Lock body scroll when open
  React.useEffect(() => {
    if (!source) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [source]);

  // Close on Esc
  React.useEffect(() => {
    if (!source) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [source, onClose]);

  const open = !!source;

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 transition-opacity duration-200"
        style={{
          background: 'rgba(0,0,0,0.5)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      />
      <aside
        className="fixed top-0 right-0 h-full z-50 bg-bg-inset border-l border-border shadow-2xl flex flex-col transition-transform duration-200 ease-out"
        style={{
          width: 'min(480px, 90vw)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
        }}
      >
        {source && <SourceContent source={source} onClose={onClose} />}
      </aside>
    </>
  );
}

function SourceContent({ source, onClose }: { source: CitationSource; onClose: () => void }) {
  const Icon = ICON_FOR_TYPE[source.type] || FileText;
  const date = source.date ? new Date(source.date) : null;
  const dateStr = date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <>
      <header className="px-5 pt-5 pb-4 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
              <Icon size={18} className="text-purple-300" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold" style={{ fontFamily: "'Exo 2', sans-serif" }}>
                {TYPE_LABEL[source.type]} · Source [{source.id}]
              </div>
              <div className="text-sm text-text-primary font-medium truncate" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                {source.title}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/5 transition-colors shrink-0"
            aria-label="Close source panel"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {source.subtitle && (
          <Field label="Detail" value={source.subtitle} />
        )}
        {dateStr && (
          <Field label="Date" value={dateStr} />
        )}
        <Field label="Source table" value={source.source_table} mono />
        <Field label="Source ID" value={source.source_id} mono />
        {source.entity_id && (
          <Field label="Linked entity" value={source.entity_id} mono />
        )}

        <div className="pt-2 space-y-2">
          {source.url_path && source.url_path !== '/' && (
            <a
              href={source.url_path}
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/15 text-purple-300 transition-colors text-sm"
              style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}
            >
              <span>Open in CRM</span>
              <ArrowUpRight size={14} />
            </a>
          )}
          {source.external_url && (
            <a
              href={source.external_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-text-secondary transition-colors text-sm"
              style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}
            >
              <span className="truncate">External source</span>
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1" style={{ fontFamily: "'Exo 2', sans-serif" }}>
        {label}
      </div>
      <div
        className={`text-sm text-text-secondary break-words ${mono ? 'font-mono text-[12px]' : ''}`}
        style={!mono ? { fontFamily: "'DM Sans', sans-serif" } : undefined}
      >
        {value}
      </div>
    </div>
  );
}
