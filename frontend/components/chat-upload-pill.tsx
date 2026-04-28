'use client';

import React from 'react';
import { FileText, Image as ImageIcon, FileSpreadsheet, Presentation, FileCode2, X, Check, AlertCircle, Loader2, BookmarkPlus, BookmarkCheck } from 'lucide-react';
import type { ChatUploadSummary, ChatUploadType } from '@/lib/api';

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

// Pending upload — shown above the input bar while the user is composing.
export function PendingUploadPill({
  filename,
  sizeBytes,
  uploadType,
  uploading,
  failed,
  saveToDocuments,
  onToggleSave,
  onRemove,
}: {
  filename: string;
  sizeBytes: number;
  uploadType: ChatUploadType;
  uploading: boolean;
  failed?: string | null;
  saveToDocuments: boolean;
  onToggleSave: () => void;
  onRemove: () => void;
}) {
  const Icon = ICON_FOR_TYPE[uploadType] || FileText;
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
        failed
          ? 'border-semantic-error/40 bg-semantic-error/10 text-semantic-error'
          : 'border-purple-500/25 bg-purple-500/10 text-purple-200'
      }`}
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      <Icon size={14} className="shrink-0 opacity-80" />
      <span className="max-w-[180px] truncate">{filename}</span>
      <span className="text-[10px] text-text-muted">{formatBytes(sizeBytes)}</span>
      {uploading ? (
        <Loader2 size={12} className="animate-spin text-text-muted shrink-0" />
      ) : failed ? (
        <AlertCircle size={12} className="text-semantic-error shrink-0" />
      ) : (
        <button
          type="button"
          onClick={onToggleSave}
          title={saveToDocuments ? 'Saving to Documents — click to undo' : 'Save to Documents (permanent)'}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            saveToDocuments
              ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
              : 'text-text-muted hover:bg-white/5 hover:text-text-primary'
          }`}
        >
          {saveToDocuments ? (
            <><BookmarkCheck size={11} /> <span>Save</span></>
          ) : (
            <><BookmarkPlus size={11} /> <span>Save</span></>
          )}
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-text-muted hover:text-text-primary shrink-0"
        aria-label={`Remove ${filename}`}
      >
        <X size={12} />
      </button>
    </div>
  );
}

// Sent attachment — shown beneath the user message bubble. Click previews
// (or routes to the saved document if applicable).
export function SentUploadPill({
  upload,
  onClick,
}: {
  upload: ChatUploadSummary;
  onClick: (u: ChatUploadSummary) => void;
}) {
  const Icon = ICON_FOR_TYPE[upload.upload_type] || FileText;
  return (
    <button
      onClick={() => onClick(upload)}
      title={upload.preview_text || upload.filename}
      className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
        upload.in_context
          ? 'border-white/10 bg-white/[0.03] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary'
          : 'border-white/5 bg-white/[0.02] text-text-muted hover:bg-white/[0.04]'
      }`}
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      <Icon size={14} className="shrink-0 opacity-80" />
      <span className="max-w-[180px] truncate">{upload.filename}</span>
      <span className="text-[10px] text-text-muted">{formatBytes(upload.size_bytes)}</span>
      {upload.saved_to_documents && (
        <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
          <Check size={10} /> Saved
        </span>
      )}
      {!upload.in_context && (
        <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-muted">
          Out of context
        </span>
      )}
    </button>
  );
}
