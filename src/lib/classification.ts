// TRD §7.2 — Intake classification with email privacy
import type { Env } from '../types/env';
import type {
  ClassifiableItem,
  ClassifiedItem,
  ChunkMetadata,
} from '../types/interfaces';
import { discoverNewContact, PERSONAL_DOMAINS, findOrCreateCompanyByDomain, type DiscoveryEligibility } from './discovery';
import { runEmbedding } from './embedding';

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
    // When a message we've already stored arrives again (cross-user inbox view,
    // re-delivery, etc.) we still want to (a) merge the new viewer into
    // participant_user_ids and (b) revisit contact linking — earlier passes
    // may have rejected a participant whose name we now have.
    let existingConversationId: string | null = null;
    if (item.externalId) {
      if (item.type === 'email' || item.type === 'slack_message' || item.type === 'news') {
        const existing = await env.D1.prepare(
          'SELECT id FROM conversations WHERE external_message_id = ?'
        ).bind(item.externalId).first<{ id: string }>();
        if (existing) existingConversationId = existing.id;
      }
    }

    // --- cross-user email dedup (v3.0) ---
    if (!existingConversationId && item.type === 'email' && item.threadId && item.fromEmail) {
      const crossUserDup = await env.D1.prepare(
        'SELECT id FROM conversations WHERE external_thread_id = ? AND sent_at = ? AND from_email = ? AND org_id = ?'
      ).bind(item.threadId, item.sentAt, item.fromEmail, orgId).first<{ id: string }>();
      if (crossUserDup) existingConversationId = crossUserDup.id;
    }

    if (existingConversationId) {
      // Merge new viewer into participant_user_ids if applicable
      if (item.userId) {
        const row = await env.D1.prepare(
          'SELECT participant_user_ids FROM conversations WHERE id = ?'
        ).bind(existingConversationId).first<{ participant_user_ids: string }>();
        const existingParticipants: string[] = row?.participant_user_ids
          ? JSON.parse(row.participant_user_ids)
          : [];

        if (!existingParticipants.includes(item.userId)) {
          existingParticipants.push(item.userId);
          await env.D1.prepare(
            'UPDATE conversations SET participant_user_ids = ? WHERE id = ?'
          ).bind(JSON.stringify(existingParticipants), existingConversationId).run();

          // Re-upsert Vectorize chunks with new participant string (P-1 fix)
          const updatedParticipantStr = existingParticipants.join(',');
          const vectors = await env.D1.prepare(
            'SELECT vector_id FROM vector_entity_index WHERE entity_id = ? AND source_table = ?'
          ).bind(existingConversationId, 'conversations').all<{ vector_id: string }>();

          for (const v of vectors.results) {
            const vectorId = v.vector_id;
            const chunkText = await env.KV.get(`chunk:${vectorId}`);
            if (chunkText) {
              const values = await runEmbedding(env, chunkText, orgId);

              const existingVec = await env.VECTORIZE.getByIds([vectorId]);
              if (existingVec.length > 0) {
                const meta = {
                  ...existingVec[0].metadata,
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

      // Re-run contact resolution against the existing conversation so that
      // recipients who were rejected on a prior pass (e.g. unknown display name)
      // can now be linked, and total_interactions stays accurate.
      await reconcileExistingConversation(
        existingConversationId,
        item,
        orgId,
        internalEmails,
        env
      );

      continue;
    }

    // --- contact resolution ---
    const contactIds: string[] = [];
    const fromEmailLower = item.fromEmail?.toLowerCase();
    const recipientEmails = new Set<string>();
    for (const e of item.toEmails || []) recipientEmails.add(e.toLowerCase());
    for (const e of item.ccEmails || []) recipientEmails.add(e.toLowerCase());

    const eligibilityFor = (email: string): DiscoveryEligibility | null => {
      if (item.type === 'calendar_event') return { kind: 'meeting_attendee' };
      if (item.type !== 'email') return null;
      if (item.direction === 'internal') return null;

      // Outbound: recipients become contacts (we initiated).
      if (item.direction === 'outbound') {
        if (recipientEmails.has(email)) return { kind: 'outbound' };
        return null;
      }
      // Inbound: sender is eligible immediately. The "have we replied yet"
      // gate (Finding 3) was over-restrictive — a real inbound is a real signal.
      if (email === fromEmailLower) return { kind: 'reply' };
      return null;
    };

    const allEmails = new Set<string>(recipientEmails);
    if (fromEmailLower) allEmails.add(fromEmailLower);

    // --- auto-create company stubs FIRST so contact discovery can attach them ---
    if (item.type === 'email') {
      const domainsSeen = new Set<string>();
      for (const email of allEmails) {
        if (internalEmails.has(email)) continue;
        const domain = email.split('@')[1];
        if (!domain || PERSONAL_DOMAINS.has(domain) || domainsSeen.has(domain)) continue;
        domainsSeen.add(domain);
        try {
          await findOrCreateCompanyByDomain(domain, orgId, env);
        } catch (e) {
          console.error(`[classification] company stub creation failed for ${domain}:`, e);
        }
      }
    }

    for (const email of allEmails) {
      if (internalEmails.has(email)) {
        contactsSkippedInternal++;
        continue;
      }

      const existing = await env.D1.prepare(
        'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL'
      ).bind(orgId, email).first<{ id: string }>();

      if (existing) {
        contactIds.push(existing.id);
        contactsExisting++;
        continue;
      }

      // Eligibility + automated-email filtering happen inside discoverNewContact.
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

    // News items already exist as rows in news_articles (inserted by
    // fetchNewsForActiveCompanies). Use that ID so vector_entity_index points
    // at a real row. Everything else gets a fresh UUID — stage-approvals will
    // INSERT a conversations / events row with this ID.
    const entityId =
      item.type === 'news' && item.articleId ? item.articleId : crypto.randomUUID();

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

    // Match the actual table the entityId lives in. Audit 2026-04-28: the
    // prior "everything-not-an-event = conversations" branch sent news items
    // through with source_table='conversations', orphaning 50+ vectors per
    // run because news items are persisted in news_articles and never land
    // in conversations.
    const sourceTable =
      item.type === 'calendar_event' ? 'events'
      : item.type === 'news' ? 'news_articles'
      : 'conversations';

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

// When an inbound message turns out to be a duplicate of one we've already
// stored, we still need to (a) try to link any participants that were rejected
// on the first pass and (b) bump total_interactions for newly added links.
async function reconcileExistingConversation(
  conversationId: string,
  item: ClassifiableItem,
  orgId: string,
  internalEmails: Set<string>,
  env: Env
): Promise<void> {
  if (item.type !== 'email') return;

  const fromEmailLower = item.fromEmail?.toLowerCase();
  const recipientEmails = new Set<string>();
  for (const e of item.toEmails || []) recipientEmails.add(e.toLowerCase());
  for (const e of item.ccEmails || []) recipientEmails.add(e.toLowerCase());
  const allEmails = new Set<string>(recipientEmails);
  if (fromEmailLower) allEmails.add(fromEmailLower);

  const eligibilityFor = (email: string): DiscoveryEligibility | null => {
    if (item.direction === 'internal') return null;
    if (item.direction === 'outbound') {
      if (recipientEmails.has(email)) return { kind: 'outbound' };
      return null;
    }
    if (email === fromEmailLower) return { kind: 'reply' };
    return null;
  };

  for (const email of allEmails) {
    if (internalEmails.has(email)) continue;

    let contactId: string | null = null;
    const existing = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL'
    ).bind(orgId, email).first<{ id: string }>();

    if (existing) {
      contactId = existing.id;
    } else {
      const eligibility = eligibilityFor(email);
      if (!eligibility) continue;
      const discovered = await discoverNewContact(email, item, orgId, env, eligibility);
      if (discovered) contactId = discovered.id;
    }

    if (!contactId) continue;

    const result = await env.D1.prepare(
      `INSERT OR IGNORE INTO conversation_contacts (conversation_id, contact_id, role)
       VALUES (?, ?, 'participant')`
    ).bind(conversationId, contactId).run();

    if (result.meta?.changes) {
      await env.D1.prepare(
        `UPDATE contacts
           SET last_contact_date = ?,
               total_interactions = total_interactions + 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      ).bind(item.sentAt, contactId).run();
    }
  }
}
