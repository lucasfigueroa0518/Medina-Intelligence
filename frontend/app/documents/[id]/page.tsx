'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Download, FileText, AlertCircle, Loader2, ExternalLink } from 'lucide-react';

const API_BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api`;

function authHeader(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const t = localStorage.getItem('auth_token');
  return t ? { Authorization: `Bearer ${t}` } : undefined;
}

type Doc = {
  id: string;
  title: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  document_type: string | null;
  source: string | null;
  processing_status: string | null;
  extracted_text_preview: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  conversation_id: string | null;
  visibility: string | null;
  version_number: number | null;
  created_at: string;
};

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [doc, setDoc] = React.useState<Doc | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);

  React.useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/documents/${id}`, { headers: authHeader() })
      .then(async r => {
        if (!alive) return;
        if (r.status === 404) {
          setError("Document not found, or you don't have access to it.");
          setLoading(false);
          return;
        }
        if (!r.ok) {
          setError(`Failed to load document (${r.status}).`);
          setLoading(false);
          return;
        }
        const data = await r.json();
        setDoc(data.document as Doc);
        setLoading(false);
      })
      .catch((e: any) => {
        if (!alive) return;
        setError(`Failed to load document: ${e?.message || 'unknown error'}`);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [id]);

  // Download must pass the bearer token, so an <a href> won't work — fetch
  // the file as a blob, build an object URL, and click it programmatically.
  async function handleDownload() {
    if (!id || !doc) return;
    setDownloading(true);
    try {
      const res = await fetch(`${API_BASE}/documents/${id}/download`, { headers: authHeader() });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.file_name || doc.title || 'document';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(`Download failed: ${e?.message || 'unknown error'}`);
    } finally {
      setDownloading(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8 text-text-muted text-sm flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="flex items-center gap-2 text-semantic-error text-sm">
          <AlertCircle size={16} /> {error}
        </div>
      </div>
    );
  }

  if (!doc) return null;

  const sizeLabel = formatBytes(doc.file_size);
  const dateLabel = formatDate(doc.created_at);
  const sourceLabel = doc.source ? doc.source.replace(/_/g, ' ') : null;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <header className="flex items-start gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
          <FileText size={20} className="text-purple-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h1
            className="text-xl text-text-primary font-medium truncate"
            style={{ fontFamily: "'DM Sans', sans-serif" }}
          >
            {doc.title || doc.file_name || 'Untitled document'}
          </h1>
          <div className="text-xs text-text-muted flex flex-wrap gap-x-3 gap-y-1 mt-1">
            {doc.document_type && <span>{doc.document_type.replace(/_/g, ' ')}</span>}
            {sourceLabel && <span>· {sourceLabel}</span>}
            {sizeLabel && <span>· {sizeLabel}</span>}
            {dateLabel && <span>· {dateLabel}</span>}
            {doc.version_number && doc.version_number > 1 && (
              <span className="text-purple-300">· v{doc.version_number}</span>
            )}
          </div>
        </div>
      </header>

      <div className="flex gap-2 mb-6">
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex items-center gap-2 bg-purple-500/20 border border-purple-500/30 text-purple-200 px-3.5 py-2 rounded-lg text-sm hover:bg-purple-500/30 disabled:opacity-50"
        >
          {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {downloading ? 'Downloading…' : 'Download original'}
        </button>
      </div>

      {doc.processing_status && doc.processing_status !== 'completed' && (
        <div className="mb-6 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-xs text-text-muted">
          Processing status: <span className="text-text-secondary">{doc.processing_status}</span>
        </div>
      )}

      {doc.extracted_text_preview && (
        <section className="mb-6 bg-white/[0.03] border border-border rounded-lg p-5">
          <h2 className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-2.5">
            Preview
          </h2>
          <p className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
            {doc.extracted_text_preview}
          </p>
        </section>
      )}

      {(doc.contact_id || doc.company_id || doc.deal_id || doc.conversation_id) && (
        <section className="bg-white/[0.03] border border-border rounded-lg p-5">
          <h2 className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-3">
            Linked to
          </h2>
          <div className="flex flex-wrap gap-2">
            {doc.contact_id && (
              <Link
                href={`/contacts/${doc.contact_id}`}
                className="inline-flex items-center gap-1.5 text-xs bg-purple-500/10 border border-purple-500/20 text-purple-200 px-2.5 py-1 rounded-md hover:bg-purple-500/20"
              >
                Contact <ExternalLink size={11} />
              </Link>
            )}
            {doc.company_id && (
              <Link
                href={`/companies/${doc.company_id}`}
                className="inline-flex items-center gap-1.5 text-xs bg-purple-500/10 border border-purple-500/20 text-purple-200 px-2.5 py-1 rounded-md hover:bg-purple-500/20"
              >
                Company <ExternalLink size={11} />
              </Link>
            )}
            {doc.deal_id && (
              <Link
                href={`/deals/${doc.deal_id}`}
                className="inline-flex items-center gap-1.5 text-xs bg-purple-500/10 border border-purple-500/20 text-purple-200 px-2.5 py-1 rounded-md hover:bg-purple-500/20"
              >
                Deal <ExternalLink size={11} />
              </Link>
            )}
            {doc.conversation_id && (
              <span className="inline-flex items-center text-xs bg-white/[0.05] border border-white/10 text-text-secondary px-2.5 py-1 rounded-md">
                Email thread
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function formatBytes(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(s: string): string {
  try {
    return new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}
