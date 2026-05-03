ALTER TABLE runs ADD COLUMN practice BOOLEAN NOT NULL DEFAULT false;

-- All existing rows get practice=false via the DEFAULT.
-- No backfill needed.

-- Speeds up future analytics queries that distinguish practice from leaderboard runs.
CREATE INDEX runs_practice_idx ON runs(user_id, played_at DESC) WHERE practice = true;
