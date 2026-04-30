'use client';

import React from 'react';
import { X as XIcon, Upload as UploadIcon, FileText, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';

// Wave 5 Phase F — single shared upload modal used by:
//   - /documents top-bar Upload button (no entity context)
//   - /documents page-level drag-drop overlay (no entity context)
//   - contacts/companies/deals Documents block drag-drop (entity context)
//
// Multi-file: dropping or picking N files queues them sequentially. Per-
// file status displayed; modal stays open until the user dismisses or
// every file resolves. api.uploadDocument is called once per file.
//
// Entity context: contactId / companyId / dealId pre-fills the link payload
// so attachments surface on the linked entity's Documents block. Unset =
// upload lands without entity links (still visible at /documents).

export type UploadState =
  | { kind: 'pending'; file: File }
  | { kind: 'uploading'; file: File }
  | { kind: 'done'; file: File; documentId: string; duplicate: boolean }
  | { kind: 'error'; file: File; error: string };

export function DocumentUploadModal({
  open,
  onClose,
  onUploaded,
  initialFiles,
  contactId,
  companyId,
  dealId,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded?: (count: number) => void;
  initialFiles?: File[];
  contactId?: string;
  companyId?: string;
  dealId?: string;
}) {
  const [files, setFiles] = React.useState<UploadState[]>([]);
  const [visibility, setVisibility] = React.useState<'private' | 'org_wide'>('private');
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Seed from initialFiles when the modal opens (e.g. drag-drop hand-off)
  React.useEffect(() => {
    if (open && initialFiles && initialFiles.length > 0) {
      setFiles(initialFiles.map(f => ({ kind: 'pending', file: f })));
    }
  }, [open, initialFiles]);

  // Reset on close so re-opens are fresh
  React.useEffect(() => {
    if (!open) {
      setFiles([]);
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !uploading) onClose(); };
    window.addEventListener('keydown', handler);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = prev;
    };
  }, [open, uploading, onClose]);

  if (!open) return null;

  function addFiles(newFiles: FileList | File[] | null) {
    if (!newFiles) return;
    const arr = Array.from(newFiles).map<UploadState>(f => ({ kind: 'pending', file: f }));
    setFiles(prev => [...prev, ...arr]);
  }

  async function handleSubmit() {
    if (uploading) return;
    const pending = files.filter(f => f.kind === 'pending');
    if (pending.length === 0) return;
    setUploading(true);

    let successCount = 0;
    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      if (item.kind !== 'pending') continue;
      setFiles(prev => prev.map((p, idx) => idx === i ? { kind: 'uploading', file: item.file } : p));
      try {
        const res = await api.uploadDocument(item.file, {
          contact_id: contactId,
          company_id: companyId,
          deal_id: dealId,
          visibility,
        });
        const docId = (res as any)?.document?.id || '';
        const duplicate = !!(res as any)?.duplicate;
        setFiles(prev => prev.map((p, idx) => idx === i ? { kind: 'done', file: item.file, documentId: docId, duplicate } : p));
        successCount++;
      } catch (err: any) {
        setFiles(prev => prev.map((p, idx) => idx === i ? { kind: 'error', file: item.file, error: err?.message || 'Upload failed' } : p));
      }
    }
    setUploading(false);
    if (successCount > 0 && onUploaded) onUploaded(successCount);
  }

  const totalPending = files.filter(f => f.kind === 'pending').length;
  const allResolved = files.length > 0 && files.every(f => f.kind === 'done' || f.kind === 'error');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => !uploading && onClose()}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-bg-inset border border-border rounded-xl shadow-2xl flex flex-col w-full"
        style={{ maxWidth: '600px', maxHeight: '85vh' }}
      >
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center">
              <UploadIcon size={16} className="text-purple-300" />
            </div>
            <div className="text-sm font-medium text-text-primary">Upload documents</div>
          </div>
          <button onClick={onClose} disabled={uploading}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/5 disabled:opacity-30">
            <XIcon size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Visibility selector */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1.5 block">Visibility</label>
            <select
              value={visibility}
              onChange={e => setVisibility(e.target.value as 'private' | 'org_wide')}
              disabled={uploading}
              className="bg-bg-input border border-border text-text-secondary text-sm px-2.5 py-1.5 rounded-lg w-full disabled:opacity-50"
            >
              <option value="private">Private — only you</option>
              <option value="org_wide">Org-wide — everyone in your team</option>
            </select>
          </div>

          {/* Entity context badge */}
          {(contactId || companyId || dealId) && (
            <div className="text-[11px] text-text-muted">
              Will link to <span className="text-text-secondary">{contactId ? 'contact' : companyId ? 'company' : 'deal'}</span> in context.
            </div>
          )}

          {/* File picker */}
          <label
            className="card border-2 border-dashed flex flex-col items-center justify-center py-8 cursor-pointer transition-all border-border hover:border-border-hover"
          >
            <FileText size={28} className="text-text-muted mb-2" />
            <div className="text-sm font-medium text-text-primary mb-0.5">Click to add files</div>
            <div className="text-[11px] text-text-muted">PDF, DOCX, XLSX, PPTX, images, text</div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => { addFiles(e.target.files); if (e.target) e.target.value = ''; }}
              disabled={uploading}
            />
          </label>

          {/* File queue */}
          {files.length > 0 && (
            <div className="space-y-1.5">
              {files.map((f, i) => (
                <FileRow key={i} state={f}
                  onRemove={f.kind === 'pending' ? () => setFiles(prev => prev.filter((_, idx) => idx !== i)) : undefined}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border">
          <div className="text-[11px] text-text-muted">
            {files.length === 0 ? 'No files queued' : `${totalPending} pending · ${files.length - totalPending} processed`}
          </div>
          <div className="flex items-center gap-2">
            {allResolved ? (
              <button onClick={onClose} className="btn-primary text-sm">Done</button>
            ) : (
              <>
                <button onClick={onClose} disabled={uploading}
                  className="btn-ghost text-sm disabled:opacity-30">Cancel</button>
                <button onClick={handleSubmit} disabled={uploading || totalPending === 0}
                  className="btn-primary text-sm disabled:opacity-30 flex items-center gap-1.5">
                  {uploading && <Loader2 size={14} className="animate-spin" />}
                  Upload {totalPending > 0 ? `(${totalPending})` : ''}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function FileRow({ state, onRemove }: { state: UploadState; onRemove?: () => void }) {
  const file = state.file;
  const sizeLabel = file.size < 1024 ? `${file.size} B` :
                    file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)} KB` :
                    `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-white/[0.02] border border-white/[0.05]">
      <FileText size={14} className="text-text-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary truncate">{file.name}</div>
        <div className="text-[10px] text-text-muted">
          {sizeLabel}
          {state.kind === 'done' && state.duplicate && <span className="ml-2 text-amber-300">· duplicate</span>}
          {state.kind === 'error' && <span className="ml-2 text-semantic-error">· {state.error}</span>}
        </div>
      </div>
      <div className="shrink-0">
        {state.kind === 'pending' && onRemove && (
          <button onClick={onRemove} className="text-text-muted hover:text-text-primary p-1"><XIcon size={12} /></button>
        )}
        {state.kind === 'uploading' && <Loader2 size={14} className="animate-spin text-text-muted" />}
        {state.kind === 'done' && <CheckCircle2 size={14} className="text-semantic-success" />}
        {state.kind === 'error' && <AlertCircle size={14} className="text-semantic-error" />}
      </div>
    </div>
  );
}
