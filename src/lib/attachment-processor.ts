import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import { getDecryptedAccessToken } from './helpers';
import { refreshOutlookToken } from '../integrations/oauth';
import { extractTextFromFile } from './file-extraction';
import { classifyDocument } from './document-intelligence';
import { emitAudit } from './audit';
import { persistDocument, type DocumentLink } from './persist-document';

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

interface AttachmentProcessResult {
  documents_created: number;
  documents_skipped: number;
  errors: string[];
}

// Build the link set for an email attachment. The conversation is always
// 'attached' (the attachment lives inside the email). The contact (if any) is
// the 'primary' anchor for versioning + per-entity retrieval boost. The
// company and any additional contacts are 'mentioned' so they show up in their
// respective entity views without being mistaken for the version anchor.
function buildAttachmentLinks(item: ClassifiedItem): DocumentLink[] {
  const links: DocumentLink[] = [];
  const contactId = item.contactIds[0] || null;
  const companyId = item.companyId || null;
  const conversationId = item.entityId;

  if (contactId) {
    links.push({ entityType: 'contact', entityId: contactId, linkKind: 'primary', linkSource: 'pipeline' });
  } else if (companyId) {
    // Without a contact to anchor versioning, fall back to the company.
    links.push({ entityType: 'company', entityId: companyId, linkKind: 'primary', linkSource: 'pipeline' });
  }
  if (companyId && contactId) {
    links.push({ entityType: 'company', entityId: companyId, linkKind: 'mentioned', linkSource: 'pipeline' });
  }
  if (conversationId) {
    links.push({ entityType: 'conversation', entityId: conversationId, linkKind: 'attached', linkSource: 'pipeline' });
  }
  // Additional contacts beyond the first land as 'mentioned'.
  for (const cid of item.contactIds.slice(1)) {
    links.push({ entityType: 'contact', entityId: cid, linkKind: 'mentioned', linkSource: 'pipeline' });
  }
  return links;
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
  const links = buildAttachmentLinks(item);
  const participantUserIds = item.participantUserIds && item.participantUserIds.length > 0
    ? item.participantUserIds
    : null;

  let attachmentCount = 0;

  for (const att of item.attachments) {
    if (att.size > MAX_ATTACHMENT_SIZE) {
      // Oversize path: we never fetched the bytes, so persistDocument can't
      // be used. Open-code the skipped row + matching document_links so the
      // attachment still surfaces in entity views as a skipped placeholder.
      const docId = crypto.randomUUID();
      const now = new Date().toISOString();
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
        participantUserIds ? JSON.stringify(participantUserIds) : null,
        now, now
      ).run();
      if (links.length > 0) {
        await env.D1.batch(
          links.map(link =>
            env.D1.prepare(
              `INSERT OR IGNORE INTO document_links
                 (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(crypto.randomUUID(), docId, orgId, link.entityType, link.entityId, link.linkKind, link.linkSource, now)
          )
        );
      }
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
      const file = new File([buffer], att.name, { type: att.contentType });

      // Pre-extract + pre-classify so finalize() doesn't redo the work.
      // Wave 5 Phase A: extraction throws are now propagated through to
      // persistDocument via `extractionError`. The row still lands in
      // documents (visibility for the user) but with status='failed' +
      // error_message — closing the silent-fail class on email-attachment
      // PDFs that pre-Phase-A landed as 'completed' with empty preview.
      let text = '';
      let extractionError: string | undefined;
      try {
        text = await extractTextFromFile(file);
      } catch (e: any) {
        extractionError = String(e?.message || e);
        result.errors.push(`Extract "${att.name}": ${extractionError}`);
      }
      let docCategory = 'other';
      if (text.length > 20) {
        try {
          const cls = await classifyDocument(text, att.name, env, orgId);
          docCategory = cls.category;
        } catch { /* keep 'other' */ }
      }

      const persisted = await persistDocument({
        file,
        orgId,
        source: 'email_attachment',
        // Email attachments inherit the parent thread's privacy: always
        // private, with the conversation's participant_user_ids carried into
        // both the row and the vector chunk metadata.
        visibility: 'private',
        participantUserIds,
        // System-ingested — no human uploader. NULL is intentional here.
        uploadedBy: null,
        links,
        documentType: docCategory,
        preExtractedText: text,
        extractionError,
        embed: true,
      }, env);

      if (persisted.isExisting) {
        // Same file already present (cross-pipeline dedup). Don't re-link or
        // re-finalize — the existing row owns it.
        result.documents_skipped++;
        attachmentCount++;
        continue;
      }

      try {
        await persisted.finalize();
      } catch (e: any) {
        result.errors.push(`Finalize "${att.name}": ${e?.message || e}`);
      }

      await emitAudit(env, {
        org_id: orgId,
        action: 'create',
        entity_type: 'document',
        entity_id: persisted.documentId,
        metadata: { source: 'email_attachment', file_name: att.name, conversation_id: conversationId, category: docCategory },
        created_at: new Date().toISOString(),
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
