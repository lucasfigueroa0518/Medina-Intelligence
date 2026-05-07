'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X as XIcon, ExternalLink, Download, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { FilePreview, kindFromMime } from './file-preview';
import { api } from '@/lib/api';

const API_BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api`;

function authHeader(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const t = localStorage.getItem('auth_token');
  return t ? { Authorization: `Bearer ${t}` } : undefined;
}

// Wave 5 Phase G — shared cross-site preview modal. Wraps file-preview.tsx
// for in-context preview (no scroll loss, no full-page navigation). Used by:
//   - /documents list rows
//   - /companies/[id], /contacts/[id], /deals/[id] Documents blocks
//   - MARTy SourcePanel doc citations (Preview button)
//
// Modal-with-escape-hatch pattern: power users get an "Open in detail page"
// link in the header, deep-linkable for sharing. ACL discipline relies on
// the same `getDocument` endpoint that already enforces visibility (loadDocumentForUser
// returns 404 for inaccessible docs); failed extractions surface their
// error_message banner directly. PDF/image previews use bearer-auth blob
// fetch + object URL since iframe/img can't carry Authorization headers.

interface DocLite {
  id: string;
  title: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  r2_key?: string | null;
  document_type: string | null;
  source: string | null;
  processing_status: string | null;
  error_message: string | null;
  extracted_text_preview: string | null;
}

export function DocumentPreviewModal({
  docId,
  onClose,
}: {
  docId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [doc, setDoc] = React.useState<DocLite | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [previewBlobUrl, setPreviewBlobUrl] = React.useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);
  const [sendingToMarty, setSendingToMarty] = React.useState(false);

  React.useEffect(() => {
    if (!docId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setDoc(null);
    setPreviewBlobUrl(null);
    setPreviewError(null);
    api.getDocument(docId)
      .then((res: any) => {
        if (!alive) return;
        setDoc(res.document as DocLite);
        setLoading(false);
      })
      .catch((e: any) => {
        if (!alive) return;
        const msg = String(e?.message || '').includes('404')
          ? "Document not found, or you don't have access to it."
          : `Failed to load document: ${e?.message || 'unknown error'}`;
        setError(msg);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [docId]);

  // Original-file preview: blob-fetch with bearer auth → object URL.
  // PDFs/images render natively; DOCX uses browser-side document rendering.
  React.useEffect(() => {
    if (!doc) return;
    const kind = kindFromMime(doc.mime_type);
    if (kind !== 'pdf' && kind !== 'image' && kind !== 'docx') return;
    if (!doc.r2_key) {
      setPreviewError('Original file is unavailable.');
      return;
    }
    let alive = true;
    let createdUrl: string | null = null;
    setPreviewLoading(true);
    setPreviewError(null);
    fetch(`${API_BASE}/documents/${doc.id}/download`, { headers: authHeader() })
      .then(async r => {
        if (!alive) return;
        if (!r.ok) {
          setPreviewError(`Preview failed to load (${r.status}).`);
          setPreviewLoading(false);
          return;
        }
        const blob = await r.blob();
        if (!alive) return;
        createdUrl = URL.createObjectURL(blob);
        setPreviewBlobUrl(createdUrl);
        setPreviewLoading(false);
      })
      .catch((e: any) => {
        if (!alive) return;
        setPreviewError(e?.message || 'Preview failed to load.');
        setPreviewLoading(false);
      });
    return () => {
      alive = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [doc]);

  // Esc to close
  React.useEffect(() => {
    if (!docId) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = prev;
    };
  }, [docId, onClose]);

  // Wave 5 Phase H — materialize chat_uploads row from this doc, then
  // navigate to /god-mode with the upload pre-attached. Backend does the
  // R2 byte copy; we receive upload_id + session_id and pass them via
  // URL params so god-mode's URL-param consumer pushes the upload into
  // pending state on mount.
  async function handleSendToMarty() {
    if (!doc) return;
    setSendingToMarty(true);
    try {
      const res = await api.attachDocumentToChat(doc.id);
      onClose();
      router.push(`/god-mode?session_id=${encodeURIComponent(res.session_id)}&attach_upload=${encodeURIComponent(res.upload_id)}`);
    } catch (e: any) {
      setError(`Send to MARTy failed: ${e?.message || 'unknown error'}`);
    } finally {
      setSendingToMarty(false);
    }
  }

  async function handleDownload() {
    if (!doc) return;
    if (!doc.r2_key) {
      setError('Original file is unavailable for this document.');
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch(`${API_BASE}/documents/${doc.id}/download`, { headers: authHeader() });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.file_name || doc.title || 'document';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setError(e?.message || 'Download failed.');
    }
    finally { setDownloading(false); }
  }

  if (!docId) return null;

  const rawKind = doc ? kindFromMime(doc.mime_type) : 'unsupported';
  const kind = rawKind === 'unsupported' && doc?.extracted_text_preview ? 'text' : rawKind;
  const showFailedBanner = doc?.processing_status === 'failed';
  const hasOriginalFile = !!doc?.r2_key;
  const title = doc?.title || doc?.file_name || 'Document';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-bg-inset border border-border rounded-xl shadow-2xl flex flex-col w-full"
        style={{ maxWidth: '900px', maxHeight: '90vh' }}
      >
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
              <ExternalLink size={16} className="text-purple-300" />
            </div>
            <div className="min-w-0">
              <div className="text-sm text-text-primary font-medium truncate" title={title}>{title}</div>
              <div className="text-[11px] text-text-muted">
                {doc?.document_type && <span>{doc.document_type.replace(/_/g, ' ')}</span>}
                {doc?.source && <span> · {doc.source.replace(/_/g, ' ')}</span>}
                {doc?.file_size != null && <span> · {formatBytes(doc.file_size)}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={handleSendToMarty} disabled={sendingToMarty || !doc}
              title="Send to MARTy"
              className="flex items-center gap-1.5 px-2.5 py-1.5 mr-1 rounded-lg text-purple-300 bg-purple-500/10 hover:bg-purple-500/15 transition-colors text-xs font-medium disabled:opacity-30">
              {sendingToMarty ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {sendingToMarty ? 'Sending…' : 'Send to MARTy'}
            </button>
            <button onClick={handleDownload} disabled={downloading || !doc || !hasOriginalFile}
              title="Download"
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/5 disabled:opacity-30">
              {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            </button>
            <Link href={`/documents/${docId}`} onClick={onClose}
              title="Open in detail page"
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/5">
              <ExternalLink size={16} />
            </Link>
            <button onClick={onClose}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/5">
              <XIcon size={16} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-hidden p-3 flex flex-col gap-3 min-h-0">
          {showFailedBanner && doc?.error_message && (
            <div className="px-3 py-2.5 rounded-lg border text-xs flex items-start gap-2 shrink-0"
              style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)', color: '#FCA5A5' }}>
              <AlertCircle size={14} className="shrink-0 mt-px" />
              <div className="min-w-0">
                <div className="font-medium">Extraction failed</div>
                <div className="text-[11px] mt-0.5 break-words" style={{ color: '#FECACA' }}>{doc.error_message}</div>
              </div>
            </div>
          )}
          <div className="flex-1 min-h-0 rounded-md overflow-hidden bg-white/[0.02]">
            {loading || (kind !== 'text' && previewLoading) ? (
              <FilePreview kind={kind as any} loading />
            ) : error ? (
              <FilePreview kind={kind as any} error={error} />
            ) : kind === 'text' ? (
              <FilePreview
                kind="text"
                text={doc?.extracted_text_preview || undefined}
                emptyMessage="No text preview available — open detail page for full content."
              />
            ) : kind === 'pdf' || kind === 'image' || kind === 'docx' ? (
              <FilePreview
                kind={kind}
                src={previewBlobUrl || undefined}
                fileName={doc?.file_name || undefined}
                error={previewError || (!previewBlobUrl && !previewLoading ? 'Preview unavailable' : null)}
              />
            ) : (
              <FilePreview kind="unsupported" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
