-- Graph webhook subscriptions (Microsoft Graph push notifications)
CREATE TABLE IF NOT EXISTS graph_subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  subscription_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  expiration_at TEXT NOT NULL,
  client_state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_graph_sub_user ON graph_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_graph_sub_expiry ON graph_subscriptions(expiration_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_sub_subscription_id ON graph_subscriptions(subscription_id);
