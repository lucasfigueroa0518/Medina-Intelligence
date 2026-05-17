'use client';

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FileText, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import { FilePreview, kindFromMime } from '@/components/file-preview';
import { DocumentActions } from '@/components/document-actions';

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
  error_message: string | null;
  extracted_text_preview: string | null;
  r2_key: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  conversation_id: string | null;
  visibility: string | null;
  version_number: number | null;
  custom_fields?: string | Record<string, unknown> | null;
  created_at: string;
};

function parseCustomFields(value: Doc['custom_fields']): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function deckHtmlDocumentId(doc: Doc | null): string | null {
  const fields = parseCustomFields(doc?.custom_fields);
  const id = fields?.deck_bundle?.html_document_id;
  return typeof id === 'string' && id ? id : null;
}

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [doc, setDoc] = React.useState<Doc | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Inline preview state. For PDFs and images we fetch the file as a blob
  // (bearer auth required) and render via an object URL — iframe/img can't
  // carry an Authorization header. Object URLs are revoked on cleanup.
  const [previewBlobUrl, setPreviewBlobUrl] = React.useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

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

  // Fetch the file as a blob and turn it into an object URL for inline
  // preview. PDFs/images render natively; DOCX uses browser-side rendering.
  React.useEffect(() => {
    if (!doc) return;
    const htmlDocId = deckHtmlDocumentId(doc);
    const kind = htmlDocId ? 'html' : kindFromMime(doc.mime_type);
    if (kind !== 'pdf' && kind !== 'image' && kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx' && kind !== 'html') {
      setPreviewBlobUrl(null);
      return;
    }
    if (!doc.r2_key && !htmlDocId) {
      setPreviewBlobUrl(null);
      setPreviewError('Original file is unavailable.');
      return;
    }
    let alive = true;
    let createdUrl: string | null = null;
    setPreviewLoading(true);
    setPreviewError(null);
    fetch(`${API_BASE}/documents/${htmlDocId || doc.id}/download`, { headers: authHeader() })
      .then(async r => {
        if (!alive) return;
        if (!r.ok) {
          setPreviewError(`Failed to load preview (${r.status}).`);
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
        setPreviewError(e?.message || 'Failed to load preview');
        setPreviewLoading(false);
      });
    return () => {
      alive = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [doc]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-4 md:p-8 text-text-muted text-sm flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-4 md:p-8">
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
    <div className="max-w-4xl mx-auto p-4 md:p-8">
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

      <div className="mb-6">
        <DocumentActions
          doc={doc}
          variant="compact"
          onError={message => setError(message)}
        />
      </div>

      {doc.processing_status === 'failed' && (
        <div className="mb-6 px-3 py-2.5 rounded-lg border text-xs"
          style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)', color: '#FCA5A5' }}>
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-px" />
            <div className="min-w-0">
              <div className="font-medium">Extraction failed</div>
              {doc.error_message && (
                <div className="text-[11px] mt-0.5 break-words" style={{ color: '#FECACA' }}>
                  {doc.error_message}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {doc.processing_status && doc.processing_status !== 'completed' && doc.processing_status !== 'failed' && (
        <div className="mb-6 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-xs text-text-muted">
          Processing status: <span className="text-text-secondary">{doc.processing_status}</span>
        </div>
      )}

      {(() => {
        const rawKind = deckHtmlDocumentId(doc) ? 'html' : kindFromMime(doc.mime_type);
        const kind = rawKind === 'unsupported' && doc.extracted_text_preview ? 'text' : rawKind;
        if (kind === 'pdf' || kind === 'image' || kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'html') {
          return (
            <section className="mb-6 bg-white/[0.03] border border-border rounded-xl overflow-hidden h-[78dvh] max-h-[920px] min-h-[420px]">
              <FilePreview
                kind={kind}
                src={previewBlobUrl || undefined}
                fileName={doc.file_name || doc.title || undefined}
                loading={previewLoading}
                error={previewError}
              />
            </section>
          );
        }
        if (kind === 'text') {
          return null;
        }
        return null;
      })()}

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
