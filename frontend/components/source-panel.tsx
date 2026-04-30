'use client';

import React from 'react';
import { X, ExternalLink, Mail, Calendar, FileText, Hash, Newspaper, User, Building2, ArrowUpRight, Download, Loader2 } from 'lucide-react';
import type { CitationSource, CitationSourceType } from '@/lib/citations';

const API_BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api`;

function authHeader(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const t = localStorage.getItem('auth_token');
  return t ? { Authorization: `Bearer ${t}` } : undefined;
}

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

function fmtDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function faviconFor(externalUrl?: string): string | null {
  if (!externalUrl) return null;
  try {
    const u = new URL(externalUrl);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return null;
  }
}

function domainFor(externalUrl?: string): string | null {
  if (!externalUrl) return null;
  try {
    return new URL(externalUrl).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

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
        {source && <SourceHeaderAndBody source={source} onClose={onClose} />}
      </aside>
    </>
  );
}

function SourceHeaderAndBody({ source, onClose }: { source: CitationSource; onClose: () => void }) {
  const Icon = ICON_FOR_TYPE[source.type] || FileText;
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
                {source.title || 'Untitled'}
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
        <PerTypeBody source={source} />
      </div>
    </>
  );
}

function PerTypeBody({ source }: { source: CitationSource }) {
  switch (source.type) {
    case 'email': return <EmailBody source={source} />;
    case 'slack': return <SlackBody source={source} />;
    case 'meeting': return <MeetingBody source={source} />;
    case 'document': return <DocumentBody source={source} />;
    case 'news': return <NewsBody source={source} />;
    case 'contact': return <ContactBody source={source} />;
    case 'company': return <CompanyBody source={source} />;
    default: return <GenericBody source={source} />;
  }
}

// ---------------- Per-type bodies ----------------

function EmailBody({ source }: { source: CitationSource }) {
  return (
    <>
      <MetaRow label="From" value={source.subtitle || 'Unknown sender'} />
      {source.date && <MetaRow label="Sent" value={fmtDate(source.date) || source.date} />}
      <Excerpt text={source.excerpt} />
      <PrimaryAction href={source.url_path} label="Open thread" />
    </>
  );
}

function SlackBody({ source }: { source: CitationSource }) {
  return (
    <>
      <MetaRow label="Channel" value={source.subtitle || 'Slack'} />
      {source.date && <MetaRow label="Sent" value={fmtDate(source.date) || source.date} />}
      <Excerpt text={source.excerpt} />
      <PrimaryAction href={source.url_path} label="Open message" />
    </>
  );
}

function MeetingBody({ source }: { source: CitationSource }) {
  return (
    <>
      {source.subtitle && <MetaRow label="Type" value={source.subtitle} />}
      {source.date && <MetaRow label="Date" value={fmtDate(source.date) || source.date} />}
      <Excerpt text={source.excerpt} label="Transcript excerpt" />
      <PrimaryAction href={source.url_path} label="Open meeting" />
    </>
  );
}

function DocumentBody({ source }: { source: CitationSource }) {
  return (
    <>
      {source.subtitle && <MetaRow label="Type" value={source.subtitle} />}
      {source.date && <MetaRow label="Added" value={fmtDate(source.date) || source.date} />}
      {source.entity_name && (
        <MetaRow
          label="About"
          value={source.entity_name}
          href={source.entity_url_path}
        />
      )}
      <Excerpt text={source.excerpt} />
      <PrimaryAction href={source.url_path} label="Open document" />
      <DocumentDownloadButton documentId={source.source_id} fileName={source.title} />
    </>
  );
}

function DocumentDownloadButton({ documentId, fileName }: { documentId: string; fileName: string }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Same auth-bearing blob-fetch pattern as documents/[id]/page.tsx — an
  // <a href> can't carry the bearer token, so we fetch as blob, build an
  // object URL, and click it programmatically.
  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/documents/${documentId}/download`, { headers: authHeader() });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'document';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setErr(e?.message || 'Download failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={busy}
        className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-text-secondary hover:text-text-primary transition-colors text-sm w-full disabled:opacity-50"
        style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}
      >
        <span>{busy ? 'Downloading…' : 'Download'}</span>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      </button>
      {err && <div className="text-[11px] text-semantic-error">{err}</div>}
    </>
  );
}

function NewsBody({ source }: { source: CitationSource }) {
  const favicon = faviconFor(source.external_url);
  const domain = domainFor(source.external_url);
  return (
    <>
      <div className="flex items-center gap-2">
        {favicon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={favicon} alt="" className="w-4 h-4 rounded-sm" />
        )}
        <div className="text-xs text-text-secondary" style={{ fontFamily: "'DM Sans', sans-serif" }}>
          {source.subtitle || 'News'}{domain ? ` · ${domain}` : ''}
        </div>
      </div>
      {source.date && <MetaRow label="Published" value={fmtDate(source.date) || source.date} />}
      {source.entity_name && (
        <MetaRow label="About" value={source.entity_name} href={source.entity_url_path} />
      )}
      <Excerpt text={source.excerpt} />
      {source.external_url ? (
        <PrimaryAction href={source.external_url} label="Read article" external />
      ) : source.url_path && source.url_path !== '/' ? (
        <PrimaryAction href={source.url_path} label="Open in CRM" />
      ) : null}
    </>
  );
}

function ContactBody({ source }: { source: CitationSource }) {
  return (
    <>
      {source.subtitle && <MetaRow label="Role / company" value={source.subtitle} />}
      <Excerpt text={source.excerpt} label="Bio" />
      <PrimaryAction href={source.url_path} label="View contact" />
    </>
  );
}

function CompanyBody({ source }: { source: CitationSource }) {
  return (
    <>
      {source.subtitle && <MetaRow label="Sector" value={source.subtitle} />}
      <Excerpt text={source.excerpt} label="Description" />
      <PrimaryAction href={source.url_path} label="View company" />
    </>
  );
}

function GenericBody({ source }: { source: CitationSource }) {
  return (
    <>
      {source.subtitle && <MetaRow label="Detail" value={source.subtitle} />}
      {source.date && <MetaRow label="Date" value={fmtDate(source.date) || source.date} />}
      <Excerpt text={source.excerpt} />
      {source.url_path && source.url_path !== '/' && (
        <PrimaryAction href={source.url_path} label="Open in CRM" />
      )}
    </>
  );
}

// ---------------- Shared atoms ----------------

function MetaRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1" style={{ fontFamily: "'Exo 2', sans-serif" }}>
        {label}
      </div>
      {href ? (
        <a
          href={href}
          className="text-sm text-purple-300 hover:text-purple-200 underline-offset-2 hover:underline inline-flex items-center gap-1"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          {value}
          <ArrowUpRight size={12} />
        </a>
      ) : (
        <div className="text-sm text-text-secondary break-words" style={{ fontFamily: "'DM Sans', sans-serif" }}>
          {value}
        </div>
      )}
    </div>
  );
}

function Excerpt({ text, label = 'Excerpt' }: { text?: string; label?: string }) {
  if (!text) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1" style={{ fontFamily: "'Exo 2', sans-serif" }}>
        {label}
      </div>
      <blockquote
        className="text-sm text-text-secondary leading-relaxed border-l-2 border-purple-500/40 pl-3"
        style={{ fontFamily: "'DM Sans', sans-serif" }}
      >
        {text}
      </blockquote>
    </div>
  );
}

function PrimaryAction({ href, label, external }: { href?: string; label: string; external?: boolean }) {
  if (!href || href === '/') return null;
  const Icon = external ? ExternalLink : ArrowUpRight;
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/15 text-purple-300 transition-colors text-sm mt-2"
      style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}
    >
      <span>{label}</span>
      <Icon size={14} />
    </a>
  );
}
