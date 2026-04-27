CREATE TABLE attempts (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  q_index       INTEGER NOT NULL,
  op            TEXT NOT NULL,
  lhs           INTEGER NOT NULL,
  rhs           INTEGER NOT NULL,
  answer        INTEGER NOT NULL,
  user_answer   TEXT,
  response_ms   INTEGER NOT NULL,
  correct       BOOLEAN NOT NULL,
  asked_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX attempts_run_id_idx ON attempts(run_id);
CREATE INDEX attempts_op_idx     ON attempts(op);
