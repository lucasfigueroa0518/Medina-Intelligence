'use client';

import React from 'react';
import { Mail, Calendar, FileText, User, Building2, Hash, Newspaper, HelpCircle } from 'lucide-react';
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

export interface CitationPillProps {
  source?: CitationSource;
  sourceId: number;
  variant?: 'inline' | 'footer';
  onClick?: (source: CitationSource) => void;
}

export function CitationPill({ source, sourceId, variant = 'inline', onClick }: CitationPillProps) {
  if (!source) {
    // Hallucinated or stale citation — render a muted placeholder.
    return (
      <span
        title="Source no longer available"
        className="inline-flex items-baseline gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-white/5 text-text-muted text-[10px] font-medium leading-none align-baseline cursor-help"
      >
        <HelpCircle className="w-2.5 h-2.5" />
        <span>{sourceId}</span>
      </span>
    );
  }

  const Icon = ICON_FOR_TYPE[source.type] || FileText;
  const tooltip = [source.title, source.subtitle, source.date && new Date(source.date).toLocaleDateString()]
    .filter(Boolean)
    .join(' — ');

  if (variant === 'footer') {
    return (
      <button
        onClick={() => onClick?.(source)}
        title={tooltip}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 text-[11px] font-medium transition-colors"
        style={{ fontFamily: "'DM Sans', sans-serif" }}
      >
        <span className="text-[10px] text-purple-400/70 font-mono">[{source.id}]</span>
        <Icon className="w-3 h-3" />
        <span className="truncate max-w-[180px]">{footerLabel(source)}</span>
      </button>
    );
  }

  return (
    <button
      onClick={() => onClick?.(source)}
      title={tooltip}
      className="citation-pill inline-flex items-baseline gap-0.5 px-1.5 py-0.5 mx-[1px] rounded-md bg-purple-500/15 text-purple-300 text-[10px] font-semibold leading-none hover:bg-purple-500/25 hover:text-purple-200 transition-colors align-baseline"
      style={{ verticalAlign: 'baseline', fontFamily: "'DM Sans', sans-serif" }}
    >
      <Icon className="w-2.5 h-2.5" style={{ transform: 'translateY(1px)' }} />
      <span>{source.id}</span>
    </button>
  );
}

function footerLabel(source: CitationSource): string {
  switch (source.type) {
    case 'email':
      return source.subtitle || source.title;
    case 'slack':
      return source.subtitle || source.title;
    case 'meeting':
      return source.title;
    case 'document':
      return source.title;
    case 'news':
      return source.title;
    case 'contact':
      return source.title;
    case 'company':
      return source.title;
  }
}
