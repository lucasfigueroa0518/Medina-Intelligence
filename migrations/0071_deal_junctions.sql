-- Phase B: first-class deal pointers for conversations + events
--
-- T6's audit revealed the structural ceiling: conversations and events have
-- no direct deal pointer. Every "what's about this deal" query routes
-- through deal_contacts → conversation_contacts → conversations (the
-- two-hop contact-overlap join). That join over-attributes (a contact at
-- the company on a separate side conversation appears) and under-attributes
-- (an internal user discussing the deal in a thread without any external
-- contact never appears).
--
-- These junction tables are the direct backbone. They populate from:
--   • Phase C: meeting-based deal detection (event_deals, source='llm_classification')
--   • Phase D: confidence ladder (auto_high / auto_medium / inherited_*)
--   • Phase E: Slack channel auto-linking (conversation_deals, source='inherited_channel')
--   • Phase F: manual link UI (source='manual')
--   • Approval-queue commit path: when a 'link_to_deal' proposal is approved
--
-- The contact-overlap path (PR #24's propagateContactToOpenDeals) stays as
-- the fallback evidence source. Direct links take precedence in
-- fetchDealConversations; contact-overlap fills in only where no direct
-- link exists.
--
-- Source enum (informational; not a CHECK constraint because new sources
-- will land as the wave progresses — soft-typed via TEXT):
--   auto_high            high-confidence rule (subject contains
--                        "<company> term sheet" + deal-language, etc.)
--   auto_medium          medium-confidence LLM classification (auto-link
--                        threshold, ≥ 0.9)
--   inherited_thread     reply on a thread already linked to a deal
--   inherited_channel    Slack channel linked to a deal — message inherits
--   inherited_series     recurring calendar series linked → all instances
--   manual               user clicked "Link to deal"
--   llm_classification   single-shot LLM tagging (Phase C / D)
--   approval_committed   approval_queue 'link_to_deal' proposal accepted
--
-- Confidence is informational on auto/inherited rows; manual is always 1.0.
-- An approved approval_queue proposal lands at 1.0 too (human ack).

CREATE TABLE IF NOT EXISTS conversation_deals (
  conversation_id TEXT NOT NULL,
  deal_id         TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  source          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by      TEXT,            -- nullable: user_id for 'manual', null for auto/system paths
  PRIMARY KEY (conversation_id, deal_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conv_deals_deal ON conversation_deals(deal_id);
CREATE INDEX IF NOT EXISTS idx_conv_deals_conv ON conversation_deals(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_deals_source ON conversation_deals(source);

CREATE TABLE IF NOT EXISTS event_deals (
  event_id    TEXT NOT NULL,
  deal_id     TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by  TEXT,
  PRIMARY KEY (event_id, deal_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_event_deals_deal ON event_deals(deal_id);
CREATE INDEX IF NOT EXISTS idx_event_deals_event ON event_deals(event_id);
CREATE INDEX IF NOT EXISTS idx_event_deals_source ON event_deals(source);
