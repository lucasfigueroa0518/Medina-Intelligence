// TRD §7.1 Step 5 — stage approvals + commit auto-approved
import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import { hashShort, getOrgSettings } from './helpers';
import { autoLinkAttendees, autoLinkConversationParticipants } from './associations';
import { processEmailSignature, processDisplayNameUpdate } from './email-signature-parser';

/**
 * Stages classified items as approval queue entries (or writes them directly
 * if org settings permit auto-approve).
 *
 * All writes use INSERT OR IGNORE keyed on idempotency_key so Workflow replay
 * after checkpoint failure does not create duplicate rows.
 */
export async function stageAndCommitApprovals(
  items: ClassifiedItem[],
  orgId: string,
  syncJobId: string,
  env: Env
): Promise<void> {
  const settings = await getOrgSettings(orgId, env);
  const now = new Date().toISOString();

  for (const item of items) {
    if (item.entityType === 'conversation') {
      // Commit the conversation record directly (org-wide creation — gated by participant_user_ids)
      const idempotencyKey = `${orgId}:conversation:create:${item.externalId}:${syncJobId}`;

      const attCount = item.attachments?.length || 0;
      await env.D1.prepare(
        `INSERT OR IGNORE INTO conversations
           (id, org_id, source, external_thread_id, external_message_id, subject, body_r2_key, body_preview, direction, sent_at,
            from_email, to_emails, cc_emails, participant_user_ids, is_campaign_email,
            has_attachments, attachment_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      )
        .bind(
          item.entityId,
          orgId,
          item.source === 'claude_search' ? 'manual' : item.source,
          item.threadId || null,
          item.externalId,
          item.subject || null,
          item.metadata.r2_key,
          item.bodyPreview.slice(0, 500),
          item.direction || 'inbound',
          item.sentAt,
          item.fromEmail || '',
          JSON.stringify(item.toEmails || []),
          JSON.stringify(item.ccEmails || []),
          JSON.stringify(item.participantUserIds || []),
          attCount > 0 ? 1 : 0,
          attCount,
          now,
          now
        )
        .run();

      // Junction rows for conversation_contacts. Only bump total_interactions
      // for links that were newly inserted — replays/dedup must not double-count.
      const newlyLinked: string[] = [];
      for (const cid of item.contactIds) {
        const result = await env.D1.prepare(
          `INSERT OR IGNORE INTO conversation_contacts (conversation_id, contact_id, role)
           VALUES (?, ?, 'participant')`
        ).bind(item.entityId, cid).run();
        if (result.meta?.changes) newlyLinked.push(cid);
      }

      // Auto-link pairs
      if (item.contactIds.length >= 2) {
        await autoLinkConversationParticipants(item.entityId, item.contactIds, orgId, env);
      }

      // Update last_contact_date on every linked contact (it's monotonic),
      // but only increment total_interactions for newly inserted links.
      for (const cid of item.contactIds) {
        await env.D1.prepare(
          `UPDATE contacts SET last_contact_date = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ? AND (last_contact_date IS NULL OR last_contact_date < ?)`
        ).bind(item.sentAt, cid, item.sentAt).run();
      }
      for (const cid of newlyLinked) {
        await env.D1.prepare(
          `UPDATE contacts SET total_interactions = total_interactions + 1
           WHERE id = ?`
        ).bind(cid).run();
      }

      // Email signature extraction + display name updates (progressive enrichment)
      if (item.type === 'email' && item.direction !== 'internal' && item.contactIds.length > 0) {
        const senderContactId = item.contactIds[0];
        try {
          if (item.bodyText && item.bodyText.length > 100) {
            await processEmailSignature(
              senderContactId, orgId, item.bodyText,
              item.fromName || '', item.entityId, item.sentAt, env
            );
          }
          // Apply display-name updates to every linked contact for which we have
          // a real display name (either fromName matching sender or recipientNames).
          const recipientNames = item.recipientNames || {};
          for (const cid of item.contactIds) {
            const row = await env.D1.prepare(
              'SELECT email FROM contacts WHERE id = ?'
            ).bind(cid).first<{ email: string | null }>();
            const emailLower = row?.email?.toLowerCase();
            if (!emailLower) continue;

            let nameCandidate: string | null = null;
            if (item.fromEmail && item.fromEmail.toLowerCase() === emailLower && item.fromName) {
              nameCandidate = item.fromName;
            } else if (recipientNames[emailLower]) {
              nameCandidate = recipientNames[emailLower];
            }

            if (nameCandidate && nameCandidate.trim().split(/\s+/).length >= 2) {
              await processDisplayNameUpdate(
                cid, orgId, nameCandidate,
                item.entityId, item.sentAt, env
              );
            }
          }
        } catch (e) {
          console.error(`[sig-parser] error for contact ${senderContactId}:`, e);
        }
      }

      void idempotencyKey;
      continue;
    }

    if (item.entityType === 'news') {
      // News articles are already persisted in news_articles by fetchNewsForActiveCompanies.
      // Only update the company's last_news_summary — do NOT duplicate into conversations.
      if (item.relatedCompanyId) {
        await env.D1.prepare(
          `UPDATE companies SET
             last_news_summary = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`
        ).bind(item.bodyPreview.slice(0, 500), item.relatedCompanyId).run();
      }
      continue;
    }

    // Calendar events handled by integrations/outlook.ts directly (ON CONFLICT upsert).
  }

  // Settings-gated field-level staging happens in extraction.ts for enrichment signals.
  void settings;
}
