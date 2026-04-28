'use client';

import React from 'react';
import { X, ExternalLink, AlertCircle, Loader2, FileText } from 'lucide-react';
import { api, type ChatUploadSummary } from '@/lib/api';
import { formatBytes } from './chat-upload-pill';

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

  const isPdf = upload.upload_type === 'pdf';
  const isImage = upload.upload_type === 'image';
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
              <div className="text-sm text-text-primary font-medium truncate" style={{ fontFamily: "'DM Sans', sans-serif" }}>
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
              <a
                href={`/documents/${upload.saved_document_id}`}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors"
                style={{ fontFamily: "'DM Sans', sans-serif" }}
              >
                <ExternalLink size={12} /> Open in Documents
              </a>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/5">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden p-3">
          {isPdf ? (
            <iframe src={contentUrl} title={upload.filename} className="w-full h-full rounded-md bg-white" />
          ) : isImage ? (
            <div className="w-full h-full flex items-center justify-center bg-black/40 rounded-md overflow-hidden">
              <img src={contentUrl} alt={upload.filename} className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <ExtractedTextPreview uploadId={upload.id} extractionStatus={upload.extraction_status} />
          )}
        </div>
      </div>
    </div>
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

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading preview…
      </div>
    );
  }
  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center text-semantic-error text-xs">
        <AlertCircle size={14} className="mr-2" /> {error}
      </div>
    );
  }
  if (!text) {
    return (
      <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">
        {extractionStatus === 'failed' ? 'Could not extract text from this file.' : 'No text content available.'}
      </div>
    );
  }
  return (
    <pre className="w-full h-full overflow-auto bg-bg-root rounded-md p-4 text-xs text-text-secondary whitespace-pre-wrap font-mono">
      {text}
    </pre>
  );
}
