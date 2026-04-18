// TRD §4.2 — Chunk config registry + RecursiveCharacterTextSplitter + speaker-turn-aware chunking
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { estimateTokens } from './tokens';
import type { SpeakerTurn, TranscriptChunk } from '../types/interfaces';

export interface ChunkConfig {
  size: number;
  overlap?: number;
  overlapTurns?: number | 'dynamic';
  splitter: 'recursive' | 'speaker_turn';
}

export const CHUNK_CONFIGS: Record<string, Record<string, ChunkConfig>> = {
  v1: {
    email: { size: 384, overlap: 50, splitter: 'recursive' },
    transcript: { size: 1024, overlap: 150, splitter: 'recursive' },
    pdf: { size: 768, overlap: 100, splitter: 'recursive' },
    csv: { size: 256, overlap: 25, splitter: 'recursive' },
    news: { size: 512, overlap: 50, splitter: 'recursive' },
  },
  v2: {
    email: { size: 384, overlap: 50, splitter: 'recursive' },
    transcript: { size: 1024, overlapTurns: 'dynamic', splitter: 'speaker_turn' },
    pdf: { size: 768, overlap: 100, splitter: 'recursive' },
    csv: { size: 256, overlap: 25, splitter: 'recursive' },
    news: { size: 512, overlap: 50, splitter: 'recursive' },
    conversation: { size: 384, overlap: 50, splitter: 'recursive' },
    document: { size: 768, overlap: 100, splitter: 'recursive' },
    enrichment: { size: 512, overlap: 50, splitter: 'recursive' },
  },
};

export const CURRENT_CHUNK_VERSION = 'v2';

export function createSplitter(docType: string): RecursiveCharacterTextSplitter {
  const cfg = CHUNK_CONFIGS[CURRENT_CHUNK_VERSION][docType] || CHUNK_CONFIGS.v2.document;
  return new RecursiveCharacterTextSplitter({
    chunkSize: cfg.size,
    chunkOverlap: cfg.overlap || 0,
    separators: ['\n\n', '\n', '. ', '! ', '? ', ' ', ''],
  });
}

// --- Speaker-turn-aware transcript chunking ---

export function determineOverlapTurns(turns: SpeakerTurn[]): number {
  if (turns.length === 0) return 1;
  const uniqueSpeakers = new Set(turns.map(t => t.speaker)).size;
  const totalDurationMs =
    turns[turns.length - 1].timestamp && turns[0].timestamp
      ? new Date(turns[turns.length - 1].timestamp!).getTime() -
        new Date(turns[0].timestamp!).getTime()
      : 0;

  if (totalDurationMs === 0) {
    return uniqueSpeakers > 4 ? 3 : uniqueSpeakers > 2 ? 2 : 1;
  }

  const durationMinutes = totalDurationMs / (1000 * 60);
  const changesPerTenMin = (turns.length / durationMinutes) * 10;

  if (changesPerTenMin > 20) return 3;
  if (changesPerTenMin > 10) return 2;
  return 1;
}

export function chunkTranscriptBySpeakerTurns(
  turns: SpeakerTurn[],
  maxChunkTokens = 1024,
  overlapTurns = 1
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let currentTurns: SpeakerTurn[] = [];
  let currentTokens = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const turnPrefix = `[${turn.speaker} | ${turn.affiliation}]: `;
    const turnTokens = estimateTokens(turn.text) + estimateTokens(turnPrefix);

    if (turnTokens > maxChunkTokens) {
      if (currentTurns.length > 0) {
        chunks.push(buildChunkFromTurns(currentTurns));
        currentTurns = [];
        currentTokens = 0;
      }

      const sentences = turn.text.match(/[^.!?]+[.!?]+/g) || [turn.text];
      let sentenceBuffer = '';
      let sentenceTokens = 0;

      for (const sentence of sentences) {
        const sTokens = estimateTokens(sentence);
        if (
          sentenceTokens + sTokens + estimateTokens(turnPrefix) > maxChunkTokens &&
          sentenceBuffer
        ) {
          chunks.push({
            text: `${turnPrefix}${sentenceBuffer.trim()}`,
            speakers: [turn.speaker],
            primary_speaker: turn.speaker,
            start_timestamp: turn.timestamp,
          });
          sentenceBuffer = '';
          sentenceTokens = 0;
        }
        sentenceBuffer += sentence;
        sentenceTokens += sTokens;
      }

      if (sentenceBuffer.trim()) {
        currentTurns = [{ ...turn, text: sentenceBuffer.trim() }];
        currentTokens = sentenceTokens + estimateTokens(turnPrefix);
      }
      continue;
    }

    if (currentTokens + turnTokens > maxChunkTokens && currentTurns.length > 0) {
      chunks.push(buildChunkFromTurns(currentTurns));

      const overlapStart = Math.max(0, currentTurns.length - overlapTurns);
      const overlapSlice = currentTurns.slice(overlapStart);
      currentTurns = [...overlapSlice];
      currentTokens = overlapSlice.reduce(
        (sum, t) => sum + estimateTokens(`[${t.speaker} | ${t.affiliation}]: ${t.text}`),
        0
      );
    }

    currentTurns.push(turn);
    currentTokens += turnTokens;
  }

  if (currentTurns.length > 0) {
    chunks.push(buildChunkFromTurns(currentTurns));
  }

  return chunks;
}

export function buildChunkFromTurns(turns: SpeakerTurn[]): TranscriptChunk {
  const text = turns
    .map(t => `[${t.speaker} | ${t.affiliation}]: ${t.text}`)
    .join('\n\n');

  const speakerTokens = new Map<string, number>();
  for (const t of turns) {
    speakerTokens.set(
      t.speaker,
      (speakerTokens.get(t.speaker) || 0) + estimateTokens(t.text)
    );
  }
  const sorted = [...speakerTokens.entries()].sort((a, b) => b[1] - a[1]);
  const primarySpeaker = sorted.length > 0 ? sorted[0][0] : '';

  return {
    text,
    speakers: [...new Set(turns.map(t => t.speaker))],
    primary_speaker: primarySpeaker,
    start_timestamp: turns[0]?.timestamp,
    end_timestamp: turns[turns.length - 1]?.timestamp,
  };
}
