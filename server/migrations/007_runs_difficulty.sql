ALTER TABLE runs ADD COLUMN difficulty NUMERIC(4,2) NULL;

-- Speeds up leaderboard queries that may sort or filter on difficulty later.
-- Partial index because most analytics paths only care about scored runs.
CREATE INDEX runs_difficulty_idx ON runs(difficulty) WHERE difficulty IS NOT NULL;