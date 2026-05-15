// Wave 6 — channel taxonomy.
//
// The corroboration model (Phase C's evaluateProposal) counts distinct
// CHANNELS, not API calls. A channel is an independent ORIGIN of
// information. Two observations from the same channel are zero
// corroboration — same source telling us the same thing twice. Two
// observations from different channels are corroboration of two.
//
// Examples / rules of thumb:
//
//   • Two email signatures from the same observing user's inbox across
//     time → ONE channel. (Same observer, same data path.)
//
//   • Same contact's phone observed in user A's mailbox and user B's
//     mailbox → TWO channels. (A and B are independent observers.)
//
//   • LinkedIn pull AND ReverseContact pull → ONE channel.
//     (ReverseContact pulls FROM LinkedIn — they share the same upstream
//     source. Counting them as two would be self-corroboration.)
//
//   • Email signature + transcript mention + manual edit → THREE channels.
//
// Channel keys are strings. Per-observer channels embed a stable id
// (userId, importId) so two observers on the same source kind stay
// distinct.
//
// Discipline note: callers don't construct channel strings directly.
// They call resolveChannel(source, ctx) so taxonomy lives in one place
// and unmapped sources surface a warning rather than silently producing
// a phantom channel.

export const CHANNEL = {
  // Per-observing-user. Same contact's signature seen in user A's vs
  // user B's mailbox = two channels. Format embeds userId so two
  // observers stay separated.
  EMAIL_SIGNATURE_INBOX: (userId: string) => `email_signature_inbox_${userId}`,

  // The "From: 'Name <addr>'" display name — distinct evidence path from
  // signature parsing, but still per-observer.
  EMAIL_DISPLAY_NAME_INBOX: (userId: string) => `email_display_name_inbox_${userId}`,

  // Meeting transcript mention. Single channel — the same fact stated
  // twice in the same meeting is one observation, not two.
  TRANSCRIPT_MENTION: 'transcript_mention',

  // Per-editing-user. A given user editing the same field again is the
  // same channel; two different humans editing separately = two
  // channels.
  MANUAL_EDIT: (userId: string) => `manual_edit_${userId}`,

  // LinkedIn data of any vintage — direct LinkedIn pull, ReverseContact,
  // any third-party that aggregates LinkedIn — all ONE channel because
  // the upstream source is the same. Adding a second LinkedIn-derived
  // signal does not corroborate; it's the same data path twice.
  LINKEDIN_DATA: 'linkedin_data',

  // Pitchbook (paid integration). Independent data path.
  PITCHBOOK: 'pitchbook',

  // Firefly attendee data — name+email of an attendee that came in via
  // a Firefly meeting invitation. Distinct from TRANSCRIPT_MENTION
  // (which is what was *said* in the meeting, not who was *invited*).
  FIREFLY_ATTENDEE_DATA: 'firefly_attendee_data',

  // Slack workspace member profile — display_name, profile.email,
  // status_text. Distinct from message content.
  SLACK_PROFILE: 'slack_profile',

  // Per-import. Each CSV import is its own channel (same importId on
  // re-import = same channel). Different files = different channels.
  IMPORTED_CSV: (importId: string) => `imported_csv_${importId}`,

  // LLM extracted from an inbound communication observed by a specific
  // user's inbox. Two extractions from different inboxes = two channels.
  // Two extractions from the same inbox (across time) = one channel —
  // we're saying "this observer's data path keeps surfacing the same
  // fact" which is not independent corroboration.
  LLM_EXTRACTION_INBOX: (userId: string) => `llm_extraction_inbox_${userId}`,

  // Daily-cron enrichment re-run. Aggregates LinkedIn + web + news but
  // arrives via a distinct compute path with its own potential failure
  // modes; treated as its own channel. Slight double-counting risk vs
  // direct LinkedIn pulls — accepted because enrichment runs at most
  // daily and produces one batch per entity per cycle.
  ENRICHMENT_AGGREGATED: 'enrichment_aggregated',

  // Historical default. Pre-Wave-6 values were backfilled into
  // entity_field_state with this single-channel attribution because we
  // don't know which path put them there. The evaluator treats any
  // incoming proposal as the 1st distinct channel against
  // historical_unknown — which produces correct corroboration math
  // (still need 3+ NEW channels to overwrite).
  HISTORICAL_UNKNOWN: 'historical_unknown',
} as const;

/**
 * Context fields needed by resolveChannel. All optional — sources that
 * don't have observer attribution can pass {} and we'll log + return a
 * fallback.
 */
export interface ChannelContext {
  /** Observing user — owns the inbox/transcript/edit. */
  userId?: string | null;
  /** CSV import id — for IMPORTED_CSV. */
  importId?: string | null;
  /** Source conversation id — purely for logging when channel resolution
   *  hits the fallback path. */
  conversationId?: string | null;
}

/**
 * Map a raw source identifier (the strings already in use across the
 * proposal-source code paths) to a canonical channel string.
 *
 * Returns a per-source-instance fallback channel and console.warns when
 * the source is unrecognized. Never throws — better to count an
 * unmapped source's observation as one channel than to drop it on the
 * floor and break corroboration math silently.
 */
export function resolveChannel(source: string, ctx: ChannelContext = {}): string {
  switch (source) {
    case 'email_signature':
      return CHANNEL.EMAIL_SIGNATURE_INBOX(ctx.userId || 'unknown');

    case 'display_name':
      return CHANNEL.EMAIL_DISPLAY_NAME_INBOX(ctx.userId || 'unknown');

    case 'transcript_mention':
    case 'meeting_transcript':
    case 'transcript_extraction':
      return CHANNEL.TRANSCRIPT_MENTION;

    case 'manual':
    case 'manual_edit':
    case 'human_edit':
      return CHANNEL.MANUAL_EDIT(ctx.userId || 'unknown');

    case 'linkedin':
    case 'linkedin_data':
    case 'linkedin_discovery':
    case 'reversecontact':
    case 'reversecontact_unverified':
      return CHANNEL.LINKEDIN_DATA;

    case 'pitchbook':
      return CHANNEL.PITCHBOOK;

    case 'firefly_attendee':
    case 'firefly_attendee_data':
      return CHANNEL.FIREFLY_ATTENDEE_DATA;

    case 'slack_profile':
      return CHANNEL.SLACK_PROFILE;

    case 'imported_csv':
    case 'csv_import':
      return CHANNEL.IMPORTED_CSV(ctx.importId || 'unknown');

    case 'llm_extraction':
    case 'web_enrichment':
    case 'web_enrichment_company':
    case 'fallback_web_search':
    case 'news_article':
      return CHANNEL.LLM_EXTRACTION_INBOX(ctx.userId || 'unknown');

    case 'enrichment':
      return CHANNEL.ENRICHMENT_AGGREGATED;

    case 'historical_unknown':
      return CHANNEL.HISTORICAL_UNKNOWN;

    default: {
      const safe = source.replace(/[^a-z0-9_]/gi, '_').slice(0, 60);
      console.warn(
        `[source-channels] unmapped source="${source}" ` +
          `(conversation=${ctx.conversationId || 'n/a'}) → falling back to source_${safe}`
      );
      return `source_${safe}`;
    }
  }
}
