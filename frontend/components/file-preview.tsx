'use client';

import React from 'react';
import { Loader2, AlertCircle, FileText } from 'lucide-react';

// Shared inline-preview primitive used by both upload-preview-modal and the
// documents detail page. Pure rendering — caller is responsible for fetching
// the blob/text and passing in `src` (for pdf/image) or `text`. This split
// keeps auth concerns at the call site: the modal can pass a same-origin URL
// (cookie-auth), the detail page passes a blob: URL after a bearer-fetch.
export type FilePreviewKind = 'pdf' | 'image' | 'text' | 'unsupported';

export function FilePreview({
  kind,
  src,
  text,
  fileName,
  loading,
  error,
  emptyMessage,
}: {
  kind: FilePreviewKind;
  src?: string;
  text?: string;
  fileName?: string;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
}) {
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
  if (kind === 'pdf' && src) {
    return <iframe src={src} title={fileName || 'document'} className="w-full h-full rounded-md bg-white" />;
  }
  if (kind === 'image' && src) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black/40 rounded-md overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={fileName || ''} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }
  if (kind === 'text' && text) {
    return (
      <pre className="w-full h-full overflow-auto bg-bg-root rounded-md p-4 text-xs text-text-secondary whitespace-pre-wrap font-mono">
        {text}
      </pre>
    );
  }
  return (
    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs gap-2">
      <FileText size={14} />
      {emptyMessage || 'Preview not available for this file type.'}
    </div>
  );
}

// Map a mime_type to a FilePreviewKind. Unknown types fall through to
// 'unsupported' so the caller can render a "Preview not available" hint.
export function kindFromMime(mime: string | null | undefined): FilePreviewKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('application/pdf')) return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('text/')) return 'text';
  return 'unsupported';
}
