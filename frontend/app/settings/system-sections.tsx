'use client';

import React from 'react';
import {
  Check,
  X as XIcon,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Mail,
  Loader2,
  Shield,
  Users,
  Target,
  Calendar,
} from 'lucide-react';
import { ExpandableText } from '@/components/expandable-text';
import {
  api,
  type SystemStatusResponse,
  type SystemStatusActiveTask,
  type SystemStatusRunHistoryEntry,
  type CompletenessMetric,
  type WorkQueueInventoryEntry,
  type StuckWorkQueueEntry,
  type BudgetSnapshotRow,
  type IngestionIncident,
  type DealReplayEvidenceRow,
  type MartyLabStatusSnapshot,
  type MartyLabRunSnapshot,
  type DealReplayStatusSnapshot,
} from '@/lib/api';

const MARTY_SANDBOX_EXECUTION_DISABLED = true;

// ────────────────────────────────────────────────────────────────────────────
// System Status tab — active tasks + run history + data completeness.
// All numbers come from a single GET /api/settings/system-status which runs
// direct D1 queries (no KV counters, no estimates).
// ────────────────────────────────────────────────────────────────────────────

export function SystemStatusSection() {
  const [data, setData] = React.useState<SystemStatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api.getSettingsSystemStatus().then(setData).catch(e => setError(e?.message || 'Failed to load'));
  }, []);

  React.useEffect(() => {
    load();
    // Refresh every 10s while the tab is open. No visibility-pause logic
    // needed — Settings is a low-frequency page.
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (error) {
    return (
      <div className="card p-6">
        <div className="text-sm text-semantic-error">{error}</div>
        <button onClick={load} className="btn-secondary text-xs mt-3">Retry</button>
      </div>
    );
  }
  if (!data) {
    return <div className="card p-6 text-sm text-text-muted">Loading…</div>;
  }

	  return (
	    <div className="space-y-6">
	      <RateLimitIndicator budgets={data.budgets || []} />
	      <OutlookAppOnlyHealthCard health={data.outlook_app_only_health} />
	      <IngestionIncidentsCard incidents={data.ingestion_incidents || []} />
	      <ActiveTasksCard tasks={data.active_tasks} />
	      <RunHistoryCard rows={data.run_history} />
      <DataCompletenessCard c={data.completeness} />
      <WorkQueueCard
        inventory={data.work_queue_inventory}
        stuck={data.stuck_work_queue}
      />
      <DealReplayStatusCard replay={data.deal_replay || emptyDealReplay} onRefresh={load} />
    </div>
  );
}

export function MartySandboxSection() {
  const [data, setData] = React.useState<SystemStatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api.getSettingsSystemStatus().then(setData).catch(e => setError(e?.message || 'Failed to load MARTy Sandbox'));
  }, []);

  React.useEffect(() => {
    load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (error) {
    return (
      <div className="card p-6">
        <div className="text-sm text-semantic-error">{error}</div>
        <button onClick={load} className="btn-secondary text-xs mt-3">Retry</button>
      </div>
    );
  }
  if (!data) {
    return <div className="card p-6 text-sm text-text-muted">Loading MARTy Sandbox...</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="text-xl font-semibold text-text-primary">MARTy Sandbox</div>
        <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-muted">
          A controlled experiment studio for testing one MARTy improvement at a time. Each experiment runs discovery, applies one candidate upgrade, tests it, then waits for Ship or Reject.
        </div>
      </div>
      <MartyLabStatusCard lab={data.marty_lab || emptyMartyLab} onRefresh={load} />
    </div>
  );
}

const emptyMartyLab: MartyLabStatusSnapshot = {
  run: null,
  recent_runs: [],
  queued_runs: [],
  experiments: [],
  upgrade_candidates: [],
  versions: [],
  upgrade_trials: [],
  deep_work_items: [],
  code_patch_jobs: [],
  readiness: {
    ok: false,
    harness_version: 'unknown',
    generated_at: new Date().toISOString(),
    blockers: ['Readiness has not loaded yet.'],
    warnings: [],
    checks: [],
  },
  generated_at: new Date().toISOString(),
};

const emptyDealReplay: DealReplayStatusSnapshot = {
  run: null,
  queue: { pending: 0, in_progress: 0, completed: 0, failed: 0, dead_letter: 0 },
  generated_at: new Date().toISOString(),
};

function ReplayMetric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const color = tone === 'good'
    ? 'text-semantic-success'
    : tone === 'warn'
      ? 'text-semantic-warning'
      : tone === 'bad'
        ? 'text-semantic-error'
        : 'text-text-primary';
  return (
    <div className="rounded-lg border border-white/[0.04] bg-white/[0.025] px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function ReplayStatusPill({ status }: { status: NonNullable<DealReplayStatusSnapshot['run']>['status'] }) {
  const cfg = {
    running: { label: 'Running', cls: 'bg-accent-magenta/15 text-accent-magenta' },
    completed: { label: 'Completed', cls: 'bg-semantic-success/15 text-semantic-success' },
    cancelled: { label: 'Cancelled', cls: 'bg-semantic-warning/15 text-semantic-warning' },
    failed: { label: 'Failed', cls: 'bg-semantic-error/15 text-semantic-error' },
  }[status];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cfg.cls}`}>{cfg.label}</span>;
}

function MartyLabStatusPill({ status }: { status: string }) {
  const pretty = status.replace(/_/g, ' ');
  const cfg = status === 'running' || status === 'queued' || status === 'sandbox_applied' || status === 'pending'
    ? { cls: 'bg-accent-purple/15 text-accent-purple', label: status === 'sandbox_applied' ? 'Sandbox applied' : status.charAt(0).toUpperCase() + status.slice(1) }
    : status === 'completed' || status === 'graded' || status === 'validated' || status === 'accepted'
      ? { cls: 'bg-semantic-success/15 text-semantic-success', label: status.charAt(0).toUpperCase() + status.slice(1) }
    : status === 'blocked' || status === 'failed' || status === 'rejected'
        ? { cls: 'bg-semantic-error/15 text-semantic-error', label: status.charAt(0).toUpperCase() + status.slice(1) }
        : status === 'cancelled' || status === 'inconclusive'
          ? { cls: 'bg-semantic-warning/15 text-semantic-warning', label: status.charAt(0).toUpperCase() + status.slice(1) }
        : { cls: 'bg-white/[0.06] text-text-muted', label: status.charAt(0).toUpperCase() + status.slice(1) };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${cfg.cls}`}>{cfg.label.replace(/_/g, ' ') || pretty}</span>;
}

function formatLabScore(score: number | null | undefined): string {
  return typeof score === 'number' ? `${Math.round(score)}/100` : '—';
}

function formatLabList(values: string[] | undefined, fallback = 'None recorded yet'): string {
  if (!values || values.length === 0) return fallback;
  return values.slice(0, 3).join(' · ');
}

function formatLabNote(value: Record<string, unknown>): string {
  const title = value.title || value.label || value.dimension || value.type;
  const body = value.body || value.message || value.note || value.summary || value.text;
  if (title && body) return `${String(title)}: ${String(body)}`;
  if (body) return String(body);
  return JSON.stringify(value);
}

function labSummaryText(summary: Record<string, unknown> | null | undefined): string | null {
  if (!summary) return null;
  const conclusion = summary.conclusion || summary.current_phase || summary.message;
  return conclusion ? String(conclusion) : null;
}

function labEvidenceList(evidence: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = evidence?.[key];
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

type MartyLabExperimentRow = MartyLabStatusSnapshot['experiments'][number];
type MartyLabTrialRow = MartyLabStatusSnapshot['upgrade_trials'][number];
type MartyLabDeepWorkItemRow = MartyLabStatusSnapshot['deep_work_items'][number];
type MartyLabCodePatchJobRow = MartyLabStatusSnapshot['code_patch_jobs'][number];

function labRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function titleizeLabValue(value: unknown, fallback = 'Unknown'): string {
  const raw = String(value || fallback).replace(/_/g, ' ');
  return raw.replace(/\b\w/g, c => c.toUpperCase());
}

function labNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function labReadableEvidence(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const text = value.map(item => labReadableEvidence(item)).filter(Boolean).join('\n');
    return text || null;
  }
  const record = labRecord(value);
  if (record) {
    const lines = Object.entries(record)
      .slice(0, 8)
      .map(([key, item]) => {
        const text = labReadableEvidence(item);
        return text ? `${titleizeLabValue(key)}: ${text}` : null;
      })
      .filter(Boolean);
    return lines.length ? lines.join('\n') : null;
  }
  return null;
}

function labDeepWorkBody(item: MartyLabDeepWorkItemRow): string {
  const evidence = labRecord(item.evidence) || {};
  const keys = [
    'recommended_implementation',
    'implementation',
    'why_it_matters',
    'why_it_matters_for_user_experience',
    'evidence_summary',
    'summary',
    'recommendation',
    'acceptance_tests',
    'root_cause',
  ];
  const parts = keys
    .map(key => labReadableEvidence(evidence[key]))
    .filter(Boolean) as string[];
  if (parts.length > 0) return Array.from(new Set(parts)).join('\n\n');
  return item.lever_ids.length > 0
    ? `Candidate levers: ${item.lever_ids.join(', ')}`
    : `Cluster: ${item.cluster_key}`;
}

function labCodePatchStatusLabel(status: MartyLabCodePatchJobRow['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'planning':
      return 'Writing patch brief';
    case 'ready_for_agent':
      return 'Ready for isolated agent';
    case 'in_agent_worktree':
      return 'In isolated worktree';
    case 'ready_for_review':
      return 'Ready for review';
    case 'validated':
      return 'Validated';
    case 'rejected':
      return 'Rejected';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return titleizeLabValue(status);
  }
}

function labCodePatchBody(job: MartyLabCodePatchJobRow): string {
  const patchScope = labRecord(job.patch_scope) || {};
  const validationPlan = labRecord(job.validation_plan) || {};
  const evidence = labRecord(job.evidence) || {};
  const brief = labRecord(patchScope.agent_brief)
    || labRecord(evidence.planning_output)
    || null;
  const parts = [
    brief?.summary ? `Summary: ${String(brief.summary)}` : null,
    brief?.patch_plan ? `Patch plan: ${labReadableEvidence(brief.patch_plan)}` : null,
    patchScope.recommended_files ? `Suggested files: ${labReadableEvidence(patchScope.recommended_files)}` : null,
    validationPlan.human_like_prompts ? `Human-like prompts: ${labReadableEvidence(validationPlan.human_like_prompts)}` : null,
    validationPlan.acceptance_tests ? `Acceptance tests: ${labReadableEvidence(validationPlan.acceptance_tests)}` : null,
  ].filter(Boolean) as string[];
  return parts.length > 0
    ? parts.join('\n\n')
    : 'This lane prepares an isolated code patch brief. It does not ship or deploy MARTy by itself.';
}

function labFailureClusterBody(cluster: Record<string, unknown>): string {
  return labReadableEvidence({
    failed_gate: cluster.failed_gate || cluster.failure_type,
    reason: cluster.reason || cluster.summary || cluster.note,
    affected_samples: cluster.count,
    suggested_next_step: cluster.suggested_next_step || cluster.recommendation,
  }) || 'Needs diagnosis before it can become a shippable upgrade.';
}

function labRoundPolicy(exp: MartyLabExperimentRow): { round: number; role: 'discovery' | 'validation' | 'global_guardrail'; sample: number } | null {
  const meta = labRecord(exp.followup_policy?.lab_round);
  if (!meta) return null;
  const role = meta.sample_role === 'discovery' || meta.sample_role === 'validation' || meta.sample_role === 'global_guardrail'
    ? meta.sample_role
    : null;
  const round = labNumber(meta.round_index, 0);
  const sample = labNumber(meta.sample_index, 1);
  return role && round > 0 ? { round, role, sample: sample > 0 ? sample : 1 } : null;
}

function labConversationRoleLabel(exp: MartyLabExperimentRow): string {
  const meta = labRoundPolicy(exp);
  if (!meta) return exp.variable_under_test ? 'Validation sample' : 'Discovery sample';
  if (meta.role === 'discovery') return `Round ${meta.round} discovery`;
  if (meta.role === 'global_guardrail') return `Round ${meta.round} golden ${meta.sample}`;
  return `Round ${meta.round} validation ${Math.max(1, meta.sample - 3)}/7`;
}

function labCurrentRound(
  run: MartyLabStatusSnapshot['run'],
  experiments: MartyLabExperimentRow[],
  fallbackTotal: number
): number {
  const fromSummary = labNumber(run?.summary?.current_round, 0);
  if (fromSummary > 0) return Math.min(fromSummary, fallbackTotal);
  const highestSeededRound = experiments.reduce((max, exp) => {
    const meta = labRoundPolicy(exp);
    return meta ? Math.max(max, meta.round) : max;
  }, 0);
  return highestSeededRound > 0 ? Math.min(highestSeededRound, fallbackTotal) : 1;
}

function labTrialDecisionText(trial: MartyLabTrialRow | null): string {
  if (!trial) return 'No controlled trial has been created yet.';
  const local = labRecord(trial.evidence?.local_validation);
  const global = labRecord(trial.evidence?.global_guardrail);
  const localSummary = labRecord(local?.summary);
  const globalSummary = labRecord(global?.summary);
  if (globalSummary) {
    return `Global guardrail · ${Number(globalSummary.wins || 0)}W/${Number(globalSummary.losses || 0)}L · ${titleizeLabValue(global?.decision || trial.status)}`;
  }
  if (localSummary) {
    return `Local validation · ${Number(localSummary.wins || 0)}W/${Number(localSummary.losses || 0)}L · ${titleizeLabValue(local?.decision || 'pending global')}`;
  }
  const pct = trial.valid_sample_size > 0 ? Math.round((trial.wins / trial.valid_sample_size) * 100) : null;
  const passLabel = trial.status === 'accepted'
    ? `${trial.wins}/${trial.valid_sample_size} clean measured wins (${pct ?? 0}%)`
    : trial.status === 'rejected'
      ? `${trial.wins}/${trial.valid_sample_size} clean measured wins`
      : trial.status === 'inconclusive'
        ? 'Inconclusive sample or regression guardrail'
        : 'Validation in progress';
  return `${titleizeLabValue(trial.status)} · ${passLabel}`;
}

function labTrialRoundIndex(trial: MartyLabTrialRow | null): number {
  const evidence = labRecord(trial?.evidence);
  return labNumber(evidence?.round_index, 0);
}

type MartyLabExperimentPage = {
  round: number;
  title: string;
  trial: MartyLabTrialRow | null;
  samples: MartyLabExperimentRow[];
};

const MARTY_LAB_UI_ROUND_SAMPLE_SIZE = 10;

function buildMartyLabExperimentPages(
  experiments: MartyLabExperimentRow[],
  trials: MartyLabTrialRow[]
): MartyLabExperimentPage[] {
  const byRound = new Map<number, MartyLabExperimentRow[]>();
  for (const exp of experiments) {
    const meta = labRoundPolicy(exp);
    if (!meta?.round) continue;
    if (meta.role === 'validation' && meta.sample > MARTY_LAB_UI_ROUND_SAMPLE_SIZE) continue;
    byRound.set(meta.round, [...(byRound.get(meta.round) || []), exp]);
  }
  return Array.from(byRound.entries())
    .sort(([a], [b]) => a - b)
    .map(([round, samples]) => {
      const orderedSamples = [...samples].sort((a, b) => {
        const aMeta = labRoundPolicy(a);
        const bMeta = labRoundPolicy(b);
        return (aMeta?.sample || 0) - (bMeta?.sample || 0);
      });
      const trial = trials.find(item => labTrialRoundIndex(item) === round)
        || trials.find(item => orderedSamples.some(sample => sample.replicate_group === item.id))
        || null;
      return {
        round,
        trial,
        samples: orderedSamples,
        title: trial?.title || orderedSamples[0]?.variable_under_test || `Experiment ${round}`,
      };
    });
}

function labDeltaText(delta: number | null): string {
  if (delta === null) return 'Pending';
  return `${delta > 0 ? '+' : ''}${Math.round(delta)}`;
}

function labFriendlyOutcomeNote(note: string | null | undefined): string {
  const text = String(note || '').trim();
  if (!text) return 'No observation recorded yet.';
  if (/^[a-z0-9_]+$/i.test(text)) return titleizeLabValue(text);
  return text.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/gi, match => titleizeLabValue(match).toLowerCase());
}

function cleanLabPromptForDisplay(text: string | null | undefined): string {
  return String(text || '')
    .replace(/\s+Validation pass\s+\d+\s*:\s*use a fresh angle and make the output fully usable\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function labSampleDisplayTitle(sample: MartyLabExperimentRow): string {
  const meta = labRoundPolicy(sample);
  const goal = cleanLabPromptForDisplay(sample.goal);
  const prompt = cleanLabPromptForDisplay(sample.starting_prompt);
  if (meta?.role === 'validation') return prompt || goal || 'Validation sample';
  return goal || prompt || 'Lab sample';
}

function labSampleDisplaySubtitle(sample: MartyLabExperimentRow): string {
  const meta = labRoundPolicy(sample);
  if (meta?.role !== 'validation') return '';
  const goal = cleanLabPromptForDisplay(sample.goal);
  const title = labSampleDisplayTitle(sample);
  return goal && goal !== title ? goal : '';
}

function labExperimentOutcome(exp: MartyLabExperimentRow): { label: string; tone: 'good' | 'bad' | 'warn' | 'muted'; note: string } {
  const meta = labRoundPolicy(exp);
  const isDiscovery = meta?.role === 'discovery';
  if (exp.status === 'queued') return { label: 'Queued', tone: 'muted', note: 'Waiting for worker' };
  if (exp.status === 'running') return { label: 'Running', tone: 'warn', note: isDiscovery ? 'Finding deficiency' : 'Running paired test' };
  if (exp.status === 'failed') return { label: 'Failed', tone: 'bad', note: exp.recommendation || 'Runner failed' };
  if (exp.status === 'cancelled') return { label: 'Cancelled', tone: 'muted', note: 'Cancelled' };
  if (isDiscovery) {
    const finding = exp.findings.find(item => String((item as any)?.dimension || '') === 'bootcamp_discovery');
    return { label: 'Discovery', tone: 'warn', note: String((finding as any)?.note || exp.recommendation || 'Discovery completed') };
  }
  if (exp.privacy_failure || exp.status === 'blocked') return { label: 'Privacy fail', tone: 'bad', note: exp.recommendation || 'Privacy gate blocked candidate' };

  const baseline = typeof exp.baseline_score === 'number' ? exp.baseline_score : null;
  const candidate = typeof exp.candidate_score === 'number' ? exp.candidate_score : null;
  if (baseline === null || candidate === null) return { label: 'No grade', tone: 'warn', note: exp.recommendation || 'Missing paired grade' };
  const delta = candidate - baseline;
  const evaluator = labRecord(exp.tool_trace?.evaluator);
  const regressions = Array.isArray(evaluator?.pareto_regressions) ? evaluator?.pareto_regressions : [];
  const artifactReview = labRecord(exp.tool_trace?.artifact_review);
  if (artifactReview?.required === true && artifactReview.pass !== true) {
    return { label: 'Artifact loss', tone: 'bad', note: titleizeLabValue(artifactReview.decision || 'artifact did not beat baseline') };
  }
  if (regressions.length > 0) {
    return { label: 'Regression', tone: 'bad', note: `${regressions.length} protected priority regression${regressions.length === 1 ? '' : 's'}` };
  }
  if (delta > 0) return { label: 'Win', tone: 'good', note: exp.recommendation || 'Candidate beat baseline' };
  if (delta < 0) return { label: 'Loss', tone: 'bad', note: exp.recommendation || 'Baseline beat candidate' };
  return { label: 'Tie', tone: 'muted', note: exp.recommendation || 'No clear improvement' };
}

function labArtifactResultText(exp: MartyLabExperimentRow): string {
  const artifactReview = labRecord(exp.tool_trace?.artifact_review);
  if (!artifactReview?.required) return '—';
  const baseline = labRecord(artifactReview.baseline);
  const candidate = labRecord(artifactReview.candidate);
  const delta = Number(artifactReview.score_delta || 0);
  const verdict = artifactReview.pass === true ? 'Win' : 'Loss';
  return `${verdict} · ${String(baseline?.score ?? '—')}→${String(candidate?.score ?? '—')} (${delta > 0 ? '+' : ''}${delta})`;
}

function labApprovalAssessment(trial: MartyLabTrialRow | null): Record<string, unknown> | null {
  return labRecord(trial?.evidence?.approval_assessment);
}

function labRationaleList(assessment: Record<string, unknown> | null): string[] {
  const value = assessment?.rationale;
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean).slice(0, 4) : [];
}

function labExperimentTagline(page: MartyLabExperimentPage | null): string {
  const title = [
    page?.title,
    page?.trial?.upgrade_key,
    String(labRecord(page?.trial?.evidence?.upgrade)?.deficiency || ''),
    String(labRecord(page?.trial?.evidence?.approval_assessment)?.target_kind || ''),
  ].join(' ').toLowerCase();
  if (title.includes('retrieval') || title.includes('source') || title.includes('grounding') || title.includes('context') || title.includes('document-first')) {
    return 'Improves context retrieval. Finds the right source material before answering or creating artifacts.';
  }
  if (title.includes('xlsx') || title.includes('excel') || title.includes('workbook') || title.includes('formula')) {
    return 'Improves Excel artifact creation. Ensures workbook tabs, rows, and formulas are populated correctly.';
  }
  if (title.includes('docx') || title.includes('memo') || title.includes('word') || (title.includes('document') && !title.includes('document-first'))) {
    return 'Improves Word document creation. Produces richer, better-structured memos with usable tables and sections.';
  }
  if (title.includes('pptx') || title.includes('deck') || title.includes('presentation')) {
    return 'Improves PowerPoint deck creation. Produces more complete slides with stronger narrative structure and notes.';
  }
  if (title.includes('privacy') || title.includes('permission')) {
    return 'Improves privacy boundaries. Keeps answers useful while avoiding information the user should not see.';
  }
  if (title.includes('conversation') || title.includes('memory') || title.includes('intent')) {
    return 'Improves conversation carry. Helps MARTy remember the latest user intent across follow-up turns.';
  }
  return 'Improves MARTy response quality for this workflow while checking for regressions against the current baseline.';
}

type MartyLabTone = 'good' | 'warn' | 'bad' | 'purple' | 'muted';
type MartyLabRepairAction = 'clear_orphaned_lab_queue' | 'archive_legacy_full_lab' | 'quarantine_lab_artifacts' | 'reset_lab_baseline_to_live_runtime';

function martyToneClasses(tone: MartyLabTone): { box: string; text: string; border: string; soft: string } {
  if (tone === 'good') return {
    box: 'border-semantic-success/25 bg-semantic-success/10 text-semantic-success',
    text: 'text-semantic-success',
    border: 'border-semantic-success/25',
    soft: 'bg-semantic-success/5',
  };
  if (tone === 'warn') return {
    box: 'border-semantic-warning/25 bg-semantic-warning/10 text-semantic-warning',
    text: 'text-semantic-warning',
    border: 'border-semantic-warning/25',
    soft: 'bg-semantic-warning/5',
  };
  if (tone === 'bad') return {
    box: 'border-semantic-error/25 bg-semantic-error/10 text-semantic-error',
    text: 'text-semantic-error',
    border: 'border-semantic-error/25',
    soft: 'bg-semantic-error/5',
  };
  if (tone === 'purple') return {
    box: 'border-accent-purple/25 bg-accent-purple/10 text-accent-purple',
    text: 'text-accent-purple',
    border: 'border-accent-purple/25',
    soft: 'bg-accent-purple/5',
  };
  return {
    box: 'border-white/10 bg-white/[0.04] text-text-muted',
    text: 'text-text-muted',
    border: 'border-white/10',
    soft: 'bg-white/[0.025]',
  };
}

function labRunModeLabel(run: MartyLabRunSnapshot | null | undefined): string {
  if (!run) return 'No run';
  return labRunIsCanary(run) ? 'Experiment' : 'Legacy full lab';
}

function labRunHarnessVersion(run: MartyLabRunSnapshot | null | undefined): string {
  if (!run) return '';
  return String(run.summary?.harness_version || run.upgrade_variable?.harness_version || '').trim();
}

function labRunIsCanary(run: MartyLabRunSnapshot | null | undefined): boolean {
  if (!run) return false;
  return Boolean(
    run.upgrade_variable?.mode === 'canary'
    || run.summary?.mode === 'canary'
    || run.suite_name.includes('canary')
  );
}

function labRunIsLegacyFullLab(run: MartyLabRunSnapshot | null | undefined, currentHarnessVersion?: string): boolean {
  if (!run || labRunIsCanary(run)) return false;
  const harness = labRunHarnessVersion(run);
  return !harness || !currentHarnessVersion || harness !== currentHarnessVersion;
}

function labRunShortTitle(run: MartyLabRunSnapshot | null | undefined): string {
  if (!run) return 'Next sandbox request';
  return cleanExperimentTitle(run.upgrade_title || String(run.summary?.current_upgrade_title || '') || run.candidate_label || labRunModeLabel(run));
}

function cleanExperimentTitle(value: unknown): string {
  const text = String(value || 'Experiment').trim();
  return text.replace(/^Round\s+\d+\s*:\s*/i, '').replace(/^Canary\s*:\s*/i, '').trim() || 'Experiment';
}

function labRunPhase(run: MartyLabRunSnapshot | null | undefined): string | null {
  if (!run) return null;
  return String(run.bootcamp_phase || run.summary?.current_phase || run.summary?.bootcamp_phase || '').trim() || null;
}

function labRunPhaseLabel(phase: string | null | undefined): string {
  if (phase === 'round_discovery') return 'finding the next weakness';
  if (phase === 'round_validation') return 'testing a candidate fix';
  if (phase === 'round_inconclusive_needs_review') return 'waiting for review';
  if (phase === 'bootcamp_complete') return 'ready for a decision';
  if (phase === 'human_shipped') return 'shipped';
  if (phase === 'human_rejected') return 'rejected';
  return phase ? phase.replace(/_/g, ' ') : 'running';
}

function labRunNeedsDecision(run: MartyLabRunSnapshot | null | undefined): boolean {
  return Boolean(run && run.status === 'completed' && !['human_shipped', 'human_rejected'].includes(labRunPhase(run) || ''));
}

function labRunChipState(run: MartyLabRunSnapshot, isCurrent: boolean): { label: string; tone: MartyLabTone } {
  const phase = labRunPhase(run);
  if (run.discarded_at || run.discard_reason) return { label: 'Archived', tone: 'warn' };
  if (run.status === 'running' || run.status === 'configured') return { label: 'Active', tone: 'purple' };
  if (run.status === 'queued') return { label: 'Queued', tone: 'purple' };
  if (phase === 'human_shipped') return { label: 'Shipped', tone: 'good' };
  if (phase === 'human_rejected') return { label: 'Rejected', tone: 'bad' };
  if (labRunNeedsDecision(run)) return { label: 'Needs decision', tone: 'warn' };
  if (run.status === 'cancelled') return { label: 'Cancelled', tone: 'muted' };
  if (run.status === 'failed') return { label: 'Failed', tone: 'bad' };
  return { label: isCurrent ? 'Current' : 'Finished', tone: 'muted' };
}

function labRunStateCopy(
  run: MartyLabRunSnapshot | null,
  args: {
    activeTrial: MartyLabTrialRow | null;
    isQuarantined: boolean;
    isViewingCurrent: boolean;
    pausedForRoundReview: boolean;
    completed: number;
    total: number;
    currentRound: number;
    roundTotal: number;
    readinessOk: boolean;
    readinessMessage: string;
  }
): { eyebrow: string; title: string; body: string; tone: MartyLabTone } {
  if (!run) {
    return {
      eyebrow: 'Sandbox queue',
      title: args.readinessOk ? 'Ready for the next controlled run' : 'Not ready to start',
      body: args.readinessMessage,
      tone: args.readinessOk ? 'good' : 'warn',
    };
  }
  if (args.isQuarantined) {
    return {
      eyebrow: args.isViewingCurrent ? 'Historical run selected' : 'Viewing history',
      title: 'Archived run: do not use for decisions',
      body: run.discard_reason || 'This run is kept only as historical context. Use the current run for Ship or Reject decisions.',
      tone: 'warn',
    };
  }
  if (!args.isViewingCurrent) {
    return {
      eyebrow: 'Viewing older result',
      title: `${labRunModeLabel(run)} from ${formatRelative(run.created_at)}`,
      body: 'This is a past run. It is useful for learning what happened, but it is not the active run.',
      tone: 'muted',
    };
  }
  if (args.pausedForRoundReview) {
    return {
      eyebrow: 'Human review needed',
      title: 'Review this experiment before the lab continues',
      body: 'Approve and continue or reject this experiment to keep the lab moving. Nothing ships from this round by itself.',
      tone: 'warn',
    };
  }
  if (run.status === 'running' || run.status === 'configured') {
    const phase = labRunPhaseLabel(labRunPhase(run));
    return {
      eyebrow: 'Current run',
      title: `Experiment ${args.currentRound} of ${args.roundTotal}: ${phase}`,
      body: `${labRunModeLabel(run)} is comparing a candidate fix against the accepted baseline. ${args.completed}/${args.total || run.total_experiments || 0} checks are complete. New sandbox requests can be queued while this finishes.`,
      tone: 'purple',
    };
  }
  if (labRunNeedsDecision(run)) {
    const trialStatus = args.activeTrial?.status ? titleizeLabValue(args.activeTrial.status) : 'Review';
    return {
      eyebrow: 'Decision needed',
      title: `${labRunModeLabel(run)} finished: ${trialStatus}`,
      body: 'Review the cover page, then Ship or Reject the whole run. The next queued run will not begin until this decision is made.',
      tone: args.activeTrial?.status === 'accepted' ? 'good' : args.activeTrial?.status === 'rejected' ? 'bad' : 'warn',
    };
  }
  if (labRunPhase(run) === 'human_shipped') {
    return {
      eyebrow: 'Finished result',
      title: 'This run was shipped',
      body: 'Its accepted upgrade became part of the baseline for future MARTy Sandbox runs.',
      tone: 'good',
    };
  }
  if (labRunPhase(run) === 'human_rejected') {
    return {
      eyebrow: 'Finished result',
      title: 'This run was rejected',
      body: 'The existing baseline stayed in place. Use Deep Work or a focused canary for the next attempt.',
      tone: 'bad',
    };
  }
  return {
    eyebrow: 'Finished result',
    title: `${labRunModeLabel(run)} is closed`,
    body: run.summary?.conclusion ? String(run.summary.conclusion) : 'This run is no longer active.',
    tone: 'muted',
  };
}

function MartyLabDecisionButtons({
  disabled,
  deciding,
  onDecide,
}: {
  disabled: boolean;
  deciding: 'ship' | 'reject' | null;
  onDecide: (decision: 'ship' | 'reject') => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onDecide('ship')}
        disabled={disabled || deciding !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-success/25 bg-semantic-success/10 px-3 py-1.5 text-xs font-medium text-semantic-success hover:bg-semantic-success/15 disabled:opacity-45"
      >
        <Check size={13} /> {deciding === 'ship' ? 'Shipping...' : 'Ship'}
      </button>
      <button
        type="button"
        onClick={() => onDecide('reject')}
        disabled={disabled || deciding !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-error/25 bg-semantic-error/10 px-3 py-1.5 text-xs font-medium text-semantic-error hover:bg-semantic-error/15 disabled:opacity-45"
      >
        <XIcon size={13} /> {deciding === 'reject' ? 'Rejecting...' : 'Reject'}
      </button>
    </div>
  );
}

function MartyLabRoundReviewButtons({
  disabled,
  reviewing,
  onReview,
}: {
  disabled: boolean;
  reviewing: 'approve_continue' | 'reject_continue' | null;
  onReview: (decision: 'approve_continue' | 'reject_continue') => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onReview('approve_continue')}
        disabled={disabled || reviewing !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-success/25 bg-semantic-success/10 px-3 py-1.5 text-xs font-medium text-semantic-success hover:bg-semantic-success/15 disabled:opacity-45"
      >
        <Check size={13} /> {reviewing === 'approve_continue' ? 'Continuing...' : 'Approve and continue lab'}
      </button>
      <button
        type="button"
        onClick={() => onReview('reject_continue')}
        disabled={disabled || reviewing !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-error/25 bg-semantic-error/10 px-3 py-1.5 text-xs font-medium text-semantic-error hover:bg-semantic-error/15 disabled:opacity-45"
      >
        <XIcon size={13} /> {reviewing === 'reject_continue' ? 'Rejecting...' : 'Reject experiment'}
      </button>
    </div>
  );
}

function MartyLabPageShell({
  children,
  pageIndex,
  pageCount,
  onPrev,
  onNext,
  onSelect,
}: {
  children: React.ReactNode;
  pageIndex: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
}) {
  const pageLabel = pageIndex === 0 ? 'Cover' : `Experiment ${pageIndex}`;
  return (
    <section className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.015]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-3">
        <button
          type="button"
          onClick={onPrev}
          disabled={pageIndex <= 0}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-40"
          aria-label="Previous MARTy Lab page"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3 px-2">
          <div className="hidden shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-muted sm:block">
            {pageLabel}
          </div>
          <div className="flex min-w-0 items-center justify-center gap-1 overflow-x-auto">
            {Array.from({ length: pageCount }).map((_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onSelect(index)}
                className={`h-2.5 w-2.5 shrink-0 rounded-full border transition ${
                  index === pageIndex
                    ? 'border-accent-magenta bg-accent-magenta'
                    : 'border-white/15 bg-white/[0.06] hover:bg-white/[0.12]'
                }`}
                aria-label={index === 0 ? 'MARTy Lab cover page' : `MARTy Lab experiment ${index}`}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={pageIndex >= pageCount - 1}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-40"
          aria-label="Next MARTy Lab page"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="min-h-[24rem] p-4">{children}</div>
    </section>
  );
}

function MartyLabMiniStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'purple';
}) {
  const color = tone === 'good'
    ? 'text-semantic-success'
    : tone === 'warn'
      ? 'text-semantic-warning'
      : tone === 'bad'
        ? 'text-semantic-error'
        : tone === 'purple'
          ? 'text-accent-purple'
          : 'text-text-primary';
  return (
    <div className="rounded-lg border border-white/[0.05] bg-white/[0.025] px-3 py-2">
      <div className={`text-base font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-text-muted">{label}</div>
    </div>
  );
}

function MartyLabRoundSampleCard({ sample }: { sample: MartyLabExperimentRow }) {
  const outcome = labExperimentOutcome(sample);
  const roundMeta = labRoundPolicy(sample);
  const delta = typeof sample.candidate_score === 'number' && typeof sample.baseline_score === 'number'
    ? sample.candidate_score - sample.baseline_score
    : null;
  const outcomeTone = outcome.tone === 'good'
    ? 'bg-semantic-success/15 text-semantic-success'
    : outcome.tone === 'bad'
      ? 'bg-semantic-error/15 text-semantic-error'
      : outcome.tone === 'warn'
        ? 'bg-semantic-warning/15 text-semantic-warning'
        : 'bg-white/[0.05] text-text-muted';
  const label = roundMeta?.role === 'discovery'
    ? 'Discovery'
    : roundMeta?.role === 'global_guardrail'
      ? `Guardrail ${roundMeta.sample}`
      : `Validation ${Math.max(1, (roundMeta?.sample || 4) - 3)}/7`;
  const artifactText = labArtifactResultText(sample);
  const displayTitle = labSampleDisplayTitle(sample);
  const displaySubtitle = labSampleDisplaySubtitle(sample);

  return (
    <article className="rounded-lg border border-white/[0.05] bg-black/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
          <div className="mt-1 text-sm font-medium leading-snug text-text-primary">{displayTitle}</div>
          {displaySubtitle && <div className="mt-1 text-[11px] leading-relaxed text-text-muted">{displaySubtitle}</div>}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${outcomeTone}`}>{outcome.label}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <MartyLabMiniStat label="Baseline" value={formatLabScore(sample.baseline_score)} />
        <MartyLabMiniStat label="Candidate" value={formatLabScore(sample.candidate_score)} />
        <MartyLabMiniStat
          label="Delta"
          value={labDeltaText(delta)}
          tone={delta && delta > 0 ? 'good' : delta && delta < 0 ? 'bad' : 'default'}
        />
      </div>
      <div className="mt-3 text-xs leading-relaxed text-text-secondary">{outcome.note}</div>
      {artifactText !== '—' && <div className="mt-1 text-[11px] text-text-muted">{artifactText}</div>}
      <details className="mt-3 rounded-md border border-white/[0.04] bg-white/[0.02] px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-text-muted">Prompt</summary>
        <ExpandableText
          text={sample.starting_prompt || sample.goal}
          collapsedLines={4}
          minToggleChars={220}
          className="mt-2 text-xs leading-relaxed text-text-secondary"
        />
      </details>
    </article>
  );
}

function martyLabExperimentStats(page: MartyLabExperimentPage, expectedSamples = 10) {
  const validationSamples = page.samples.filter(sample => labRoundPolicy(sample)?.role === 'validation');
  const closedSamples = page.samples.filter(sample => !['queued', 'running'].includes(sample.status));
  const scoredValidation = validationSamples.filter(sample => (
    typeof sample.baseline_score === 'number'
    && typeof sample.candidate_score === 'number'
    && !sample.privacy_failure
  ));
  const computedDeltas = scoredValidation.map(sample => (sample.candidate_score || 0) - (sample.baseline_score || 0));
  const computedWins = computedDeltas.filter(delta => delta > 0).length;
  const computedLosses = computedDeltas.filter(delta => delta < 0).length;
  const computedAverage = computedDeltas.length
    ? computedDeltas.reduce((sum, delta) => sum + delta, 0) / computedDeltas.length
    : null;
  const trial = page.trial;
  const useFinalTrialStats = Boolean(trial && trial.status !== 'pending' && trial.valid_sample_size > 0);
  const validationTotal = Math.max(7, validationSamples.length);
  const totalSamples = Math.max(expectedSamples, page.samples.length || expectedSamples);
  const waiting = page.samples.length === 0;
  const complete = closedSamples.length >= totalSamples;
  return {
    totalSamples,
    closedSamples: closedSamples.length,
    validationTotal,
    validSamples: useFinalTrialStats ? trial!.valid_sample_size : scoredValidation.length,
    wins: useFinalTrialStats ? trial!.wins : computedWins,
    losses: useFinalTrialStats ? trial!.losses : computedLosses,
    averageDelta: useFinalTrialStats ? trial!.average_delta : computedAverage,
    decision: trial && trial.status !== 'pending'
      ? titleizeLabValue(trial.status)
      : waiting
        ? 'Waiting'
        : complete
          ? 'Finalizing'
          : 'Testing now',
    };
}

type SandboxViewStateId =
  | 'idle_ready'
  | 'running_discovery'
  | 'running_validation'
  | 'paused_review'
  | 'ready_decision'
  | 'queued'
  | 'needs_cleanup'
  | 'historical'
  | 'failed';

type SandboxViewState = {
  id: SandboxViewStateId;
  eyebrow: string;
  title: string;
  body: string;
  tone: MartyLabTone;
};

function sandboxCheckLabel(key: string): string {
  const labels: Record<string, string> = {
    lab_work_queue_clear: 'Stuck sandbox work',
    legacy_full_lab_active: 'Legacy sandbox cleanup',
    sandbox_artifact_isolation: 'Sandbox artifact cleanup',
    accepted_baseline_live_parity: 'Live baseline parity',
    round_inconclusive_needs_review: 'Needs your review',
    no_active_lab_run: 'Another improvement is already running',
    no_active_lab_run_race: 'Another improvement is already running',
    one_active_lab_run_per_suite: 'Another improvement is already running',
    one_active_lab_run_per_org: 'Another improvement is already running',
    human_decision_required: 'Waiting for Ship or Reject',
    sandbox_queue_pending: 'Queued improvement waiting',
  };
  return labels[key] || titleizeLabValue(key);
}

function sandboxRunViewState(args: {
  run: MartyLabRunSnapshot | null;
  readiness: MartyLabStatusSnapshot['readiness'];
  activeTrial: MartyLabTrialRow | null;
  isViewingCurrent: boolean;
  isQuarantined: boolean;
  pausedForRoundReview: boolean;
  canRepairLabQueue: boolean;
  canArchiveLegacyRun: boolean;
  canQuarantineLabArtifacts: boolean;
  canResetLabBaseline: boolean;
  runIsCanary: boolean;
  completed: number;
  expectedTotal: number;
  currentRound: number;
  roundTotal: number;
  discoveryCompleted: number;
  validationCompleted: number;
}): SandboxViewState {
  const {
    run,
    readiness,
    activeTrial,
    isViewingCurrent,
    isQuarantined,
    pausedForRoundReview,
    canRepairLabQueue,
    canArchiveLegacyRun,
    canQuarantineLabArtifacts,
    canResetLabBaseline,
    runIsCanary,
    completed,
    expectedTotal,
    currentRound,
    roundTotal,
    discoveryCompleted,
    validationCompleted,
  } = args;

  if (canArchiveLegacyRun) {
    return {
      id: 'needs_cleanup',
      eyebrow: 'Legacy sandbox cleanup',
      title: 'Archive the old full lab',
      body: 'This is an old full-lab result from before the experiment-only harness. Archive it to unblock clean experiments; nothing will ship.',
      tone: 'warn',
    };
  }

  if (!run) {
    if (canQuarantineLabArtifacts) {
      return {
        id: 'needs_cleanup',
        eyebrow: 'Sandbox cleanup',
        title: 'Quarantine old sandbox artifacts',
        body: 'Old sandbox-generated documents are still stored in the document table. They are hidden from MARTy retrieval, but quarantine them before starting a clean experiment.',
        tone: 'warn',
      };
    }
    if (canRepairLabQueue) {
      return {
        id: 'needs_cleanup',
        eyebrow: 'Sandbox cleanup',
        title: 'Sandbox cleanup needed',
        body: 'Some retryable sandbox work is still waiting even though no experiment is active. Clear it here, then start the next clean experiment.',
        tone: 'warn',
      };
    }
    if (canResetLabBaseline) {
      return {
        id: 'needs_cleanup',
        eyebrow: 'Live baseline parity',
        title: 'Reset the lab baseline',
        body: 'The accepted sandbox baseline is not stamped as the live production MARTy runtime. Reset it before starting another comparison.',
        tone: 'warn',
      };
    }
    if (!readiness.ok) {
      const blocker = readiness.checks.find(check => check.status === 'block');
      return {
        id: 'queued',
        eyebrow: 'Sandbox queue',
        title: sandboxCheckLabel(blocker?.key || 'sandbox_queue_pending'),
        body: readiness.blockers[0] || readiness.warnings[0] || 'The next improvement will wait until the current sandbox work finishes.',
        tone: 'warn',
      };
    }
    return {
      id: 'idle_ready',
      eyebrow: 'MARTy Improvement Studio',
      title: 'Ready to improve MARTy',
      body: 'Describe a MARTy problem or pick a focus area. The sandbox will test a candidate fix against the current accepted baseline.',
      tone: 'good',
    };
  }

  if (!isViewingCurrent || isQuarantined) {
    return {
      id: 'historical',
      eyebrow: 'Past result',
      title: 'Viewing a past sandbox result',
      body: 'This result is useful for learning what happened, but Ship and Reject decisions only apply to the current completed run.',
      tone: 'muted',
    };
  }

  if (pausedForRoundReview) {
    return {
      id: 'paused_review',
      eyebrow: 'Needs your review',
      title: 'Review this experiment to continue',
      body: 'The lab hit an inconclusive fix. Approve and continue or reject this experiment. Nothing ships from this decision by itself.',
      tone: 'warn',
    };
  }

  if (labRunNeedsDecision(run)) {
    const status = activeTrial?.status ? titleizeLabValue(activeTrial.status) : 'Review';
    return {
      id: 'ready_decision',
      eyebrow: 'Decision ready',
      title: `${labRunModeLabel(run)} finished: ${status}`,
      body: 'Review the cover page, then Ship or Reject this experiment. The next queued request waits for that decision.',
      tone: activeTrial?.status === 'accepted' ? 'good' : activeTrial?.status === 'rejected' ? 'warn' : 'warn',
    };
  }

  if (run.status === 'failed') {
    return {
      id: 'failed',
      eyebrow: 'Sandbox issue',
      title: 'This run failed',
      body: run.summary?.conclusion ? String(run.summary.conclusion) : 'The sandbox could not complete this run. Review details before starting another one.',
      tone: 'bad',
    };
  }

  if (run.status === 'running' || run.status === 'configured') {
    const phase = labRunPhase(run);
    if (phase === 'round_discovery') {
      return {
        id: 'running_discovery',
        eyebrow: 'Live now',
        title: runIsCanary
          ? `Finding weakness: discovery chat ${Math.min(3, discoveryCompleted + 1)} of 3`
          : `Finding weakness ${Math.max(1, currentRound)} of ${roundTotal}`,
        body: runIsCanary
          ? `${Math.min(3, discoveryCompleted)} of 3 discovery rounds are complete. MARTy is looking for a real gap before it tests a fix.`
          : `${completed.toLocaleString()} of ${expectedTotal.toLocaleString()} checks are complete. MARTy is looking for a real gap before it tests a fix.`,
        tone: 'purple',
      };
    }
    return {
      id: 'running_validation',
      eyebrow: 'Live now',
      title: runIsCanary
        ? `Testing fix: validation chat ${Math.min(7, validationCompleted + 1)} of 7`
        : `Testing fix ${Math.max(1, currentRound)} of ${roundTotal}`,
      body: runIsCanary
        ? `${Math.min(7, validationCompleted)} of 7 testing rounds are complete. The current candidate is being compared against the accepted baseline.`
        : `${completed.toLocaleString()} of ${expectedTotal.toLocaleString()} checks are complete. The current candidate is being compared against the accepted baseline.`,
      tone: 'purple',
    };
  }

  if (labRunPhase(run) === 'human_shipped') {
    return {
      id: 'historical',
      eyebrow: 'Shipped',
      title: 'This improvement was shipped',
      body: 'The accepted upgrade became the baseline for future sandbox tests.',
      tone: 'good',
    };
  }

  if (labRunPhase(run) === 'human_rejected') {
    return {
      id: 'historical',
      eyebrow: 'Rejected',
      title: 'This improvement was rejected',
      body: 'The existing baseline stayed in place. Start another focused experiment with a sharper problem statement.',
      tone: 'muted',
    };
  }

  return {
    id: 'historical',
    eyebrow: 'Closed',
    title: `${labRunModeLabel(run)} is closed`,
    body: run.summary?.conclusion ? String(run.summary.conclusion) : 'This run is no longer active.',
    tone: 'muted',
  };
}

function SandboxHeroState({
  state,
  progressPct,
  progressLabel,
  contextLabel,
  actions,
}: {
  state: SandboxViewState;
  progressPct?: number | null;
  progressLabel?: string | null;
  contextLabel?: string | null;
  actions?: React.ReactNode;
}) {
  const tone = martyToneClasses(state.tone);
  return (
    <section className={`rounded-xl border ${tone.border} ${tone.soft} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className={`text-[11px] font-semibold uppercase tracking-wide ${tone.text}`}>{state.eyebrow}</div>
          <h3 className="mt-1 text-2xl font-semibold leading-tight text-text-primary">{state.title}</h3>
          <p className="mt-2 max-w-4xl text-sm leading-relaxed text-text-secondary">{state.body}</p>
          {contextLabel && (
            <div className="mt-3 text-xs text-text-muted">{contextLabel}</div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {typeof progressPct === 'number' && progressLabel && (
        <div className="mt-5">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }} />
          </div>
          <div className="mt-2 text-xs text-text-muted">{progressLabel}</div>
        </div>
      )}
    </section>
  );
}

function SandboxFocusComposer({
  value,
  onChange,
  onStart,
  startDisabled,
  startVerb,
  startingMode,
  isBusy,
}: {
  value: string;
  onChange: (value: string) => void;
  onStart: () => void;
  startDisabled: boolean;
  startVerb: string;
  startingMode: 'canary' | null;
  isBusy: boolean;
}) {
  const chips = [
    { label: 'Retrieval', prompt: 'Focus on MARTy finding the right database records, source docs, and prior conversation context before answering.' },
    { label: 'Conversation carry', prompt: 'Focus on MARTy carrying user intent across short follow-ups and ambiguous messages.' },
    { label: 'Artifacts', prompt: 'Focus on DOCX, XLSX, and PPTX artifact quality, including formulas, tables, formatting, and visual completeness.' },
    { label: 'Privacy', prompt: 'Focus on privacy-safe answers that avoid leaking unrelated user or deal information.' },
    { label: 'Prompt logic', prompt: 'Focus on MARTy system/runtime logic and instruction-following quality.' },
  ];
  const title = isBusy ? 'Queue the next experiment focus' : 'What should MARTy improve?';
  const body = isBusy
    ? 'The current improvement keeps running. This request will wait its turn.'
    : 'Use plain language, like you would when telling Codex what went wrong with MARTy.';

  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">{body}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map(chip => (
            <button
              key={chip.label}
              type="button"
              onClick={() => onChange(value.trim() ? `${value.trim()} ${chip.prompt}` : chip.prompt)}
              className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-text-secondary hover:border-accent-purple/30 hover:bg-accent-purple/10 hover:text-accent-purple"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Example: MARTy missed the source doc and gave me a generic answer. Focus on retrieval."
          className="min-w-[18rem] flex-1 rounded-lg border border-white/10 bg-bg-input px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-magenta/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={onStart}
          disabled={startDisabled}
          className="inline-flex items-center gap-1 rounded-lg border border-accent-magenta/25 bg-accent-magenta/10 px-3 py-2 text-xs font-medium text-accent-magenta hover:bg-accent-magenta/15 disabled:opacity-50"
        >
          <Sparkles size={14} /> {MARTY_SANDBOX_EXECUTION_DISABLED ? 'Execution disabled' : startingMode === 'canary' ? `${startVerb}ing...` : `${startVerb} experiment`}
        </button>
      </div>
    </section>
  );
}

function SandboxEvidenceDrawer({
  title = 'Evidence Details',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-lg border border-white/[0.06] bg-black/10">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-text-primary">
        <span>{title}</span>
        <ChevronDown size={14} className="text-text-muted" />
      </summary>
      <div className="border-t border-white/[0.05] p-3">{children}</div>
    </details>
  );
}

function SandboxRunPager({
  pageIndex,
  pageCount,
  onPrev,
  onNext,
  onSelect,
  children,
}: {
  pageIndex: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.015]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div>
          <div className="text-xs font-semibold text-text-primary">Experiment workspace</div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            {pageIndex === 0 ? 'Experiment cover' : 'Rounds page'} · {pageCount} page{pageCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPrev}
            disabled={pageIndex <= 0}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-35"
            aria-label="Previous sandbox page"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="flex max-w-[18rem] items-center gap-1 overflow-x-auto">
            {Array.from({ length: pageCount }).map((_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onSelect(index)}
                className={`h-2.5 shrink-0 rounded-full border transition ${
                  index === pageIndex
                    ? 'w-6 border-accent-magenta bg-accent-magenta'
                    : 'w-2.5 border-white/15 bg-white/[0.06] hover:bg-white/[0.12]'
                }`}
                aria-label={index === 0 ? 'Experiment cover page' : 'Experiment rounds page'}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onNext}
            disabled={pageIndex >= pageCount - 1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-35"
            aria-label="Next sandbox page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function labHumanPreferenceText(sample: MartyLabExperimentRow): string {
  const evaluator = labRecord(sample.tool_trace?.evaluator);
  const preference = labRecord(evaluator?.human_preference) || labRecord(sample.tool_trace?.human_preference);
  const winner = String(preference?.winner || preference?.pick || preference?.preferred || '').toLowerCase();
  if (winner.includes('candidate')) return 'Candidate';
  if (winner.includes('baseline')) return 'Baseline';
  if (winner.includes('tie')) return 'Tie';
  return 'Pending';
}

function labSampleIsClosed(sample: MartyLabExperimentRow): boolean {
  return !['queued', 'running'].includes(sample.status);
}

function labPlainExperimentConclusion(
  run: MartyLabRunSnapshot,
  trial: MartyLabTrialRow | null,
  rationale: string[]
): string {
  const status = trial?.status || run.status;
  if (labRunPhase(run) === 'human_shipped') {
    return 'This experiment was shipped. Its upgrade became the baseline for future MARTy tests.';
  }
  if (labRunPhase(run) === 'human_rejected') {
    return 'This experiment was rejected. The existing MARTy baseline stayed unchanged.';
  }
  if (run.status === 'running' || run.status === 'configured') {
    return 'This experiment is still running. Wait for the testing rounds to finish before making a Ship or Reject decision.';
  }
  if (status === 'accepted') {
    return 'The candidate produced enough evidence to recommend shipping. Review the testing rounds, then decide whether to make it the new baseline.';
  }
  if (status === 'rejected') {
    return 'The candidate did not improve MARTy enough to ship. The baseline should stay unchanged.';
  }
  if (status === 'inconclusive') {
    return 'The experiment found some signal, but not enough clean evidence to ship automatically. The baseline stays unchanged unless a human chooses otherwise.';
  }
  if (rationale.length > 0) return rationale[0];
  return run.summary?.conclusion ? String(run.summary.conclusion) : 'No conclusion has been recorded yet.';
}

function labUpgradeSummary(activeUpgrade: Record<string, unknown> | null, trial: MartyLabTrialRow | null): string {
  const upgrade = activeUpgrade || labRecord(trial?.evidence?.upgrade);
  const fields = [
    upgrade?.title,
    upgrade?.name,
    upgrade?.runtime_strategy,
    upgrade?.strategy,
    trial?.upgrade_key,
    trial?.title,
  ];
  const text = fields.map(item => String(item || '').trim()).find(Boolean);
  return cleanExperimentTitle(text || 'Candidate upgrade');
}

function labHypothesisSummary(activeUpgrade: Record<string, unknown> | null, trial: MartyLabTrialRow | null): string {
  const evidence = labRecord(trial?.evidence);
  const upgrade = activeUpgrade || labRecord(evidence?.upgrade);
  const fields = [
    upgrade?.hypothesis,
    upgrade?.deficiency,
    evidence?.hypothesis,
    evidence?.discovery_synthesis,
    evidence?.deficiency_summary,
  ];
  const text = fields.map(item => labReadableEvidence(item)).find(Boolean);
  return text || 'MARTy may be missing the user’s real intent or source context, so the experiment tests one focused upgrade against the current baseline.';
}

function ExperimentCoverSection({
  title,
  status,
  children,
}: {
  title: string;
  status?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-3">
        <h5 className="text-sm font-semibold text-text-primary">{title}</h5>
        {status && <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-text-muted">{status}</span>}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-text-secondary">{children}</div>
    </section>
  );
}

function SandboxRoundCard({ sample }: { sample: MartyLabExperimentRow }) {
  const outcome = labExperimentOutcome(sample);
  const roundMeta = labRoundPolicy(sample);
  const delta = typeof sample.candidate_score === 'number' && typeof sample.baseline_score === 'number'
    ? sample.candidate_score - sample.baseline_score
    : null;
  const outcomeTone = outcome.tone === 'good'
    ? 'bg-semantic-success/15 text-semantic-success'
    : outcome.tone === 'bad'
      ? 'bg-semantic-error/15 text-semantic-error'
      : outcome.tone === 'warn'
        ? 'bg-semantic-warning/15 text-semantic-warning'
        : 'bg-white/[0.05] text-text-muted';
  const label = roundMeta?.role === 'discovery'
    ? 'Discovery'
    : roundMeta?.role === 'global_guardrail'
      ? `Guardrail ${roundMeta.sample}`
      : `Validation ${Math.max(1, (roundMeta?.sample || 4) - 3)}/7`;
  const artifactText = labArtifactResultText(sample);
  const humanPick = labHumanPreferenceText(sample);
  const note = labFriendlyOutcomeNote(outcome.note);
  const displayTitle = labSampleDisplayTitle(sample);
  const displaySubtitle = labSampleDisplaySubtitle(sample);
  const observation = roundMeta?.role === 'discovery'
    ? note || 'Discovery captured baseline behavior for this experiment.'
    : delta === null
      ? note
      : delta > 0
        ? `Improved by ${labDeltaText(delta)}. ${note}`
        : delta < 0
          ? `Regressed by ${labDeltaText(delta)}. ${note}`
          : `No measured lift. ${note}`;

  return (
    <details className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
      <summary className="cursor-pointer list-none px-4 py-3 marker:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
            <h5 className="mt-1 text-sm font-semibold leading-snug text-text-primary">{displayTitle}</h5>
            {displaySubtitle && <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{displaySubtitle}</p>}
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">{observation}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {delta !== null && <span className={`text-sm font-semibold tabular-nums ${delta > 0 ? 'text-semantic-success' : delta < 0 ? 'text-semantic-error' : 'text-text-muted'}`}>{labDeltaText(delta)}</span>}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${outcomeTone}`}>{outcome.label}</span>
            <ChevronDown size={14} className="text-text-muted" />
          </div>
        </div>
      </summary>
      <div className="space-y-3 border-t border-white/[0.05] px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-4">
          <MartyLabMiniStat label="Baseline" value={formatLabScore(sample.baseline_score)} />
          <MartyLabMiniStat label="Candidate" value={formatLabScore(sample.candidate_score)} />
          <MartyLabMiniStat
            label="Delta"
            value={labDeltaText(delta)}
            tone={delta && delta > 0 ? 'good' : delta && delta < 0 ? 'bad' : 'default'}
          />
          <MartyLabMiniStat
            label="Human pick"
            value={humanPick}
            tone={humanPick === 'Candidate' ? 'good' : humanPick === 'Baseline' ? 'bad' : 'default'}
          />
        </div>
        {artifactText !== '—' && <p className="text-[11px] text-text-muted">{artifactText}</p>}
        <div className="rounded-md border border-white/[0.05] bg-black/10 px-3 py-2">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Prompt</div>
            <ExpandableText
              text={sample.starting_prompt || sample.goal}
              collapsedLines={4}
              minToggleChars={220}
              className="mt-1 text-xs leading-relaxed text-text-secondary"
            />
          </div>
          {sample.recommendation && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Outcome summary</div>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">{labFriendlyOutcomeNote(sample.recommendation)}</p>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

function SandboxCoverPage({
  run,
  runIsCanary,
  currentRound,
  roundTotal,
  visibleRoundTotal,
  completed,
  expectedTotal,
  progressPct,
  acceptedTrialCount,
  rejectedTrialCount,
  inconclusiveTrialCount,
  privacyFailures,
  activeTrial,
  activeExperimentPage,
  activeUpgrade,
  activeLeverIds,
  activeCandidatePool,
  acceptedBaseline,
  approvalRationale,
  pausedForRoundReview,
  canShowRunDecision,
  decisionDisabled,
  deciding,
  reviewingRound,
  onDecide,
  onReview,
}: {
  run: MartyLabRunSnapshot;
  runIsCanary: boolean;
  currentRound: number;
  roundTotal: number;
  visibleRoundTotal: number;
  completed: number;
  expectedTotal: number;
  progressPct: number;
  acceptedTrialCount: number;
  rejectedTrialCount: number;
  inconclusiveTrialCount: number;
  privacyFailures: number;
  activeTrial: MartyLabTrialRow | null;
  activeExperimentPage: MartyLabExperimentPage | null;
  activeUpgrade: Record<string, unknown> | null;
  activeLeverIds: string[];
  activeCandidatePool: Record<string, unknown> | null;
  acceptedBaseline: MartyLabStatusSnapshot['versions'][number] | null;
  approvalRationale: string[];
  pausedForRoundReview: boolean;
  canShowRunDecision: boolean;
  decisionDisabled: boolean;
  deciding: 'ship' | 'reject' | null;
  reviewingRound: 'approve_continue' | 'reject_continue' | null;
  onDecide: (decision: 'ship' | 'reject') => void;
  onReview: (decision: 'approve_continue' | 'reject_continue') => void;
}) {
  const focusPrompt = typeof run.summary?.focus_prompt === 'string' ? run.summary.focus_prompt.trim() : '';
  const samples = activeExperimentPage?.samples || [];
  const discoverySamples = samples.filter(sample => labRoundPolicy(sample)?.role === 'discovery');
  const validationSamples = samples.filter(sample => labRoundPolicy(sample)?.role === 'validation');
  const discoveryDone = discoverySamples.filter(labSampleIsClosed).length;
  const validationDone = validationSamples.filter(labSampleIsClosed).length;
  const validationOutcomes = validationSamples.map(sample => labExperimentOutcome(sample));
  const validationWins = validationOutcomes.filter(outcome => outcome.label === 'Win').length;
  const validationLosses = validationOutcomes.filter(outcome => ['Loss', 'Regression', 'Artifact loss', 'Privacy fail'].includes(outcome.label)).length;
  const validationTies = validationOutcomes.filter(outcome => outcome.label === 'Tie').length;
  const validationStopped = validationSamples.filter(sample => ['cancelled', 'failed', 'blocked'].includes(sample.status)).length;
  const experimentProgressPct = Math.max(0, Math.min(100, Math.round(((discoveryDone + validationDone) / 10) * 100)));
  const recommendation = activeTrial?.status ? titleizeLabValue(activeTrial.status) : titleizeLabValue(run.status);
  const summary = run.summary?.conclusion ? String(run.summary.conclusion) : null;
  const title = cleanExperimentTitle(activeTrial?.title || run.upgrade_title || labRunShortTitle(run));
  const hypothesis = labHypothesisSummary(activeUpgrade, activeTrial);
  const appliedUpgrade = labUpgradeSummary(activeUpgrade, activeTrial);
  const conclusion = labPlainExperimentConclusion(run, activeTrial, approvalRationale);
  const phase = labRunPhase(run);
  const stageLabel = run.status === 'running' || run.status === 'configured'
    ? phase === 'round_discovery'
      ? `Discovery ${Math.min(3, discoveryDone + 1)} of 3`
      : `Testing ${Math.min(7, validationDone + 1)} of 7`
    : labRunNeedsDecision(run)
      ? 'Ready for decision'
      : labRunPhase(run) === 'human_shipped'
        ? 'Shipped'
        : labRunPhase(run) === 'human_rejected'
          ? 'Rejected'
          : titleizeLabValue(activeTrial?.status || run.status);
  const validationSummary = validationSamples.length > 0
    ? `${validationDone}/7 testing rounds recorded: ${validationWins} improved, ${validationLosses} regressed, ${validationTies} tied${validationStopped > 0 ? `, ${validationStopped} stopped early` : ''}.`
    : 'Testing rounds have not started yet. They will compare baseline MARTy against the candidate upgrade across seven human-like conversations.';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-4xl">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {runIsCanary ? 'Experiment' : 'Legacy full lab'}
          </div>
          <h4 className="mt-1 text-2xl font-semibold leading-tight text-text-primary">
            {title}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            {activeExperimentPage ? labExperimentTagline(activeExperimentPage) : 'The sandbox is testing a MARTy improvement against the accepted baseline.'}
          </p>
        </div>
        {pausedForRoundReview ? (
          <MartyLabRoundReviewButtons disabled={MARTY_SANDBOX_EXECUTION_DISABLED || reviewingRound !== null} reviewing={reviewingRound} onReview={onReview} />
        ) : canShowRunDecision ? (
          <MartyLabDecisionButtons disabled={decisionDisabled} deciding={deciding} onDecide={onDecide} />
        ) : null}
      </div>

      <div className="rounded-lg border border-white/[0.06] bg-black/10 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-text-primary">{stageLabel}</div>
            <div className="mt-1 text-xs leading-relaxed text-text-muted">
              Three discovery rounds shape one hypothesis. Seven testing rounds compare the applied upgrade against the current baseline.
            </div>
          </div>
          <MartyLabStatusPill status={run.status} />
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full rounded-full bg-accent-magenta" style={{ width: `${experimentProgressPct || progressPct}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
          <span>{discoveryDone}/3 discovery rounds</span>
          <span>{validationDone}/7 testing rounds</span>
          <span>Recommendation: {recommendation}</span>
          {privacyFailures > 0 && <span className="text-semantic-error">{privacyFailures} privacy issue{privacyFailures === 1 ? '' : 's'}</span>}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ExperimentCoverSection title="Discovery rounds" status={`${discoveryDone}/3`}>
          {discoveryDone < 3
            ? 'The sandbox is still gathering baseline MARTy behavior from realistic user conversations.'
            : 'The discovery rounds captured where baseline MARTy struggled before proposing one focused upgrade.'}
        </ExperimentCoverSection>

        <ExperimentCoverSection title="Hypothesis" status={activeTrial?.status === 'pending' ? 'Forming' : 'Set'}>
          {hypothesis}
        </ExperimentCoverSection>

        <ExperimentCoverSection title="Applied upgrade" status={activeLeverIds.length > 0 ? `${activeLeverIds.length} lever${activeLeverIds.length === 1 ? '' : 's'}` : undefined}>
          {appliedUpgrade}
        </ExperimentCoverSection>

        <ExperimentCoverSection title="Testing rounds" status={`${validationDone}/7`}>
          {validationSummary}
        </ExperimentCoverSection>
      </div>

      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div className="text-sm font-semibold text-text-primary">Findings and conclusion</div>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">{conclusion}</p>
        {summary && summary !== conclusion && <p className="mt-2 text-xs leading-relaxed text-text-muted">{summary}</p>}
        {focusPrompt && (
          <div className="mt-3 rounded-md border border-accent-purple/15 bg-accent-purple/5 px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-accent-purple">User focus</div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">{focusPrompt}</p>
          </div>
        )}
        {approvalRationale.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Why</div>
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-text-secondary">
              {approvalRationale.map(item => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        </div>

      <SandboxEvidenceDrawer>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Raw run decisions</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <MartyLabMiniStat label="Accepted" value={acceptedTrialCount} tone="good" />
              <MartyLabMiniStat label="Rejected" value={rejectedTrialCount} tone="warn" />
              <MartyLabMiniStat label="Review" value={inconclusiveTrialCount} tone="warn" />
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current baseline</div>
            <div className="mt-2 text-sm font-medium text-text-primary">{acceptedBaseline?.label || 'Accepted MARTy baseline'}</div>
            <div className="mt-1 text-xs text-text-muted">Generation {acceptedBaseline?.generation ?? '—'}</div>
          </div>
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Candidate pool</div>
            <div className="mt-2 text-xs leading-relaxed text-text-secondary">
              Rank {String(activeCandidatePool?.selected_rank || activeCandidatePool?.rank || '—')} of {String(activeCandidatePool?.size || activeCandidatePool?.pool_size || '—')}
            </div>
            <div className="mt-2 text-[11px] text-text-muted">
              Run checks: {completed}/{expectedTotal} · Experiment {Math.max(1, currentRound)}/{Math.max(1, visibleRoundTotal || roundTotal)}
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Upgrade levers</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(activeLeverIds.length > 0 ? activeLeverIds : labEvidenceList(activeUpgrade, 'lever_ids')).slice(0, 6).map(lever => (
                <span key={lever} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-text-muted">{lever}</span>
              ))}
              {activeLeverIds.length === 0 && <span className="text-xs text-text-muted">No lever IDs recorded yet.</span>}
            </div>
          </div>
        </div>
      </SandboxEvidenceDrawer>
    </div>
  );
}

function SandboxExperimentPage({
  page,
  expectedSamples,
}: {
  page: MartyLabExperimentPage;
  expectedSamples: number;
}) {
  const [activeSampleIndex, setActiveSampleIndex] = React.useState(0);
  const roundsListRef = React.useRef<HTMLDivElement | null>(null);
  const roundCardRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const stats = martyLabExperimentStats(page, expectedSamples);
  const tone = page.trial?.status === 'accepted'
    ? 'good'
    : page.trial?.status === 'rejected'
      ? 'warn'
      : page.trial?.status === 'inconclusive'
        ? 'warn'
        : 'purple';
  const statusTone = martyToneClasses(tone);
  const sortedSamples = [...page.samples].sort((a, b) => {
    const aMeta = labRoundPolicy(a);
    const bMeta = labRoundPolicy(b);
    return (aMeta?.sample || 0) - (bMeta?.sample || 0);
  });
  React.useEffect(() => {
    roundCardRefs.current = roundCardRefs.current.slice(0, sortedSamples.length);
    setActiveSampleIndex(0);
    if (roundsListRef.current) roundsListRef.current.scrollTop = 0;
  }, [page.round, sortedSamples.length]);
  const handleRoundsScroll = React.useCallback(() => {
    const container = roundsListRef.current;
    if (!container || sortedSamples.length === 0) return;
    const targetTop = container.scrollTop + 8;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    roundCardRefs.current.forEach((card, index) => {
      if (!card) return;
      const distance = Math.abs(card.offsetTop - targetTop);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    setActiveSampleIndex(closestIndex);
  }, [sortedSamples.length]);
  const scrollToRound = React.useCallback((index: number) => {
    const container = roundsListRef.current;
    const target = roundCardRefs.current[index];
    if (!container || !target) return;
    container.scrollTo({
      top: Math.max(0, target.offsetTop - 8),
      behavior: 'smooth',
    });
    setActiveSampleIndex(index);
  }, []);
  const discoveryDone = sortedSamples.filter(sample => labRoundPolicy(sample)?.role === 'discovery' && labSampleIsClosed(sample)).length;
  const validationDone = sortedSamples.filter(sample => labRoundPolicy(sample)?.role === 'validation' && labSampleIsClosed(sample)).length;
  const cleanTitle = cleanExperimentTitle(page.title);
  const liftText = typeof stats.averageDelta === 'number'
    ? `Average lift ${labDeltaText(stats.averageDelta)}`
    : 'Average lift pending';
  const activeSample = sortedSamples[activeSampleIndex] || sortedSamples[0] || null;
  const activeSampleMeta = activeSample ? labRoundPolicy(activeSample) : null;
  const activeRoundLabel = activeSampleMeta?.role === 'discovery'
    ? `Discovery ${activeSampleMeta.sample}/3`
    : activeSampleMeta?.role === 'validation'
      ? `Testing ${Math.max(1, (activeSampleMeta.sample || 4) - 3)}/7`
      : 'Round position';
  const scrollProgressPct = sortedSamples.length > 0
    ? Math.round(((activeSampleIndex + 1) / sortedSamples.length) * 100)
    : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-5xl">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Experiment rounds</div>
          <h4 className="mt-1 text-2xl font-semibold leading-tight text-text-primary">{cleanTitle}</h4>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{labExperimentTagline(page)}</p>
          <p className="mt-2 text-xs leading-relaxed text-text-muted">
            Discovery {discoveryDone}/3 · Testing {validationDone}/7 · {stats.wins} improved · {stats.losses} regressed · {liftText}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusTone.box}`}>{stats.decision}</span>
      </div>

      {sortedSamples.length > 0 && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Round position</div>
            <div className="text-xs font-medium text-text-primary">{activeRoundLabel}</div>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className="h-full rounded-full bg-accent-magenta transition-[width] duration-150"
              style={{ width: `${scrollProgressPct}%` }}
            />
          </div>
          <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
            {sortedSamples.map((sample, index) => {
              const meta = labRoundPolicy(sample);
              const outcome = labExperimentOutcome(sample);
              const isActive = index === activeSampleIndex;
              const isClosed = labSampleIsClosed(sample);
              const label = meta?.role === 'discovery'
                ? `D${meta.sample}`
                : meta?.role === 'validation'
                  ? `T${Math.max(1, (meta.sample || 4) - 3)}`
                  : `${index + 1}`;
              const toneClass = isActive
                ? 'border-accent-magenta bg-accent-magenta text-white'
                : outcome.tone === 'good'
                  ? 'border-semantic-success/30 bg-semantic-success/10 text-semantic-success'
                  : outcome.tone === 'bad'
                    ? 'border-semantic-error/30 bg-semantic-error/10 text-semantic-error'
                    : isClosed
                      ? 'border-white/15 bg-white/[0.08] text-text-secondary'
                      : 'border-white/10 bg-white/[0.03] text-text-muted';
              return (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => scrollToRound(index)}
                  className={`h-7 min-w-9 shrink-0 rounded-md border px-2 text-[11px] font-medium transition ${toneClass}`}
                  aria-label={`Jump to ${label}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div
        ref={roundsListRef}
        onScroll={handleRoundsScroll}
        className="max-h-[42rem] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/10 p-2 pr-3"
      >
        {sortedSamples.length > 0 ? (
          <div className="space-y-2">
            {sortedSamples.map((sample, index) => (
              <div
                key={sample.id}
                ref={element => {
                  roundCardRefs.current[index] = element;
                }}
              >
                <SandboxRoundCard sample={sample} />
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-white/[0.06] bg-black/10 p-5 text-sm leading-relaxed text-text-muted">
            This experiment has not started yet. It will fill with three discovery cards and seven validation cards when the lab reaches this step.
          </div>
        )}
      </div>
    </div>
  );
}

function SandboxImprovementQueue({
  run,
  liveRun,
  queuedRuns,
  recentRuns,
  readiness,
  readinessMessage,
  canRepairLabQueue,
  canQuarantineLabArtifacts,
  canResetLabBaseline,
  repairingAction,
  onRepairReadiness,
  deepWorkItems,
  activeFailureClusters,
  codePatchJobs,
  startDisabled,
  startVerb,
  startingCodePatchId,
  onStartLab,
  onStartCodePatch,
  onSelectRun,
  loadingRunId,
  isViewingCurrent,
}: {
  run: MartyLabRunSnapshot | null;
  liveRun: MartyLabRunSnapshot | null;
  queuedRuns: MartyLabStatusSnapshot['queued_runs'];
  recentRuns: MartyLabStatusSnapshot['recent_runs'];
  readiness: MartyLabStatusSnapshot['readiness'];
  readinessMessage: string;
  canRepairLabQueue: boolean;
  canQuarantineLabArtifacts: boolean;
  canResetLabBaseline: boolean;
  repairingAction: MartyLabRepairAction | null;
  onRepairReadiness: (action?: MartyLabRepairAction) => void;
  deepWorkItems: MartyLabDeepWorkItemRow[];
  activeFailureClusters: Array<Record<string, unknown>>;
  codePatchJobs: MartyLabCodePatchJobRow[];
  startDisabled: boolean;
  startVerb: string;
  startingCodePatchId: string | null;
  onStartLab: (focusOverride?: string) => void;
  onStartCodePatch: (item: MartyLabDeepWorkItemRow) => void;
  onSelectRun: (runId: string | null) => void;
  loadingRunId: string | null;
  isViewingCurrent: boolean;
}) {
  const deepWorkCount = deepWorkItems.length || activeFailureClusters.length;

  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.015] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-text-primary">Improvement queue</h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            Pending runs, bigger fixes, and isolated code patches live here. Details stay collapsed until you need them.
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-text-muted">
          {queuedRuns.length} queued
        </span>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-3">
        <details className="rounded-lg border border-white/[0.06] bg-black/10" open={queuedRuns.length > 0}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Queued requests</summary>
          <div className="space-y-2 border-t border-white/[0.05] p-3">
            {queuedRuns.length > 0 ? queuedRuns.map((queued, index) => (
              <div key={queued.id} className="rounded-md border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-text-primary">{index === 0 ? 'Next up' : `Queued ${index + 1}`}</div>
                  <MartyLabStatusPill status={queued.status} />
                </div>
                <div className="mt-1 text-[11px] text-text-muted">{labRunModeLabel(queued)} · {queued.total_experiments.toLocaleString()} checks</div>
                {typeof queued.summary?.focus_prompt === 'string' && queued.summary.focus_prompt.trim() && (
                  <ExpandableText
                    text={queued.summary.focus_prompt}
                    collapsedLines={2}
                    minToggleChars={110}
                    className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                  />
                )}
              </div>
            )) : (
              <div className="text-xs leading-relaxed text-text-muted">No queued sandbox requests.</div>
            )}
          </div>
        </details>

        <details className="rounded-lg border border-semantic-warning/20 bg-semantic-warning/5" open={deepWorkCount > 0}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Bigger fixes MARTy found</summary>
          <div className="max-h-[25rem] space-y-2 overflow-y-auto border-t border-semantic-warning/10 p-3 pr-2">
            {deepWorkItems.map(item => {
              const patchJob = codePatchJobs.find(job => job.deep_work_item_id === item.id);
              const focus = `${item.title}. ${labDeepWorkBody(item)}`;
              return (
                <div key={item.id} className="rounded-md border border-semantic-warning/15 bg-black/10 px-3 py-2">
                  <div className="text-xs font-medium leading-snug text-text-primary">{item.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                    <span>{titleizeLabValue(item.priority)}</span>
                    <span>·</span>
                    <span>{titleizeLabValue(item.failure_type)}</span>
                    {patchJob && <span className="rounded border border-accent-magenta/20 bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] text-accent-magenta">Patch {labCodePatchStatusLabel(patchJob.status)}</span>}
                  </div>
                  <ExpandableText text={labDeepWorkBody(item)} collapsedLines={3} minToggleChars={140} className="mt-2 text-[11px] leading-relaxed text-text-secondary" />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onStartCodePatch(item)}
                      disabled={MARTY_SANDBOX_EXECUTION_DISABLED || Boolean(patchJob) || startingCodePatchId === item.id || !isViewingCurrent}
                      className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
                    >
                      {MARTY_SANDBOX_EXECUTION_DISABLED ? 'Execution disabled' : startingCodePatchId === item.id ? 'Starting patch' : patchJob ? 'Patch started' : 'Start code patch'}
                    </button>
                    <button type="button" onClick={() => onStartLab(focus)} disabled={startDisabled} className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-white/[0.04] disabled:opacity-50">{startVerb} canary</button>
                  </div>
                </div>
              );
            })}
            {deepWorkItems.length === 0 && activeFailureClusters.map((cluster, index) => {
              const focus = `${titleizeLabValue(cluster.failed_gate || cluster.failure_type)}. ${labFailureClusterBody(cluster)}`;
              return (
                <div key={`${String(cluster.cluster_key || index)}`} className="rounded-md border border-white/[0.05] bg-black/10 px-3 py-2">
                  <div className="text-xs font-medium leading-snug text-text-primary">{titleizeLabValue(cluster.failed_gate || cluster.failure_type)}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{Number(cluster.count || 0)} affected check{Number(cluster.count || 0) === 1 ? '' : 's'}</div>
                  <ExpandableText text={labFailureClusterBody(cluster)} collapsedLines={3} minToggleChars={140} className="mt-2 text-[11px] leading-relaxed text-text-secondary" />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => onStartLab(focus)} disabled={startDisabled} className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50">{startVerb} canary</button>
                  </div>
                </div>
              );
            })}
            {deepWorkCount === 0 && <div className="text-xs leading-relaxed text-text-muted">No bigger fixes identified yet.</div>}
          </div>
        </details>

        <details className="rounded-lg border border-white/[0.06] bg-black/10" open={codePatchJobs.length > 0}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Isolated code patches</summary>
          <div className="max-h-[25rem] space-y-2 overflow-y-auto border-t border-white/[0.05] p-3 pr-2">
            {codePatchJobs.length > 0 ? codePatchJobs.map(job => (
              <div key={job.id} className="rounded-md border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium leading-snug text-text-primary">{job.title}</div>
                    <div className="mt-1 text-[11px] text-text-muted">{labCodePatchStatusLabel(job.status)} · {job.model}</div>
                  </div>
                  <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">No deploy</span>
                </div>
                <SandboxEvidenceDrawer title="Patch details">
                  <div className="space-y-2 text-[11px] leading-relaxed text-text-secondary">
                    <div>Branch: {job.branch_name || 'pending'}</div>
                    <div>Worktree: {job.worktree_path || 'pending'}</div>
                    <ExpandableText text={labCodePatchBody(job)} collapsedLines={4} minToggleChars={180} />
                  </div>
                </SandboxEvidenceDrawer>
              </div>
            )) : (
              <div className="text-xs leading-relaxed text-text-muted">No isolated code patches started yet.</div>
            )}
          </div>
        </details>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <details className="rounded-lg border border-white/[0.06] bg-black/10">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">
            Run history {loadingRunId ? '· loading' : ''}
          </summary>
          <div className="flex gap-2 overflow-x-auto border-t border-white/[0.05] p-3">
            <button
              type="button"
              onClick={() => onSelectRun(null)}
              className={`min-w-[13rem] rounded-lg border px-3 py-2 text-left transition ${!run ? 'border-accent-purple/25 bg-accent-purple/5' : 'border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.04]'}`}
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current lane</div>
              <div className="mt-1 truncate text-xs font-medium text-text-primary">{liveRun ? labRunShortTitle(liveRun) : 'Ready for next canary'}</div>
              <div className="mt-1 text-[11px] text-text-muted">{liveRun ? `${liveRun.completed_experiments}/${liveRun.total_experiments || 0} checks` : 'No active canary'}</div>
            </button>
            {recentRuns.map(item => {
              const selected = run?.id === item.id;
              const current = liveRun?.id === item.id;
              const chipState = labRunChipState(item, current);
              const tone = martyToneClasses(chipState.tone);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectRun(item.id)}
                  className={`min-w-[13rem] rounded-lg border px-3 py-2 text-left transition ${selected ? `${tone.border} ${tone.soft}` : 'border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.04]'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{current ? 'Current' : formatRelative(item.created_at)}</span>
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.box}`}>{chipState.label}</span>
                  </div>
                  <div className="mt-1 truncate text-xs font-medium text-text-primary">{labRunShortTitle(item)}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{labRunModeLabel(item)} · {item.completed_experiments}/{item.total_experiments || 0} checks</div>
                </button>
              );
            })}
          </div>
        </details>

        <details className="rounded-lg border border-white/[0.06] bg-black/10">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Readiness details</summary>
          <div className="space-y-2 border-t border-white/[0.05] p-3">
            <div className="text-xs leading-relaxed text-text-muted">{readiness.ok ? 'Ready for a clean canary.' : readinessMessage}</div>
            {canRepairLabQueue && (
              <button
                type="button"
                onClick={() => onRepairReadiness('clear_orphaned_lab_queue')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-md border border-semantic-warning/25 px-2 py-1 text-[10px] font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                {repairingAction === 'clear_orphaned_lab_queue' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {repairingAction === 'clear_orphaned_lab_queue' ? 'Clearing stuck work' : 'Clear stuck sandbox work'}
              </button>
            )}
            {canQuarantineLabArtifacts && (
              <button
                type="button"
                onClick={() => onRepairReadiness('quarantine_lab_artifacts')}
                disabled={repairingAction !== null}
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-semantic-warning/25 px-2 py-1 text-[10px] font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                {repairingAction === 'quarantine_lab_artifacts' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {repairingAction === 'quarantine_lab_artifacts' ? 'Quarantining artifacts' : 'Quarantine sandbox artifacts'}
              </button>
            )}
            {canResetLabBaseline && (
              <button
                type="button"
                onClick={() => onRepairReadiness('reset_lab_baseline_to_live_runtime')}
                disabled={repairingAction !== null}
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-semantic-warning/25 px-2 py-1 text-[10px] font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                {repairingAction === 'reset_lab_baseline_to_live_runtime' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {repairingAction === 'reset_lab_baseline_to_live_runtime' ? 'Resetting baseline' : 'Reset baseline to live'}
              </button>
            )}
            <div className="grid gap-1">
              {readiness.checks.map(check => (
                <div key={check.key} className="rounded border border-white/[0.04] bg-white/[0.02] px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
                  <span className="font-medium text-text-primary">{sandboxCheckLabel(check.key)}:</span> {check.detail}
                </div>
              ))}
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}

function MartyLabStatusCard({
  lab,
  onRefresh,
}: {
  lab: MartyLabStatusSnapshot;
  onRefresh: () => void;
}) {
  const [startingMode, setStartingMode] = React.useState<'canary' | null>(null);
  const [startingCodePatchId, setStartingCodePatchId] = React.useState<string | null>(null);
  const [repairingAction, setRepairingAction] = React.useState<MartyLabRepairAction | null>(null);
  const [canceling, setCanceling] = React.useState(false);
  const [deciding, setDeciding] = React.useState<'ship' | 'reject' | null>(null);
  const [reviewingRound, setReviewingRound] = React.useState<'approve_continue' | 'reject_continue' | null>(null);
  const [activePageIndex, setActivePageIndex] = React.useState(0);
  const [focusPrompt, setFocusPrompt] = React.useState('');
  const [viewLab, setViewLab] = React.useState<MartyLabStatusSnapshot | null>(null);
  const [loadingRunId, setLoadingRunId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const liveRun = lab.run;
  const selectedLab = viewLab || lab;
  const run = selectedLab.run;
  const isViewingCurrent = !viewLab || viewLab.run?.id === liveRun?.id;

  React.useEffect(() => {
    if (viewLab?.run?.id && liveRun?.id === viewLab.run.id) setViewLab(null);
  }, [liveRun?.id, viewLab?.run?.id]);

  async function startLab(focusOverride?: string) {
    if (MARTY_SANDBOX_EXECUTION_DISABLED) {
      setError('MARTy Sandbox execution is disabled so it cannot run work or consume credits.');
      return;
    }
    setStartingMode('canary');
    setError(null);
    try {
      const requestedFocus = (focusOverride ?? focusPrompt).trim();
      await api.startMartyLabRun({
        mode: 'canary',
        round_count: 1,
        candidate_label: 'sandbox-experiment',
        focus_prompt: requestedFocus || undefined,
        queue_if_blocked: true,
      });
      if (!focusOverride) setFocusPrompt('');
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start MARTy Lab');
    } finally {
      setStartingMode(null);
    }
  }

  async function cancelLab() {
    if (!run || !isViewingCurrent || run.status !== 'running') return;
    setCanceling(true);
    setError(null);
    try {
      await api.cancelMartyLabRun(run.id);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to cancel MARTy Lab run');
    } finally {
      setCanceling(false);
    }
  }

  async function decideLab(decision: 'ship' | 'reject') {
    if (MARTY_SANDBOX_EXECUTION_DISABLED) {
      setError('MARTy Sandbox execution is disabled so it cannot change sandbox decisions.');
      return;
    }
    if (!run || !isViewingCurrent) return;
    setDeciding(decision);
    setError(null);
    try {
      await api.decideMartyLabRun(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || `Failed to ${decision} MARTy Lab candidate`);
    } finally {
      setDeciding(null);
    }
  }

  async function reviewRound(decision: 'approve_continue' | 'reject_continue') {
    if (MARTY_SANDBOX_EXECUTION_DISABLED) {
      setError('MARTy Sandbox execution is disabled so it cannot continue rounds.');
      return;
    }
    if (!run || !isViewingCurrent) return;
    setReviewingRound(decision);
    setError(null);
    try {
      await api.reviewMartyLabRound(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to continue MARTy Lab');
    } finally {
      setReviewingRound(null);
    }
  }

  async function repairReadiness(action: MartyLabRepairAction = 'clear_orphaned_lab_queue') {
    setRepairingAction(action);
    setError(null);
    try {
      await api.repairMartyLabReadiness({ action });
      onRefresh();
    } catch (e: any) {
      const fallback = action === 'archive_legacy_full_lab'
        ? 'Failed to archive legacy sandbox run'
        : action === 'quarantine_lab_artifacts'
          ? 'Failed to quarantine sandbox artifacts'
          : action === 'reset_lab_baseline_to_live_runtime'
            ? 'Failed to reset lab baseline to live runtime'
          : 'Failed to clear stuck sandbox work';
      setError(e?.message || fallback);
    } finally {
      setRepairingAction(null);
    }
  }

  async function startCodePatch(item: MartyLabDeepWorkItemRow) {
    if (MARTY_SANDBOX_EXECUTION_DISABLED) {
      setError('MARTy Sandbox execution is disabled so it cannot start code-patch work.');
      return;
    }
    if (!run || !isViewingCurrent) return;
    setStartingCodePatchId(item.id);
    setError(null);
    try {
      const requestedFocus = focusPrompt.trim();
      await api.startMartyLabCodePatch(run.id, item.id, {
        focus_prompt: requestedFocus || undefined,
      });
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start isolated code patch');
    } finally {
      setStartingCodePatchId(null);
    }
  }

  async function selectRun(runId: string | null) {
    setError(null);
    if (!runId || runId === liveRun?.id) {
      setViewLab(null);
      setActivePageIndex(0);
      return;
    }
    setLoadingRunId(runId);
    try {
      const snapshot = await api.getMartyLabRun(runId);
      setViewLab(snapshot);
      setActivePageIndex(0);
    } catch (e: any) {
      setError(e?.message || 'Failed to load MARTy Sandbox run');
    } finally {
      setLoadingRunId(null);
    }
  }

  const experiments = selectedLab.experiments || [];
  const versions = selectedLab.versions || [];
  const trials = selectedLab.upgrade_trials || [];
  const deepWorkItems = selectedLab.deep_work_items || [];
  const codePatchJobs = selectedLab.code_patch_jobs || [];
  const queuedRuns = lab.queued_runs || [];
  const recentRuns = lab.recent_runs || [];
  const science = labRecord(run?.summary?.scientific_model);
  const isQuarantined = Boolean(run?.discarded_at || run?.discard_reason);
  const roundTotal = labNumber(science?.rounds, 8);
  const roundSampleSize = labNumber(science?.sample_size_per_round, 10);
  const completed = run?.completed_experiments || 0;
  const total = run?.total_experiments || experiments.length || 0;
  const expectedTotal = total || roundTotal * roundSampleSize;
  const progressPct = expectedTotal > 0 ? Math.round((completed / expectedTotal) * 100) : 0;
  const currentRound = run ? labCurrentRound(run, experiments, roundTotal) : 0;
  const acceptedTrialCount = trials.filter(trial => trial.status === 'accepted').length;
  const rejectedTrialCount = trials.filter(trial => trial.status === 'rejected').length;
  const inconclusiveTrialCount = trials.filter(trial => trial.status === 'inconclusive').length;
  const latestTrial = trials[0] || null;
  const activeTrial = trials.find(trial => trial.status === 'pending') || latestTrial;
  const activeUpgrade = labRecord(activeTrial?.evidence?.upgrade);
  const approvalAssessment = labApprovalAssessment(activeTrial);
  const approvalRationale = labRationaleList(approvalAssessment);
  const activeCandidatePool = labRecord(activeTrial?.evidence?.candidate_pool_summary);
  const activeLeverIds = labEvidenceList(activeUpgrade, 'lever_ids');
  const acceptedBaseline = versions.find(version => version.status === 'accepted') || versions[0] || null;
  const activeFailureClusters = Array.isArray(run?.summary?.active_failure_clusters)
    ? run?.summary?.active_failure_clusters as Array<Record<string, unknown>>
    : [];
  const privacyFailures = experiments.filter(exp => exp.privacy_failure).length;
  const experimentRows = [...experiments].sort((a, b) => {
    const aMeta = labRoundPolicy(a);
    const bMeta = labRoundPolicy(b);
    const aRound = aMeta?.round || 0;
    const bRound = bMeta?.round || 0;
    if (aRound !== bRound) return aRound - bRound;
    return (aMeta?.sample || 0) - (bMeta?.sample || 0);
  });
  const closedExperimentRows = experimentRows.filter(exp => !['queued', 'running'].includes(exp.status));
  const discoveryCompleted = closedExperimentRows.filter(exp => labRoundPolicy(exp)?.role === 'discovery').length;
  const validationCompleted = closedExperimentRows.filter(exp => labRoundPolicy(exp)?.role === 'validation').length;
  const seededExperimentPages = buildMartyLabExperimentPages(experimentRows, trials);
  const runIsCanary = labRunIsCanary(run);
  const visibleRoundTotal = run ? (runIsCanary ? 1 : roundTotal) : seededExperimentPages.length;
  const experimentPages = run
    ? Array.from({ length: Math.max(visibleRoundTotal, seededExperimentPages.length) }, (_, index) => {
      const round = index + 1;
      return seededExperimentPages.find(page => page.round === round) || {
        round,
        trial: null,
        samples: [],
        title: `Experiment ${round}`,
      };
    })
    : seededExperimentPages;
  const pageCount = Math.max(1, experimentPages.length + 1);

  React.useEffect(() => {
    setActivePageIndex(index => Math.min(index, pageCount - 1));
  }, [pageCount, run?.id]);

  const readiness = lab.readiness || emptyMartyLab.readiness;
  const readinessMessage = readiness.blockers[0] || readiness.warnings[0] || 'Ready for a clean controlled run.';
  const blockingKeys = readiness.checks.filter(check => check.status === 'block').map(check => check.key);
  const labQueueBlocker = readiness.checks.find(check => check.key === 'lab_work_queue_clear' && check.status === 'block');
  const artifactIsolationCheck = readiness.checks.find(check => check.key === 'sandbox_artifact_isolation' && check.status !== 'pass');
  const legacyRunBlocker = readiness.checks.find(check => check.key === 'legacy_full_lab_active' && check.status === 'block');
  const baselineParityBlocker = readiness.checks.find(check => check.key === 'accepted_baseline_live_parity' && check.status === 'block');
  const labQueueHasStaleRows = Array.isArray((labQueueBlocker?.data as any)?.stale_queue)
    && ((labQueueBlocker?.data as any)?.stale_queue as unknown[]).length > 0;
  const liveRunIsLegacyFullLab = labRunIsLegacyFullLab(liveRun, readiness.harness_version);
  const selectedRunIsLegacyFullLab = labRunIsLegacyFullLab(run, readiness.harness_version);
  const canArchiveLegacyRun = Boolean(isViewingCurrent && liveRun && selectedRunIsLegacyFullLab && liveRunIsLegacyFullLab && legacyRunBlocker);
  const canQuarantineLabArtifacts = Boolean(!liveRun && artifactIsolationCheck);
  const canRepairLabQueue = Boolean(!liveRun && labQueueBlocker);
  const canResetLabBaseline = Boolean(!liveRun && baselineParityBlocker);
  const canQueueWhenBlocked = !readiness.ok && blockingKeys.length > 0 && blockingKeys.every(key => [
    'no_active_lab_run',
    'human_decision_required',
    'sandbox_queue_pending',
    'no_active_lab_run_race',
    'one_active_lab_run_per_suite',
    'one_active_lab_run_per_org',
  ].includes(key) || (key === 'lab_work_queue_clear' && Boolean(liveRun) && !labQueueHasStaleRows));
  const startDisabled = Boolean(MARTY_SANDBOX_EXECUTION_DISABLED || startingMode || canRepairLabQueue || canArchiveLegacyRun || canQuarantineLabArtifacts || canResetLabBaseline || (!readiness.ok && !canQueueWhenBlocked));
  const startVerb = readiness.ok && !liveRun ? 'Start' : 'Queue';
  const currentRunPhase = labRunPhase(run);
  const hasHumanDecision = currentRunPhase === 'human_shipped' || currentRunPhase === 'human_rejected';
  const pausedForRoundReview = Boolean(run?.status === 'running' && currentRunPhase === 'round_inconclusive_needs_review' && run.summary?.needs_human_round_review);
  const decisionDisabled = Boolean(MARTY_SANDBOX_EXECUTION_DISABLED || !run || !runIsCanary || selectedRunIsLegacyFullLab || !isViewingCurrent || isQuarantined || run.status === 'running' || run.status === 'configured' || hasHumanDecision || !activeTrial?.candidate_version_id);
  const canShowRunDecision = Boolean(run && runIsCanary && !selectedRunIsLegacyFullLab && labRunNeedsDecision(run) && isViewingCurrent && !pausedForRoundReview && !isQuarantined);
  const activeTrialExperimentPage = experimentPages.find(page => page.trial?.id === activeTrial?.id)
    || (currentRound > 0 ? experimentPages[currentRound - 1] : null)
    || experimentPages[experimentPages.length - 1]
    || null;
  const selectedExperimentPage = activePageIndex > 0 ? experimentPages[activePageIndex - 1] || null : null;
  const viewState = sandboxRunViewState({
    run,
    readiness,
    activeTrial,
    isViewingCurrent,
    isQuarantined,
    pausedForRoundReview,
    canRepairLabQueue,
    canArchiveLegacyRun,
    canQuarantineLabArtifacts,
    canResetLabBaseline,
    runIsCanary,
    completed,
    expectedTotal,
    currentRound,
    roundTotal,
    discoveryCompleted,
    validationCompleted,
  });
  const contextLabel = run
    ? `${labRunModeLabel(run)} · ${isViewingCurrent ? 'current run' : `created ${formatRelative(run.created_at)}`}`
    : readiness.ok ? 'No active experiment' : 'Waiting for the sandbox to clear';
  const experimentProgressPct = runIsCanary
    ? Math.max(0, Math.min(100, Math.round(((Math.min(discoveryCompleted, 3) + Math.min(validationCompleted, 7)) / 10) * 100)))
    : progressPct;
  const experimentProgressLabel = runIsCanary
    ? `${Math.min(discoveryCompleted, 3)}/3 discovery rounds · ${Math.min(validationCompleted, 7)}/7 testing rounds`
    : `${completed.toLocaleString()} of ${expectedTotal.toLocaleString()} checks complete`;

  return (
    <div className="space-y-5">
      <SandboxHeroState
        state={viewState}
        progressPct={run ? experimentProgressPct : null}
        progressLabel={run ? experimentProgressLabel : null}
        contextLabel={contextLabel}
        actions={(
          <>
            {canArchiveLegacyRun && (
              <button
                type="button"
                onClick={() => repairReadiness('archive_legacy_full_lab')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/15 disabled:opacity-50"
              >
                {repairingAction === 'archive_legacy_full_lab' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {repairingAction === 'archive_legacy_full_lab' ? 'Archiving...' : 'Archive legacy run'}
              </button>
            )}
            {canQuarantineLabArtifacts && (
              <button
                type="button"
                onClick={() => repairReadiness('quarantine_lab_artifacts')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/15 disabled:opacity-50"
              >
                {repairingAction === 'quarantine_lab_artifacts' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {repairingAction === 'quarantine_lab_artifacts' ? 'Quarantining...' : 'Quarantine artifacts'}
              </button>
            )}
            {canRepairLabQueue && (
              <button
                type="button"
                onClick={() => repairReadiness('clear_orphaned_lab_queue')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/15 disabled:opacity-50"
              >
                {repairingAction === 'clear_orphaned_lab_queue' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {repairingAction === 'clear_orphaned_lab_queue' ? 'Clearing...' : 'Clear stuck work'}
              </button>
            )}
            {canResetLabBaseline && (
              <button
                type="button"
                onClick={() => repairReadiness('reset_lab_baseline_to_live_runtime')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/15 disabled:opacity-50"
              >
                {repairingAction === 'reset_lab_baseline_to_live_runtime' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {repairingAction === 'reset_lab_baseline_to_live_runtime' ? 'Resetting...' : 'Reset baseline to live'}
              </button>
            )}
            {!isViewingCurrent && (
              <button
                type="button"
                onClick={() => selectRun(null)}
                className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-white/[0.04]"
              >
                Back to current
              </button>
            )}
            {run?.status === 'running' && isViewingCurrent && !canArchiveLegacyRun && (
              <button
                type="button"
                onClick={cancelLab}
                disabled={canceling}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                <XIcon size={13} /> {canceling ? 'Canceling...' : 'Cancel'}
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-white/[0.04]"
            >
              Refresh
            </button>
          </>
        )}
      />

      {MARTY_SANDBOX_EXECUTION_DISABLED && (
        <div className="rounded-lg border border-semantic-warning/20 bg-semantic-warning/10 px-3 py-2 text-xs leading-relaxed text-semantic-warning">
          MARTy Sandbox execution is disabled. This view is available for inspection and cleanup only; sandbox jobs cannot start, continue, ship, or consume credits.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs text-semantic-error">
          {error}
        </div>
      )}

      <SandboxFocusComposer
        value={focusPrompt}
        onChange={setFocusPrompt}
        onStart={() => startLab()}
        startDisabled={startDisabled}
        startVerb={MARTY_SANDBOX_EXECUTION_DISABLED ? 'Disabled' : startVerb}
        startingMode={startingMode}
        isBusy={Boolean(liveRun || queuedRuns.length > 0 || !readiness.ok)}
      />

      {run && canArchiveLegacyRun ? (
        <section className="rounded-xl border border-semantic-warning/20 bg-semantic-warning/5 p-5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-semantic-warning">Cleanup required</div>
          <h4 className="mt-1 text-2xl font-semibold text-text-primary">Old full lab is blocking clean experiments</h4>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-secondary">
            This run came from the retired full-lab harness. Archive it to clear the sandbox lane. The action only discards the stale lab record; it does not ship or reject a MARTy upgrade.
          </p>
          <SandboxEvidenceDrawer title="Legacy run details">
            <div className="space-y-2 text-xs leading-relaxed text-text-secondary">
              <div>Run: {run.id}</div>
              <div>Harness: {labRunHarnessVersion(run) || 'Legacy harness'}</div>
              <div>Phase: {labRunPhaseLabel(labRunPhase(run))}</div>
              {run.discard_reason && <div>{run.discard_reason}</div>}
            </div>
          </SandboxEvidenceDrawer>
        </section>
      ) : run ? (
        <SandboxRunPager
          pageIndex={activePageIndex}
          pageCount={pageCount}
          onPrev={() => setActivePageIndex(index => Math.max(0, index - 1))}
          onNext={() => setActivePageIndex(index => Math.min(pageCount - 1, index + 1))}
          onSelect={setActivePageIndex}
        >
          {activePageIndex === 0 ? (
            <SandboxCoverPage
              run={run}
              runIsCanary={runIsCanary}
              currentRound={currentRound}
              roundTotal={roundTotal}
              visibleRoundTotal={visibleRoundTotal}
              completed={completed}
              expectedTotal={expectedTotal}
              progressPct={progressPct}
              acceptedTrialCount={acceptedTrialCount}
              rejectedTrialCount={rejectedTrialCount}
              inconclusiveTrialCount={inconclusiveTrialCount}
              privacyFailures={privacyFailures}
              activeTrial={activeTrial}
              activeExperimentPage={activeTrialExperimentPage}
              activeUpgrade={activeUpgrade}
              activeLeverIds={activeLeverIds}
              activeCandidatePool={activeCandidatePool}
              acceptedBaseline={acceptedBaseline}
              approvalRationale={approvalRationale}
              pausedForRoundReview={pausedForRoundReview}
              canShowRunDecision={canShowRunDecision}
              decisionDisabled={decisionDisabled}
              deciding={deciding}
              reviewingRound={reviewingRound}
              onDecide={decideLab}
              onReview={reviewRound}
            />
          ) : selectedExperimentPage ? (
            <SandboxExperimentPage
              page={selectedExperimentPage}
              expectedSamples={roundSampleSize}
            />
          ) : (
            <div className="rounded-lg border border-white/[0.06] bg-black/10 p-5 text-sm text-text-muted">No experiment selected.</div>
          )}
        </SandboxRunPager>
      ) : (
        <section className="rounded-xl border border-white/[0.08] bg-white/[0.015] p-5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Experiment</div>
          <h4 className="mt-1 text-2xl font-semibold text-text-primary">No active experiment</h4>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-secondary">
            {canQuarantineLabArtifacts
              ? 'Quarantine old sandbox artifacts above before starting a clean experiment.'
              : canRepairLabQueue
                ? 'Clear the stuck sandbox work above before starting another clean experiment.'
                : 'Start a focused experiment for one controlled improvement, or queue the next experiment focus.'}
          </p>
        </section>
      )}
    </div>
  );
}

function MartyLabStatusCardLegacy({
  lab,
  onRefresh,
}: {
  lab: MartyLabStatusSnapshot;
  onRefresh: () => void;
}) {
  const [startingMode, setStartingMode] = React.useState<'canary' | null>(null);
  const [startingCodePatchId, setStartingCodePatchId] = React.useState<string | null>(null);
  const [repairingReadiness, setRepairingReadiness] = React.useState(false);
  const [canceling, setCanceling] = React.useState(false);
  const [deciding, setDeciding] = React.useState<'ship' | 'reject' | null>(null);
  const [reviewingRound, setReviewingRound] = React.useState<'approve_continue' | 'reject_continue' | null>(null);
  const [activePageIndex, setActivePageIndex] = React.useState(0);
  const [focusPrompt, setFocusPrompt] = React.useState('');
  const [viewLab, setViewLab] = React.useState<MartyLabStatusSnapshot | null>(null);
  const [loadingRunId, setLoadingRunId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const liveRun = lab.run;
  const selectedLab = viewLab || lab;
  const run = selectedLab.run;
  const isViewingCurrent = !viewLab || viewLab.run?.id === liveRun?.id;

  React.useEffect(() => {
    if (viewLab?.run?.id && liveRun?.id === viewLab.run.id) setViewLab(null);
  }, [liveRun?.id, viewLab?.run?.id]);

  async function startLab(focusOverride?: string) {
    setStartingMode('canary');
    setError(null);
    try {
      const requestedFocus = (focusOverride ?? focusPrompt).trim();
      await api.startMartyLabRun({
        mode: 'canary',
        round_count: 1,
        candidate_label: 'sandbox-canary',
        focus_prompt: requestedFocus || undefined,
        queue_if_blocked: true,
      });
      if (!focusOverride) setFocusPrompt('');
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start MARTy Lab');
    } finally {
      setStartingMode(null);
    }
  }

  async function cancelLab() {
    if (!run || !isViewingCurrent || run.status !== 'running') return;
    setCanceling(true);
    setError(null);
    try {
      await api.cancelMartyLabRun(run.id);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to cancel MARTy Lab run');
    } finally {
      setCanceling(false);
    }
  }

  async function decideLab(decision: 'ship' | 'reject') {
    if (!run || !isViewingCurrent) return;
    setDeciding(decision);
    setError(null);
    try {
      await api.decideMartyLabRun(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || `Failed to ${decision} MARTy Lab candidate`);
    } finally {
      setDeciding(null);
    }
  }

  async function reviewRound(decision: 'approve_continue' | 'reject_continue') {
    if (!run || !isViewingCurrent) return;
    setReviewingRound(decision);
    setError(null);
    try {
      await api.reviewMartyLabRound(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to continue MARTy Lab');
    } finally {
      setReviewingRound(null);
    }
  }

  async function repairReadiness() {
    setRepairingReadiness(true);
    setError(null);
    try {
      await api.repairMartyLabReadiness({ action: 'clear_orphaned_lab_queue' });
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to repair MARTy Sandbox readiness');
    } finally {
      setRepairingReadiness(false);
    }
  }

  async function startCodePatch(item: MartyLabDeepWorkItemRow) {
    if (!run || !isViewingCurrent) return;
    setStartingCodePatchId(item.id);
    setError(null);
    try {
      const requestedFocus = focusPrompt.trim();
      await api.startMartyLabCodePatch(run.id, item.id, {
        focus_prompt: requestedFocus || undefined,
      });
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start isolated code-patch lane');
    } finally {
      setStartingCodePatchId(null);
    }
  }

  async function selectRun(runId: string | null) {
    setError(null);
    if (!runId || runId === liveRun?.id) {
      setViewLab(null);
      setActivePageIndex(0);
      return;
    }
    setLoadingRunId(runId);
    try {
      const snapshot = await api.getMartyLabRun(runId);
      setViewLab(snapshot);
      setActivePageIndex(0);
    } catch (e: any) {
      setError(e?.message || 'Failed to load MARTy Lab run');
    } finally {
      setLoadingRunId(null);
    }
  }

  const experiments = selectedLab.experiments || [];
  const versions = selectedLab.versions || [];
  const trials = selectedLab.upgrade_trials || [];
  const deepWorkItems = selectedLab.deep_work_items || [];
  const codePatchJobs = selectedLab.code_patch_jobs || [];
  const queuedRuns = lab.queued_runs || [];
  const recentRuns = lab.recent_runs || [];
  const science = labRecord(run?.summary?.scientific_model);
  const isQuarantined = Boolean(run?.discarded_at || run?.discard_reason);
  const roundTotal = labNumber(science?.rounds, 8);
  const roundSampleSize = labNumber(science?.sample_size_per_round, 10);
  const validationPerRound = labNumber(science?.validation_conversations_per_round, 7);
  const discoveryPerRound = labNumber(science?.discovery_conversations_per_round, 1);
  const candidatePoolSize = labNumber(science?.candidate_pool_size, 5);
  const minCodeBackedCandidates = labNumber(science?.min_code_backed_candidates, 3);
  const completed = run?.completed_experiments || 0;
  const total = run?.total_experiments || experiments.length || 0;
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const currentRound = run ? labCurrentRound(run, experiments, roundTotal) : 0;
  const acceptedTrialCount = trials.filter(trial => trial.status === 'accepted').length;
  const rejectedTrialCount = trials.filter(trial => trial.status === 'rejected').length;
  const inconclusiveTrialCount = trials.filter(trial => trial.status === 'inconclusive').length;
  const decidedTrialCount = acceptedTrialCount + rejectedTrialCount + inconclusiveTrialCount;
  const latestTrial = trials[0] || null;
  const activeTrial = trials.find(trial => trial.status === 'pending') || latestTrial;
  const summaryText = labSummaryText(run?.summary);
  const autopilot = run?.summary?.autopilot && typeof run.summary.autopilot === 'object'
    ? run.summary.autopilot as Record<string, unknown>
    : null;
  const autopilotEnabled = autopilot?.enabled === true;
  const nextRunAfter = typeof autopilot?.next_run_after === 'string' ? autopilot.next_run_after : null;
  const activeFailureClusters = Array.isArray(run?.summary?.active_failure_clusters)
    ? run?.summary?.active_failure_clusters as Array<Record<string, unknown>>
    : [];
  const experimentRows = [...experiments].sort((a, b) => {
    const aMeta = labRoundPolicy(a);
    const bMeta = labRoundPolicy(b);
    const aRound = aMeta?.round || 0;
    const bRound = bMeta?.round || 0;
    if (aRound !== bRound) return aRound - bRound;
    return (aMeta?.sample || 0) - (bMeta?.sample || 0);
  });
  const seededExperimentPages = buildMartyLabExperimentPages(experimentRows, trials);
  const inferredRunIsCanary = Boolean(run && (run.upgrade_variable?.mode === 'canary' || run.suite_name.includes('canary')));
  const visibleRoundTotal = run ? (inferredRunIsCanary ? 1 : roundTotal) : seededExperimentPages.length;
  const experimentPages = run
    ? Array.from({ length: Math.max(visibleRoundTotal, seededExperimentPages.length) }, (_, index) => {
      const round = index + 1;
      return seededExperimentPages.find(page => page.round === round) || {
        round,
        trial: null,
        samples: [],
        title: `Experiment ${round}`,
      };
    })
    : seededExperimentPages;
  const pageCount = Math.max(1, experimentPages.length + 1);
  React.useEffect(() => {
    setActivePageIndex(index => Math.min(index, pageCount - 1));
  }, [pageCount, run?.id]);
  const activeLocal = labRecord(activeTrial?.evidence?.local_validation);
  const activeLocalSummary = labRecord(activeLocal?.summary);
  const activeUpgrade = labRecord(activeTrial?.evidence?.upgrade);
  const approvalAssessment = labApprovalAssessment(activeTrial);
  const approvalTarget = labRecord(approvalAssessment?.target);
  const approvalRegressions = labRecord(approvalAssessment?.regressions);
  const approvalRationale = labRationaleList(approvalAssessment);
  const activeCandidatePool = labRecord(activeTrial?.evidence?.candidate_pool_summary);
  const activeLeverIds = labEvidenceList(activeUpgrade, 'lever_ids');
  const acceptedBaseline = versions.find(version => version.status === 'accepted') || versions[0] || null;
  const readiness = lab.readiness || emptyMartyLab.readiness;
  const readinessTone = readiness.ok
    ? readiness.warnings.length > 0 ? 'warn' : 'good'
    : 'bad';
  const readinessMessage = readiness.blockers[0] || readiness.warnings[0] || 'Ready for a clean controlled run.';
  const blockingKeys = readiness.checks.filter(check => check.status === 'block').map(check => check.key);
  const labQueueBlocker = readiness.checks.find(check => check.key === 'lab_work_queue_clear' && check.status === 'block');
  const canRepairLabQueue = Boolean(!run && labQueueBlocker);
  const canQueueWhenBlocked = !readiness.ok && blockingKeys.length > 0 && blockingKeys.every(key => [
    'no_active_lab_run',
    'lab_work_queue_clear',
    'human_decision_required',
    'sandbox_queue_pending',
    'no_active_lab_run_race',
    'one_active_lab_run_per_suite',
  ].includes(key));
  const startDisabled = Boolean(startingMode || (!readiness.ok && !canQueueWhenBlocked));
  const startVerb = readiness.ok ? 'Start' : 'Queue';
  const currentRunPhase = labRunPhase(run);
  const hasHumanDecision = currentRunPhase === 'human_shipped' || currentRunPhase === 'human_rejected';
  const decisionDisabled = Boolean(!run || !isViewingCurrent || isQuarantined || run.status === 'running' || run.status === 'configured' || hasHumanDecision || !activeTrial?.candidate_version_id);
  const selectedExperimentPage = activePageIndex > 0 ? experimentPages[activePageIndex - 1] || null : null;
  const selectedExperimentStats = selectedExperimentPage ? martyLabExperimentStats(selectedExperimentPage, roundSampleSize) : null;
  const activeTrialExperimentPage = experimentPages.find(page => page.trial?.id === activeTrial?.id) || experimentPages[experimentPages.length - 1] || null;
  const pausedForRoundReview = Boolean(run?.status === 'running' && currentRunPhase === 'round_inconclusive_needs_review' && run.summary?.needs_human_round_review);
  const pausedReview = labRecord(run?.summary?.needs_human_round_review);
  const stateCopy = labRunStateCopy(run, {
    activeTrial,
    isQuarantined,
    isViewingCurrent,
	    pausedForRoundReview,
	    completed,
	    total,
	    currentRound,
	    roundTotal,
	    readinessOk: readiness.ok,
	    readinessMessage,
	  });
  const stateTone = martyToneClasses(stateCopy.tone);
  const selectedRunChip = run ? labRunChipState(run, isViewingCurrent) : null;
  const selectedRunTone = selectedRunChip ? martyToneClasses(selectedRunChip.tone) : martyToneClasses(readiness.ok ? 'good' : 'warn');
  const expectedTotal = total || roundTotal * roundSampleSize;
  const runIsCanary = inferredRunIsCanary;
  const canShowRunDecision = Boolean(run && labRunNeedsDecision(run) && !pausedForRoundReview);
  const laneMessage = readiness.ok
    ? 'Ready for a clean controlled run.'
    : canQueueWhenBlocked
      ? 'A run is already active. New requests will wait in the queue until the current run gets a Ship or Reject decision.'
      : readinessMessage;
  const labQueueBlockerQueue = Array.isArray(labRecord(labQueueBlocker?.data)?.queue)
    ? labRecord(labQueueBlocker?.data)?.queue as Array<Record<string, unknown>>
    : [];

  return (
    <div className="card p-5 space-y-4">
      <div className={`rounded-xl border ${stateTone.border} bg-white/[0.02] p-4`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className={`text-[11px] font-semibold uppercase tracking-wide ${stateTone.text}`}>{stateCopy.eyebrow}</div>
            <div className="mt-1 text-xl font-semibold leading-tight text-text-primary">{stateCopy.title}</div>
            <div className="mt-2 max-w-4xl text-sm leading-relaxed text-text-secondary">{stateCopy.body}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {run && <MartyLabStatusPill status={run.status} />}
              {selectedRunChip && (
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${selectedRunTone.box}`}>
                  {selectedRunChip.label}
                </span>
              )}
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                {run ? labRunModeLabel(run) : readiness.ok ? 'Ready' : 'Waiting'}
              </span>
              {run && (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                  Experiment {currentRound}/{roundTotal}
                </span>
              )}
              {autopilotEnabled && (
                <span className="rounded-full border border-accent-purple/30 bg-accent-purple/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-purple">
                  Autopilot
                </span>
              )}
              {!isViewingCurrent && (
                <button
                  type="button"
                  onClick={() => selectRun(null)}
                  className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary hover:bg-white/[0.05]"
                >
                  Back to current run
                </button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canRepairLabQueue && (
              <button
                type="button"
                onClick={repairReadiness}
                disabled={repairingReadiness}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-2.5 py-1.5 text-[11px] text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                {repairingReadiness ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {repairingReadiness ? 'Clearing...' : 'Clear stuck queue'}
              </button>
            )}
            {run?.status === 'running' && isViewingCurrent && (
              <button
                type="button"
                onClick={cancelLab}
                disabled={canceling}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-2.5 py-1.5 text-[11px] text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                <XIcon size={12} /> {canceling ? 'Canceling...' : 'Cancel'}
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-white/[0.04]"
            >
              Refresh
            </button>
          </div>
        </div>
        {run && (
          <div className="mt-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-text-muted">
              <span>{completed.toLocaleString()} of {expectedTotal.toLocaleString()} checks complete</span>
              <span>{isViewingCurrent ? 'Current run' : `Viewing history from ${formatRelative(run.created_at)}`}</span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs text-semantic-error">
          {error}
        </div>
      )}

      {canRepairLabQueue && (
        <div className="rounded-lg border border-semantic-warning/20 bg-semantic-warning/5 px-3 py-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-text-primary">Queue cleanup available</div>
              <div className="mt-1 max-w-3xl text-xs leading-relaxed text-text-secondary">
                The sandbox found leftover lab queue work, but there is no active lab run attached to it. Clearing it moves only retryable MARTy Lab queue rows to review history so a clean run can start.
              </div>
              {labQueueBlockerQueue.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {labQueueBlockerQueue.map((row, index) => (
                    <span key={`${String(row.domain || 'lab')}-${String(row.status || index)}`} className="rounded-full border border-semantic-warning/15 bg-semantic-warning/10 px-2 py-0.5 text-[10px] text-semantic-warning">
                      {titleizeLabValue(row.domain)} · {titleizeLabValue(row.status)} · {String(row.count || 0)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={repairReadiness}
              disabled={repairingReadiness}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-semantic-warning/25 px-2 py-1 text-[10px] font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
            >
              {repairingReadiness ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {repairingReadiness ? 'Clearing' : 'Clear stuck queue'}
            </button>
          </div>
        </div>
      )}

      {!run ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Sandbox cover</div>
          <div className="mt-1 text-lg font-semibold text-text-primary">No active lab run</div>
          <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
            {laneMessage} Start a focused canary for one controlled improvement, or queue the next canary focus.
          </div>
        </div>
      ) : (
        <MartyLabPageShell
          pageIndex={activePageIndex}
          pageCount={pageCount}
          onPrev={() => setActivePageIndex(index => Math.max(0, index - 1))}
          onNext={() => setActivePageIndex(index => Math.min(pageCount - 1, index + 1))}
          onSelect={setActivePageIndex}
        >
          {activePageIndex === 0 ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                    {runIsCanary ? 'Canary run cover' : 'Legacy full lab run cover'}
                  </div>
                  <div className="mt-1 text-lg font-semibold text-text-primary">{activeTrial?.title || run.upgrade_title || labRunShortTitle(run)}</div>
                  {activeTrialExperimentPage && (
                    <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">{labExperimentTagline(activeTrialExperimentPage)}</div>
                  )}
                  <div className="mt-1 max-w-3xl text-xs leading-relaxed text-text-muted">
                    {pausedForRoundReview
                      ? 'The full lab is paused on an inconclusive experiment. Review the evidence, then continue without shipping or reject this experiment and continue.'
                      : run.status === 'running'
                      ? runIsCanary
                        ? 'Three discovery chats find a real weakness, then seven validation chats compare one candidate against the accepted baseline.'
                        : 'Eight controlled rounds run in sequence; each round discovers one weakness, validates one candidate, and compounds only approved improvements.'
                      : run.summary?.conclusion
                        ? String(run.summary.conclusion)
                        : 'The run is closed and ready for review.'}
                  </div>
                  {typeof run.summary?.focus_prompt === 'string' && run.summary.focus_prompt.trim() && (
                    <div className="mt-2 rounded-md border border-accent-purple/15 bg-accent-purple/5 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                      <span className="font-medium text-text-primary">Focus:</span> {run.summary.focus_prompt}
                    </div>
                  )}
                </div>
                {pausedForRoundReview ? (
                  <MartyLabRoundReviewButtons
                    disabled={MARTY_SANDBOX_EXECUTION_DISABLED || reviewingRound !== null}
                    reviewing={reviewingRound}
                    onReview={reviewRound}
                  />
                ) : canShowRunDecision ? (
                  <MartyLabDecisionButtons disabled={decisionDisabled} deciding={deciding} onDecide={decideLab} />
                ) : null}
              </div>

              {pausedForRoundReview && (
                <div className="rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs leading-relaxed text-semantic-warning">
                  Paused after experiment {String(pausedReview?.round_index || '—')}. Approve and continue keeps the current baseline and starts the next experiment. Reject experiment also keeps the current baseline, marks this candidate rejected, and starts the next experiment.
                </div>
              )}

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)]">
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Run progress</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <MartyLabMiniStat label="Experiments" value={`${currentRound}/${roundTotal}`} tone={run.status === 'running' ? 'purple' : 'default'} />
                    <MartyLabMiniStat label="Checks" value={`${completed}/${expectedTotal}`} />
                    <MartyLabMiniStat label="Decided" value={`${decidedTrialCount}/${runIsCanary ? 1 : roundTotal}`} tone={decidedTrialCount > 0 ? 'good' : 'default'} />
                  </div>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Run decisions</div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <MartyLabMiniStat label="Ship-ready" value={acceptedTrialCount.toLocaleString()} tone="good" />
                    <MartyLabMiniStat label="Rejected" value={rejectedTrialCount.toLocaleString()} tone={rejectedTrialCount > 0 ? 'warn' : 'default'} />
                    <MartyLabMiniStat label="Review" value={inconclusiveTrialCount.toLocaleString()} tone={inconclusiveTrialCount > 0 ? 'warn' : 'default'} />
                  </div>
                </div>
              </div>

              {(run.privacy_failures || 0) > 0 && (
                <div className="rounded-lg border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs leading-relaxed text-semantic-error">
                  Privacy review found {run.privacy_failures.toLocaleString()} issue{run.privacy_failures === 1 ? '' : 's'} in this run.
                </div>
              )}

              <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                <div className="text-xs font-medium text-text-primary">{run.status === 'running' ? 'Current experiment' : 'Latest decision'}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium text-text-primary">{String(approvalAssessment?.label || titleizeLabValue(activeTrial?.status || 'Pending'))}</div>
                  {activeTrial && <MartyLabStatusPill status={activeTrial.status} />}
                  {typeof approvalAssessment?.recommendation === 'string' && (
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-text-muted">{titleizeLabValue(approvalAssessment.recommendation)}</span>
                  )}
                </div>
                <div className="mt-2 text-xs leading-relaxed text-text-secondary">
                  {activeTrial?.conclusion || labTrialDecisionText(activeTrial)}
                </div>
              </div>

              <details className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-text-primary">Evidence details</summary>
                <div className="mt-3 space-y-3">
                  <div className="grid gap-2 md:grid-cols-4">
                    <MartyLabMiniStat label="Approval score" value={approvalAssessment ? String(approvalAssessment.approval_score ?? '—') : '—'} tone={activeTrial?.status === 'accepted' ? 'good' : activeTrial?.status === 'rejected' ? 'bad' : 'warn'} />
                    <MartyLabMiniStat label="Valid signal" value={`${activeTrial?.valid_sample_size || labNumber(approvalAssessment?.valid_samples, 0)}/${validationPerRound}`} tone={(activeTrial?.valid_sample_size || 0) >= 5 ? 'good' : 'warn'} />
                    <MartyLabMiniStat label="Wins / losses" value={`${activeTrial?.wins || 0}/${activeTrial?.losses || 0}`} tone={(activeTrial?.wins || 0) > (activeTrial?.losses || 0) ? 'good' : 'warn'} />
                    <MartyLabMiniStat label="Target delta" value={approvalTarget?.average_delta !== undefined ? labDeltaText(Number(approvalTarget.average_delta)) : labDeltaText(activeTrial?.target_average_delta ?? null)} tone={(Number(approvalTarget?.average_delta ?? activeTrial?.target_average_delta ?? 0) > 0) ? 'good' : 'default'} />
                  </div>
                  {approvalRationale.length > 0 && (
                    <div className="grid gap-2 md:grid-cols-2">
                      {approvalRationale.map((item, index) => (
                        <div key={index} className="rounded-md border border-white/[0.04] bg-black/10 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                          {item}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-[11px] leading-relaxed text-text-muted">
                    Small unrelated losses: {String(approvalRegressions?.small_non_target_losses ?? 0)} · meaningful non-target losses: {String(approvalRegressions?.meaningful_non_target_losses ?? 0)} · severe: {String(activeTrial?.severe_regressions ?? 0)}
                  </div>
                  {acceptedBaseline && (
                    <div className="rounded-md border border-white/[0.04] bg-black/10 px-3 py-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current baseline</div>
                      <div className="mt-1 text-xs font-medium text-text-primary line-clamp-1">{acceptedBaseline.label}</div>
                      <div className="mt-0.5 text-[11px] text-text-muted">Generation {acceptedBaseline.generation.toLocaleString()}</div>
                    </div>
                  )}
                  {(activeLeverIds.length > 0 || activeCandidatePool) && (
                    <div className="rounded-md border border-white/[0.04] bg-black/10 px-3 py-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Candidate</div>
                      {activeCandidatePool && (
                        <div className="mt-1 text-[11px] text-text-muted">
                          Rank {String(activeCandidatePool.selected_rank || '—')} of {String(activeCandidatePool.candidate_count || candidatePoolSize)}
                          {' '}· code-backed {String(activeCandidatePool.code_backed_candidate_count || 0)}/{String(activeCandidatePool.required_code_backed_candidates || minCodeBackedCandidates)}
                        </div>
                      )}
                      {activeLeverIds.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {activeLeverIds.map(leverId => (
                            <span key={leverId} className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-text-muted">{leverId}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </details>
            </div>
          ) : selectedExperimentPage ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                    Experiment {selectedExperimentPage.round} of {experimentPages.length}
                  </div>
                  <div className="mt-1 max-w-4xl text-lg font-semibold leading-snug text-text-primary">{selectedExperimentPage.title}</div>
                  <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">{labExperimentTagline(selectedExperimentPage)}</div>
                  <div className="mt-1 text-xs text-text-muted">
                    {(selectedExperimentStats?.closedSamples ?? 0).toLocaleString()}/{(selectedExperimentStats?.totalSamples ?? roundSampleSize).toLocaleString()} checks complete · {selectedExperimentStats?.decision || 'Pending'}
                  </div>
                </div>
                {selectedExperimentPage.trial && <MartyLabStatusPill status={selectedExperimentPage.trial.status} />}
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)]">
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Experiment progress</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <MartyLabMiniStat label="Checks complete" value={`${selectedExperimentStats?.closedSamples ?? 0}/${selectedExperimentStats?.totalSamples ?? roundSampleSize}`} />
                    <MartyLabMiniStat label="Validation graded" value={`${selectedExperimentStats?.validSamples ?? 0}/${selectedExperimentStats?.validationTotal ?? validationPerRound}`} />
                    <MartyLabMiniStat label="Decision" value={selectedExperimentStats?.decision || 'Pending'} tone={selectedExperimentPage.trial?.status === 'accepted' ? 'good' : selectedExperimentPage.trial?.status === 'rejected' ? 'bad' : selectedExperimentPage.trial?.status === 'inconclusive' ? 'warn' : 'default'} />
                  </div>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Validation outcome</div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <MartyLabMiniStat label="Wins" value={(selectedExperimentStats?.wins ?? 0).toLocaleString()} tone="good" />
                    <MartyLabMiniStat label="Losses" value={(selectedExperimentStats?.losses ?? 0).toLocaleString()} tone={(selectedExperimentStats?.losses ?? 0) > 0 ? 'warn' : 'default'} />
                    <MartyLabMiniStat label="Avg lift" value={labDeltaText(selectedExperimentStats?.averageDelta ?? null)} tone={(selectedExperimentStats?.averageDelta ?? 0) > 0 ? 'good' : (selectedExperimentStats?.averageDelta ?? 0) < 0 ? 'bad' : 'default'} />
                  </div>
                </div>
              </div>

              <div className="max-h-[36rem] overflow-y-auto rounded-lg border border-white/[0.04] bg-white/[0.01] p-2">
                <div className="grid gap-2 xl:grid-cols-2">
                  {selectedExperimentPage.samples.length > 0 ? (
                    selectedExperimentPage.samples.map(sample => (
                      <MartyLabRoundSampleCard key={sample.id} sample={sample} />
                    ))
                  ) : (
                    <div className="rounded-lg border border-white/[0.04] bg-black/10 p-4 text-sm leading-relaxed text-text-muted xl:col-span-2">
                      This experiment has not started yet. It will fill with three discovery cards and seven validation cards when the lab reaches this step.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-text-muted">No experiment selected.</div>
          )}
        </MartyLabPageShell>
      )}

      <details className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-text-primary">
          <span>Controls, queue, and history</span>
          <span className="text-[11px] font-normal text-text-muted">{queuedRuns.length} queued</span>
        </summary>
        <div className="space-y-4 border-t border-white/[0.04] p-3">
          <div>
            <div className="text-xs font-medium text-text-primary">Focus the next run</div>
            <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
              Add a concrete problem or target area. If a run is active, this request waits for the current run to get Ship or Reject.
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={focusPrompt}
                onChange={event => setFocusPrompt(event.target.value)}
                placeholder="Example: I had a problem with Excel artifacts missing formulas. Focus on that."
                className="min-w-[18rem] flex-1 rounded-lg border border-white/10 bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-magenta/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => startLab()}
                disabled={startDisabled}
                className="inline-flex items-center gap-1 rounded-lg border border-accent-magenta/25 px-2.5 py-1.5 text-[11px] text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
              >
                <Sparkles size={12} /> {startingMode === 'canary' ? `${startVerb}ing...` : `${startVerb} canary`}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.04] bg-black/10 px-3 py-2 text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Queue state:</span> {laneMessage}
            {readiness.ok && readiness.warnings.length > 0 ? ` Warning: ${readiness.warnings[0]}` : ''}
          </div>

          {queuedRuns.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-primary">Queued runs</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {queuedRuns.map((queued, index) => (
                  <div key={queued.id} className="rounded-md border border-white/[0.05] bg-black/10 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-text-primary">{index === 0 ? 'Next' : `Queued ${index + 1}`}</div>
                      <MartyLabStatusPill status={queued.status} />
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">
                      {queued.upgrade_variable?.mode === 'canary' ? 'Canary' : 'Legacy full lab'} · {queued.total_experiments.toLocaleString()} checks
                    </div>
                    {typeof queued.summary?.focus_prompt === 'string' && queued.summary.focus_prompt.trim() && (
                      <ExpandableText
                        text={queued.summary.focus_prompt}
                        collapsedLines={2}
                        minToggleChars={110}
                        className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {recentRuns.length > 0 && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium text-text-primary">Past runs</div>
                {loadingRunId && <div className="text-[11px] text-text-muted">Loading run...</div>}
              </div>
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => selectRun(null)}
                  className={`min-w-[14rem] rounded-lg border px-3 py-2 text-left transition ${!run ? `${stateTone.border} ${stateTone.soft}` : 'border-white/[0.05] bg-black/10 hover:bg-white/[0.03]'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current run</span>
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${martyToneClasses(readiness.ok ? 'good' : 'warn').box}`}>
                      {readiness.ok ? 'Ready' : 'Waiting'}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs font-medium text-text-primary">Next canary</div>
                  <div className="mt-1 text-[11px] text-text-muted">Single controlled run at a time</div>
                </button>
                {recentRuns.map(item => {
                  const selected = run?.id === item.id;
                  const current = liveRun?.id === item.id;
                  const chipState = labRunChipState(item, current);
                  const tone = martyToneClasses(chipState.tone);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectRun(item.id)}
                      className={`min-w-[14rem] rounded-lg border px-3 py-2 text-left transition ${selected ? `${tone.border} ${tone.soft}` : 'border-white/[0.05] bg-black/10 hover:bg-white/[0.03]'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{current ? 'Current run' : formatRelative(item.created_at)}</span>
                        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.box}`}>{chipState.label}</span>
                      </div>
                      <div className="mt-1 truncate text-xs font-medium text-text-primary">{labRunShortTitle(item)}</div>
                      <div className="mt-1 text-[11px] text-text-muted">
                        {labRunModeLabel(item)} · {item.completed_experiments}/{item.total_experiments || 0} closed
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isQuarantined && (
            <div className="rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs leading-relaxed text-semantic-warning">
              This lab run is archived and should not drive Ship or Reject decisions. {run?.discard_reason || 'Its scorecards are kept only as historical context.'}
            </div>
          )}
        </div>
      </details>

      {(run && codePatchJobs.length > 0) && (
        <details className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-text-primary">Code Patch Lane</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
                Isolated engineering briefs for Deep Work. These do not deploy or ship MARTy until a human reviews the patch and reruns a canary.
              </div>
            </div>
            <span className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-text-secondary">
              {codePatchJobs.length} job{codePatchJobs.length === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="grid max-h-[22rem] gap-2 overflow-y-auto border-t border-white/[0.06] p-3 pr-1 lg:grid-cols-2">
            {codePatchJobs.map(job => (
              <div key={job.id} className="rounded-md border border-white/[0.06] bg-black/10 px-2.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium leading-snug text-text-primary">{job.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                      <span>{labCodePatchStatusLabel(job.status)}</span>
                      <span>·</span>
                      <span>{titleizeLabValue(job.priority)}</span>
                      <span>·</span>
                      <span>{job.model}</span>
                    </div>
                  </div>
                  <span className="shrink-0 rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">
                    No deploy
                  </span>
                </div>
                <div className="mt-2 grid gap-1.5 text-[11px] text-text-muted sm:grid-cols-2">
                  <div className="rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1">
                    Branch: <span className="text-text-secondary">{job.branch_name || 'pending'}</span>
                  </div>
                  <div className="rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1">
                    Worktree: <span className="text-text-secondary">{job.worktree_path || 'pending'}</span>
                  </div>
                </div>
                <ExpandableText
                  text={labCodePatchBody(job)}
                  collapsedLines={4}
                  minToggleChars={180}
                  className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                />
              </div>
            ))}
          </div>
        </details>
      )}

      {(run && (deepWorkItems.length > 0 || activeFailureClusters.length > 0)) && (
        <details className="rounded-lg border border-semantic-warning/20 bg-semantic-warning/5">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-text-primary">Deep Work</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
                Engineering follow-up found by the lab. These items need a focused canary or lab before they can ship.
              </div>
            </div>
            <span className="shrink-0 rounded-md border border-semantic-warning/20 bg-semantic-warning/10 px-2 py-1 text-[10px] font-medium text-semantic-warning">
              {deepWorkItems.length || activeFailureClusters.length} item{(deepWorkItems.length || activeFailureClusters.length) === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="grid max-h-[24rem] gap-2 overflow-y-auto border-t border-semantic-warning/10 p-3 pr-1 md:grid-cols-2 xl:grid-cols-3">
            {deepWorkItems.map(item => {
              const patchJob = codePatchJobs.find(job => job.deep_work_item_id === item.id);
              return (
                <div key={item.id} className="rounded-md border border-semantic-warning/15 bg-black/10 px-2.5 py-2">
                  <div className="text-xs font-medium leading-snug text-text-primary">{item.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                    <span>{titleizeLabValue(item.priority)}</span>
                    <span>·</span>
                    <span>{titleizeLabValue(item.failure_type)}</span>
                    <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">Not included in Ship</span>
                    {patchJob && (
                      <span className="rounded border border-accent-magenta/20 bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] text-accent-magenta">
                        Patch {labCodePatchStatusLabel(patchJob.status)}
                      </span>
                    )}
                  </div>
                  <ExpandableText
                    text={labDeepWorkBody(item)}
                    collapsedLines={3}
                    minToggleChars={140}
                    className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => startCodePatch(item)}
                      disabled={MARTY_SANDBOX_EXECUTION_DISABLED || Boolean(patchJob) || startingCodePatchId === item.id || !isViewingCurrent}
                      className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
                    >
                      {MARTY_SANDBOX_EXECUTION_DISABLED ? 'Execution disabled' : startingCodePatchId === item.id ? 'Starting patch' : patchJob ? 'Patch started' : 'Start code patch'}
                    </button>
                    <button
                      type="button"
                      onClick={() => startLab(`${item.title}. ${labDeepWorkBody(item)}`)}
                      disabled={startDisabled}
                      className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-white/[0.04] disabled:opacity-50"
                    >
                      {startVerb} canary
                    </button>
                  </div>
                </div>
              );
            })}
            {deepWorkItems.length === 0 && activeFailureClusters.map((cluster, index) => (
              <div key={`${String(cluster.cluster_key || index)}`} className="rounded-md border border-white/[0.04] bg-black/10 px-2.5 py-2">
                <div className="text-xs font-medium leading-snug text-text-primary">{titleizeLabValue(cluster.failed_gate || cluster.failure_type)}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                  <span>{titleizeLabValue(cluster.priority)}</span>
                  <span>·</span>
                  <span>{Number(cluster.count || 0)} sample{Number(cluster.count || 0) === 1 ? '' : 's'}</span>
                  <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">Needs diagnosis</span>
                </div>
                <ExpandableText
                  text={labFailureClusterBody(cluster)}
                  collapsedLines={3}
                  minToggleChars={140}
                  className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => startLab(`${titleizeLabValue(cluster.failed_gate || cluster.failure_type)}. ${labFailureClusterBody(cluster)}`)}
                    disabled={startDisabled}
                    className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
                  >
                    {startVerb} canary
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function friendlyReplayReason(reason: string): string {
  return reason.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function DealReplayStatusCard({
  replay,
  onRefresh,
}: {
  replay: DealReplayStatusSnapshot;
  onRefresh: () => void;
}) {
  const [canceling, setCanceling] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [evidenceRows, setEvidenceRows] = React.useState<DealReplayEvidenceRow[]>([]);
  const [evidenceTotal, setEvidenceTotal] = React.useState(0);
  const [evidenceLoading, setEvidenceLoading] = React.useState(false);
  const [evidenceError, setEvidenceError] = React.useState<string | null>(null);
  const run = replay.run;
  const queue = replay.queue;

  const loadEvidence = React.useCallback(async (offset = 0) => {
    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const result = await api.getDealReplayEvidence({ limit: 50, offset });
      setEvidenceTotal(result.total);
      setEvidenceRows(prev => offset === 0 ? result.evidence : [...prev, ...result.evidence]);
    } catch (e: any) {
      setEvidenceError(e?.message || 'Failed to load evidence');
    } finally {
      setEvidenceLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (evidenceOpen && evidenceRows.length === 0 && !evidenceLoading) {
      loadEvidence(0);
    }
  }, [evidenceOpen, evidenceRows.length, evidenceLoading, loadEvidence]);

  async function cancelReplay() {
    if (!run || run.status !== 'running') return;
    setCanceling(true);
    try {
      await api.cancelDealReplay();
      onRefresh();
    } finally {
      setCanceling(false);
    }
  }

  if (!run) {
    return (
      <div className="card p-5">
        <div className="text-sm font-medium text-text-primary">Deal Rebuild</div>
        <div className="text-xs text-text-muted mt-1">
          No six-week rebuild has been started yet. When it runs, this panel shows candidate scanning, conservative evidence, promotions, skips, and Claude deferrals.
        </div>
      </div>
    );
  }

  const queuedRemaining = queue.pending + queue.in_progress + queue.failed;
  const progressPct = run.enqueued_count > 0
    ? Math.min(100, Math.round((run.processed_count / run.enqueued_count) * 100))
    : 100;
  const skipReasons = Object.entries(run.skip_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const promoted = run.promoted_companies.slice(0, 5);
  const evidence = run.recent_evidence.slice(0, 5);
  const errors = run.recent_errors.slice(0, 4);
  const titleStatus = run.status === 'running'
    ? `Running for ${formatDuration(run.elapsed_seconds)}`
    : `Finished ${run.completed_at ? formatRelative(run.completed_at) : formatRelative(run.updated_at)}`;

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-text-primary">Deal Rebuild</div>
            <ReplayStatusPill status={run.status} />
          </div>
          <div className="text-xs text-text-muted mt-1">
            Conservative replay for the last {run.days_back} days. It only promotes a startup after 4 strong evidence records across at least 2 source families.
          </div>
          {run.last_event && (
            <div className="mt-2 text-xs text-text-secondary">{run.last_event}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right text-[11px] text-text-muted">
            <div>{titleStatus}</div>
            <div>{run.pace_per_minute.toLocaleString()} items/min</div>
          </div>
          {run.status === 'running' && (
            <button
              type="button"
              onClick={cancelReplay}
              disabled={canceling}
              className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-2.5 py-1.5 text-[11px] text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
            >
              <XIcon size={12} /> Cancel
            </button>
          )}
        </div>
      </div>

      <div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${progressPct}%` }} />
        </div>
        <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-text-muted">
          <span>{run.processed_count.toLocaleString()} of {run.enqueued_count.toLocaleString()} candidates processed</span>
          <span>{queuedRemaining.toLocaleString()} still queued or retrying</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        <ReplayMetric label="Scanned" value={run.scanned_count.toLocaleString()} />
        <ReplayMetric label="Strong evidence" value={run.evidence_recorded_count.toLocaleString()} tone="good" />
        <ReplayMetric label="Promoted to New" value={run.promoted_count.toLocaleString()} tone="good" />
        <ReplayMetric label="Skipped" value={run.skipped_count.toLocaleString()} />
        <ReplayMetric label="Claude pauses" value={run.rate_limited_count.toLocaleString()} tone={run.rate_limited_count > 0 ? 'warn' : 'default'} />
        <ReplayMetric label="Errors" value={run.error_count.toLocaleString()} tone={run.error_count > 0 ? 'bad' : 'default'} />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Queue State</div>
          <div className="mt-2 grid grid-cols-5 gap-2 text-center text-[11px]">
            {(['pending', 'in_progress', 'failed', 'dead_letter', 'completed'] as const).map(key => (
              <div key={key} className="rounded-md bg-white/[0.025] px-2 py-1">
                <div className="text-text-primary tabular-nums">{queue[key].toLocaleString()}</div>
                <div className="text-[10px] text-text-muted">{key.replace('_', ' ')}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Skipped Candidates</div>
          {skipReasons.length === 0 ? (
            <div className="mt-2 text-xs text-text-muted">No skipped candidates recorded yet.</div>
          ) : (
            <div className="mt-2 max-h-28 overflow-y-auto pr-1 space-y-1.5">
              {skipReasons.map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-text-secondary">{friendlyReplayReason(reason)}</span>
                  <span className="shrink-0 tabular-nums text-text-muted">{count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Recent Evidence</div>
          {evidence.length === 0 ? (
            <div className="mt-2 text-xs text-text-muted">Strong evidence snippets will appear here as they are recorded.</div>
          ) : (
            <div className="mt-2 max-h-44 overflow-y-auto pr-1 space-y-2">
              {evidence.map((item, idx) => (
                <div key={`${item.company_name}-${item.at}-${idx}`} className="rounded-md bg-white/[0.025] px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-text-primary truncate">{item.company_name}</span>
                    <span className="shrink-0 text-[10px] text-text-muted">{item.source_type}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-muted truncate">
                    {item.source_title || 'Untitled source'}{typeof item.confidence === 'number' ? ` · ${(item.confidence * 100).toFixed(0)}%` : ''}
                  </div>
                  {item.evidence && (
                    <div className="mt-1 text-[11px] leading-relaxed text-text-secondary line-clamp-2">{item.evidence}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Promotions And Issues</div>
          {promoted.length === 0 && errors.length === 0 ? (
            <div className="mt-2 text-xs text-text-muted">Promoted startup cards and replay issues will appear here.</div>
          ) : (
            <div className="mt-2 max-h-44 overflow-y-auto pr-1 space-y-2">
              {promoted.map((item, idx) => (
                <div key={`${item.company_name}-${item.at}-${idx}`} className="rounded-md bg-semantic-success/[0.06] border border-semantic-success/10 px-2 py-1.5">
                  <div className="text-xs font-medium text-semantic-success truncate">{item.company_name}</div>
                  <div className="text-[11px] text-text-muted">Promoted {formatRelative(item.at)}</div>
                </div>
              ))}
              {errors.map((item, idx) => (
                <div key={`${item.error}-${item.at}-${idx}`} className="rounded-md bg-semantic-error/[0.06] border border-semantic-error/10 px-2 py-1.5">
                  <div className="text-xs text-semantic-error line-clamp-2">{item.error}</div>
                  <div className="text-[11px] text-text-muted">{item.source_type || 'source'} · {formatRelative(item.at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-text-primary">All Recorded Evidence</div>
            <div className="mt-0.5 text-[11px] text-text-muted">
              Read-only view of every strong evidence record written by the replay. Loading this does not touch the scan queue.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !evidenceOpen;
              setEvidenceOpen(next);
              if (next && evidenceRows.length === 0) loadEvidence(0);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-white/[0.04]"
          >
            {evidenceOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {evidenceOpen ? 'Hide evidence' : 'Show evidence'}
          </button>
        </div>

        {evidenceOpen && (
          <div className="mt-3">
            {evidenceError && (
              <div className="mb-2 rounded-md border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs text-semantic-error">
                {evidenceError}
              </div>
            )}
            <div className="max-h-96 overflow-y-auto rounded-lg border border-white/[0.04]">
              {evidenceRows.length === 0 && !evidenceLoading ? (
                <div className="p-3 text-xs text-text-muted">No evidence records have been written yet.</div>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {evidenceRows.map(row => (
                    <div key={row.id} className="grid gap-2 p-3 lg:grid-cols-[minmax(150px,220px)_minmax(0,1fr)_auto]">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-text-primary">{row.company_name || 'Unknown company'}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {row.funding_stage && row.funding_stage !== 'unknown' && (
                            <span className="rounded-full bg-accent-magenta/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent-magenta">
                              {row.funding_stage.replace('_', ' ')}
                            </span>
                          )}
                          {row.signal_kind && (
                            <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                              {row.signal_kind}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
                          <span>{row.source_type}</span>
                          <span>·</span>
                          <span className="min-w-0 truncate">{row.source_title || 'Untitled source'}</span>
                          {row.source_date && <span>· {formatRelative(row.source_date)}</span>}
                        </div>
                        {row.evidence_note && (
                          <div className="mt-1 text-xs leading-relaxed text-text-secondary">{row.evidence_note}</div>
                        )}
                        {row.source_excerpt && (
                          <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-muted">{row.source_excerpt}</div>
                        )}
                      </div>
                      <div className="flex items-start justify-between gap-3 lg:block lg:text-right">
                        <div className="text-xs font-medium text-semantic-success">{Math.round(row.confidence * 100)}%</div>
                        <div className="mt-0.5 text-[11px] text-text-muted">{formatRelative(row.created_at)}</div>
                        {row.promoted_at && (
                          <div className="mt-1 text-[10px] text-semantic-success">Promoted</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
              <span>
                Showing {evidenceRows.length.toLocaleString()} of {evidenceTotal.toLocaleString()} evidence records
              </span>
              {evidenceRows.length < evidenceTotal && (
                <button
                  type="button"
                  onClick={() => loadEvidence(evidenceRows.length)}
                  disabled={evidenceLoading}
                  className="rounded-lg border border-white/10 px-2.5 py-1.5 text-text-secondary hover:bg-white/[0.04] disabled:opacity-50"
                >
                  {evidenceLoading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section 4: Work Queue (Phase 5 1c, 2026-05-05) ──────────────────────
//
// Universal work_queue surface. Substrate ships in Phase 5; the registry
// is empty today so this card renders an empty state on every org. First
// pilot domain (Phase 5.1+, likely embed_retry) populates the inventory
// rows; the card auto-renders the per-domain breakdown without needing
// further frontend work — domain name is the row label.
//
// Reads `work_queue_inventory` (per-domain status counts) and
// `stuck_work_queue` (in_progress rows with stale heartbeat). The
// stuck list is rendered as a per-domain badge on the corresponding
// inventory row, NOT as a separate sub-table — that keeps the panel
// dense and operator-actionable: one row per domain, all signals
// co-located.

function WorkQueueCard({
  inventory,
  stuck,
}: {
  inventory: WorkQueueInventoryEntry[];
  stuck: StuckWorkQueueEntry[];
}) {
  // Aggregate inventory by domain. The backend returns one row per
  // (domain, status), so we collapse here for rendering.
  const byDomain = React.useMemo(() => {
    const m = new Map<string, {
      pending: number;
      in_progress: number;
      completed: number;
      failed: number;
      dead_letter: number;
    }>();
    for (const r of inventory) {
      const slot = m.get(r.domain) || { pending: 0, in_progress: 0, completed: 0, failed: 0, dead_letter: 0 };
      slot[r.status] = r.count;
      m.set(r.domain, slot);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [inventory]);

  // Stuck count per domain — surfaced as a red badge on the inventory row.
  const stuckByDomain = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stuck) m.set(s.domain, (m.get(s.domain) || 0) + 1);
    return m;
  }, [stuck]);

  const isEmpty = byDomain.length === 0;

  return (
    <div className="card p-5">
      <div className="text-sm font-medium text-text-primary mb-3">Work Queue</div>
      {isEmpty ? (
        <div className="text-sm text-text-muted">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success mr-2 align-middle" />
          No registered domains. The universal work queue substrate is live;
          domain pilots will populate this panel as they come online.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-text-muted text-left">
                <th className="pb-2 pr-4 font-medium">Domain</th>
                <th className="pb-2 pr-4 font-medium text-right">Pending</th>
                <th className="pb-2 pr-4 font-medium text-right">In progress</th>
                <th className="pb-2 pr-4 font-medium text-right">Dead-letter</th>
                <th className="pb-2 font-medium text-right">Stuck</th>
              </tr>
            </thead>
            <tbody>
              {byDomain.map(([domain, counts]) => {
                const stuckN = stuckByDomain.get(domain) ?? 0;
                return (
                  <tr key={domain} className="border-t border-border/30">
                    <td className="py-2 pr-4 font-mono text-xs text-text-primary">{domain}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-text-primary">
                      {counts.pending.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-text-primary">
                      {counts.in_progress.toLocaleString()}
                    </td>
                    <td className={`py-2 pr-4 text-right tabular-nums ${counts.dead_letter > 0 ? 'text-semantic-error font-medium' : 'text-text-muted'}`}>
                      {counts.dead_letter.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {stuckN > 0 ? (
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold"
                          style={{ background: 'rgba(245,158,11,0.15)', color: '#FCD34D' }}>
                          {stuckN}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {stuck.length > 0 && (
            <div className="text-[10px] text-text-muted mt-3">
              Stuck = in-progress rows with no heartbeat for &gt;10 min. The
              minute-tick watchdog reclaims these on the next sweep; if the
              count persists across refreshes, the handler is genuinely
              degraded and warrants investigation.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IngestionIncidentsCard({ incidents }: { incidents: IngestionIncident[] }) {
  const active = incidents.filter(i => i.status !== 'resolved');
  if (active.length === 0) {
    return (
      <div className="card p-5">
        <div className="flex items-start gap-3">
          <Shield size={18} className="text-semantic-success shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-medium text-text-primary">Ingestion Health</div>
            <div className="text-xs text-text-secondary mt-1">No active ingestion incidents. Source failures and dead letters will surface here automatically.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-5 border-semantic-error/25 bg-semantic-error/[0.03]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Ingestion Incidents</div>
          <div className="text-xs text-text-secondary mt-1">Failures are durable, visible, and repaired automatically unless tenant or mailbox configuration needs operator action.</div>
        </div>
        <span className="rounded-full border border-semantic-error/25 bg-semantic-error/10 px-2 py-1 text-[10px] font-medium text-semantic-error">
          {active.length} active
        </span>
      </div>
      <div className="space-y-2">
        {active.slice(0, 8).map(incident => (
          <div key={incident.id} className="rounded-lg border border-border/60 bg-bg-surface/60 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-text-primary">{incident.title}</div>
              <div className={`text-[10px] font-medium ${incident.severity === 'critical' ? 'text-semantic-error' : 'text-semantic-warning'}`}>
                {incident.status} · {incident.recovery_status.replace(/_/g, ' ')}
              </div>
            </div>
            <div className="mt-1 text-xs text-text-secondary">{incident.message}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-text-muted">
              <span>{incident.source.replace(/_/g, ' ')}</span>
              {incident.scope_id && <span>{incident.scope_type}: {incident.scope_id}</span>}
              <span>last seen {formatRelative(incident.last_seen_at)}</span>
              {incident.recovery_window_start && incident.recovery_window_end && (
                <span>repair window {new Date(incident.recovery_window_start).toLocaleDateString()} → {new Date(incident.recovery_window_end).toLocaleDateString()}</span>
              )}
              {incident.human_action_required === 1 && <span className="text-semantic-error">requires operator action</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutlookAppOnlyHealthCard({ health }: { health: SystemStatusResponse['outlook_app_only_health'] | null | undefined }) {
  if (!health) return null;
  const tone =
    health.status === 'healthy'
      ? { icon: 'text-semantic-success', border: 'border-semantic-success/20', bg: 'bg-semantic-success/[0.03]' }
      : health.status === 'degraded'
        ? { icon: 'text-semantic-warning', border: 'border-semantic-warning/25', bg: 'bg-semantic-warning/[0.04]' }
        : { icon: 'text-semantic-error', border: 'border-semantic-error/25', bg: 'bg-semantic-error/[0.04]' };

  return (
    <div className={`card p-5 ${tone.border} ${tone.bg}`}>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <Mail size={18} className={`${tone.icon} shrink-0 mt-0.5`} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">Outlook App-Only Health</div>
            <div className="text-xs text-text-secondary mt-1">{health.label}: {health.detail}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-[10px] text-text-muted sm:min-w-[260px]">
          <div>
            <div className="text-sm font-medium text-text-primary">{health.summary.healthy_mailboxes}</div>
            healthy
          </div>
          <div>
            <div className="text-sm font-medium text-text-primary">{health.summary.missing_subscriptions + health.summary.expired_subscriptions}</div>
            subscription gaps
          </div>
          <div>
            <div className="text-sm font-medium text-text-primary">{health.summary.stale_delegated_incidents}</div>
            stale legacy
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-text-muted border-b border-border/60">
              <th className="pb-2 pr-3">Mailbox</th>
              <th className="pb-2 pr-3">Graph</th>
              <th className="pb-2 pr-3">Subscriptions</th>
              <th className="pb-2 pr-3">Last email</th>
              <th className="pb-2 pr-3">Calendar</th>
              <th className="pb-2">Queue</th>
            </tr>
          </thead>
          <tbody>
            {health.mailboxes.map(m => {
              const graphOk = m.graph.messages_ok === true && m.graph.calendar_ok === true;
              return (
                <tr key={m.user_id} className="border-b border-border/30 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-text-primary">{m.full_name || m.email || m.user_id}</div>
                    <div className="text-text-muted">{m.mailbox || 'No mailbox target'}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={graphOk ? 'text-semantic-success' : m.graph.checked_at ? 'text-semantic-error' : 'text-text-muted'}>
                      {graphOk ? 'Passing' : m.graph.checked_at ? 'Failing' : 'Not checked'}
                    </span>
                    {m.graph.error && <div className="max-w-[220px] truncate text-text-muted">{m.graph.error}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={m.subscriptions.current.length === m.subscriptions.expected.length ? 'text-semantic-success' : 'text-semantic-warning'}>
                      {m.subscriptions.current.length}/{m.subscriptions.expected.length} current
                    </span>
                    {(m.subscriptions.missing.length > 0 || m.subscriptions.expired.length > 0 || m.subscriptions.legacy.length > 0) && (
                      <div className="text-text-muted">
                        {m.subscriptions.missing.length} missing · {m.subscriptions.expired.length} expired · {m.subscriptions.legacy.length} legacy
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-text-muted">
                    {m.last_email_ingested_at ? formatRelative(m.last_email_ingested_at) : 'No evidence'}
                  </td>
                  <td className="py-2 pr-3 text-text-muted">
                    {m.last_calendar_success_at ? formatRelative(m.last_calendar_success_at) : 'No sync evidence'}
                  </td>
                  <td className="py-2 text-text-muted">
                    {m.pending_work} pending · {m.dead_letter_work} dead-lettered
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Section 1: Active Tasks ──────────────────────────────────────────────

function RateLimitIndicator({ budgets }: { budgets: BudgetSnapshotRow[] }) {
  const limited = React.useMemo(() => {
    const now = Date.now();
    return budgets.filter(b => {
      const openUntil = b.circuit_open_until ? new Date(b.circuit_open_until).getTime() : 0;
      const circuitActuallyOpen = b.circuit_open === true && openUntil > now;
      const hardCapHit = b.cap > 0 && b.used >= b.cap && b.consecutive_429s > 0;
      return circuitActuallyOpen || hardCapHit;
    });
  }, [budgets]);

  if (limited.length === 0) return null;
  const primary = limited[0];
  const resetText = primary.circuit_open_until ? ` until ${formatRelative(primary.circuit_open_until)}` : '';

  return (
    <div className="card p-4 border-semantic-warning/30 bg-semantic-warning/[0.04]">
      <div className="flex items-start gap-3">
        <Shield size={18} className="text-semantic-warning shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">Upstream rate limit active</div>
          <div className="text-xs text-text-secondary mt-1">
            {primary.upstream} is limiting requests{resetText}. MARTy will recover automatically when the circuit closes.
          </div>
          {limited.length > 1 && (
            <div className="text-[11px] text-text-muted mt-1">
              {limited.length - 1} other upstream budget{limited.length === 2 ? '' : 's'} also constrained.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function friendlyTaskType(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('webhook')) return 'Processing fresh Outlook updates';
  if (lower.includes('progressive') || lower.includes('backfill')) return 'Backfilling historical data';
  if (lower.includes('ingestion')) return 'Syncing email, calendar, Slack, and news';
  if (lower.includes('enrich')) return 'Enriching CRM records';
  if (lower.includes('embed')) return 'Indexing searchable knowledge';
  if (lower.includes('news')) return 'Refreshing market news';
  return type.replace(/[_-]+/g, ' ');
}

function summarizeActiveTasks(tasks: SystemStatusActiveTask[]) {
  const grouped = new Map<string, {
    label: string;
    count: number;
    processed: number;
    longest: number;
    latestStarted: string;
  }>();
  for (const t of tasks) {
    const label = friendlyTaskType(t.type);
    const existing = grouped.get(label) || {
      label,
      count: 0,
      processed: 0,
      longest: 0,
      latestStarted: t.started_at,
    };
    existing.count += 1;
    existing.processed += t.items_processed || 0;
    existing.longest = Math.max(existing.longest, t.elapsed_seconds || 0);
    if (new Date(t.started_at).getTime() > new Date(existing.latestStarted).getTime()) {
      existing.latestStarted = t.started_at;
    }
    grouped.set(label, existing);
  }
  return Array.from(grouped.values()).sort((a, b) => b.longest - a.longest);
}

function ActiveTasksCard({ tasks }: { tasks: SystemStatusActiveTask[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const summaries = React.useMemo(() => summarizeActiveTasks(tasks), [tasks]);
  const moving = summaries.filter(t => t.processed > 0);
  const stalled = summaries.filter(t => t.processed === 0 && t.longest >= 30 * 60);
  const warming = summaries.filter(t => t.processed === 0 && t.longest < 30 * 60);
  const totalProcessed = moving.reduce((acc, t) => acc + t.processed, 0);
  const visible = expanded ? [...moving, ...stalled, ...warming] : [...moving, ...stalled].slice(0, 3);
  const hasDataMovingWork = moving.length > 0;
  const zeroOnlyWork = tasks.length > 0 && !hasDataMovingWork;

  return (
    <div className="card p-5">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div>
          <div className="text-sm font-medium text-text-primary">Active Work</div>
          <div className="text-xs text-text-muted mt-0.5">
            {tasks.length === 0
              ? 'No active background jobs'
              : hasDataMovingWork
                ? `${totalProcessed.toLocaleString()} item${totalProcessed === 1 ? '' : 's'} moving now · ${tasks.length} background job${tasks.length === 1 ? '' : 's'} tracked`
                : `No data-moving work right now · ${tasks.length} bookkeeping job${tasks.length === 1 ? '' : 's'} tracked`}
          </div>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-text-muted">
          {tasks.length > 0 && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success animate-pulse" />
          )}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {tasks.length === 0 ? (
        <div className="text-sm text-text-muted mt-3">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success mr-2 align-middle" />
          No active tasks. Next email sync at <span className="text-text-primary">:00</span>, next enrichment at <span className="text-text-primary">:05</span>.
        </div>
      ) : (
        <div className={`mt-4 overflow-hidden transition-all duration-200 ${expanded ? 'max-h-96 opacity-100' : 'max-h-32 opacity-100'}`}>
          <div className="rounded-lg bg-white/[0.025] border border-white/[0.04] p-3 mb-3">
            <div className="text-xs text-text-secondary leading-relaxed">
              Active Work shows background jobs the system has marked as running. Zeros usually mean bookkeeping, startup, or a stale backfill window, not missing customer data. This panel highlights data that is actually moving and separates stale zero-work rows.
            </div>
          </div>

          {zeroOnlyWork && (
            <div className={`rounded-lg px-3 py-2 mb-3 border ${
              stalled.length > 0
                ? 'bg-semantic-warning/[0.06] border-semantic-warning/20'
                : 'bg-white/[0.025] border-white/[0.04]'
            }`}>
              <div className="text-sm text-text-primary">
                {stalled.length > 0 ? 'No records are moving; some job rows look stale.' : 'Background jobs are warming up.'}
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">
                {stalled.length > 0
                  ? `${stalled.reduce((acc, t) => acc + t.count, 0).toLocaleString()} zero-work job row${stalled.reduce((acc, t) => acc + t.count, 0) === 1 ? '' : 's'} have been marked running for more than 30 minutes.`
                  : `${warming.reduce((acc, t) => acc + t.count, 0).toLocaleString()} job row${warming.reduce((acc, t) => acc + t.count, 0) === 1 ? '' : 's'} have not reported processed items yet.`}
              </div>
            </div>
          )}

          <div className={`space-y-2 ${expanded ? 'max-h-56 overflow-y-auto pr-1' : ''}`}>
            {visible.map(t => {
              const isStalled = t.processed === 0 && t.longest >= 30 * 60;
              const isWarming = t.processed === 0 && !isStalled;
              return (
                <div key={t.label} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                  isStalled
                    ? 'bg-semantic-warning/[0.04] border-semantic-warning/15'
                    : 'bg-white/[0.025] border-white/[0.04]'
                }`}>
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary truncate">{t.label}</div>
                    <div className="text-[11px] text-text-muted">
                      {t.count > 1 ? `${t.count} rows · ` : ''}
                      {isStalled ? 'stale zero-work row' : isWarming ? 'waiting to report work' : 'actively processing'} · {formatDuration(t.longest)}
                    </div>
                  </div>
                  <div className="text-right shrink-0 min-w-[88px]">
                    <div className={`text-sm tabular-nums ${t.processed > 0 ? 'text-text-primary' : 'text-text-muted'}`}>
                      {t.processed > 0 ? t.processed.toLocaleString() : 'No records'}
                    </div>
                    <div className="text-[10px] text-text-muted">{t.processed > 0 ? 'processed' : 'moved'}</div>
                  </div>
                </div>
              );
            })}
            {!expanded && [...moving, ...stalled].length > visible.length && (
              <div className="text-[11px] text-text-muted px-1">
                {[...moving, ...stalled].length - visible.length} more signal row{[...moving, ...stalled].length - visible.length === 1 ? '' : 's'} hidden. Expand to inspect.
              </div>
            )}
            {expanded && warming.length > 0 && (
              <div className="text-[11px] text-text-muted px-1">
                Warming rows are shown last because they have not yet moved records.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section 2: Run History ───────────────────────────────────────────────

function isZeroNoiseRun(row: SystemStatusRunHistoryEntry): boolean {
  return row.status === 'completed' && row.items_processed === 0 && row.items_failed === 0 && !row.error_message;
}

function isAttentionRun(row: SystemStatusRunHistoryEntry): boolean {
  return row.status !== 'completed' || row.items_failed > 0 || !!row.error_message;
}

function RunHistoryCard({ rows }: { rows: SystemStatusRunHistoryEntry[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const attentionRows = rows.filter(isAttentionRun);
  const meaningfulRows = rows.filter(r => !isZeroNoiseRun(r) && !isAttentionRun(r));
  const zeroNoiseCount = rows.length - attentionRows.length - meaningfulRows.length;
  const latestMeaningful = [...attentionRows, ...meaningfulRows].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  )[0];
  const orderedRows = [...attentionRows, ...meaningfulRows].sort(
    (a, b) => Number(isAttentionRun(b)) - Number(isAttentionRun(a)) || new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );
  const visibleRows = expanded ? orderedRows : orderedRows.slice(0, 4);

  return (
    <div className="card p-5 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div>
          <div className="text-sm font-medium text-text-primary">Run History</div>
          <div className="text-xs text-text-muted mt-0.5">
            {latestMeaningful
              ? `Latest signal: ${latestMeaningful.type} · ${latestMeaningful.items_processed.toLocaleString()} processed · ${formatRelative(latestMeaningful.started_at)}`
              : 'No runs recorded yet'}
            {attentionRows.length > 0 ? ` · ${attentionRows.length} need attention` : ''}
          </div>
        </div>
        {rows.length > 0 && (
          <span className="text-text-muted">{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        )}
      </button>
      {rows.length === 0 ? (
        <div className="mt-3 text-sm text-text-muted">No runs recorded yet.</div>
      ) : (
        <div className="mt-4">
          <div className="rounded-lg bg-white/[0.025] border border-white/[0.04] p-3 mb-3">
            <div className="text-xs text-text-secondary leading-relaxed">
              Run History shows recent background runs after they finish. Completed rows with 0 processed are usually health checks, webhooks with no eligible records, or cleanup passes, so they are hidden unless you expand.
            </div>
            {zeroNoiseCount > 0 && (
              <div className="text-[11px] text-text-muted mt-1">
                {zeroNoiseCount} zero-record bookkeeping run{zeroNoiseCount === 1 ? '' : 's'} hidden from the main view.
              </div>
            )}
          </div>
          {visibleRows.length === 0 ? (
            <div className="rounded-lg bg-white/[0.025] border border-white/[0.04] px-3 py-2 text-sm text-text-secondary">
              Only bookkeeping runs finished recently. Nothing needs attention.
            </div>
          ) : (
            <div className={`space-y-2 ${expanded ? 'max-h-80 overflow-y-auto pr-1' : ''}`}>
              {visibleRows.map(r => <RunHistoryRow key={r.id} row={r} />)}
            </div>
          )}
          {!expanded && orderedRows.length > visibleRows.length && (
            <div className="mt-2 text-[11px] text-text-muted px-1">
              {orderedRows.length - visibleRows.length} more meaningful run{orderedRows.length - visibleRows.length === 1 ? '' : 's'} hidden. Expand to scroll.
            </div>
          )}
          {expanded && zeroNoiseCount > 0 && (
            <div className="mt-2 text-[11px] text-text-muted px-1">
              Hidden zero-record runs are omitted here too so this panel stays focused on failures and real throughput.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunHistoryRow({ row }: { row: SystemStatusRunHistoryEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const attention = isAttentionRun(row);
  const processedLabel = row.items_processed > 0
    ? `${row.items_processed.toLocaleString()} processed`
    : 'No records moved';
  return (
    <div className={`rounded-lg border px-3 py-2 ${
      attention ? 'bg-semantic-error/[0.045] border-semantic-error/15' : 'bg-white/[0.025] border-white/[0.04]'
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm text-text-primary truncate">{row.type}</div>
            <StatusBadge status={row.status} />
          </div>
          <div className="text-[11px] text-text-muted mt-1 flex flex-wrap gap-x-2 gap-y-1">
            <span>{processedLabel}</span>
            {row.items_failed > 0 && <span className="text-semantic-error">{row.items_failed.toLocaleString()} failed</span>}
            <span>{formatRelative(row.started_at)}</span>
            <span>{row.duration_seconds === 0 ? 'instant' : formatDuration(row.duration_seconds)}</span>
          </div>
        </div>
        {row.error_message && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="shrink-0 text-[11px] text-semantic-error hover:underline"
          >
            {expanded ? 'Hide error' : 'Show error'}
          </button>
        )}
      </div>
      {row.error_message && expanded && (
        <div className="mt-2 rounded-md bg-semantic-error/10 border border-semantic-error/15 px-2 py-1.5 text-xs text-semantic-error leading-relaxed">
          {row.error_message}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SystemStatusRunHistoryEntry['status'] }) {
  const cfg = {
    completed: { bg: 'bg-semantic-success/15', fg: 'text-semantic-success', label: 'Completed' },
    failed:    { bg: 'bg-semantic-error/15',   fg: 'text-semantic-error',   label: 'Failed' },
    timed_out: { bg: 'bg-semantic-warning/15', fg: 'text-semantic-warning', label: 'Timed out' },
  }[status];
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${cfg.bg} ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

// ── Section 3: Data Completeness ─────────────────────────────────────────

function DataCompletenessCard({ c }: { c: SystemStatusResponse['completeness'] }) {
  return (
    <div className="card p-5 space-y-5">
      <div>
        <div className="text-sm font-medium text-text-primary">Data Completeness</div>
        <div className="text-xs text-text-muted mt-0.5">
          How much of your data is captured, connected, and searchable.
        </div>
      </div>

      <CompletenessGroup title="Email Coverage">
        <CompletenessBar
          label="embedded"
          metric={c.email_embedding}
          unit="conversations searchable by MARTy"
          warningHint="Some emails were ingested before embedding was wired up — they're stored but not retrievable. A backfill would re-embed them."
        />
        <CompletenessBar
          label="linked"
          metric={c.email_linkage}
          unit="connected to contacts"
          warningHint="Some emails couldn't be linked to a contact — likely auto-generated, no-reply, or from senders not in the CRM."
        />
      </CompletenessGroup>

      <CompletenessGroup title="Document Coverage">
        <CompletenessBar
          label="embedded"
          metric={c.document_embedding}
          unit="documents searchable by MARTy"
          warningHint="Unembedded documents are stored and preview/downloadable, but MARTy's semantic retrieval is weaker until the document self-healer processes them."
        />
      </CompletenessGroup>

      <CompletenessGroup title="Contact Coverage">
        <CompletenessBar
          label="enriched"
          metric={c.contact_enrichment}
          unit="contacts have enrichment data"
          warningHint="Unenriched contacts are missing bio, title, or LinkedIn data. The enrichment cron picks them up over time."
        />
        <CompletenessBar
          label="have company"
          metric={c.contact_company}
          unit="linked to a company"
          warningHint="Contacts without a company are usually personal-domain emails (gmail.com, etc.) or first-time meeting attendees."
        />
        <CompletenessBar
          label="have LinkedIn"
          metric={c.contact_linkedin}
          unit="have a LinkedIn URL"
          warningHint="LinkedIn discovery only runs during enrichment. Many contacts won't have a discoverable profile (privacy settings, generic names, etc.)."
        />
      </CompletenessGroup>

      <CompletenessGroup title="Company Coverage">
        <CompletenessBar
          label="enriched"
          metric={c.company_enrichment}
          unit="companies have enrichment data"
        />
        <CompletenessBar
          label="have LinkedIn"
          metric={c.company_linkedin}
          unit="companies have a LinkedIn URL"
          warningHint="Company enrichment doesn't currently resolve LinkedIn URLs — only contact-level enrichment does. Worth a separate pass."
        />
      </CompletenessGroup>

      <CompletenessGroup title="Meeting Coverage">
        <CompletenessBar
          label="embedded"
          metric={c.meeting_embedding}
          unit="meetings searchable by MARTy"
        />
        <CompletenessBar
          label="attendees linked"
          metric={c.meeting_attendees}
          unit="attendees connected to contacts or users"
          warningHint="Unlinked attendees are real people Firefly captured but no contact exists for them yet — auto-create runs on each new meeting going forward."
        />
      </CompletenessGroup>

      <ConnectedUsersBar metric={c.connected_users} />
    </div>
  );
}

function CompletenessGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-text-muted mb-2">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function completenessColor(label: string, pct: number): string {
  if (label.toLowerCase().includes('linkedin')) return '#60A5FA';
  if (pct >= 95) return '#22C55E';
  if (pct >= 80) return '#6B8F71';
  if (pct >= 50) return '#F59E0B';
  return '#EF4444';
}

function CompletenessBar({
  label, metric, unit, warningHint,
}: { label: string; metric: CompletenessMetric; unit: string; warningHint?: string }) {
  const pct = metric.percentage;
  const color = completenessColor(label, pct);
  const showHint = pct < 95 && warningHint;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-text-primary tabular-nums font-medium" style={{ color }}>{pct}% {label}</span>
        <span className="text-text-muted">
          {metric.current.toLocaleString()} of {metric.total.toLocaleString()} {unit}
        </span>
      </div>
      <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: color,
            transition: 'width 600ms ease-out, background 400ms ease-out',
          }}
        />
      </div>
      {showHint && (
        <div className="text-[11px] text-text-muted mt-1">{warningHint}</div>
      )}
    </div>
  );
}

function ConnectedUsersBar({ metric }: { metric: CompletenessMetric & { names_missing: string[] } }) {
  const pct = metric.percentage;
  const color =
    pct >= 95 ? '#22C55E' :
    pct >= 80 ? '#6B8F71' :
    pct >= 50 ? '#F59E0B' :
    '#EF4444';
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Connected Users</div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-text-primary tabular-nums font-medium" style={{ color }}>
          {metric.current} of {metric.total} users have Outlook connected
        </span>
      </div>
      <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: color, transition: 'width 600ms ease-out' }}
        />
      </div>
      {metric.names_missing.length > 0 && (
        <div className="text-[11px] text-text-muted mt-1">
          Missing: {metric.names_missing.join(', ')}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
