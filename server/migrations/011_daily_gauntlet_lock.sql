-- Replace the partial UNIQUE index so any daily-gauntlet row (lock or completed)
-- locks the day for that user. The lock row is inserted at /api/play/start
-- and UPDATEd in place when the run completes.
DROP INDEX IF EXISTS runs_user_daily_gauntlet_idx;

CREATE UNIQUE INDEX runs_user_daily_gauntlet_idx
  ON runs (user_id, daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL;
