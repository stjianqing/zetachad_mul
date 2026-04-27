ALTER TABLE runs ADD COLUMN submitted_to_leaderboard BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every existing row in runs was inserted at submit time
-- (pre-migration code only created runs rows on /api/leaderboard/submit),
-- so they are all submitted-eligible.
UPDATE runs SET submitted_to_leaderboard = true;

CREATE INDEX runs_played_at_idx ON runs(played_at DESC);
