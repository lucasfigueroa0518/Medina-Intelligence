// Wave 2: single document writer. Every pipeline (email-attach, manual upload,
// intelligent_import, chat_upload save, future Drive/Gmail/transcript) calls
// this helper instead of open-coding INSERT + R2 put + chunk + embed. Result:
// every documents row has a consistent shape regardless of entry point — same
// columns populated, same dedup behavior, same junction-link rows in
// document_links.
//
// Two-phase shape:
//   1. persistDocument() — fast, synchronous: hash → dedup → versioning →
//      R2 put → INSERT documents (status='pending') → INSERT document_links.
//      Returns documentId immediately so request handlers can 201 fast.
//   2. result.finalize() — slow, optionally deferred: extract → classify →
//      embed → status='completed'. Caller chooses sync vs ctxExec.waitUntil.
//
// Callers can short-circuit the slow phase by passing `preExtractedText` or
// `documentType` — used by intelligent_import (already extracted/classified)
// and chat_upload save (extracted text already cached on chat_uploads row).

import type { Env } from '../types/env';
import type { ChunkMetadata } from '../types/interfaces';
import { extractTextFromFile } from './file-extraction';
import { classifyDocument } from './document-intelligence';
import { classifyByFilename } from './document-filename-classifier';
import { chunkEmbedAndPersistAll } from './embedding';

export type DocumentSource =
  | 'email_attachment'
  | 'manual_upload'
  | 'upload'                 // legacy alias for manual_upload (kept so existing rows match)
  | 'intelligent_import'
  | 'chat_upload'
  | 'drive_import'
  | 'meeting_transcript';

export type DocumentVisibility = 'private' | 'org_wide' | 'public' | 'confidential';

export interface DocumentLink {
  entityType: 'contact' | 'company' | 'deal' | 'conversation' | 'event' | 'agent_message';
  entityId: string;
  linkKind: 'primary' | 'attached' | 'mentioned' | 'derived';
  linkSource: 'pipeline' | 'manual' | 'llm_extracted';
}

export interface PersistDocumentInput {
  /** The file binary. Helper reads bytes from this for hash + R2 put + extract. */
  file: File;

  /** Owning org. */
  orgId: string;
  /** Which pipeline produced this row. */
  source: DocumentSource;

  /** ACL — required, no defaults. */
  visibility: DocumentVisibility;
  /** D1-format participant list. Stored JSON-stringified on `documents`; comma-joined on vector metadata. */
  participantUserIds: string[] | null;
  /** User who uploaded (or null for system-ingested rows like email attachments). */
  uploadedBy: string | null;

  /** Junction-table links. The first occurrence per entity_type also fills the legacy scalar FK column. */
  links: DocumentLink[];

  /** Display title; defaults to `file.name`. */
  title?: string;
  /** Pre-classified category. If provided, finalize() skips the classifier. */
  documentType?: string;
  /** For versioning chains — caller-provided override. If null, helper looks up via name fuzzy-match against same primary entity. */
  parentDocumentId?: string;
  /** Extracted text from a prior step. If provided, finalize() skips extraction. */
  preExtractedText?: string;
  /** Caller pre-extracted and the parser threw. finalize() will skip extract +
   *  classify + embed and stamp processing_status='failed' with this message in
   *  documents.error_message. Wave 5 Phase A — closes the silent-fail class on
   *  email_attachment / chat_upload / intelligent_import pre-extract sites. */
  extractionError?: string;

  /** Default true. When false, dedup-on-hash is bypassed and a new row is always created. */
  dedupOnContentHash?: boolean;
  /** Default true. When false, finalize() persists status='completed' but skips chunking + embedding. */
  embed?: boolean;
}

export interface PersistDocumentResult {
  documentId: string;
  /** True when a hash dedup matched an existing row. r2Key/contentHash refer to the existing doc. */
  isExisting: boolean;
  versionNumber: number;
  parentDocumentId: string | null;
  r2Key: string;
  contentHash: string;
  /** Async finalize step — extract (if no preExtractedText), classify (if no documentType), embed (if embed=true), set status='completed'. No-op when isExisting=true. */
  finalize: () => Promise<void>;
}

const VERSIONABLE_PRIMARY_TYPES = new Set(['contact', 'company']);

function stripVersionSuffix(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_-]*(v\d+|draft|final|rev\d*|copy|revised|updated)$/i, '')
    .trim()
    .toLowerCase();
}

async function findExistingVersionByName(
  fileName: string,
  orgId: string,
  scope: { contactId?: string | null; companyId?: string | null } | null,
  env: Env
): Promise<{ parentId: string; nextVersion: number } | null> {
  const baseName = stripVersionSuffix(fileName);
  if (!baseName) return null;

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [orgId];
  if (scope?.contactId) { where.push('contact_id = ?'); binds.push(scope.contactId); }
  else if (scope?.companyId) { where.push('company_id = ?'); binds.push(scope.companyId); }

  const candidates = await env.D1.prepare(
    `SELECT id, file_name, version_number, parent_document_id
       FROM documents WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT 100`
  ).bind(...binds).all<{ id: string; file_name: string | null; version_number: number | null; parent_document_id: string | null }>();

  for (const c of candidates.results) {
    if (!c.file_name) continue;
    if (stripVersionSuffix(c.file_name) === baseName) {
      const parentId = c.parent_document_id || c.id;
      const currentVersion = c.version_number || 1;
      return { parentId, nextVersion: currentVersion + 1 };
    }
  }
  return null;
}

async function computeSha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function persistDocument(
  input: PersistDocumentInput,
  env: Env
): Promise<PersistDocumentResult> {
  const buffer = await input.file.arrayBuffer();
  const contentHash = await computeSha256Hex(buffer);

  const dedupOn = input.dedupOnContentHash !== false;

  // Phase 1 — dedup on content hash. Existing row wins; no new row, no new
  // links. Caller decides whether to add additional links separately.
  if (dedupOn) {
    const existing = await env.D1.prepare(
      `SELECT id, r2_key, version_number, parent_document_id
         FROM documents
        WHERE org_id = ? AND content_hash = ? AND deleted_at IS NULL
        LIMIT 1`
    ).bind(input.orgId, contentHash).first<{
      id: string; r2_key: string; version_number: number | null; parent_document_id: string | null;
    }>();
    if (existing) {
      return {
        documentId: existing.id,
        isExisting: true,
        versionNumber: existing.version_number || 1,
        parentDocumentId: existing.parent_document_id,
        r2Key: existing.r2_key,
        contentHash,
        finalize: async () => { /* no-op — existing doc is already finalized (or has its own retry path) */ },
      };
    }
  }

  // Phase 2 — versioning lookup. Use the first 'primary' link if it points
  // at a contact/company (those are the entity types that anchor "my version
  // of file X for this entity" semantics). Email-attachment dedup uses
  // conversation as primary, but versioning by name within a conversation is
  // not a real workflow — so we skip it for non-versionable primary types.
  let parentId: string | null = input.parentDocumentId || null;
  let versionNumber = 1;
  if (!parentId) {
    const primary = input.links.find(l => l.linkKind === 'primary');
    const scope = primary && VERSIONABLE_PRIMARY_TYPES.has(primary.entityType)
      ? (primary.entityType === 'contact'
          ? { contactId: primary.entityId }
          : { companyId: primary.entityId })
      : null;
    if (scope) {
      const versionMatch = await findExistingVersionByName(input.file.name, input.orgId, scope, env);
      if (versionMatch) {
        parentId = versionMatch.parentId;
        versionNumber = versionMatch.nextVersion;
      }
    }
  }

  // Phase 3 — generate ID + R2 key, put binary.
  const documentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `${input.orgId}/document/${now.slice(0, 7)}/${documentId}_${input.file.name}`;
  await env.R2.put(r2Key, buffer);

  // Phase 4 — INSERT into documents. Scalar FK columns are filled from the
  // first matching link of each entity_type (rollout-safety denormalization;
  // a future mini-wave drops them after Wave 4 stabilizes).
  const firstLinkOf = (t: DocumentLink['entityType']): string | null =>
    input.links.find(l => l.entityType === t)?.entityId ?? null;

  const participantsJson = input.participantUserIds && input.participantUserIds.length > 0
    ? JSON.stringify(input.participantUserIds)
    : null;

  // Normalize legacy 'manual_upload' to 'upload' so `source` matches existing
  // rows produced by the manual handler — keeps cross-pipeline filters simple.
  const sourceValue = input.source === 'manual_upload' ? 'upload' : input.source;

  try {
    await env.D1.prepare(
      `INSERT INTO documents
         (id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
          contact_id, company_id, deal_id, conversation_id,
          uploaded_by, processing_status, content_hash, parent_document_id, version_number,
          visibility, participant_user_ids,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?, 'pending', ?, ?, ?,
               ?, ?,
               ?, ?)`
    ).bind(
      documentId, input.orgId,
      input.title || input.file.name,
      input.documentType || 'other',
      sourceValue,
      r2Key, input.file.name, input.file.size, input.file.type || null,
      firstLinkOf('contact'), firstLinkOf('company'), firstLinkOf('deal'), firstLinkOf('conversation'),
      input.uploadedBy, contentHash, parentId, versionNumber,
      input.visibility, participantsJson,
      now, now
    ).run();
  } catch (e) {
    // Roll back the R2 put — if D1 fails after R2, we'd leak the binary.
    try { await env.R2.delete(r2Key); } catch { /* best-effort */ }
    throw e;
  }

  // Phase 5 — INSERT document_links (one per link in input.links). The unique
  // constraint on (document_id, entity_type, entity_id, link_kind) makes
  // duplicates within the same input array harmless.
  if (input.links.length > 0) {
    const stmts = input.links.map(link =>
      env.D1.prepare(
        `INSERT OR IGNORE INTO document_links
           (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(), documentId, input.orgId,
        link.entityType, link.entityId, link.linkKind, link.linkSource,
        now, input.uploadedBy
      )
    );
    await env.D1.batch(stmts);
  }

  // Phase 6 — return the doc handle + a finalize callable.
  // Closure captures everything finalize needs so callers don't have to
  // re-pass anything. The file is reused as-is for extraction (cheaper than
  // round-tripping bytes through R2 just to extract again).
  const fileForFinalize = input.file;
  const userProvidedType = input.documentType;
  const preExtractedText = input.preExtractedText;
  const extractionError = input.extractionError;
  const wantEmbed = input.embed !== false;
  const links = input.links;
  const visibility = input.visibility;
  const participants = input.participantUserIds || [];
  const titleForVector = input.title || input.file.name;

  const finalize = async () => {
    try {
      await env.D1.prepare(
        `UPDATE documents SET processing_status = 'processing' WHERE id = ?`
      ).bind(documentId).run();

      // Wave 5 Phase A: caller pre-extract failed — persist as failed, skip
      // classify + embed. Without this branch the row would silently land
      // `'completed'` with empty preview + `'other'` category (the
      // 695-PDF silent-fail class).
      if (extractionError !== undefined) {
        await env.D1.prepare(
          `UPDATE documents
              SET processing_status = 'failed',
                  error_message = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`
        ).bind(extractionError.slice(0, 500), documentId).run();
        return;
      }

      // Extract — only when caller didn't pre-extract. Throws here are
      // caught locally so we mark `'failed'` + populate error_message,
      // rather than letting the outer catch confuse extract failures with
      // classify/embed failures.
      let text: string;
      if (preExtractedText !== undefined) {
        text = preExtractedText;
      } else {
        try {
          text = await extractTextFromFile(fileForFinalize);
        } catch (e: any) {
          const msg = String(e?.message || e).slice(0, 500);
          console.error(`[persistDocument:finalize] extract failed for ${documentId}: ${msg}`);
          await env.D1.prepare(
            `UPDATE documents
                SET processing_status = 'failed',
                    error_message = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id = ?`
          ).bind(msg, documentId).run();
          return;
        }
      }
      const preview = text.slice(0, 500);

      // Wave 5 Phase C: cheap filename pre-classifier before LLM. Only
      // applies when caller didn't pre-classify (userProvidedType is undef).
      // Tier disposition:
      //   high   → use directly, skip LLM
      //   medium → call LLM with cheap match as a hint
      //   null   → existing LLM-only path
      let finalType = userProvidedType || 'other';
      if (!userProvidedType) {
        const cheap = classifyByFilename(input.file.name);
        if (cheap?.confidence === 'high') {
          finalType = cheap.category;
          console.log(`[doc-intel] cheap=${cheap.category} (high) skip-llm "${input.file.name}"`);
        } else if (text.length > 20) {
          try {
            const cls = await classifyDocument(text, input.file.name, env, input.orgId, cheap);
            finalType = cls.category;
            console.log(`[doc-intel] llm=${cls.category} cheap=${cheap?.category || 'null'} "${input.file.name}"`);
          } catch { /* keep 'other' */ }
        } else if (cheap?.confidence === 'medium') {
          finalType = cheap.category;
          console.log(`[doc-intel] cheap=${cheap.category} (medium, no text) "${input.file.name}"`);
        }
      }

      if (wantEmbed && text.length > 10) {
        try {
          const primary = links.find(l => l.linkKind === 'primary');
          // ChunkMetadata.visibility doesn't include 'public' — coerce to
          // 'org_wide' for chunk metadata so retrieval treats it identically.
          const chunkVisibility: 'private' | 'org_wide' | 'confidential' =
            visibility === 'public' ? 'org_wide' : visibility;
          const meta: ChunkMetadata = {
            org_id: input.orgId,
            document_type: finalType,
            source_table: 'documents',
            source_id: documentId,
            r2_key: r2Key,
            visibility: chunkVisibility,
            participant_user_ids: participants.length > 0 ? participants.join(',') : undefined,
            primary_entity_id: primary?.entityId || documentId,
            created_at: now,
            entity_name: titleForVector,
          };
          const entries = await chunkEmbedAndPersistAll(text, meta, env);
          if (entries.length > 0) {
            await env.D1.batch(
              entries.map(e =>
                env.D1.prepare(
                  'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
                ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
              )
            );
          }
        } catch (e: any) {
          console.error(`[persistDocument:finalize] embed failed for ${documentId}:`, e?.message || e);
        }
      }

      await env.D1.prepare(
        `UPDATE documents
            SET processing_status = 'completed',
                document_type = ?,
                extracted_text_preview = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(finalType, preview, documentId).run();
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      console.error(`[persistDocument:finalize] failed for ${documentId}: ${msg}`);
      await env.D1.prepare(
        `UPDATE documents
            SET processing_status = 'failed',
                error_message = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(msg, documentId).run().catch(() => undefined);
    }
  };

  return {
    documentId,
    isExisting: false,
    versionNumber,
    parentDocumentId: parentId,
    r2Key,
    contentHash,
    finalize,
  };
}
