'use client';

import React from 'react';
import {
  AlertCircle,
  Check,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Presentation,
  X,
} from 'lucide-react';
import { api, type ChatUploadSummary, type ChatUploadType } from '@/lib/api';

const ICON_FOR_TYPE: Record<ChatUploadType, typeof FileText> = {
  pdf: FileText,
  image: ImageIcon,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  text: FileText,
  data: FileCode2,
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function uploadTypeLabel(type: ChatUploadType): string {
  switch (type) {
    case 'pdf': return 'PDF';
    case 'image': return 'Image';
    case 'spreadsheet': return 'Sheet';
    case 'presentation': return 'Slides';
    case 'data': return 'Data';
    case 'text': return 'Text';
    default: return 'Document';
  }
}

function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);

  return url;
}

function authHeaders(): Record<string, string> | undefined {
  if (typeof window === 'undefined') return undefined;
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function useUploadImageUrl(upload: ChatUploadSummary): string | null {
  const [blob, setBlob] = React.useState<Blob | null>(null);

  React.useEffect(() => {
    if (upload.upload_type !== 'image') {
      setBlob(null);
      return undefined;
    }
    let alive = true;
    setBlob(null);
    const url = upload.saved_to_documents && upload.saved_document_id
      ? `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/documents/${upload.saved_document_id}/download`
      : api.uploadContentUrl(upload.id);
    fetch(url, { headers: authHeaders() })
      .then(async response => {
        if (!alive || !response.ok) return;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) return;
        setBlob(await response.blob());
      })
      .catch(() => { /* thumbnail is best-effort */ });
    return () => { alive = false; };
  }, [upload.id, upload.saved_document_id, upload.saved_to_documents, upload.upload_type]);

  return useObjectUrl(blob);
}

function AttachmentThumb({
  uploadType,
  previewUrl,
  loading,
  failed,
  compact = false,
}: {
  uploadType: ChatUploadType;
  previewUrl?: string | null;
  loading?: boolean;
  failed?: boolean;
  compact?: boolean;
}) {
  const Icon = ICON_FOR_TYPE[uploadType] || FileText;
  const sizeClass = compact ? 'h-11 w-11 rounded-xl' : 'h-14 w-14 rounded-2xl';

  if (uploadType === 'image' && previewUrl) {
    return (
      <div className={`${sizeClass} shrink-0 overflow-hidden border border-white/10 bg-black/30`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={previewUrl} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }

  return (
    <div className={`${sizeClass} relative shrink-0 border border-white/10 bg-white/[0.045] flex items-center justify-center`}>
      <Icon size={compact ? 18 : 22} className={failed ? 'text-semantic-error' : 'text-text-secondary'} />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-black/45">
          <Loader2 size={compact ? 14 : 16} className="animate-spin text-white/80" />
        </div>
      )}
    </div>
  );
}

// Pending upload - shown in the input bar while the user is composing.
export function PendingUploadPill({
  file,
  filename,
  sizeBytes,
  uploadType,
  uploading,
  failed,
  onRemove,
}: {
  file?: File;
  filename: string;
  sizeBytes: number;
  uploadType: ChatUploadType;
  uploading: boolean;
  failed?: string | null;
  saveToDocuments: boolean;
  onToggleSave: () => void;
  onRemove: () => void;
}) {
  const localImageUrl = useObjectUrl(uploadType === 'image' ? file : null);

  return (
    <div
      className={`group relative flex min-w-0 items-center gap-3 rounded-2xl border p-2 pr-8 text-xs shadow-[0_12px_30px_rgba(0,0,0,0.18)] transition-colors ${
        failed
          ? 'border-semantic-error/35 bg-semantic-error/10 text-semantic-error'
          : 'border-white/10 bg-[#18181d] text-text-primary'
      }`}
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      <AttachmentThumb uploadType={uploadType} previewUrl={localImageUrl} loading={uploading} failed={Boolean(failed)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-text-primary">{filename}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
          <span>{uploadTypeLabel(uploadType)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{formatBytes(sizeBytes)}</span>
          {failed ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="inline-flex items-center gap-1 text-semantic-error">
                <AlertCircle size={11} /> Failed
              </span>
            </>
          ) : uploading ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <span>Uploading</span>
            </>
          ) : (
            <>
              <span aria-hidden="true">&middot;</span>
              <span>Ready</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-2 top-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/45 text-white/70 opacity-100 transition-colors hover:bg-black/70 hover:text-white md:opacity-0 md:group-hover:opacity-100"
        aria-label={`Remove ${filename}`}
      >
        <X size={13} />
      </button>
    </div>
  );
}

// Sent attachment - shown with the user message bubble. Click previews
// (or routes to the saved document if applicable).
export function SentUploadPill({
  upload,
  onClick,
}: {
  upload: ChatUploadSummary;
  onClick: (u: ChatUploadSummary) => void;
}) {
  const imageUrl = useUploadImageUrl(upload);

  return (
    <button
      onClick={() => onClick(upload)}
      title={upload.preview_text || upload.filename}
      className={`group flex min-w-0 max-w-full items-center gap-3 rounded-2xl border p-2 text-left text-xs shadow-[0_12px_30px_rgba(0,0,0,0.14)] transition-all hover:-translate-y-0.5 ${
        upload.in_context
          ? 'border-white/10 bg-[#18181d] text-text-secondary hover:border-white/18 hover:bg-[#202026] hover:text-text-primary'
          : 'border-white/5 bg-white/[0.025] text-text-muted opacity-75 hover:bg-white/[0.04]'
      }`}
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      <AttachmentThumb uploadType={upload.upload_type} previewUrl={imageUrl} compact />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-text-primary">{upload.filename}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
          <span>{uploadTypeLabel(upload.upload_type)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{formatBytes(upload.size_bytes)}</span>
          {upload.saved_to_documents && (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <Check size={10} /> Saved
              </span>
            </>
          )}
          {!upload.in_context && (
            <>
              <span aria-hidden="true">&middot;</span>
              <span>Out of context</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}
