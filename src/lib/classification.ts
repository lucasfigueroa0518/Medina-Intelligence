// TRD §7.2 — Intake classification with email privacy
import type { Env } from '../types/env';
import type {
  ClassifiableItem,
  ClassifiedItem,
  ChunkMetadata,
} from '../types/interfaces';
import { discoverNewContact, type DiscoveryEligibility } from './discovery';

export async function classifyAndDeduplicate(
  items: ClassifiableItem[],
  orgId: string,
  env: Env
): Promise<ClassifiedItem[]> {
  const classified: ClassifiedItem[] = [];

  // Contact creation stats — logged at the end of the batch
  let contactsCreated = 0;
  let contactsExisting = 0;
  let contactsSkippedInternal = 0;
  let contactsSkippedNoEligibility = 0;
  let contactsSkippedAutomated = 0;

  // Cache per-invocation lookups
  const orgUsers = await env.D1.prepare(
    'SELECT id, email FROM users WHERE org_id = ? AND is_active = 1 AND deleted_at IS NULL'
  ).bind(orgId).all<{ id: string; email: string }>();

  const internalEmails = new Set<string>();
  const emailToUserId = new Map<string, string>();
  for (const u of orgUsers.results) {
    const e = u.email.toLowerCase();
    internalEmails.add(e);
    emailToUserId.set(e, u.id);
  }

  for (const item of items) {
    // --- dedup: external_message_id uniqueness ---
    if (item.externalId) {
      if (item.type === 'email' || item.type === 'slack_message' || item.type === 'news') {
        const existing = await env.D1.prepare(
          'SELECT id FROM conversations WHERE external_message_id = ?'
        ).bind(item.externalId).first();
        if (existing) continue;
      }
    }

    // --- cross-user email dedup (v3.0) ---
    if (item.type === 'email' && item.threadId && item.fromEmail) {
      const crossUserDup = await env.D1.prepare(
        'SELECT id, participant_user_ids FROM conversations WHERE external_thread_id = ? AND sent_at = ? AND from_email = ? AND org_id = ?'
      ).bind(item.threadId, item.sentAt, item.fromEmail, orgId).first<{
        id: string;
        participant_user_ids: string;
      }>();

      if (crossUserDup) {
        if (item.userId) {
          const existingParticipants: string[] = JSON.parse(
            crossUserDup.participant_user_ids || '[]'
          );
          if (!existingParticipants.includes(item.userId)) {
            existingParticipants.push(item.userId);
            await env.D1.prepare(
              'UPDATE conversations SET participant_user_ids = ? WHERE id = ?'
            ).bind(JSON.stringify(existingParticipants), crossUserDup.id).run();

            // Re-upsert Vectorize chunks with new participant string (P-1 fix)
            const updatedParticipantStr = existingParticipants.join(',');
            const vectors = await env.D1.prepare(
              'SELECT vector_id FROM vector_entity_index WHERE entity_id = ? AND source_table = ?'
            ).bind(crossUserDup.id, 'conversations').all<{ vector_id: string }>();

            for (const v of vectors.results) {
              const vectorId = v.vector_id;
              const chunkText = await env.KV.get(`chunk:${vectorId}`);
              if (chunkText) {
                const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
                  text: [chunkText],
                  pooling: 'cls',
                } as any);
                const values = Array.isArray((embedding as any).data)
                  ? (embedding as any).data[0]
                  : (embedding as any).data;

                const existing = await env.VECTORIZE.getByIds([vectorId]);
                if (existing.length > 0) {
                  const meta = {
                    ...existing[0].metadata,
                    participant_user_ids: updatedParticipantStr,
                  };
                  await env.VECTORIZE.upsert([
                    { id: vectorId, values, metadata: meta },
                  ]);
                }
              }
            }
          }
        }
        continue;
      }
    }

    // --- contact resolution ---
    const contactIds: string[] = [];
    const fromEmailLower = item.fromEmail?.toLowerCase();
    const recipientEmails = new Set<string>();
    for (const e of item.toEmails || []) recipientEmails.add(e.toLowerCase());
    for (const e of item.ccEmails || []) recipientEmails.add(e.toLowerCase());

    // For an inbound email, the sender only becomes a contact once we have replied.
    // That means another conversation in the same thread is outbound (direction='outbound').
    let weRepliedToSender = false;
    if (item.type === 'email' && item.direction === 'inbound' && item.threadId) {
      const prior = await env.D1.prepare(
        "SELECT 1 FROM conversations WHERE org_id = ? AND external_thread_id = ? AND direction = 'outbound' LIMIT 1"
      ).bind(orgId, item.threadId).first();
      weRepliedToSender = !!prior;
    }

    const eligibilityFor = (email: string): DiscoveryEligibility | null => {
      if (item.type === 'calendar_event') return { kind: 'meeting_attendee' };
      if (item.type !== 'email') return null;
      if (item.direction === 'internal') return null;

      if (item.direction === 'outbound') {
        // We sent this message; recipients become contacts.
        if (recipientEmails.has(email)) return { kind: 'outbound' };
        return null;
      }
      // Inbound: only the sender is eligible, and only if we have already replied in-thread.
      if (email === fromEmailLower && weRepliedToSender) return { kind: 'reply' };
      return null;
    };

    const allEmails = new Set<string>(recipientEmails);
    if (fromEmailLower) allEmails.add(fromEmailLower);

    for (const email of allEmails) {
      if (internalEmails.has(email)) {
        contactsSkippedInternal++;
        continue;
      }

      const existing = await env.D1.prepare(
        'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL'
      ).bind(orgId, email).first<{ id: string }>();

      if (existing) {
        await env.D1.prepare(
          'UPDATE contacts SET total_interactions = COALESCE(total_interactions, 0) + 1, updated_at = ? WHERE id = ?'
        ).bind(new Date().toISOString(), existing.id).run();
        contactIds.push(existing.id);
        contactsExisting++;
        continue;
      }

      // Eligibility + automated-email filtering happen inside discoverNewContact.
      // It returns null when:
      //   - eligibility is null (inbound-only sender we haven't replied to)
      //   - isAutomatedEmail() blocks the address (automated domain or keyword)
      const eligibility = eligibilityFor(email);
      if (!eligibility) {
        contactsSkippedNoEligibility++;
        continue;
      }
      const discovered = await discoverNewContact(email, item, orgId, env, eligibility);
      if (discovered) {
        contactIds.push(discovered.id);
        if (discovered.created) contactsCreated++;
        else contactsExisting++;
      } else {
        contactsSkippedAutomated++;
      }
    }

    // --- company resolution ---
    let companyId: string | undefined;
    if (item.relatedCompanyId) {
      companyId = item.relatedCompanyId;
    } else if (contactIds.length > 0) {
      const firstContact = await env.D1.prepare(
        'SELECT company_id FROM contacts WHERE id = ?'
      ).bind(contactIds[0]).first<{ company_id: string | null }>();
      if (firstContact?.company_id) companyId = firstContact.company_id;
    }

    // --- R2 body storage ---
    const monthStr = item.sentAt
      ? item.sentAt.slice(0, 7)
      : new Date().toISOString().slice(0, 7);
    const r2Key = `${orgId}/${item.type}/${monthStr}/${
      item.externalId || crypto.randomUUID()
    }.txt`;
    await env.R2.put(r2Key, item.bodyText);

    const entityId = crypto.randomUUID();

    // --- participant resolution (v3.0 email privacy) ---
    let participantUserIds: string[] = [];
    if (item.type === 'email') {
      for (const email of allEmails) {
        const uid = emailToUserId.get(email);
        if (uid) participantUserIds.push(uid);
      }
      if (item.userId && !participantUserIds.includes(item.userId)) {
        participantUserIds.push(item.userId);
      }
    }

    const emailVisibility: 'private' | 'org_wide' | 'confidential' =
      item.type === 'email' ? 'private' : item.visibility;

    const docType =
      item.type === 'email'
        ? 'email'
        : item.type === 'slack_message'
        ? 'conversation'
        : item.type === 'news'
        ? 'news'
        : 'transcript';

    const sourceTable =
      item.type === 'calendar_event' ? 'events' : 'conversations';

    const metadata: ChunkMetadata = {
      org_id: orgId,
      document_type: docType,
      source_table: sourceTable,
      source_id: entityId,
      r2_key: r2Key,
      visibility: emailVisibility,
      participant_user_ids: participantUserIds.join(','),
      primary_entity_id: contactIds[0] || companyId || entityId,
      secondary_entity_ids: contactIds.slice(1).join(','),
      created_at: item.sentAt,
      entity_name: item.fromName || item.subject || '',
      date: item.sentAt,
    };

    classified.push({
      ...item,
      entityType:
        item.type === 'calendar_event'
          ? 'event'
          : item.type === 'news'
          ? 'news'
          : 'conversation',
      entityId,
      contactIds,
      companyId,
      participantUserIds,
      text: item.bodyText,
      metadata,
    });
  }

  console.log(
    `[classification] contact stats for batch of ${items.length} items: ` +
    `created=${contactsCreated} existing=${contactsExisting} ` +
    `skipped_internal=${contactsSkippedInternal} skipped_no_eligibility=${contactsSkippedNoEligibility} ` +
    `skipped_automated=${contactsSkippedAutomated}`
  );

  return classified;
}
