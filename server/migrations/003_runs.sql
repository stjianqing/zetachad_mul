CREATE TABLE runs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  played_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runs_user_score_idx ON runs(user_id, score DESC);
