import type { Env } from '../types/env';
import type { Upstream } from './upstream-budget';

export const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const CLAUDE_SONNET_MODEL = 'claude-sonnet-4-6';
export const CLAUDE_OPUS_MODEL = 'claude-opus-4-7';

export type ClaudeModelTier = 'haiku' | 'sonnet' | 'opus' | 'other';
export type QualityExceptionClaudeRole =
  | 'document_extraction'
  | 'artifact_planning'
  | 'transcript_extraction';

export function resolveDefaultClaudeModel(): string {
  return CLAUDE_HAIKU_MODEL;
}

export function resolveMartyNormalModel(env: Env): string {
  return env.MARTY_NORMAL_MODEL || CLAUDE_SONNET_MODEL;
}

export function resolveMartyMaxModel(env: Env): string {
  return env.MARTY_MAX_MODEL || CLAUDE_OPUS_MODEL;
}

export function resolveQualityExceptionClaudeModel(
  _env: Env,
  _role: QualityExceptionClaudeRole,
): string {
  return CLAUDE_SONNET_MODEL;
}

export function classifyClaudeModel(model: string): ClaudeModelTier {
  const normalized = model.toLowerCase();
  if (normalized.includes('haiku')) return 'haiku';
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('opus')) return 'opus';
  return 'other';
}

export function budgetUpstreamForClaudeModel(
  model: string,
): Extract<Upstream, 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus' | 'claude'> {
  switch (classifyClaudeModel(model)) {
    case 'haiku':
      return 'anthropic_haiku';
    case 'sonnet':
      return 'anthropic_sonnet';
    case 'opus':
      return 'anthropic_opus';
    default:
      return 'claude';
  }
}
