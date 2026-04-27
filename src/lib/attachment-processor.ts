import type { Env } from '../types/env';
import type { ClassifiedItem, ChunkMetadata, AttachmentMeta } from '../types/interfaces';
import { getDecryptedAccessToken } from './helpers';
import { refreshOutlookToken } from '../integrations/oauth';
import { extractTextFromFile } from './file-extraction';
import { classifyDocument } from './document-intelligence';
import { chunkEmbedAndPersistAll } from './embedding';
import { emitAudit } from './audit';

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

interface AttachmentProcessResult {
  documents_created: number;
  documents_skipped: number;
  errors: string[];
}

async function computeHash(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function stripVersionSuffix(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_-]*(v\d+|draft|final|rev\d*|copy|revised|updated)$/i, '')
    .trim()
    .toLowerCase();
}

async function findExistingVersion(
  contentHash: string,
  fileName: string,
  orgId: string,
  contactId: string | null,
  companyId: string | null,
  env: Env
): Promise<{ type: 'exact_dup'; id: string } | { type: 'version'; parentId: string; nextVersion: number } | null> {
  const byHash = await env.D1.prepare(
    'SELECT id FROM documents WHERE org_id = ? AND content_hash = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, contentHash).first<{ id: string }>();
  if (byHash) return { type: 'exact_dup', id: byHash.id };

  const baseName = stripVersionSuffix(fileName);
  if (!baseName) return null;

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [orgId];
  if (contactId) { where.push('contact_id = ?'); binds.push(contactId); }
  else if (companyId) { where.push('company_id = ?'); binds.push(companyId); }

  const candidates = await env.D1.prepare(
    `SELECT id, file_name, version_number, parent_document_id
     FROM documents WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT 100`
  ).bind(...binds).all<{ id: string; file_name: string | null; version_number: number | null; parent_document_id: string | null }>();

  for (const c of candidates.results) {
    if (!c.file_name) continue;
    const candidateBase = stripVersionSuffix(c.file_name);
    if (candidateBase === baseName) {
      const parentId = c.parent_document_id || c.id;
      const currentVersion = c.version_number || 1;
      return { type: 'version', parentId, nextVersion: currentVersion + 1 };
    }
  }

  return null;
}

export async function processEmailAttachments(
  item: ClassifiedItem,
  orgId: string,
  env: Env
): Promise<AttachmentProcessResult> {
  const result: AttachmentProcessResult = { documents_created: 0, documents_skipped: 0, errors: [] };
  if (!item.attachments?.length || !item.userId) return result;

  let token: string;
  try {
    await refreshOutlookToken(item.userId, orgId, env);
    token = await getDecryptedAccessToken(item.userId, env);
  } catch (e: any) {
    result.errors.push(`Token refresh failed: ${e.message}`);
    return result;
  }

  const contactId = item.contactIds[0] || null;
  const companyId = item.companyId || null;
  const conversationId = item.entityId;
  const now = new Date().toISOString();
  const monthStr = now.slice(0, 7);

  let attachmentCount = 0;

  for (const att of item.attachments) {
    if (att.size > MAX_ATTACHMENT_SIZE) {
      const docId = crypto.randomUUID();
      await env.D1.prepare(
        `INSERT INTO documents
           (id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
            contact_id, company_id, conversation_id, processing_status, error_message,
            visibility, participant_user_ids, created_at, updated_at)
         VALUES (?, ?, ?, 'other', 'email_attachment', '', ?, ?, ?, ?, ?, ?, 'skipped', ?,
                 'private', ?, ?, ?)`
      ).bind(
        docId, orgId, att.name, att.name, att.size, att.contentType,
        contactId, companyId, conversationId,
        'File too large (>25MB)',
        item.participantUserIds ? JSON.stringify(item.participantUserIds) : null,
        now, now
      ).run();
      result.documents_skipped++;
      attachmentCount++;
      continue;
    }

    try {
      const graphUrl = `https://graph.microsoft.com/v1.0/me/messages/${item.externalId}/attachments/${att.id}/$value`;
      const resp = await fetch(graphUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        result.errors.push(`Attachment "${att.name}": Graph API ${resp.status}`);
        continue;
      }

      const buffer = await resp.arrayBuffer();
      const contentHash = await computeHash(buffer);

      const existing = await findExistingVersion(contentHash, att.name, orgId, contactId, companyId, env);
      if (existing?.type === 'exact_dup') {
        result.documents_skipped++;
        attachmentCount++;
        continue;
      }

      const r2Key = `${orgId}/attachments/email/${monthStr}/${conversationId}/${att.name}`;
      await env.R2.put(r2Key, buffer);

      const docId = crypto.randomUUID();
      const parentId = existing?.type === 'version' ? existing.parentId : null;
      const versionNum = existing?.type === 'version' ? existing.nextVersion : 1;

      const file = new File([buffer], att.name, { type: att.contentType });
      const text = await extractTextFromFile(file);
      const preview = text.slice(0, 500);

      let docCategory = 'other';
      if (text.length > 20) {
        try {
          const cls = await classifyDocument(text, att.name, env, orgId);
          docCategory = cls.category;
        } catch { /* keep 'other' */ }
      }

      await env.D1.prepare(
        `INSERT INTO documents
           (id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
            contact_id, company_id, conversation_id, processing_status, extracted_text_preview,
            content_hash, parent_document_id, version_number,
            visibility, participant_user_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'email_attachment', ?, ?, ?, ?,
                 ?, ?, ?, 'processing', ?,
                 ?, ?, ?,
                 'private', ?, ?, ?)`
      ).bind(
        docId, orgId, att.name, docCategory, r2Key, att.name, att.size, att.contentType,
        contactId, companyId, conversationId, preview,
        contentHash, parentId, versionNum,
        item.participantUserIds ? JSON.stringify(item.participantUserIds) : null,
        now, now
      ).run();

      if (text.length > 10) {
        try {
          const meta: ChunkMetadata = {
            org_id: orgId,
            document_type: docCategory,
            source_table: 'documents',
            source_id: docId,
            r2_key: r2Key,
            visibility: 'private',
            participant_user_ids: (item.participantUserIds || []).join(','),
            primary_entity_id: contactId || companyId || docId,
            created_at: now,
            entity_name: att.name,
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
          result.errors.push(`Embed "${att.name}": ${e.message}`);
        }
      }

      await env.D1.prepare(
        `UPDATE documents SET processing_status = 'completed' WHERE id = ?`
      ).bind(docId).run();

      await emitAudit(env, {
        org_id: orgId,
        action: 'create',
        entity_type: 'document',
        entity_id: docId,
        metadata: { source: 'email_attachment', file_name: att.name, conversation_id: conversationId, category: docCategory },
        created_at: now,
      });

      result.documents_created++;
      attachmentCount++;
    } catch (e: any) {
      result.errors.push(`Attachment "${att.name}": ${e.message}`);
    }
  }

  if (attachmentCount > 0) {
    await env.D1.prepare(
      `UPDATE conversations SET has_attachments = 1, attachment_count = ? WHERE id = ?`
    ).bind(attachmentCount, conversationId).run().catch(() => {});
  }

  return result;
}
