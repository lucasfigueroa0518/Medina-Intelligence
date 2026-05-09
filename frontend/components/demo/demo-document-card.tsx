'use client';

import React from 'react';
import { Download, Eye, FileText, X } from 'lucide-react';
import { DemoDocument, downloadDemoDocument } from '@/lib/demo-mode';

export function DemoDocumentCard({ doc, compact = false }: { doc: DemoDocument; compact?: boolean }) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <article className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-magenta/15 text-accent-magenta">
              <FileText size={18} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-text-primary" title={doc.title}>{doc.title}</div>
              <div className="mt-1 text-xs text-text-muted">
                {doc.document_type} · {doc.source} · {doc.size}
              </div>
              {!compact && (
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-secondary">
                  {doc.body}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setOpen(true)} className="btn-secondary px-3 py-2 text-xs">
              <Eye size={14} /> Preview
            </button>
            <button type="button" onClick={() => downloadDemoDocument(doc)} className="btn-secondary px-3 py-2 text-xs">
              <Download size={14} /> Download
            </button>
            <button
              type="button"
              disabled
              title="Send to MARTy is disabled in UI-only Demo Mode"
              className="rounded-lg border border-white/10 px-3 py-2 text-xs text-text-muted opacity-60"
            >
              Demo only
            </button>
          </div>
        </div>
      </article>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-bg-elevated shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-text-primary">{doc.title}</div>
                <div className="mt-1 text-xs text-text-muted">{doc.file_name} · UI-only demo asset</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-2 text-text-muted hover:bg-white/10 hover:text-text-primary">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-[#0b0b0d] p-6">
              <div className="mx-auto min-h-full max-w-3xl rounded-xl bg-white p-8 text-slate-950 shadow-2xl">
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">{doc.body}</pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

