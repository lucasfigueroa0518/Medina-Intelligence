'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { TopBar } from '@/components/top-bar';
import { api } from '@/lib/api';
import { DocumentActions } from '@/components/document-actions';
import {
  Upload, FileText, FileSpreadsheet, File, Presentation,
  Users, Building2, Handshake, Zap, ChevronDown, ChevronRight,
  Check, X as XIcon, Loader2, ArrowLeft, Sparkles, EyeOff, Trash2,
  AlertTriangle,
} from 'lucide-react';

const DocumentPreviewModal = dynamic(
  () => import('@/components/document-preview-modal').then(mod => mod.DocumentPreviewModal),
  { ssr: false },
);

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface ExtractedContact {
  full_name: string;
  email?: string;
  phone?: string;
  job_title?: string;
  linkedin_url?: string;
  company_name?: string;
  location?: string;
  confidence: number;
}

interface ExtractedCompany {
  name: string;
  domain?: string;
  website?: string;
  sector?: string;
  company_type?: string;
  location?: string;
  description?: string;
  stage?: string;
  valuation?: number;
  confidence: number;
}

interface ExtractedDeal {
  name: string;
  company_name?: string;
  stage?: string;
  amount?: number;
  description?: string;
  confidence: number;
}

interface ExtractedRelationship {
  from_name: string;
  to_name: string;
  relationship_type: string;
  context?: string;
}

interface ExtractedSignal {
  entity_name: string;
  signal_type: string;
  summary: string;
  date?: string;
}

interface IntelligenceResult {
  document_id: string;
  category: string;
  summary: string;
  contacts_created: number;
  contacts_updated: number;
  companies_created: number;
  companies_updated: number;
  deals_created: number;
  relationships_found: number;
  signals_found: number;
  entities_routed: number;
  errors: string[];
  extraction?: {
    contacts: ExtractedContact[];
    companies: ExtractedCompany[];
    deals: ExtractedDeal[];
    relationships: ExtractedRelationship[];
    signals: ExtractedSignal[];
  };
  import_report?: ImportReport;
}

interface ImportJob {
  id: string;
  source_type: string;
  status: string;
  created_at: string;
  updated_at?: string;
  source_r2_key?: string;
  total_rows?: number;
  processed_rows?: number;
  created_rows?: number;
  updated_rows?: number;
  skipped_rows?: number;
  failed_rows?: number;
  hidden_at?: string | null;
  deleted_at?: string | null;
}

interface ImportReportStage {
  key: string;
  label: string;
  status: 'completed' | 'running' | 'pending' | 'failed' | 'warning';
  detail: string;
}

interface ImportReportDocument {
  id: string;
  title: string;
  file_name?: string | null;
  document_type?: string | null;
  source?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  processing_status?: string | null;
  error_message?: string | null;
  extracted_text_length?: number | null;
  vector_count: number;
}

interface ImportCreatedEntity {
  id: string;
  type: 'contact' | 'company' | 'deal' | 'document';
  name: string;
  subtitle?: string | null;
  created_at?: string | null;
}

interface ImportWorkItem {
  id: string;
  domain: string;
  status: string;
  attempt: number;
  max_attempts: number;
  last_error?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface ImportReport {
  job_id: string;
  file_name: string;
  source_r2_key: string;
  status: string;
  source_type: string;
  created_at: string;
  updated_at?: string | null;
  summary: string;
  counters: {
    total_rows: number;
    processed_rows: number;
    created_rows: number;
    updated_rows: number;
    skipped_rows: number;
    failed_rows: number;
  };
  lineage_counts: Record<string, number>;
  documents: ImportReportDocument[];
  created_entities: {
    contacts: ImportCreatedEntity[];
    companies: ImportCreatedEntity[];
    deals: ImportCreatedEntity[];
    documents: ImportCreatedEntity[];
  };
  stages: ImportReportStage[];
  work_items: ImportWorkItem[];
  errors: string[];
  notes: string[];
  ingestion?: {
    stored_only: boolean;
    readable: boolean;
    reason: 'unsupported_format' | 'no_extractable_text' | 'extraction_failed' | null;
    message: string | null;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// MECE category palette — mirrors src/lib/document-intelligence.ts.
const CATEGORY_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  // Deal flow — magenta family
  deal_pitch:       { label: 'Deal — Pitch',       color: '#8B5CF6', bg: 'rgba(139,92,246,0.12)' },
  deal_diligence:   { label: 'Deal — Diligence',   color: '#A855F7', bg: 'rgba(168,85,247,0.12)' },
  deal_terms:       { label: 'Deal — Terms',       color: '#D946A8', bg: 'rgba(217,70,168,0.12)' },
  deal_financials:  { label: 'Deal — Financials',  color: '#EC4899', bg: 'rgba(236,72,153,0.12)' },
  // Fund operations — amber/orange family
  fund_reporting:   { label: 'Fund — Reporting',   color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
  fund_legal:       { label: 'Fund — Legal',       color: '#F97316', bg: 'rgba(249,115,22,0.12)' },
  fund_admin:       { label: 'Fund — Admin',       color: '#EAB308', bg: 'rgba(234,179,8,0.12)' },
  // Relationships — green/cyan family
  contact_data:     { label: 'Contact Data',       color: '#22C55E', bg: 'rgba(34,197,94,0.12)' },
  correspondence:   { label: 'Correspondence',     color: '#06B6D4', bg: 'rgba(6,182,212,0.12)' },
  meeting_material: { label: 'Meeting Material',   color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
  // Market intelligence — teal/indigo
  research:         { label: 'Research',           color: '#14B8A6', bg: 'rgba(20,184,166,0.12)' },
  portfolio_update: { label: 'Portfolio Update',   color: '#6366F1', bg: 'rgba(99,102,241,0.12)' },
  // General — neutral
  internal_ops:     { label: 'Internal Ops',       color: '#64748B', bg: 'rgba(100,116,139,0.12)' },
  reference:        { label: 'Reference',          color: '#94A3B8', bg: 'rgba(148,163,184,0.12)' },
};

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'csv' || ext === 'xlsx' || ext === 'xls') return <FileSpreadsheet size={20} />;
  if (ext === 'pdf') return <FileText size={20} />;
  if (ext === 'pptx') return <Presentation size={20} />;
  return <File size={20} />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < 0) return 'Just now';
  if (diff < day) return 'Today';
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function importFileName(job: ImportJob): string {
  const raw = job.source_r2_key || 'Uploaded file';
  const file = raw.split('/').pop() || raw;
  return file.replace(/^[0-9a-f-]{36}_/i, '');
}

function routedCount(job: ImportJob): number {
  if (job.created_rows != null || job.updated_rows != null) {
    return (job.created_rows || 0) + (job.updated_rows || 0);
  }
  return job.processed_rows || job.total_rows || 0;
}

function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat().format(Number(value || 0));
}

const TEXT_EXTRACTABLE_IMPORT_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'xls', 'pptx', 'csv', 'txt', 'md', 'json',
]);

function unsupportedImportExtension(fileName: string): string | null {
  const clean = fileName.split('?')[0]?.toLowerCase() || '';
  const ext = clean.includes('.') ? clean.split('.').pop() || '' : '';
  if (!ext) return null;
  return TEXT_EXTRACTABLE_IMPORT_EXTENSIONS.has(ext) ? null : ext;
}

function likelyStoredOnlyJob(job: ImportJob): boolean {
  if (job.status !== 'completed' || job.source_type !== 'intelligent') return false;
  if (routedCount(job) > 0) return false;
  return Boolean(unsupportedImportExtension(importFileName(job))) || (job.failed_rows || 0) > 0;
}

function reportStoredOnlyMessage(report: ImportReport | undefined): string | null {
  if (!report) return null;
  if (report.ingestion?.stored_only) {
    return report.ingestion.message || 'The original file was stored, but no readable content was ingested into the CRM.';
  }

  const routed = (report.counters?.created_rows || 0) + (report.counters?.updated_rows || 0);
  const hasReadableText = (report.documents || []).some(doc =>
    (doc.extracted_text_length || 0) >= 20 || (doc.vector_count || 0) > 0
  );
  const hasUnsupportedFormat = (report.documents || []).some(doc =>
    Boolean(unsupportedImportExtension(doc.file_name || doc.title || report.file_name))
  );
  const hasExtractionProblem = (report.documents || []).some(doc =>
    doc.processing_status === 'failed' || /extract|readable|unsupported/i.test(doc.error_message || '')
  );
  const storedOnly =
    report.status === 'completed' &&
    (report.documents || []).length > 0 &&
    routed === 0 &&
    !hasReadableText &&
    (hasUnsupportedFormat || hasExtractionProblem || (report.counters?.failed_rows || 0) > 0);

  if (!storedOnly) return null;
  return hasUnsupportedFormat
    ? `${report.file_name} was stored in Documents, but this file format is not readable by the importer. No CRM records were created or updated, and no document chunks were added to MARTy.`
    : `${report.file_name} was stored in Documents, but no readable text could be extracted. No CRM records were created or updated, and no document chunks were added to MARTy.`;
}

function confidenceBadge(c: number) {
  const pct = Math.round(c * 100);
  const color = c >= 0.9 ? '#22C55E' : c >= 0.7 ? '#F59E0B' : '#EF4444';
  return (
    <span className="text-[10px] font-semibold font-accent tabular-nums" style={{ color }}>
      {pct}%
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

type Phase = 'upload' | 'analyzing' | 'report';

const ANALYZE_STEPS = [
  'Classifying document...',
  'Extracting entities...',
  'Matching against CRM...',
  'Preparing intelligence report...',
];

export function ImportsPageContent({ embedded = false }: { embedded?: boolean } = {}) {
  const [phase, setPhase] = React.useState<Phase>('upload');
  const [file, setFile] = React.useState<File | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [analyzeStep, setAnalyzeStep] = React.useState(0);
  const [result, setResult] = React.useState<IntelligenceResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [previewDocId, setPreviewDocId] = React.useState<string | null>(null);

  // Import history
  const [history, setHistory] = React.useState<ImportJob[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(true);
  const [reportLoadingId, setReportLoadingId] = React.useState<string | null>(null);
  const [historyActionId, setHistoryActionId] = React.useState<string | null>(null);

  // Report state
  const [activeTab, setActiveTab] = React.useState<'contacts' | 'companies' | 'deals'>('contacts');
  const [expandedRows, setExpandedRows] = React.useState<Set<number>>(new Set());
  const activeJobs = React.useMemo(
    () => history.filter(j => j.status === 'processing'),
    [history]
  );

  React.useEffect(() => {
    api.listImports()
      .then(d => setHistory(d.imports || []))
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, []);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Background polling — watches `history` for any job with status='processing'
  // and refreshes its row every 4s until the server flips it to a terminal
  // state. This makes navigation work trivially: the import keeps running
  // server-side, and whenever the user lands back on /imports, polling
  // resumes automatically. No 3-min cap, no full-screen blocker.
  const activeJobIds = React.useMemo(
    () => activeJobs.map(j => j.id).sort().join('|'),
    [activeJobs]
  );
  React.useEffect(() => {
    if (!activeJobIds) return;
    let cancelled = false;
    const inProgress = activeJobIds.split('|').filter(Boolean);

    const refresh = async () => {
      await Promise.all(inProgress.map(async jobId => {
        try {
          const data = await api.getImportJob(jobId);
          const job = data.job;
          if (!job || cancelled) return;
          setHistory(prev => prev.map(j => j.id === jobId ? { ...j, ...job } : j));
          if (job.status === 'completed' || job.status === 'failed' || job.status === 'reverted') {
            if (job.status === 'completed') {
              setToast(`Analysis complete: ${routedCount(job)} CRM records routed. Click the row to view the report.`);
            } else if (job.status === 'failed') {
              setToast('Import failed. Check the row in your history.');
            }
          }
        } catch {
          // keep trying — transient network errors shouldn't kill the poll
        }
      }));
    };

    refresh();
    const intervalId = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeJobIds]);

  // Animated analysis steps
  React.useEffect(() => {
    if (phase !== 'analyzing') return;
    const interval = setInterval(() => {
      setAnalyzeStep(prev => (prev < ANALYZE_STEPS.length - 1 ? prev + 1 : prev));
    }, 2500);
    return () => clearInterval(interval);
  }, [phase]);

  async function handleAnalyze() {
    if (!file) return;
    setError(null);
    const fileName = file.name;
    try {
      // Fire-and-forget. Server returns a job_id within a second; processing
      // runs server-side through the durable work queue. We add the job to
      // history and let the background-polling effect drive status updates.
      // The user is freed immediately — no full-screen blocker, navigate-away
      // works, and returning to /imports just resumes polling for any
      // 'processing' rows in the list.
      const data = await api.intelligentImport(file);
      setHistory(prev => [
        { id: data.job_id, source_type: 'intelligent', status: 'processing',
          created_at: new Date().toISOString(),
          total_rows: 0, created_rows: 0, updated_rows: 0,
          source_r2_key: data.file_name },
        ...prev,
      ]);
      setFile(null);
      setToast(`"${fileName}" uploaded — analyzing in the background. You can navigate away; the result will show in your import history.`);
    } catch (e: any) {
      setError(e.message || 'Upload failed');
    }
  }

  async function openReportFromJob(job: ImportJob) {
    if (reportLoadingId) return;
    setReportLoadingId(job.id);
    try {
      const data = await api.getImportJob(job.id);
      const freshJob = data.job || job;
      const report = (data as any).report as ImportReport | undefined;
      const docType = report?.documents?.[0]?.document_type || 'reference';
      const storedOnly = reportStoredOnlyMessage(report);
      const routed = report
        ? (report.counters.created_rows || 0) + (report.counters.updated_rows || 0)
        : routedCount(freshJob);
      setHistory(prev => prev.map(j => j.id === job.id ? { ...j, ...freshJob } : j));
      setResult({
        document_id: freshJob.id,
        category: docType,
        summary: storedOnly || report?.summary || `Processed ${freshJob.total_rows || 0} entities from "${importFileName(freshJob)}".`,
        contacts_created: report?.lineage_counts?.contact || 0,
        contacts_updated: freshJob.updated_rows || 0,
        companies_created: report?.lineage_counts?.company || 0,
        companies_updated: 0,
        deals_created: report?.lineage_counts?.deal || 0,
        relationships_found: 0,
        signals_found: 0,
        entities_routed: routed,
        errors: report?.errors || (freshJob.failed_rows ? [`${freshJob.failed_rows} rows failed`] : []),
        import_report: report,
      });
      setPhase('report');
    } catch (e: any) {
      setError(e?.message || 'Could not open import report');
    } finally {
      setReportLoadingId(null);
    }
  }

  async function handleUndo(jobId: string) {
    if (!confirm('Undo this import? Created contacts, companies, deals, and the document will be soft-deleted. Updates to pre-existing entities are not reverted.')) return;
    try {
      const r = await api.undoImport(jobId);
      setHistory(prev => prev.map(j => j.id === jobId ? { ...j, status: 'reverted' } : j));
      if (result?.document_id === jobId || result?.import_report?.job_id === jobId) {
        setResult(null);
        setPhase('upload');
      }
      alert(`Reverted: ${r.reverted.contact} contacts, ${r.reverted.company} companies, ${r.reverted.deal} deals, ${r.reverted.document} document, ${r.reverted.vectors} embeddings.`);
    } catch (e: any) {
      alert(`Undo failed: ${e?.message || e}`);
    }
  }

  async function handleHideHistory(job: ImportJob) {
    setHistoryActionId(job.id);
    try {
      await api.hideImport(job.id);
      setHistory(prev => prev.filter(j => j.id !== job.id));
      setToast(`Hidden from import history: ${importFileName(job)}`);
    } catch (e: any) {
      setToast(`Could not hide import: ${e?.message || e}`);
    } finally {
      setHistoryActionId(null);
    }
  }

  async function handleDeleteHistory(job: ImportJob) {
    const ok = confirm(
      'Delete this import history row? This only removes it from the history table. It does not undo contacts, companies, deals, or documents created by the import.'
    );
    if (!ok) return;

    setHistoryActionId(job.id);
    try {
      await api.deleteImportHistory(job.id);
      setHistory(prev => prev.filter(j => j.id !== job.id));
      if (result?.document_id === job.id || result?.import_report?.job_id === job.id) {
        setResult(null);
        setPhase('upload');
      }
      setToast(`Deleted import history row: ${importFileName(job)}`);
    } catch (e: any) {
      setToast(`Could not delete import history row: ${e?.message || e}`);
    } finally {
      setHistoryActionId(null);
    }
  }

  async function pollJob(jobId: string) {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const data = await api.getImportJob(jobId);
        const job = data.job;
        if (job.status === 'completed') {
          const report = (data as any).report as ImportReport | undefined;
          const storedOnly = reportStoredOnlyMessage(report);
          const routed = report
            ? (report.counters.created_rows || 0) + (report.counters.updated_rows || 0)
            : routedCount(job);
          setResult({
            document_id: job.id,
            category: report?.documents?.[0]?.document_type || 'reference',
            summary: storedOnly || report?.summary || `Processed ${job.total_rows || 0} entities from uploaded file.`,
            contacts_created: report?.lineage_counts?.contact || 0,
            contacts_updated: job.updated_rows || 0,
            companies_created: report?.lineage_counts?.company || 0,
            companies_updated: 0,
            deals_created: report?.lineage_counts?.deal || 0,
            relationships_found: 0,
            signals_found: 0,
            entities_routed: routed,
            errors: report?.errors || (job.failed_rows ? [`${job.failed_rows} rows failed`] : []),
            import_report: report,
          });
          setHistory(prev => prev.map(j => j.id === jobId ? { ...j, ...job } : j));
          setPhase('report');
          return;
        }
        if (job.status === 'failed') {
          setError('Import processing failed on the server');
          setPhase('upload');
          return;
        }
      } catch {
        // keep polling
      }
    }
    setError('Import timed out — check back later');
    setPhase('upload');
  }

  function resetToUpload() {
    setPhase('upload');
    setFile(null);
    setResult(null);
    setError(null);
    setActiveTab('contacts');
    setExpandedRows(new Set());
  }

  function toggleRow(idx: number) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render: Upload Phase
  // ────────────────────────────────────────────────────────────────────────

  if (phase === 'upload') {
    return (
      <div className="flex-1 min-h-0 h-full flex flex-col overflow-hidden">
        {!embedded && (
          <TopBar
            title="Document Intelligence"
            actions={
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <Sparkles size={14} className="text-accent-magenta" />
                AI-powered document analysis
              </div>
            }
          />
        )}
      <div className="flex-1 min-h-0 p-4 md:p-8 overflow-auto">
          <div className="max-w-5xl mx-auto">
            {activeJobs.length > 0 && (
              <div className="card p-4 mb-5 border-accent-magenta/25 bg-accent-magenta/5">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-accent-magenta/10 text-accent-magenta flex items-center justify-center shrink-0">
                    <Loader2 size={18} className="animate-spin" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text-primary">
                      {activeJobs.length === 1 ? 'Import running in the background' : `${activeJobs.length} imports running in the background`}
                    </div>
                    <div className="text-xs text-text-muted mt-1">
                      You can leave this page. This list will reconnect to the job when you come back.
                    </div>
                    <div className="mt-3 space-y-2">
                      {activeJobs.slice(0, 3).map(job => (
                        <div key={job.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-bg-inset/70 px-3 py-2 text-xs">
                          <span className="text-text-secondary truncate">
                            {importFileName(job)}
                          </span>
                          <span className="text-accent-magenta shrink-0">
                            {routedCount(job) ? `${routedCount(job)} routed` : 'analyzing...'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Upload Area */}
            <label
              className={`card border-2 border-dashed flex flex-col items-center justify-center py-16 cursor-pointer transition-all max-w-3xl mx-auto ${
                dragOver
                  ? 'border-accent-magenta bg-accent-magenta/5'
                  : file
                    ? 'border-semantic-success/40 bg-semantic-success/5'
                    : 'border-border hover:border-border-hover'
              }`}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                const dropped = e.dataTransfer.files[0];
                if (dropped) setFile(dropped);
              }}
            >
              {file ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-semantic-success/10 flex items-center justify-center text-semantic-success">
                    {fileIcon(file.name)}
                  </div>
                  <div className="text-sm font-medium text-text-primary">{file.name}</div>
                  <div className="text-xs text-text-muted">{formatFileSize(file.size)}</div>
                  {file.size > 1024 * 1024 && (
                    <div className="text-[11px] text-semantic-warning bg-semantic-warning/10 border-l-2 border-semantic-warning px-2 py-1 rounded text-left max-w-xs">
                      Large file — analysis runs in the background. You can navigate away and come back; it'll show in your import history when done.
                    </div>
                  )}
                  <button
                    onClick={e => { e.preventDefault(); setFile(null); }}
                    className="text-[11px] text-text-muted hover:text-semantic-error transition-colors flex items-center gap-1 mt-1"
                  >
                    <XIcon size={10} /> Remove
                  </button>
                </div>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-2xl bg-bg-surface-hover flex items-center justify-center text-text-muted mb-4">
                    <Upload size={28} />
                  </div>
                  <div className="text-sm font-medium text-text-primary mb-1">
                    Drop your file here or click to browse
                  </div>
                  <div className="text-xs text-text-muted">
                    Any file type — documents, spreadsheets, presentations, data exports, and more.
                  </div>
                </>
              )}
              <input
                type="file"
                className="hidden"
                accept="*/*"
                onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ''; }}
              />
            </label>

            {error && (
              <div className="mt-4 rounded-xl px-4 py-3" style={{ background: '#1A1A1F', border: '1px solid rgba(239,68,68,0.3)', borderLeft: '3px solid #EF4444' }}>
                <div className="text-sm text-text-primary">{error}</div>
              </div>
            )}

            <div className="flex justify-end mt-6 max-w-3xl mx-auto">
              <button
                className="btn-primary flex items-center gap-2"
                disabled={!file}
                onClick={handleAnalyze}
              >
                <Sparkles size={16} /> Analyze
              </button>
            </div>

            {/* Import History */}
            <div className="mt-10 max-w-4xl mx-auto">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between mb-3">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">Import History</h3>
                  <p className="text-xs text-text-muted mt-1">
                    Bounded history window. Hide duplicates, or delete history rows without undoing imported data.
                  </p>
                </div>
                <span className="text-[11px] text-text-muted">Scroll inside the table</span>
              </div>
              {historyLoading ? (
                <div className="card p-6 text-sm text-text-muted text-center">Loading...</div>
              ) : history.length === 0 ? (
                <div className="card p-6 text-sm text-text-muted text-center">No imports yet</div>
              ) : (
                <div className="card p-0 overflow-hidden flex flex-col max-h-[340px]">
                  <div className="px-4 py-3 border-b border-border/60 bg-bg-inset/40 flex items-center justify-between gap-3">
                    <span className="text-xs text-text-muted">
                      Showing {history.length} visible import{history.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-[11px] text-text-muted">
                      Report opens completed rows
                    </span>
                  </div>
                  <div className="min-h-0 overflow-auto overscroll-contain">
                    <table className="min-w-[980px] w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-border bg-bg-inset/50">
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">File</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Type</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Routed</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Created</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Updated</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Status</th>
                        <th className="text-right px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(job => {
                        const clickable = job.status === 'completed';
                        const storedOnly = likelyStoredOnlyJob(job);
                        return (
                          <tr
                            key={job.id}
                            className={`border-b border-border/50 ${clickable ? 'cursor-pointer hover:bg-bg-surface-hover' : ''}`}
                            onClick={clickable ? () => void openReportFromJob(job) : undefined}
                          >
                            <td className="px-4 py-3">
                              <div className="max-w-[260px] truncate text-text-primary">{importFileName(job)}</div>
                              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                                <span>{formatRelative(job.created_at)}</span>
                                {storedOnly && (
                                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-semantic-warning bg-semantic-warning/10">
                                    <AlertTriangle size={10} /> Stored only
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="badge capitalize">{job.source_type}</span>
                            </td>
                            <td className="px-4 py-3 text-text-primary tabular-nums">{routedCount(job)}</td>
                            <td className="px-4 py-3 text-text-primary tabular-nums">{job.created_rows ?? '—'}</td>
                            <td className="px-4 py-3 text-text-primary tabular-nums">{job.updated_rows ?? '—'}</td>
                            <td className="px-4 py-3">
                              <StatusBadge status={job.status} />
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                {job.status === 'completed' && (
                                  <span className={`text-xs ${storedOnly ? 'text-semantic-warning' : 'text-accent-magenta'}`}>
                                    {reportLoadingId === job.id ? 'opening…' : storedOnly ? 'review' : 'report'}
                                  </span>
                                )}
                                {job.status === 'processing' && (
                                  <span className="text-xs text-accent-magenta">in progress…</span>
                                )}
                                {job.status === 'failed' && (
                                  <span className="text-xs text-semantic-error">failed</span>
                                )}
                                {job.status === 'reverted' && (
                                  <span className="text-xs text-text-muted italic">reverted</span>
                                )}
                                {job.status === 'completed' && (
                                  <button
                                    onClick={e => { e.stopPropagation(); handleUndo(job.id); }}
                                    className="text-xs text-text-muted hover:text-semantic-error transition-colors"
                                    title="Soft-delete created entities and remove the document"
                                  >
                                    Undo
                                  </button>
                                )}
                                <button
                                  onClick={e => { e.stopPropagation(); void handleHideHistory(job); }}
                                  className="h-8 w-8 rounded-lg border border-border/70 text-text-muted hover:text-text-primary hover:bg-bg-surface-hover transition-colors disabled:opacity-40"
                                  title="Hide this row from import history"
                                  disabled={historyActionId === job.id}
                                >
                                  <EyeOff size={14} className="mx-auto" />
                                </button>
                                <button
                                  onClick={e => { e.stopPropagation(); void handleDeleteHistory(job); }}
                                  className="h-8 w-8 rounded-lg border border-semantic-error/30 text-semantic-error/80 hover:text-semantic-error hover:bg-semantic-error/10 transition-colors disabled:opacity-40"
                                  title="Delete this import history row"
                                  disabled={historyActionId === job.id}
                                >
                                  <Trash2 size={14} className="mx-auto" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {toast && (() => {
          const isError = /fail|error|could not/i.test(toast);
          return (
            <div
              className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3 max-w-sm"
              style={{
                background: '#1A1A1F',
                border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`,
                borderLeft: `3px solid ${isError ? '#EF4444' : '#22C55E'}`,
              }}
            >
              <div className="text-sm text-text-primary">{toast}</div>
            </div>
          );
        })()}
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render: Analyzing Phase
  // ────────────────────────────────────────────────────────────────────────

  if (phase === 'analyzing') {
    return (
      <div className="flex-1 min-h-0 h-full flex flex-col overflow-hidden">
        {!embedded && <TopBar title="Document Intelligence" />}
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <div className="max-w-md w-full px-6">
            <div className="flex flex-col items-center mb-10">
              <div className="w-16 h-16 rounded-2xl bg-brand-gradient flex items-center justify-center mb-4">
                <Sparkles size={28} className="text-white" />
              </div>
              <div className="text-lg font-medium text-text-primary mb-1">Analyzing Document</div>
              <div className="text-xs text-text-muted">{file?.name}</div>
            </div>

            <div className="space-y-4">
              {ANALYZE_STEPS.map((step, i) => (
                <div key={step} className="flex items-center gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all ${
                    i < analyzeStep
                      ? 'bg-semantic-success text-white'
                      : i === analyzeStep
                        ? 'bg-brand-gradient text-white'
                        : 'bg-bg-surface-hover text-text-muted'
                  }`}>
                    {i < analyzeStep ? (
                      <Check size={12} />
                    ) : i === analyzeStep ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <span className="text-[10px]">{i + 1}</span>
                    )}
                  </div>
                  <span className={`text-sm transition-colors ${
                    i <= analyzeStep ? 'text-text-primary' : 'text-text-muted'
                  }`}>
                    {step}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render: Intelligence Report Phase
  // ────────────────────────────────────────────────────────────────────────

  if (!result) return null;

  const importReport = result.import_report;
  const primaryDocument = importReport?.documents?.[0];
  const displayFileName = importReport?.file_name || primaryDocument?.file_name || file?.name || 'Uploaded file';
  const displayFileSize = primaryDocument?.file_size || file?.size || null;
  const storedOnlyMessage = reportStoredOnlyMessage(importReport);
  const catConfig = storedOnlyMessage
    ? { label: 'Stored File', color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' }
    : CATEGORY_CONFIG[primaryDocument?.document_type || result.category] || CATEGORY_CONFIG.reference;
  const totalContacts = result.contacts_created + result.contacts_updated;
  const totalCompanies = result.companies_created + result.companies_updated;
  const undoJobId = importReport?.job_id || result.document_id;

  return (
    <div className="flex-1 min-h-0 h-full flex flex-col overflow-hidden">
      <TopBar
        title="Intelligence Report"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleUndo(undoJobId)}
              className="btn-ghost text-sm text-semantic-error hover:bg-semantic-error/10"
              title="Soft-delete created entities and remove the document"
            >
              Undo Import
            </button>
            <button className="btn-ghost flex items-center gap-2 text-sm" onClick={resetToUpload}>
              <ArrowLeft size={14} /> New Import
            </button>
          </div>
        }
      />
      <div className="flex-1 min-h-0 p-4 md:p-6 overflow-auto">
        <div className="max-w-4xl mx-auto space-y-6">

          {/* Document Summary Card */}
          <div className="card p-5">
            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: catConfig.bg, color: catConfig.color }}>
                <FileText size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold font-accent" style={{ background: catConfig.bg, color: catConfig.color }}>
                    {catConfig.label}
                  </span>
                </div>
                <div className="text-sm text-text-primary leading-relaxed">{result.summary}</div>
                <div className="text-xs text-text-muted mt-2">
                  {displayFileName}{displayFileSize ? ` · ${formatFileSize(displayFileSize)}` : ''}
                </div>
              </div>
            </div>
          </div>

          {storedOnlyMessage && (
            <div className="rounded-lg border border-semantic-warning/30 bg-semantic-warning/10 px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={17} className="text-semantic-warning shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary">Stored only</div>
                  <div className="text-xs text-text-secondary mt-1 leading-relaxed">
                    {storedOnlyMessage}
                  </div>
                </div>
              </div>
            </div>
          )}

          {importReport && <ImportRunReport report={importReport} onPreview={setPreviewDocId} />}

          {/* Stats Row */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard icon={<Users size={16} />} label="Contacts" total={totalContacts} created={result.contacts_created} updated={result.contacts_updated} />
            <StatCard icon={<Building2 size={16} />} label="Companies" total={totalCompanies} created={result.companies_created} updated={result.companies_updated} />
            <StatCard icon={<Handshake size={16} />} label="Deals" total={result.deals_created} created={result.deals_created} updated={0} />
            <StatCard icon={<Zap size={16} />} label="Signals" total={result.signals_found} created={result.signals_found} updated={0} />
          </div>

          {/* Errors (if any) */}
          {result.errors.length > 0 && (
            <div className="rounded-xl px-4 py-3" style={{ background: '#1A1A1F', border: '1px solid rgba(239,68,68,0.2)', borderLeft: '3px solid #EF4444' }}>
              <div className="text-xs font-medium text-semantic-error mb-1">{result.errors.length} issue{result.errors.length > 1 ? 's' : ''}</div>
              {result.errors.slice(0, 5).map((err, i) => (
                <div key={i} className="text-xs text-text-muted">{err}</div>
              ))}
            </div>
          )}

          {/* Entity Tabs */}
          {(totalContacts > 0 || totalCompanies > 0 || result.deals_created > 0) && (
            <div className="card p-0 overflow-hidden">
              <div className="flex border-b border-border">
                <TabButton active={activeTab === 'contacts'} onClick={() => setActiveTab('contacts')} count={totalContacts}>Contacts</TabButton>
                <TabButton active={activeTab === 'companies'} onClick={() => setActiveTab('companies')} count={totalCompanies}>Companies</TabButton>
                <TabButton active={activeTab === 'deals'} onClick={() => setActiveTab('deals')} count={result.deals_created}>Deals</TabButton>
              </div>

              <div className="overflow-x-auto">
                {activeTab === 'contacts' && (
                  <ContactsTable result={result} />
                )}
                {activeTab === 'companies' && (
                  <CompaniesTable result={result} />
                )}
                {activeTab === 'deals' && (
                  <DealsTable result={result} />
                )}
              </div>
            </div>
          )}

          {/* Relationships */}
          {result.relationships_found > 0 && result.extraction?.relationships && (
            <div className="card p-5">
              <h3 className="text-sm font-medium text-text-primary mb-3">Relationships Discovered</h3>
              <div className="space-y-2">
                {result.extraction.relationships.map((rel, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="text-text-primary font-medium">{rel.from_name}</span>
                    <span className="text-text-muted">&rarr;</span>
                    <span className="badge capitalize">{rel.relationship_type.replace(/_/g, ' ')}</span>
                    <span className="text-text-muted">at</span>
                    <span className="text-text-primary font-medium">{rel.to_name}</span>
                    {rel.context && <span className="text-xs text-text-muted ml-1">({rel.context})</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Signals */}
          {result.signals_found > 0 && result.extraction?.signals && (
            <div className="card p-5">
              <h3 className="text-sm font-medium text-text-primary mb-3">Intelligence Signals</h3>
              <div className="space-y-2">
                {result.extraction.signals.map((sig, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <div className="w-5 h-5 rounded-full bg-accent-magenta/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Zap size={10} className="text-accent-magenta" />
                    </div>
                    <div>
                      <span className="text-text-primary font-medium">{sig.entity_name}</span>
                      <span className="text-text-muted mx-1.5">&middot;</span>
                      <span className="badge capitalize">{sig.signal_type.replace(/_/g, ' ')}</span>
                      <div className="text-xs text-text-secondary mt-0.5">{sig.summary}</div>
                      {sig.date && <div className="text-[10px] text-text-muted mt-0.5">{sig.date}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result Summary Bar */}
          <div className="card p-4 flex items-center justify-between">
            <div className="text-sm text-text-secondary">
              {result.entities_routed} CRM record{result.entities_routed === 1 ? '' : 's'} routed · {result.errors.length} issue{result.errors.length !== 1 ? 's' : ''}
            </div>
            <button className="btn-primary flex items-center gap-2" onClick={resetToUpload}>
              <Upload size={14} /> Import Another
            </button>
          </div>
        </div>
      </div>

      {toast && (() => {
        const isError = /fail|error/i.test(toast);
        return (
          <div className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
            style={{ background: '#1A1A1F', border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`, borderLeft: `3px solid ${isError ? '#EF4444' : '#22C55E'}` }}>
            <div className="text-sm text-text-primary">{toast}</div>
          </div>
        );
      })()}
      <DocumentPreviewModal
        docId={previewDocId}
        onClose={() => setPreviewDocId(null)}
      />
    </div>
  );
}

export default function ImportsPage() {
  return <ImportsPageContent />;
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

function ImportRunReport({ report, onPreview }: { report: ImportReport; onPreview: (documentId: string) => void }) {
  const createdTotal =
    (report.lineage_counts.contact || 0) +
    (report.lineage_counts.company || 0) +
    (report.lineage_counts.deal || 0);

  return (
    <div className="card p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Import Run Report</h3>
          <p className="text-xs text-text-muted mt-1">
            Full trace of what happened to this upload, from document storage through CRM routing and MARTy embedding.
          </p>
        </div>
        <StatusBadge status={report.status} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MiniMetric label="Processed" value={formatNumber(report.counters.processed_rows)} />
        <MiniMetric label="Created" value={formatNumber(report.counters.created_rows)} />
        <MiniMetric label="Updated" value={formatNumber(report.counters.updated_rows)} />
        <MiniMetric label="Failed" value={formatNumber(report.counters.failed_rows)} danger={report.counters.failed_rows > 0} />
      </div>

      <div>
        <div className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">What happened</div>
        <div className="space-y-2">
          {report.stages.map(stage => (
            <div key={stage.key} className="flex items-start gap-3 rounded-xl border border-border/60 bg-bg-inset/60 px-3 py-3">
              <StageDot status={stage.status} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{stage.label}</span>
                  <StageStatusBadge status={stage.status} />
                </div>
                <div className="text-xs text-text-muted mt-1 leading-relaxed">{stage.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {report.documents.length > 0 && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Document record</div>
          <div className="space-y-2">
            {report.documents.map(doc => (
              <div
                key={doc.id}
                className="flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border border-border/60 bg-bg-inset/60 px-3 py-3 hover:border-accent-magenta/40 transition-colors"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-accent-magenta/10 text-accent-magenta flex items-center justify-center shrink-0">
                    <FileText size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{doc.file_name || doc.title}</div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {(doc.document_type || 'document').replace(/_/g, ' ')}
                      {doc.file_size ? ` · ${formatFileSize(doc.file_size)}` : ''}
                      {` · ${formatNumber(doc.vector_count)} MARTy chunk${doc.vector_count === 1 ? '' : 's'}`}
                    </div>
                    {doc.error_message && (
                      <div className="text-xs text-semantic-error mt-1">{doc.error_message}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <DocumentActions
                    doc={doc}
                    variant="compact"
                    onPreview={onPreview}
                  />
                  <Link
                    href={`/documents/${doc.id}`}
                    className="inline-flex items-center rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors"
                  >
                    Open record
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <CreatedRecords report={report} createdTotal={createdTotal} />

      {report.work_items.length > 0 && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Processing trail</div>
          <div className="max-h-64 overflow-auto rounded-xl border border-border/60">
            <table className="min-w-[680px] w-full text-xs">
              <thead className="sticky top-0 bg-bg-inset z-10">
                <tr className="border-b border-border/60 text-text-muted">
                  <th className="text-left px-3 py-2 font-medium">Work</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Attempt</th>
                  <th className="text-left px-3 py-2 font-medium">Created</th>
                  <th className="text-left px-3 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {report.work_items.map(item => (
                  <tr key={item.id} className="border-b border-border/40 last:border-b-0">
                    <td className="px-3 py-2 text-text-primary">{item.domain.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2"><StatusBadge status={item.status} /></td>
                    <td className="px-3 py-2 text-text-secondary tabular-nums">{item.attempt}/{item.max_attempts}</td>
                    <td className="px-3 py-2 text-text-secondary">{item.created_at ? formatRelative(item.created_at) : '—'}</td>
                    <td className="px-3 py-2 text-text-muted max-w-[260px] truncate">{item.last_error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {report.notes.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-bg-inset/60 px-3 py-3 space-y-1">
          {report.notes.map((note, i) => (
            <div key={i} className="text-xs text-text-muted leading-relaxed">{note}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniMetric({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-border/60 bg-bg-inset/60 px-3 py-3">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`text-xl font-semibold font-display tabular-nums mt-1 ${danger ? 'text-semantic-error' : 'text-text-primary'}`}>{value}</div>
    </div>
  );
}

function StageDot({ status }: { status: ImportReportStage['status'] }) {
  const color =
    status === 'completed' ? '#22C55E' :
    status === 'running' ? '#D946A8' :
    status === 'failed' ? '#EF4444' :
    status === 'warning' ? '#F59E0B' :
    '#64748B';
  return <div className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0" style={{ background: color }} />;
}

function StageStatusBadge({ status }: { status: ImportReportStage['status'] }) {
  const config: Record<ImportReportStage['status'], { color: string; bg: string; label: string }> = {
    completed: { color: '#22C55E', bg: 'rgba(34,197,94,0.12)', label: 'Done' },
    running: { color: '#D946A8', bg: 'rgba(217,70,168,0.12)', label: 'Running' },
    pending: { color: '#94A3B8', bg: 'rgba(148,163,184,0.12)', label: 'Pending' },
    failed: { color: '#EF4444', bg: 'rgba(239,68,68,0.12)', label: 'Failed' },
    warning: { color: '#F59E0B', bg: 'rgba(245,158,11,0.12)', label: 'Needs attention' },
  };
  const c = config[status];
  return <span className="px-2 py-0.5 rounded text-[10px] font-medium" style={{ color: c.color, background: c.bg }}>{c.label}</span>;
}

function CreatedRecords({ report, createdTotal }: { report: ImportReport; createdTotal: number }) {
  const groups: Array<[string, ImportCreatedEntity[], number]> = [
    ['Contacts', report.created_entities.contacts, report.lineage_counts.contact || 0],
    ['Companies', report.created_entities.companies, report.lineage_counts.company || 0],
    ['Deals', report.created_entities.deals, report.lineage_counts.deal || 0],
  ];
  if (createdTotal === 0) return null;

  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Created records</div>
      <div className="grid md:grid-cols-3 gap-3">
        {groups.map(([label, rows, total]) => (
          <div key={label} className="rounded-xl border border-border/60 bg-bg-inset/60 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-text-primary">{label}</span>
              <span className="text-xs text-text-muted tabular-nums">{formatNumber(total)}</span>
            </div>
            {rows.length > 0 ? (
              <div className="space-y-2">
                {rows.slice(0, 5).map(row => (
                  <div key={row.id} className="min-w-0">
                    <div className="text-xs text-text-primary truncate">{row.name}</div>
                    {row.subtitle && <div className="text-[11px] text-text-muted truncate">{row.subtitle}</div>}
                  </div>
                ))}
                {total > rows.length && (
                  <div className="text-[11px] text-text-muted">+ {formatNumber(total - rows.length)} more tracked in lineage</div>
                )}
              </div>
            ) : (
              <div className="text-xs text-text-muted">No new {label.toLowerCase()} were created.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ icon, label, total, created, updated }: {
  icon: React.ReactNode; label: string; total: number; created: number; updated: number;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2 text-text-muted">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-semibold font-display text-text-primary tabular-nums">{total}</div>
      {(created > 0 || updated > 0) && (
        <div className="flex items-center gap-2 mt-1">
          {created > 0 && <span className="text-[10px] font-medium" style={{ color: '#22C55E' }}>{created} new</span>}
          {updated > 0 && <span className="text-[10px] font-medium" style={{ color: '#3B82F6' }}>{updated} enriched</span>}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, count, children }: {
  active: boolean; onClick: () => void; count: number; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-5 py-3 text-sm font-medium transition-colors relative ${
        active ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {children}
      {count > 0 && (
        <span className="ml-1.5 text-[10px] tabular-nums text-text-muted">({count})</span>
      )}
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent-magenta" />
      )}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; bg: string }> = {
    completed:  { color: '#22C55E', bg: 'rgba(34,197,94,0.12)' },
    processing: { color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
    failed:     { color: '#EF4444', bg: 'rgba(239,68,68,0.12)' },
    cancelled:  { color: '#94A3B8', bg: 'rgba(148,163,184,0.12)' },
    mapping:    { color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
    preview:    { color: '#8B5CF6', bg: 'rgba(139,92,246,0.12)' },
  };
  const c = config[status] || config.processing;
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-medium capitalize" style={{ background: c.bg, color: c.color }}>
      {status}
    </span>
  );
}

function EntityStatusBadge({ type }: { type: 'new' | 'match' | 'enrich' }) {
  const map = {
    new:     { color: '#22C55E', bg: 'rgba(34,197,94,0.12)', label: 'New' },
    match:   { color: '#3B82F6', bg: 'rgba(59,130,246,0.12)', label: 'Match' },
    enrich:  { color: '#F59E0B', bg: 'rgba(245,158,11,0.12)', label: 'Enrich' },
  };
  const c = map[type];
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-medium" style={{ background: c.bg, color: c.color }}>
      {c.label}
    </span>
  );
}

function ContactsTable({ result }: { result: IntelligenceResult }) {
  const total = result.contacts_created + result.contacts_updated;
  if (total === 0) {
    return <div className="p-8 text-sm text-text-muted text-center">No contacts found in this document</div>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border bg-bg-inset/50">
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Name</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Email</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Company</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Title</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Status</th>
        </tr>
      </thead>
      <tbody>
        {result.extraction?.contacts?.map((c, i) => (
          <tr key={i} className="border-b border-border/50">
            <td className="px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 shrink-0 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[10px] font-medium">
                  {c.full_name.charAt(0)}
                </div>
                <span className="font-medium text-text-primary truncate">{c.full_name}</span>
              </div>
            </td>
            <td className="px-4 py-3 text-text-secondary truncate max-w-[180px]">{c.email || '—'}</td>
            <td className="px-4 py-3 text-text-secondary truncate max-w-[140px]">{c.company_name || '—'}</td>
            <td className="px-4 py-3 text-text-secondary truncate max-w-[140px]">{c.job_title || '—'}</td>
            <td className="px-4 py-3">
              <EntityStatusBadge type="new" />
            </td>
          </tr>
        )) ?? (
          <tr>
            <td colSpan={5} className="px-4 py-3 text-text-secondary text-center">
              {result.contacts_created} created, {result.contacts_updated} enriched
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function CompaniesTable({ result }: { result: IntelligenceResult }) {
  const total = result.companies_created + result.companies_updated;
  if (total === 0) {
    return <div className="p-8 text-sm text-text-muted text-center">No companies found in this document</div>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border bg-bg-inset/50">
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Name</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Website</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Sector</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Stage</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Status</th>
        </tr>
      </thead>
      <tbody>
        {result.extraction?.companies?.map((c, i) => (
          <tr key={i} className="border-b border-border/50">
            <td className="px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 shrink-0 rounded-lg bg-brand-gradient flex items-center justify-center text-white text-[10px] font-medium">
                  {c.name.charAt(0)}
                </div>
                <span className="font-medium text-text-primary truncate">{c.name}</span>
              </div>
            </td>
            <td className="px-4 py-3 text-text-secondary truncate max-w-[160px]">{c.website || c.domain || '—'}</td>
            <td className="px-4 py-3 text-text-secondary">{c.sector || '—'}</td>
            <td className="px-4 py-3"><span className="badge capitalize">{c.stage || '—'}</span></td>
            <td className="px-4 py-3">
              <EntityStatusBadge type="new" />
            </td>
          </tr>
        )) ?? (
          <tr>
            <td colSpan={5} className="px-4 py-3 text-text-secondary text-center">
              {result.companies_created} created, {result.companies_updated} enriched
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function DealsTable({ result }: { result: IntelligenceResult }) {
  if (result.deals_created === 0) {
    return <div className="p-8 text-sm text-text-muted text-center">No deals found in this document</div>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border bg-bg-inset/50">
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Deal</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Company</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Stage</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Amount</th>
          <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Status</th>
        </tr>
      </thead>
      <tbody>
        {result.extraction?.deals?.map((d, i) => (
          <tr key={i} className="border-b border-border/50">
            <td className="px-4 py-3 font-medium text-text-primary">{d.name}</td>
            <td className="px-4 py-3 text-text-secondary">{d.company_name || '—'}</td>
            <td className="px-4 py-3"><span className="badge capitalize">{d.stage || '—'}</span></td>
            <td className="px-4 py-3 text-text-primary font-accent tabular-nums">{d.amount ? formatCurrency(d.amount) : '—'}</td>
            <td className="px-4 py-3">
              <EntityStatusBadge type="new" />
            </td>
          </tr>
        )) ?? (
          <tr>
            <td colSpan={5} className="px-4 py-3 text-text-secondary text-center">
              {result.deals_created} deals created
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function formatCurrency(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}
