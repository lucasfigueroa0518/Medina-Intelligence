// TRD §4.2 — Chunk config registry + RecursiveCharacterTextSplitter + speaker-turn-aware chunking
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { estimateTokens } from './tokens';
import type { SpeakerTurn, TranscriptChunk } from '../types/interfaces';
import type { ChunkingProfile, RagV2Chunk } from '../types/rag-v2';

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
export const RAG_V2_CHUNK_VERSION = 'v3';
export const RAG_V2_PREFIX_BUDGET_TOKENS = 80;

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

// --- RAG V2 model-aware chunking ---

const SECTION_HEADING_RE =
  /^(#{1,6}\s+.+|[A-Z][A-Z0-9 .,&:/()'-]{6,}|(?:\d+\.|\d+\.\d+\.|[IVX]+\.)\s+.+)$/;

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function splitParagraphs(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
}

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4 || trimmed.length > 140) return false;
  if (trimmed.endsWith('.')) return false;
  return SECTION_HEADING_RE.test(trimmed);
}

function splitSections(text: string): Array<{ path: string; text: string }> {
  const sections: Array<{ path: string; text: string }> = [];
  let currentPath = 'Document';
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ path: currentPath, text: body });
    buffer = [];
  };

  for (const rawLine of normalizeWhitespace(text).split('\n')) {
    const line = rawLine.trim();
    if (isHeading(line)) {
      flush();
      currentPath = line.replace(/^#{1,6}\s+/, '').trim();
    } else {
      buffer.push(rawLine);
    }
  }
  flush();
  return sections.length > 0 ? sections : [{ path: currentPath, text: normalizeWhitespace(text) }];
}

function overlapTail(text: string, overlapTokens: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= overlapTokens) return text;
  return words.slice(-overlapTokens).join(' ');
}

function hardSplitLongParagraph(text: string, maxTokens: number, overlapTokens: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    const approxChars = Math.max(240, maxTokens * 4);
    const overlapChars = Math.min(Math.floor(approxChars / 5), overlapTokens * 4);
    const chunks: string[] = [];
    for (let start = 0; start < text.length; start += Math.max(1, approxChars - overlapChars)) {
      chunks.push(text.slice(start, start + approxChars));
    }
    return chunks.filter(Boolean);
  }

  const maxWords = Math.max(24, Math.floor(maxTokens * 0.75));
  const overlapWords = Math.min(Math.floor(maxWords / 3), Math.max(0, overlapTokens));
  const step = Math.max(1, maxWords - overlapWords);
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + maxWords).join(' '));
  }
  return chunks.filter(Boolean);
}

function packParagraphs(
  paragraphs: string[],
  maxTokens: number,
  overlapTokens: number
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    const text = current.join('\n\n').trim();
    if (text) chunks.push(text);
    current = [];
    currentTokens = 0;
    return text;
  };

  for (const paragraph of paragraphs) {
    const pTokens = estimateTokens(paragraph);
    if (pTokens > maxTokens) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+|\S[\s\S]{0,260}(?=\s|$)/g) || [paragraph];
      const parts = sentences.map(s => s.trim()).filter(Boolean);
      const packed = parts.length === 1 && parts[0] === paragraph
        ? hardSplitLongParagraph(paragraph, maxTokens, overlapTokens)
        : packParagraphs(parts, maxTokens, overlapTokens);
      if (current.length > 0) {
        const previous = flush();
        if (previous && overlapTokens > 0) current = [overlapTail(previous, overlapTokens)];
      }
      chunks.push(...packed);
      continue;
    }

    if (current.length > 0 && currentTokens + pTokens > maxTokens) {
      const previous = flush();
      if (previous && overlapTokens > 0) {
        const tail = overlapTail(previous, overlapTokens);
        current = [tail];
        currentTokens = estimateTokens(tail);
      }
    }

    current.push(paragraph);
    currentTokens += pTokens;
  }

  flush();
  return chunks;
}

function looksTabular(text: string, docType: string): boolean {
  if (docType === 'csv' || docType === 'spreadsheet' || docType === 'financials') return true;
  const lines = text.split('\n').slice(0, 20);
  const structured = lines.filter(line => {
    const commas = (line.match(/,/g) || []).length;
    const tabs = (line.match(/\t/g) || []).length;
    const pipes = (line.match(/\|/g) || []).length;
    return commas >= 3 || tabs >= 2 || pipes >= 2;
  });
  return structured.length >= Math.min(5, Math.max(2, lines.length / 2));
}

function chunkTableText(text: string, maxTokens: number): RagV2Chunk[] {
  const lines = normalizeWhitespace(text).split('\n').filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0];
  const rows = lines.slice(1);
  const chunks: string[] = [];
  let current = header;

  for (const row of rows) {
    const candidate = `${current}\n${row}`;
    if (estimateTokens(candidate) > maxTokens && current !== header) {
      chunks.push(current);
      current = `${header}\n${row}`;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current);
  return finalizeRagV2Chunks(chunks, 'Table', undefined);
}

export function extractExactTerms(text: string): string[] {
  const terms = new Set<string>();
  const patterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi,
    /\$[A-Z]{1,5}\b/g,
    /\b[A-Z]{2,8}\b/g,
    /\b\d+(?:\.\d+)?%?\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.match(pattern) || []) terms.add(match);
  }
  return [...terms].slice(0, 40);
}

function finalizeRagV2Chunks(
  texts: string[],
  sectionPath: string,
  title?: string
): RagV2Chunk[] {
  const total = texts.length;
  return texts.map((text, index) => ({
    text,
    title,
    sectionPath,
    chunkIndex: index,
    totalChunks: total,
    exactTerms: extractExactTerms(text),
  }));
}

export function chunkTextForRagV2(
  text: string,
  documentType: string,
  profile: ChunkingProfile
): RagV2Chunk[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized || estimateTokens(normalized) < 3) return [];

  const maxTokens = Math.max(64, profile.maxContentTokens);
  if (looksTabular(normalized, documentType)) {
    return chunkTableText(normalized, maxTokens);
  }

  if (documentType === 'transcript') {
    const turns = normalized
      .split('\n')
      .map(line => line.match(/^([^:]{2,80}):\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map(m => ({ speaker: m[1].trim(), affiliation: 'External', text: m[2].trim() }));
    if (turns.length >= 3) {
      const transcriptChunks = chunkTranscriptBySpeakerTurns(
        turns,
        maxTokens,
        determineOverlapTurns(turns)
      );
      return transcriptChunks.map((chunk, index) => ({
        text: chunk.text,
        sectionPath: chunk.primary_speaker ? `Speaker: ${chunk.primary_speaker}` : 'Transcript',
        chunkIndex: index,
        totalChunks: transcriptChunks.length,
        exactTerms: extractExactTerms(chunk.text),
      }));
    }
  }

  const overlapTokens = Math.min(80, Math.max(20, Math.floor(maxTokens * 0.12)));
  const result: RagV2Chunk[] = [];
  for (const section of splitSections(normalized)) {
    const packed = packParagraphs(splitParagraphs(section.text), maxTokens, overlapTokens);
    result.push(...finalizeRagV2Chunks(packed, section.path));
  }

  return result.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
    totalChunks: result.length,
  }));
}
