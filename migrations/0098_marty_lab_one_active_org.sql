-- MARTy Sandbox canary-only guard.
-- Keep the sandbox as a single human-reviewed lane per org, regardless of
-- suite name, so experimental runs cannot cross-contaminate each other.

CREATE UNIQUE INDEX IF NOT EXISTS idx_marty_lab_runs_one_active_org
  ON marty_lab_runs (org_id)
  WHERE status IN ('configured', 'running');
