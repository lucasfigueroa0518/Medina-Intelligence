-- Prevent duplicate in-flight MARTy turns when the browser retries after a
-- dropped stream. Keep the newest running row per session and mark older
-- duplicates stale before adding the partial unique index.

WITH ranked_running AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM agent_messages
  WHERE role = 'assistant'
    AND json_extract(metadata, '$.status') = 'running'
)
UPDATE agent_messages
SET content = CASE
      WHEN content = '' THEN 'This MARTy response was superseded by a newer in-flight response for the same session.'
      ELSE content
    END,
    metadata = json_set(
      CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}') ELSE '{}' END,
      '$.status', 'error',
      '$.error', 'REQUEST_SUPERSEDED',
      '$.retryable', 1
    )
WHERE id IN (
  SELECT id
  FROM ranked_running
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_one_running_assistant_per_session
  ON agent_messages(session_id)
  WHERE role = 'assistant'
    AND json_extract(metadata, '$.status') = 'running';
