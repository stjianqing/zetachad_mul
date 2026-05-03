-- Daily Gauntlet: track which SGT calendar day a run belongs to, with a
-- partial UNIQUE index enforcing "1 completed attempt per user per day."
ALTER TABLE runs ADD COLUMN daily_gauntlet_date DATE;

-- Enforce 1 *completed* attempt per user per day. Abandoned runs (never submitted)
-- don't lock the day — they have submitted_to_leaderboard=false and don't match.
CREATE UNIQUE INDEX runs_user_daily_gauntlet_idx
  ON runs (user_id, daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL AND submitted_to_leaderboard = true;

-- Speeds up "today's daily leaderboard" query.
CREATE INDEX runs_daily_gauntlet_date_idx
  ON runs (daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL;
