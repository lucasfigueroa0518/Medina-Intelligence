import type { Env } from '../types/env';
import { callClaude } from './claude';
import { truncateToTokens } from './tokens';
import { hashShort } from './helpers';
import {
  TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT,
  TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
} from '../prompts/transcript-extraction';

export interface ContactSignal {
  speaker: string;
  entity_identifier: string;
  field: string;
  value: string;
  confidence: number;
  evidence: string;
}

export interface CompanySignal {
  speaker: string;
  company_name: string;
  signal_type: string;
  value: string;
  confidence: number;
  evidence: string;
}

export interface DealSignal {
  speaker: string;
  company_name: string;
  signal_type: string;
  value: string;
  confidence: number;
  evidence: string;
}

export interface RelationshipSignal {
  speaker: string;
  signal_type: string;
  people_involved: string[];
  value: string;
  confidence: number;
  evidence: string;
}

export interface TranscriptSignals {
  contact_signals: ContactSignal[];
  company_signals: CompanySignal[];
  deal_signals: DealSignal[];
  relationship_signals: RelationshipSignal[];
}

function parseTranscriptSignals(response: string): TranscriptSignals {
  const empty: TranscriptSignals = {
    contact_signals: [],
    company_signals: [],
    deal_signals: [],
    relationship_signals: [],
  };

  try {
    const cleaned = response
      .trim()
      .replace(/```json\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : cleaned);

    return {
      contact_signals: Array.isArray(parsed.contact_signals)
        ? parsed.contact_signals.filter((s: any) => s && s.confidence >= 0.7)
        : [],
      company_signals: Array.isArray(parsed.company_signals)
        ? parsed.company_signals.filter((s: any) => s && s.confidence >= 0.7)
        : [],
      deal_signals: Array.isArray(parsed.deal_signals)
        ? parsed.deal_signals.filter((s: any) => s && s.confidence >= 0.7)
        : [],
      relationship_signals: Array.isArray(parsed.relationship_signals)
        ? parsed.relationship_signals.filter((s: any) => s && s.confidence >= 0.7)
        : [],
    };
  } catch {
    return empty;
  }
}

export async function extractTranscriptSignals(
  transcriptText: string,
  meetingTitle: string,
  participants: Array<{ name: string; email?: string }>,
  orgId: string,
  env: Env
): Promise<TranscriptSignals> {
  const participantList = participants
    .map(p => p.email ? `${p.name} (${p.email})` : p.name)
    .join(', ');

  const userPrompt = `Meeting: ${meetingTitle}
Participants: ${participantList}

Transcript:
${truncateToTokens(transcriptText, 6000)}`;

  const response = await callClaude(
    {
      system: TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT,
      user: userPrompt,
      max_tokens: 3000,
      orgId,
    },
    'low',
    env
  );

  return parseTranscriptSignals(response);
}

export async function generateMeetingSummary(
  transcriptText: string,
  meetingTitle: string,
  startTime: string,
  participants: Array<{ name: string; email?: string }>,
  orgId: string,
  env: Env
): Promise<string> {
  const participantList = participants
    .map(p => p.email ? `${p.name} (${p.email})` : p.name)
    .join(', ');

  const userPrompt = `Meeting title: ${meetingTitle}
Date: ${startTime}
Participants: ${participantList}

Full transcript:
${truncateToTokens(transcriptText, 5000)}`;

  return callClaude(
    {
      system: TRANSCRIPT_SUMMARY_SYSTEM_PROMPT,
      user: userPrompt,
      max_tokens: 1500,
      orgId,
    },
    'low',
    env
  );
}
