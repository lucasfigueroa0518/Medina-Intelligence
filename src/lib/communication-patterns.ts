import type { Env } from '../types/env';

export async function analyzeCommsPatterns(
  contactId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const conversations = await env.D1.prepare(
    `SELECT c.source, c.sent_at
     FROM conversations c
     WHERE c.org_id = ?
       AND (c.from_contact_id = ? OR c.id IN (
         SELECT conversation_id FROM conversation_contacts WHERE contact_id = ?
       ))
     ORDER BY c.sent_at DESC
     LIMIT 200`
  ).bind(orgId, contactId, contactId).all<{
    source: string;
    sent_at: string;
  }>();

  const events = await env.D1.prepare(
    `SELECT e.start_time
     FROM events e
     WHERE e.org_id = ? AND e.deleted_at IS NULL
       AND e.id IN (
         SELECT event_id FROM event_attendees WHERE contact_id = ?
       )
     ORDER BY e.start_time DESC
     LIMIT 50`
  ).bind(orgId, contactId).all<{ start_time: string }>();

  const channelCounts: Record<string, number> = {};
  const hourBuckets: Record<string, number> = { morning: 0, afternoon: 0, evening: 0 };

  for (const c of conversations.results) {
    const channel = c.source === 'outlook' ? 'email' : c.source === 'slack' ? 'slack' : c.source;
    channelCounts[channel] = (channelCounts[channel] || 0) + 1;

    if (c.sent_at) {
      const hour = new Date(c.sent_at).getUTCHours();
      if (hour >= 6 && hour < 12) hourBuckets.morning++;
      else if (hour >= 12 && hour < 18) hourBuckets.afternoon++;
      else hourBuckets.evening++;
    }
  }

  channelCounts.meetings = events.results.length;

  const sorted = Object.entries(channelCounts).sort((a, b) => b[1] - a[1]);
  const preferredChannel = sorted.length > 0 ? sorted[0][0] : null;

  const peakTime = Object.entries(hourBuckets).sort((a, b) => b[1] - a[1])[0];
  const totalComms = conversations.results.length + events.results.length;

  const responsePattern: Record<string, unknown> = {
    preferred_channel: preferredChannel,
    total_comms_90d: totalComms,
    peak_time: peakTime?.[0] || null,
    channel_breakdown: channelCounts,
  };

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (preferredChannel) {
    updates.push('communication_channel_preference = ?');
    binds.push(preferredChannel);
  }

  updates.push('response_time_pattern = ?');
  binds.push(JSON.stringify(responsePattern));

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    await env.D1.prepare(
      `UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...binds, contactId).run();
  }
}

export async function analyzeAllCommsPatterns(
  orgId: string,
  env: Env
): Promise<number> {
  const contacts = await env.D1.prepare(
    `SELECT id FROM contacts WHERE org_id = ? AND deleted_at IS NULL`
  ).bind(orgId).all<{ id: string }>();

  let updated = 0;
  for (const c of contacts.results) {
    try {
      await analyzeCommsPatterns(c.id, orgId, env);
      updated++;
    } catch (e) {
      console.error(`[comms-patterns] failed for ${c.id}:`, e);
    }
  }
  return updated;
}
