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
    // Hallucinated or stale citation — render a muted gray placeholder so the
    // user can see something was cited but the source is no longer attached.
    return (
      <span
        title="Source no longer available"
        className="inline-flex items-center gap-1 px-1.5 py-[1px] mx-[2px] rounded-md bg-gray-500/15 border border-gray-500/25 text-gray-400 text-[10px] font-semibold leading-[1.4] tracking-tight align-baseline cursor-help whitespace-nowrap"
        style={{ verticalAlign: 'baseline', fontFamily: "'DM Sans', sans-serif" }}
      >
        <HelpCircle className="w-2.5 h-2.5 flex-shrink-0" strokeWidth={2.5} />
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
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/[0.03] border border-white/10 text-xs text-text-secondary hover:bg-white/[0.06] hover:border-white/20 hover:text-text-primary transition-all max-w-[280px]"
        style={{ fontFamily: "'DM Sans', sans-serif" }}
      >
        <span className="text-purple-400 font-mono text-[10px] font-bold flex-shrink-0">{source.id}</span>
        <Icon className="w-3 h-3 flex-shrink-0 text-text-muted" />
        <span className="truncate">{footerLabel(source)}</span>
      </button>
    );
  }

  // Inline pill — purple-tinted, bordered, icon + number, sits on the baseline,
  // never breaks across lines. Visually distinct from prose at a glance while
  // still small enough to not interrupt reading flow.
  return (
    <button
      onClick={() => onClick?.(source)}
      title={tooltip}
      className="citation-pill inline-flex items-center gap-1 px-1.5 py-[1px] mx-[2px] rounded-md bg-purple-500/15 border border-purple-500/25 text-purple-300 text-[10px] font-semibold leading-[1.4] tracking-tight hover:bg-purple-500/25 hover:border-purple-500/40 hover:text-purple-200 transition-all align-baseline cursor-pointer whitespace-nowrap"
      style={{ verticalAlign: 'baseline', fontFamily: "'DM Sans', sans-serif" }}
    >
      <Icon className="w-2.5 h-2.5 flex-shrink-0" strokeWidth={2.5} />
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
