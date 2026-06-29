import type { Env } from '../types/env';
import { safelyRebuildContactSearchIndexForContact } from './contact-search';
import { safelyRebuildContactDetailReadModelForContact } from './contact-detail-read-model';
import { safelyUpsertContactListEntry } from './contact-list-read-model';

export async function safelyMaintainContactReadModels(
  env: Env,
  orgId: string,
  contactId: string | null | undefined,
  reason = 'contact_write_through'
): Promise<void> {
  if (!contactId) return;
  await Promise.all([
    safelyRebuildContactSearchIndexForContact(env, orgId, contactId),
    safelyRebuildContactDetailReadModelForContact(env, orgId, contactId, reason),
    safelyUpsertContactListEntry(env, orgId, contactId, reason),
  ]);
}
