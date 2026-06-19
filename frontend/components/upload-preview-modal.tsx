'use client';

import React from 'react';
import { X, ExternalLink, FileText } from 'lucide-react';
import { api, type ChatUploadSummary } from '@/lib/api';
import { formatBytes } from './chat-upload-pill';
import { FilePreview, kindFromMime } from './file-preview';
import { DocumentActions } from './document-actions';

export function UploadPreviewModal({
  upload,
  onClose,
}: {
  upload: ChatUploadSummary | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    if (!upload) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = prev;
    };
  }, [upload, onClose]);

  if (!upload) return null;

  const previewKind = kindFromMime(upload.mime_type);
  const contentUrl = api.uploadContentUrl(upload.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-bg-inset border border-border rounded-xl shadow-2xl flex flex-col"
        style={{ width: 'min(900px, 92vw)', height: 'min(86vh, 900px)' }}
      >
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0 flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
              <FileText size={18} className="text-purple-300" />
            </div>
            <div className="min-w-0">
              <div className="text-sm text-text-primary font-medium truncate" style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
                {upload.filename}
              </div>
              <div className="text-[11px] text-text-muted">
                {upload.upload_type.toUpperCase()} · {formatBytes(upload.size_bytes)}
                {upload.saved_to_documents && (
                  <span className="ml-2 text-emerald-300">· saved to Documents</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {upload.saved_to_documents && upload.saved_document_id && (
              <>
                <DocumentActions
                  docId={upload.saved_document_id}
                  fileName={upload.filename}
                  variant="compact"
                />
                <a
                  href={`/documents/${upload.saved_document_id}`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors"
                  style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}
                >
                  <ExternalLink size={12} /> Open
                </a>
              </>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/5">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden p-3">
          {previewKind === 'pdf' || previewKind === 'image' || previewKind === 'docx' || previewKind === 'xlsx' || previewKind === 'pptx' ? (
            <AuthenticatedFilePreview upload={upload} kind={previewKind} contentUrl={contentUrl} />
          ) : (
            <ExtractedTextPreview uploadId={upload.id} extractionStatus={upload.extraction_status} />
          )}
        </div>
      </div>
    </div>
  );
}

function authHeaders(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function AuthenticatedFilePreview({
  upload,
  kind,
  contentUrl,
}: {
  upload: ChatUploadSummary;
  kind: ReturnType<typeof kindFromMime>;
  contentUrl: string;
}) {
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    const url = upload.saved_to_documents && upload.saved_document_id
      ? `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/documents/${upload.saved_document_id}/download`
      : contentUrl;
    fetch(url, { headers: authHeaders() })
      .then(async r => {
        if (!alive) return;
        if (!r.ok) throw new Error(`Failed to load preview (${r.status}).`);
        const contentType = r.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          throw new Error('Original file is not available from this attachment.');
        }
        const blob = await r.blob();
        if (!alive) return;
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
        setLoading(false);
      })
      .catch((e: any) => {
        if (alive) {
          setError(e?.message || 'Preview unavailable');
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [upload.id, upload.saved_document_id, upload.saved_to_documents, contentUrl]);

  return (
    <FilePreview
      kind={kind}
      src={blobUrl || undefined}
      fileName={upload.filename}
      loading={loading}
      error={error}
      emptyMessage="Preview not available for this attachment."
    />
  );
}

function ExtractedTextPreview({ uploadId, extractionStatus }: { uploadId: string; extractionStatus: ChatUploadSummary['extraction_status'] }) {
  const [text, setText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(api.uploadContentUrl(uploadId), {
      headers: typeof window !== 'undefined' && localStorage.getItem('auth_token')
        ? { Authorization: `Bearer ${localStorage.getItem('auth_token')}` }
        : undefined,
    })
      .then(async r => {
        if (!alive) return;
        if (!r.ok) {
          setError(`Failed to load preview (${r.status}).`);
          setLoading(false);
          return;
        }
        const data = await r.json();
        setText(data.text || '');
        setLoading(false);
      })
      .catch(e => { if (alive) { setError(String(e?.message || e)); setLoading(false); } });
    return () => { alive = false; };
  }, [uploadId]);

  return (
    <FilePreview
      kind="text"
      text={text || undefined}
      loading={loading}
      error={error}
      emptyMessage={extractionStatus === 'failed' ? 'Could not extract text from this file.' : 'No text content available.'}
    />
  );
}
