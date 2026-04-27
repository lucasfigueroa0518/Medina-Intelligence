'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { api } from '@/lib/api';
import {
  Upload, FileText, FileSpreadsheet, File, Presentation,
  Users, Building2, Handshake, Zap, ChevronDown, ChevronRight,
  Check, X as XIcon, Loader2, ArrowLeft, Sparkles,
} from 'lucide-react';

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
}

interface ImportJob {
  id: string;
  source_type: string;
  status: string;
  created_at: string;
  total_rows?: number;
  created_rows?: number;
  updated_rows?: number;
  failed_rows?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const ACCEPTED_EXTENSIONS = '.csv,.xlsx,.xls,.json,.vcf,.pdf,.docx,.pptx,.txt,.md';

const CATEGORY_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  contact_list:     { label: 'Contact List',     color: '#22C55E', bg: 'rgba(34,197,94,0.12)' },
  pitch_deck:       { label: 'Pitch Deck',       color: '#8B5CF6', bg: 'rgba(139,92,246,0.12)' },
  financial_report: { label: 'Financial Report',  color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
  meeting_notes:    { label: 'Meeting Notes',     color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
  deal_memo:        { label: 'Deal Memo',         color: '#D946A8', bg: 'rgba(217,70,168,0.12)' },
  email_thread:     { label: 'Email Thread',      color: '#06B6D4', bg: 'rgba(6,182,212,0.12)' },
  news_article:     { label: 'News Article',      color: '#EF4444', bg: 'rgba(239,68,68,0.12)' },
  legal_document:   { label: 'Legal Document',    color: '#64748B', bg: 'rgba(100,116,139,0.12)' },
  investor_update:  { label: 'Investor Update',   color: '#10B981', bg: 'rgba(16,185,129,0.12)' },
  market_research:  { label: 'Market Research',   color: '#F97316', bg: 'rgba(249,115,22,0.12)' },
  portfolio_report: { label: 'Portfolio Report',   color: '#6366F1', bg: 'rgba(99,102,241,0.12)' },
  resume_cv:        { label: 'Resume / CV',       color: '#14B8A6', bg: 'rgba(20,184,166,0.12)' },
  other:            { label: 'Document',          color: '#94A3B8', bg: 'rgba(148,163,184,0.12)' },
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

export default function ImportsPage() {
  const [phase, setPhase] = React.useState<Phase>('upload');
  const [file, setFile] = React.useState<File | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [analyzeStep, setAnalyzeStep] = React.useState(0);
  const [result, setResult] = React.useState<IntelligenceResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  // Import history
  const [history, setHistory] = React.useState<ImportJob[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(true);

  // Report state
  const [activeTab, setActiveTab] = React.useState<'contacts' | 'companies' | 'deals'>('contacts');
  const [expandedRows, setExpandedRows] = React.useState<Set<number>>(new Set());

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
    setPhase('analyzing');
    setAnalyzeStep(0);
    setError(null);

    const isSmall = file.size < 5 * 1024 * 1024;

    try {
      if (isSmall) {
        const data = await api.intelligentImport(file, true);
        setResult(data.result);
        setPhase('report');
        setHistory(prev => [{ id: data.result.document_id, source_type: 'intelligent', status: 'completed', created_at: new Date().toISOString(), total_rows: data.result.entities_routed, created_rows: data.result.contacts_created + data.result.companies_created + data.result.deals_created, updated_rows: data.result.contacts_updated + data.result.companies_updated }, ...prev]);
      } else {
        const data = await api.intelligentImport(file, false);
        const jobId = data.job_id;
        await pollJob(jobId);
      }
    } catch (e: any) {
      setError(e.message || 'Import failed');
      setPhase('upload');
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
          setResult({
            document_id: job.id,
            category: 'other',
            summary: `Processed ${job.total_rows || 0} entities from uploaded file.`,
            contacts_created: job.created_rows || 0,
            contacts_updated: job.updated_rows || 0,
            companies_created: 0,
            companies_updated: 0,
            deals_created: 0,
            relationships_found: 0,
            signals_found: 0,
            entities_routed: job.processed_rows || 0,
            errors: job.failed_rows ? [`${job.failed_rows} rows failed`] : [],
          });
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
      <div className="flex-1 flex flex-col">
        <TopBar
          title="Document Intelligence"
          actions={
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Sparkles size={14} className="text-accent-magenta" />
              AI-powered document analysis
            </div>
          }
        />
        <div className="flex-1 p-8 overflow-auto">
          <div className="max-w-2xl mx-auto">
            {/* Upload Area */}
            <label
              className={`card border-2 border-dashed flex flex-col items-center justify-center py-16 cursor-pointer transition-all ${
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
                    CSV, Excel, PDF, Word, PowerPoint, JSON, Text, Markdown
                  </div>
                </>
              )}
              <input
                type="file"
                className="hidden"
                accept={ACCEPTED_EXTENSIONS}
                onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ''; }}
              />
            </label>

            {error && (
              <div className="mt-4 rounded-xl px-4 py-3" style={{ background: '#1A1A1F', border: '1px solid rgba(239,68,68,0.3)', borderLeft: '3px solid #EF4444' }}>
                <div className="text-sm text-text-primary">{error}</div>
              </div>
            )}

            <div className="flex justify-end mt-6">
              <button
                className="btn-primary flex items-center gap-2"
                disabled={!file}
                onClick={handleAnalyze}
              >
                <Sparkles size={16} /> Analyze
              </button>
            </div>

            {/* Import History */}
            <div className="mt-12">
              <h3 className="text-sm font-medium text-text-primary mb-3">Import History</h3>
              {historyLoading ? (
                <div className="card p-6 text-sm text-text-muted text-center">Loading...</div>
              ) : history.length === 0 ? (
                <div className="card p-6 text-sm text-text-muted text-center">No imports yet</div>
              ) : (
                <div className="card p-0 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-bg-inset/50">
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Date</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Type</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Created</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Updated</th>
                        <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.slice(0, 20).map(job => (
                        <tr key={job.id} className="border-b border-border/50">
                          <td className="px-4 py-3 text-text-secondary">{formatRelative(job.created_at)}</td>
                          <td className="px-4 py-3">
                            <span className="badge capitalize">{job.source_type}</span>
                          </td>
                          <td className="px-4 py-3 text-text-primary tabular-nums">{job.created_rows ?? '—'}</td>
                          <td className="px-4 py-3 text-text-primary tabular-nums">{job.updated_rows ?? '—'}</td>
                          <td className="px-4 py-3">
                            <StatusBadge status={job.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render: Analyzing Phase
  // ────────────────────────────────────────────────────────────────────────

  if (phase === 'analyzing') {
    return (
      <div className="flex-1 flex flex-col">
        <TopBar title="Document Intelligence" />
        <div className="flex-1 flex items-center justify-center">
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

  const catConfig = CATEGORY_CONFIG[result.category] || CATEGORY_CONFIG.other;
  const totalContacts = result.contacts_created + result.contacts_updated;
  const totalCompanies = result.companies_created + result.companies_updated;

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="Intelligence Report"
        actions={
          <button className="btn-ghost flex items-center gap-2 text-sm" onClick={resetToUpload}>
            <ArrowLeft size={14} /> New Import
          </button>
        }
      />
      <div className="flex-1 p-6 overflow-auto">
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
                <div className="text-xs text-text-muted mt-2">{file?.name} · {file ? formatFileSize(file.size) : ''}</div>
              </div>
            </div>
          </div>

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
              {result.entities_routed} entities processed · {result.errors.length} error{result.errors.length !== 1 ? 's' : ''}
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
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

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
