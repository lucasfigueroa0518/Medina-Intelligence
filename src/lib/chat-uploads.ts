// MARTy chat uploads — validation, sanitization, content-block preparation,
// and per-session attachment assembly.
//
// Storage: R2 at chat-uploads/{userId}/{id}.{ext}; metadata in chat_uploads
// (D1). Files expire 7 days after upload unless `saved_to_documents=1`, in
// which case they're permanent (the canonical home is `documents`; the
// chat_uploads row stays as a pointer for UI purposes).
//
// Session scope: when an agent message references uploads, we replay every
// upload from the session as a Claude content block, ordered by created_at,
// up to the SESSION_PAYLOAD_CAP. Uploads that would push past the cap are
// "aged out" — they still exist in R2 and still render in message bubbles, but
// they're sent to Claude only as a text-block hint so the model knows they
// were there.

import type { Env } from '../types/env';

export const MAX_FILES_PER_REQUEST = 5;
export const MAX_FILE_SIZE_BYTES = 32 * 1024 * 1024; // 32 MB — Claude PDF cap
export const MAX_REQUEST_PAYLOAD_BYTES = 90 * 1024 * 1024; // headroom under Workers' 100 MB body cap
export const MAX_IMAGE_RAW_BYTES = Math.floor(5 * 1024 * 1024 * 0.75); // ≈3.75 MB raw → ≤5 MB base64
export const MAX_ACTIVE_UPLOADS_PER_USER = 25;
export const SESSION_PAYLOAD_CAP_BYTES = 50 * 1024 * 1024;
export const RETENTION_DAYS = 7;

export type UploadType = 'pdf' | 'image' | 'document' | 'spreadsheet' | 'presentation' | 'text' | 'data';

export interface ChatUploadRow {
  id: string;
  user_id: string;
  org_id: string;
  session_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string;
  upload_type: UploadType;
  extraction_status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  extracted_text: string | null;
  preview_text: string | null;
  saved_to_documents: number; // 0 | 1
  saved_document_id: string | null;
  expires_at: string;
  created_at: string;
}

export interface UploadSummary {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  upload_type: UploadType;
  preview_text: string | null;
  saved_to_documents: boolean;
  saved_document_id: string | null;
  in_context: boolean; // false when aged out of session payload cap
  extraction_status: ChatUploadRow['extraction_status'];
}

export class UploadValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// --- Sanitization ---------------------------------------------------------

export function sanitizeFilename(raw: string): string {
  // Take the basename only — defends against "../../etc/passwd" tricks.
  const base = raw.split(/[/\\]/).pop() || 'file';
  // Strip control chars and characters that misbehave in URLs / R2 keys.
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim();
  if (!cleaned) return 'file';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

// --- Type detection -------------------------------------------------------

const EXT_TO_KIND: Record<string, UploadType> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  docx: 'document',
  xlsx: 'spreadsheet',
  xls: 'spreadsheet',
  csv: 'data',
  pptx: 'presentation',
  txt: 'text',
  md: 'text',
  json: 'data',
};

const MIME_TO_KIND: Record<string, UploadType> = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.ms-excel': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
  'text/csv': 'data',
  'text/plain': 'text',
  'text/markdown': 'text',
  'application/json': 'data',
};

export function detectUploadType(filename: string, mimeType: string): UploadType | null {
  const mt = (mimeType || '').toLowerCase();
  if (MIME_TO_KIND[mt]) return MIME_TO_KIND[mt];
  if (mt.startsWith('text/')) return 'text';

  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (EXT_TO_KIND[ext]) return EXT_TO_KIND[ext];
  return null;
}

// --- Per-file validation --------------------------------------------------

export function validateUpload(file: { name: string; type: string; size: number }): {
  type: UploadType;
  filename: string;
  mimeType: string;
} {
  const filename = sanitizeFilename(file.name);
  const mimeType = file.type || 'application/octet-stream';

  if (file.size === 0) {
    throw new UploadValidationError(`"${filename}" is empty.`);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new UploadValidationError(
      `"${filename}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max per file is 32 MB.`
    );
  }

  const type = detectUploadType(filename, mimeType);
  if (!type) {
    throw new UploadValidationError(
      `"${filename}" is not a supported file type. Try PDF, DOCX, XLSX, PPTX, CSV, TXT, MD, JSON, or PNG/JPG/WebP/GIF.`
    );
  }

  if (type === 'image' && file.size > MAX_IMAGE_RAW_BYTES) {
    throw new UploadValidationError(
      `"${filename}" is too large for image analysis (${(file.size / 1024 / 1024).toFixed(1)} MB; max 3.5 MB).`
    );
  }

  return { type, filename, mimeType };
}

// --- R2 keying ------------------------------------------------------------

export function buildR2Key(userId: string, uploadId: string, filename: string): string {
  const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `chat-uploads/${userId}/${uploadId}.${ext || 'bin'}`;
}

// --- Active-upload quota --------------------------------------------------

export async function ensureUserUnderQuota(userId: string, env: Env): Promise<void> {
  const row = await env.D1.prepare(
    `SELECT COUNT(*) AS n FROM chat_uploads WHERE user_id = ? AND saved_to_documents = 0`
  ).bind(userId).first<{ n: number }>();

  if ((row?.n ?? 0) < MAX_ACTIVE_UPLOADS_PER_USER) return;

  // Auto-purge oldest non-saved uploads to bring the user back under.
  const overflow = (row?.n ?? 0) - MAX_ACTIVE_UPLOADS_PER_USER + 1;
  const oldest = await env.D1.prepare(
    `SELECT id, r2_key FROM chat_uploads
     WHERE user_id = ? AND saved_to_documents = 0
     ORDER BY created_at ASC LIMIT ?`
  ).bind(userId, overflow).all<{ id: string; r2_key: string }>();

  for (const r of oldest.results) {
    try { await env.R2.delete(r.r2_key); } catch (e) { console.error('[chat-uploads] R2 purge failed:', e); }
    await env.D1.prepare(`DELETE FROM chat_uploads WHERE id = ?`).bind(r.id).run().catch(() => {});
  }
}

// --- Claude content blocks ------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function imageMediaType(mime: string, filename: string): string {
  const m = mime.toLowerCase();
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/webp' || m === 'image/gif') return m;
  if (m === 'image/jpg') return 'image/jpeg';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

/**
 * Build the Claude content block(s) for a single chat upload. PDFs and images
 * become native document/image blocks; everything else becomes a text block
 * containing the extracted text. Returns [] if the upload can't be replayed
 * (e.g. extraction failed, file gone from R2).
 */
export async function prepareContentBlocks(
  upload: ChatUploadRow,
  env: Env
): Promise<ContentBlock[]> {
  if (upload.upload_type === 'pdf' || upload.upload_type === 'image') {
    const obj = await env.R2.get(upload.r2_key);
    if (!obj) {
      console.error(`[chat-uploads] R2 miss for ${upload.id} (${upload.r2_key})`);
      return [{ type: 'text', text: `[Attached file "${upload.filename}" is no longer available.]` }];
    }
    const buf = await obj.arrayBuffer();
    const data = bufferToBase64(buf);
    if (upload.upload_type === 'pdf') {
      return [
        { type: 'text', text: `Attached PDF: ${upload.filename}` },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
      ];
    }
    return [
      { type: 'text', text: `Attached image: ${upload.filename}` },
      {
        type: 'image',
        source: { type: 'base64', media_type: imageMediaType(upload.mime_type, upload.filename), data },
      },
    ];
  }

  const text = upload.extracted_text || '';
  if (!text.trim()) {
    return [{ type: 'text', text: `[Attached file "${upload.filename}" — no extractable text.]` }];
  }
  return [
    {
      type: 'text',
      text: `Attached ${upload.upload_type} (${upload.filename}):\n\n${text}`,
    },
  ];
}

// --- Session-scope assembly ----------------------------------------------

export interface SessionAttachmentResult {
  /** Content blocks to prepend to the user message (PDFs/images first, text last). */
  contentBlocks: ContentBlock[];
  /** All session uploads in created_at order, with in_context flag set. */
  summaries: UploadSummary[];
  /** Total bytes of attachments included in the replay. */
  bytesUsed: number;
  /** Total bytes available across all session attachments. */
  bytesTotal: number;
}

/**
 * Look up every chat upload for this session, decide which fit under
 * SESSION_PAYLOAD_CAP_BYTES, and build the Claude content blocks for those.
 * Aged-out uploads contribute a single text-only hint so the model knows they
 * existed but doesn't have direct access in this turn.
 */
export async function assembleSessionAttachments(
  sessionId: string,
  userId: string,
  env: Env
): Promise<SessionAttachmentResult> {
  const result = await env.D1.prepare(
    `SELECT * FROM chat_uploads
     WHERE session_id = ? AND user_id = ?
     ORDER BY created_at ASC`
  ).bind(sessionId, userId).all<ChatUploadRow>();

  const rows = result.results;
  if (rows.length === 0) {
    return { contentBlocks: [], summaries: [], bytesUsed: 0, bytesTotal: 0 };
  }

  // Newest-first allocation: the most recent uploads are the most likely to
  // be referenced in the current turn, so they win the budget. Tracked in a
  // Set so the original ascending order is preserved for the UI summaries.
  const newestFirst = [...rows].reverse();
  const inContext = new Set<string>();
  let bytesUsed = 0;
  for (const r of newestFirst) {
    if (bytesUsed + r.size_bytes <= SESSION_PAYLOAD_CAP_BYTES) {
      inContext.add(r.id);
      bytesUsed += r.size_bytes;
    }
  }

  const contentBlocks: ContentBlock[] = [];
  const agedOutNames: string[] = [];

  for (const r of rows) {
    if (inContext.has(r.id)) {
      const blocks = await prepareContentBlocks(r, env);
      contentBlocks.push(...blocks);
    } else {
      agedOutNames.push(r.filename);
    }
  }

  if (agedOutNames.length > 0) {
    contentBlocks.push({
      type: 'text',
      text:
        `[Earlier in this session the user attached: ${agedOutNames.join(', ')}. ` +
        `These files are no longer in your immediate context (session attachment cap reached). ` +
        `If the user references one specifically, prompt them to re-attach it.]`,
    });
  }

  const summaries: UploadSummary[] = rows.map(r => ({
    id: r.id,
    filename: r.filename,
    mime_type: r.mime_type,
    size_bytes: r.size_bytes,
    upload_type: r.upload_type,
    preview_text: r.preview_text,
    saved_to_documents: r.saved_to_documents === 1,
    saved_document_id: r.saved_document_id,
    in_context: inContext.has(r.id),
    extraction_status: r.extraction_status,
  }));

  const bytesTotal = rows.reduce((acc, r) => acc + r.size_bytes, 0);
  return { contentBlocks, summaries, bytesUsed, bytesTotal };
}

export function rowToSummary(r: ChatUploadRow, inContext = true): UploadSummary {
  return {
    id: r.id,
    filename: r.filename,
    mime_type: r.mime_type,
    size_bytes: r.size_bytes,
    upload_type: r.upload_type,
    preview_text: r.preview_text,
    saved_to_documents: r.saved_to_documents === 1,
    saved_document_id: r.saved_document_id,
    in_context: inContext,
    extraction_status: r.extraction_status,
  };
}
