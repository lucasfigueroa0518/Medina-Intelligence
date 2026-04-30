// MARTy chat upload endpoints — multi-file ephemeral uploads, optional save
// to permanent Documents, and a content fetch endpoint for in-chat preview.
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { extractTextFromFile } from '../lib/file-extraction';
import { classifyDocument } from '../lib/document-intelligence';
import { classifyByFilename } from '../lib/document-filename-classifier';
import { emitAudit } from '../lib/audit';
import { persistDocument } from '../lib/persist-document';
import {
  type ChatUploadRow,
  type UploadSummary,
  validateUpload,
  buildR2Key,
  ensureUserUnderQuota,
  rowToSummary,
  detectUploadType,
  MAX_FILES_PER_REQUEST,
  MAX_REQUEST_PAYLOAD_BYTES,
  RETENTION_DAYS,
  UploadValidationError,
} from '../lib/chat-uploads';
import { loadDocumentForUser } from './documents';

export async function uploadChatFiles(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) {
    return errorResponse('VALIDATION_ERROR', 400, 'multipart/form-data required');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e: any) {
    return errorResponse('VALIDATION_ERROR', 400, e?.message || 'invalid form data');
  }

  const sessionId = (form.get('session_id') as string) || null;
  const saveToDocuments = (form.get('save_to_documents') as string) === 'true';

  const files = (form.getAll('files') as unknown[])
    .filter((v): v is File => typeof v === 'object' && v !== null && (v as any).arrayBuffer && (v as any).size > 0) as File[];
  if (files.length === 0) {
    return errorResponse('VALIDATION_ERROR', 400, 'no files');
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return jsonResponse({
      error: 'TOO_MANY_FILES',
      message: `Maximum ${MAX_FILES_PER_REQUEST} files per upload.`,
    }, 400);
  }

  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  if (totalSize > MAX_REQUEST_PAYLOAD_BYTES) {
    return jsonResponse({
      error: 'PAYLOAD_TOO_LARGE',
      message: 'Total upload size exceeds 90 MB.',
    }, 400);
  }

  // Validate every file before storing any of them — we want all-or-nothing
  // semantics so the user doesn't end up with a half-failed upload batch.
  const validated: { file: File; type: ReturnType<typeof validateUpload>['type']; filename: string; mimeType: string }[] = [];
  for (const f of files) {
    try {
      const v = validateUpload({ name: f.name, type: f.type, size: f.size });
      validated.push({ file: f, type: v.type, filename: v.filename, mimeType: v.mimeType });
    } catch (e) {
      if (e instanceof UploadValidationError) {
        return jsonResponse({ error: 'INVALID_UPLOAD', message: e.message }, e.status);
      }
      throw e;
    }
  }

  await ensureUserUnderQuota(ctx.userId, env);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString();
  const summaries: UploadSummary[] = [];

  for (const v of validated) {
    const id = `upload_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const r2Key = buildR2Key(ctx.userId, id, v.filename);

    // Synchronously store the binary in R2 — the response can't return until
    // the file is durably persisted, otherwise the client could send a
    // message referencing an upload that doesn't exist yet.
    const buffer = await v.file.arrayBuffer();
    await env.R2.put(r2Key, buffer, {
      httpMetadata: { contentType: v.mimeType },
    });

    await env.D1.prepare(
      `INSERT INTO chat_uploads
         (id, user_id, org_id, session_id, filename, mime_type, size_bytes, r2_key,
          upload_type, extraction_status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      id, ctx.userId, ctx.orgId, sessionId,
      v.filename, v.mimeType, v.file.size, r2Key,
      v.type, expiresAt, now
    ).run();

    const row: ChatUploadRow = {
      id, user_id: ctx.userId, org_id: ctx.orgId, session_id: sessionId,
      filename: v.filename, mime_type: v.mimeType, size_bytes: v.file.size, r2_key: r2Key,
      upload_type: v.type, extraction_status: 'pending',
      extracted_text: null, preview_text: null,
      saved_to_documents: 0, saved_document_id: null,
      expires_at: expiresAt, created_at: now,
    };
    summaries.push(rowToSummary(row));

    // Async work: text extraction (for everything except images, which Claude
    // reads natively) and optional ingestion into the permanent Documents
    // pipeline. Fire-and-forget under ctx.waitUntil so the response stays
    // snappy.
    const extractable = v.type !== 'image';
    ctxExec.waitUntil(
      processUpload({
        id, type: v.type, filename: v.filename, file: v.file, r2Key,
        extractable, saveToDocuments, ctx, env,
      })
    );
  }

  return jsonResponse({ uploads: summaries });
}

interface ProcessArgs {
  id: string;
  type: ChatUploadRow['upload_type'];
  filename: string;
  file: File;
  r2Key: string;
  extractable: boolean;
  saveToDocuments: boolean;
  ctx: AuthContext;
  env: Env;
}

async function processUpload(args: ProcessArgs): Promise<void> {
  const { id, type, filename, file, r2Key, extractable, saveToDocuments, ctx, env } = args;

  let extractedText = '';
  let preview: string | null = null;
  let extractionError: string | undefined;

  if (extractable) {
    try {
      await env.D1.prepare(
        `UPDATE chat_uploads SET extraction_status = 'processing' WHERE id = ?`
      ).bind(id).run();

      extractedText = await extractTextFromFile(file);
      preview = extractedText.slice(0, 500);

      await env.D1.prepare(
        `UPDATE chat_uploads SET extraction_status = 'completed',
                                  extracted_text = ?, preview_text = ?
         WHERE id = ?`
      ).bind(extractedText, preview, id).run();
    } catch (e: any) {
      extractionError = String(e?.message || e);
      console.error(`[chat-uploads] extraction failed for ${id}:`, extractionError);
      await env.D1.prepare(
        `UPDATE chat_uploads SET extraction_status = 'failed' WHERE id = ?`
      ).bind(id).run().catch(() => {});
    }
  } else {
    // Images go straight to Claude as image blocks — no text to pull.
    await env.D1.prepare(
      `UPDATE chat_uploads SET extraction_status = 'skipped' WHERE id = ?`
    ).bind(id).run().catch(() => {});
  }

  if (!saveToDocuments) return;

  // Save-to-Documents flow: re-fetch the bytes from the chat-uploads R2 prefix
  // and hand them to the unified persistDocument writer. The chat copy stays
  // until the TTL cron sweeps it; persistDocument writes a separate copy under
  // {org}/document/... so cleanup doesn't break the saved doc.
  try {
    const obj = await env.R2.get(r2Key);
    if (!obj) throw new Error('chat upload R2 object missing');
    const buffer = await obj.arrayBuffer();
    const docFile = new File([buffer], filename, { type: file.type });

    // Wave 5 Phase C: cheap filename pre-classifier. Skip when extraction
    // already failed — the row will land 'failed' regardless. high → skip
    // LLM, medium → call LLM with hint, null → existing LLM-only path.
    let classifiedType = 'other';
    const cheap = extractionError ? null : classifyByFilename(filename);
    if (cheap?.confidence === 'high') {
      classifiedType = cheap.category;
      console.log(`[doc-intel] cheap=${cheap.category} (high) skip-llm "${filename}"`);
    } else if (extractedText.length > 20) {
      try {
        const cls = await classifyDocument(extractedText, filename, env, ctx.orgId, cheap);
        classifiedType = cls.category;
        console.log(`[doc-intel] llm=${cls.category} cheap=${cheap?.category || 'null'} "${filename}"`);
      } catch { /* keep default */ }
    } else if (cheap?.confidence === 'medium') {
      classifiedType = cheap.category;
      console.log(`[doc-intel] cheap=${cheap.category} (medium, no text) "${filename}"`);
    }

    const persisted = await persistDocument({
      file: docFile,
      orgId: ctx.orgId,
      source: 'chat_upload',
      visibility: 'org_wide',
      participantUserIds: null,
      uploadedBy: ctx.userId,
      links: [],
      documentType: classifiedType,
      preExtractedText: extractedText,
      extractionError,
      embed: true,
    }, env);
    await persisted.finalize();

    await env.D1.prepare(
      `UPDATE chat_uploads SET saved_to_documents = 1, saved_document_id = ? WHERE id = ?`
    ).bind(persisted.documentId, id).run();

    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'create',
      entity_type: 'document',
      entity_id: persisted.documentId,
      after_data: { title: filename, file_name: filename, source: 'chat_upload' },
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[chat-uploads] save-to-documents failed for ${id}:`, e);
  }
}

// --- Preview / content fetch ---------------------------------------------

export async function getChatUploadContent(
  uploadId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const row = await env.D1.prepare(
    `SELECT * FROM chat_uploads WHERE id = ? AND user_id = ?`
  ).bind(uploadId, ctx.userId).first<ChatUploadRow>();
  if (!row) return errorResponse('NOT_FOUND', 404);

  // Saved uploads should redirect to the canonical document.
  if (row.saved_to_documents === 1 && row.saved_document_id) {
    return jsonResponse({
      saved: true,
      document_id: row.saved_document_id,
      filename: row.filename,
      upload_type: row.upload_type,
    });
  }

  const obj = await env.R2.get(row.r2_key);
  if (!obj) return errorResponse('GONE', 410, 'attachment expired');

  // For images and PDFs, return the raw bytes so the client can render the
  // file directly. For text-extracted formats, return the extracted text as
  // JSON so the modal can render it as a code block.
  if (row.upload_type === 'pdf' || row.upload_type === 'image') {
    return new Response(obj.body, {
      headers: {
        'Content-Type': row.mime_type,
        'Content-Disposition': `inline; filename="${encodeURIComponent(row.filename)}"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  }

  return jsonResponse({
    saved: false,
    filename: row.filename,
    upload_type: row.upload_type,
    extraction_status: row.extraction_status,
    text: row.extracted_text || row.preview_text || '',
  });
}

export async function listSessionUploads(
  sessionId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const result = await env.D1.prepare(
    `SELECT * FROM chat_uploads
     WHERE session_id = ? AND user_id = ?
     ORDER BY created_at ASC`
  ).bind(sessionId, ctx.userId).all<ChatUploadRow>();
  return jsonResponse({
    uploads: result.results.map(r => rowToSummary(r)),
  });
}

// Wave 5 Phase H — Send-to-MARTy endpoint. Materializes a chat_uploads row
// from an existing documents row so the user can carry a permanent doc
// into a MARTy chat session as an in-context attachment without re-
// uploading. Reverse-link via saved_document_id maintains traceability:
// the chat_uploads row references its source document, the documents row
// retains its existing entity links.
//
// Body: { document_id: string, session_id?: string }
// Returns: { upload_id, session_id, summary }
//
// ACL: loadDocumentForUser gates on visibility + participant_user_ids +
// sharing flags — same as GET /api/documents/:id. A user who can't read
// the doc gets a 404 here too.
//
// R2 strategy: COPY bytes (audit recommendation D-2). chat_uploads has a
// 7-day TTL (RETENTION_DAYS); the temporary copy is bounded. Sharing the
// documents R2 key would require a `r2_namespace` discriminator column +
// careful coordination with the chat-uploads TTL sweep — copying is the
// simpler, safer option for one-shot attachments.
export async function attachDocumentToChat(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await request.json().catch(() => ({}))  as {
    document_id?: string;
    session_id?: string;
  };
  const documentId = body.document_id;
  const sessionId = body.session_id || `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  if (!documentId) {
    return errorResponse('VALIDATION_ERROR', 400, 'document_id required');
  }

  const doc = await loadDocumentForUser(documentId, ctx, env);
  if (!doc) {
    return errorResponse('NOT_FOUND', 404, 'document not accessible');
  }
  if (!doc.r2_key) {
    return errorResponse('GONE', 410, 'document has no binary (likely oversize/excluded)');
  }

  // Pull bytes from documents R2 prefix.
  const obj = await env.R2.get(doc.r2_key);
  if (!obj) {
    return errorResponse('GONE', 410, 'document binary missing in R2');
  }
  const buffer = await obj.arrayBuffer();

  // Decide upload_type from filename/mime; fall back to 'document' for
  // formats chat preview supports (extractable text + Documents save).
  const uploadType = detectUploadType(doc.file_name || 'document', doc.mime_type || '') || 'document';

  const uploadId = `upload_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const r2Key = buildR2Key(ctx.userId, uploadId, doc.file_name || 'document');
  await env.R2.put(r2Key, buffer, {
    httpMetadata: { contentType: doc.mime_type || 'application/octet-stream' },
  });

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString();
  // Carry the document's extracted text directly so the chat upload is
  // immediately searchable by MARTy. extraction_status='completed' marks
  // it as not-needing-async-extraction (we already have the text via doc).
  const extractedText = doc.extracted_text_preview || '';
  const previewText = extractedText.slice(0, 500);
  const extractionStatus = uploadType === 'image' ? 'skipped' : 'completed';

  await env.D1.prepare(
    `INSERT INTO chat_uploads
       (id, user_id, org_id, session_id, filename, mime_type, size_bytes, r2_key,
        upload_type, extraction_status, extracted_text, preview_text,
        saved_to_documents, saved_document_id,
        expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).bind(
    uploadId, ctx.userId, ctx.orgId, sessionId,
    doc.file_name || 'document',
    doc.mime_type || 'application/octet-stream',
    doc.file_size || buffer.byteLength,
    r2Key,
    uploadType, extractionStatus, extractedText, previewText,
    documentId,
    expiresAt, now
  ).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    // 'create' = new chat_uploads row materialized from this document
    action: 'create',
    entity_type: 'document',
    entity_id: documentId,
    metadata: { session_id: sessionId, upload_id: uploadId, source: 'send_to_marty' },
    created_at: now,
  });

  const row: ChatUploadRow = {
    id: uploadId, user_id: ctx.userId, org_id: ctx.orgId, session_id: sessionId,
    filename: doc.file_name || 'document',
    mime_type: doc.mime_type || 'application/octet-stream',
    size_bytes: doc.file_size || buffer.byteLength,
    r2_key: r2Key,
    upload_type: uploadType, extraction_status: extractionStatus,
    extracted_text: extractedText, preview_text: previewText,
    saved_to_documents: 1, saved_document_id: documentId,
    expires_at: expiresAt, created_at: now,
  };

  return jsonResponse({
    upload_id: uploadId,
    session_id: sessionId,
    summary: rowToSummary(row),
  });
}
