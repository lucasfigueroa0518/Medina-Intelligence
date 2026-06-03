'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Download, ExternalLink, Eye, Loader2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';

const DocumentPreviewModal = dynamic(
  () => import('./document-preview-modal').then(mod => mod.DocumentPreviewModal),
  { ssr: false },
);

const API_BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api`;

function authHeader(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export async function downloadDocumentOriginal(
  documentId: string,
  fileName?: string | null
): Promise<void> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/download`, {
    headers: authHeader(),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'document';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type DocumentLike = {
  id: string;
  title?: string | null;
  file_name?: string | null;
  r2_key?: string | null;
  extracted_text_preview?: string | null;
};

type Variant = 'icon' | 'compact' | 'full' | 'panel';

export function DocumentActions({
  doc,
  docId,
  fileName,
  variant = 'compact',
  showPreview = true,
  showDownload = true,
  showSendToMarty = true,
  sessionId,
  onSentToMarty,
  onPreview,
  onError,
  stopPropagation = true,
}: {
  doc?: DocumentLike | null;
  docId?: string;
  fileName?: string | null;
  variant?: Variant;
  showPreview?: boolean;
  showDownload?: boolean;
  showSendToMarty?: boolean;
  sessionId?: string | null;
  onSentToMarty?: (result: Awaited<ReturnType<typeof api.attachDocumentToChat>>) => void;
  onPreview?: (documentId: string) => void;
  onError?: (message: string) => void;
  stopPropagation?: boolean;
}) {
  const router = useRouter();
  const id = doc?.id || docId;
  const resolvedFileName = fileName || doc?.file_name || doc?.title || 'document';
  const hasKnownOriginal = doc?.r2_key === undefined ? true : Boolean(doc.r2_key);
  const hasKnownPreview =
    hasKnownOriginal ||
    doc?.extracted_text_preview === undefined ||
    Boolean(String(doc.extracted_text_preview || '').trim());

  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  function fail(message: string) {
    if (onError) onError(message);
  }

  function guardEvent(e: React.MouseEvent) {
    if (stopPropagation) e.stopPropagation();
  }

  function openPreview() {
    if (!id) return;
    if (!hasKnownPreview) {
      fail('Preview is unavailable for this document');
      return;
    }
    if (onPreview) onPreview(id);
    else setPreviewOpen(true);
  }

  async function download() {
    if (!id || downloading) return;
    if (!hasKnownOriginal) {
      fail('Original file is unavailable for this document');
      return;
    }
    setDownloading(true);
    try {
      await downloadDocumentOriginal(id, resolvedFileName);
    } catch (e: any) {
      fail(e?.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  async function sendToMarty() {
    if (!id || sending) return;
    if (!hasKnownOriginal) {
      fail('Original file is unavailable for MARTy');
      return;
    }
    setSending(true);
    try {
      const res = await api.attachDocumentToChat(id, { sessionId });
      if (onSentToMarty) {
        onSentToMarty(res);
      } else {
        router.push(`/god-mode?session_id=${encodeURIComponent(res.session_id)}&attach_upload=${encodeURIComponent(res.upload_id)}`);
      }
    } catch (e: any) {
      fail(e?.message || 'Send to MARTy failed');
    } finally {
      setSending(false);
    }
  }

  if (!id) return null;

  const iconOnly = variant === 'icon';
  const panel = variant === 'panel';
  const buttonBase = panel
    ? 'flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg transition-colors text-sm w-full disabled:opacity-40'
    : iconOnly
      ? 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text-muted hover:text-text-primary hover:bg-white/[0.05] transition-colors disabled:opacity-35'
      : 'inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors disabled:opacity-35';
  const panelStyle = panel ? { fontFamily: "'DM Sans', sans-serif", fontWeight: 500 } : undefined;

  return (
    <>
      <div className={panel ? 'space-y-2' : 'flex items-center gap-1'}>
        {showPreview && (
          <button
            type="button"
            onClick={e => { guardEvent(e); openPreview(); }}
            disabled={!hasKnownPreview}
            title="Preview document"
            className={panel
              ? `${buttonBase} bg-purple-500/10 hover:bg-purple-500/15 text-purple-300`
              : buttonBase}
            style={panelStyle}
          >
            {panel ? <span>Preview document</span> : !iconOnly && <span>Preview</span>}
            {panel ? <Eye size={14} /> : <ExternalLink size={iconOnly ? 14 : 13} />}
          </button>
        )}
        {showDownload && (
          <button
            type="button"
            onClick={e => { guardEvent(e); void download(); }}
            disabled={downloading || !hasKnownOriginal}
            title="Download document"
            className={panel
              ? `${buttonBase} bg-white/[0.04] hover:bg-white/[0.08] text-text-secondary hover:text-text-primary`
              : buttonBase}
            style={panelStyle}
          >
            {panel ? (
              <span>{downloading ? 'Downloading...' : 'Download'}</span>
            ) : !iconOnly && (
              <span>{downloading ? 'Downloading...' : 'Download'}</span>
            )}
            {downloading ? <Loader2 size={iconOnly ? 14 : 13} className="animate-spin" /> : <Download size={iconOnly ? 14 : 13} />}
          </button>
        )}
        {showSendToMarty && (
          <button
            type="button"
            onClick={e => { guardEvent(e); void sendToMarty(); }}
            disabled={sending || !hasKnownOriginal}
            title="Send to MARTy"
            className={panel
              ? `${buttonBase} bg-pink-500/10 hover:bg-pink-500/15 text-accent-magenta`
              : iconOnly
                ? `${buttonBase} text-accent-magenta hover:text-accent-magenta`
                : 'inline-flex items-center gap-1.5 rounded-lg border border-accent-magenta/20 bg-accent-magenta/10 px-2.5 py-1.5 text-xs text-accent-magenta hover:bg-accent-magenta/15 transition-colors disabled:opacity-35'}
            style={panelStyle}
          >
            {panel ? (
              <span>{sending ? 'Sending...' : 'Send to MARTy'}</span>
            ) : !iconOnly && (
              <span>{sending ? 'Sending...' : 'MARTy'}</span>
            )}
            {sending ? <Loader2 size={iconOnly ? 14 : 13} className="animate-spin" /> : <Sparkles size={iconOnly ? 14 : 13} />}
          </button>
        )}
      </div>
      {!onPreview && (
        <DocumentPreviewModal
          docId={previewOpen ? id : null}
          onClose={() => setPreviewOpen(false)}
          sessionId={sessionId}
          onSentToMarty={onSentToMarty}
        />
      )}
    </>
  );
}
