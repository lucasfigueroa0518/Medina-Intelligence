-- MARTy Lab active-run guard.
-- Prevent duplicate active bootcamp/canary runs for the same org and suite.

CREATE UNIQUE INDEX IF NOT EXISTS idx_marty_lab_runs_one_active_org_suite
  ON marty_lab_runs (org_id, suite_name)
  WHERE status IN ('configured', 'running');
