-- Challenge Mode: persists challenger/recipient run links + share-link tokens.

ALTER TABLE runs ADD COLUMN seed BIGINT;

CREATE TABLE challenges (
  id                       BIGSERIAL PRIMARY KEY,
  challenger_run_id        BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  challenger_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id             BIGINT REFERENCES users(id) ON DELETE SET NULL,
  recipient_run_id         BIGINT REFERENCES runs(id) ON DELETE SET NULL,
  share_token              TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending',
  challenger_seen_result   BOOLEAN NOT NULL DEFAULT false,
  recipient_seen_result    BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at             TIMESTAMPTZ,
  CHECK (status IN ('pending','accepted','completed','forfeited','declined')),
  CHECK (challenger_id <> recipient_id OR recipient_id IS NULL)
);

CREATE UNIQUE INDEX challenges_share_token_idx
  ON challenges(share_token)
  WHERE share_token IS NOT NULL;

CREATE INDEX challenges_recipient_pending_idx
  ON challenges(recipient_id, status)
  WHERE status = 'pending';

CREATE INDEX challenges_challenger_idx
  ON challenges(challenger_id, created_at DESC);

CREATE INDEX challenges_sweep_idx
  ON challenges(status, responded_at)
  WHERE status = 'accepted';
