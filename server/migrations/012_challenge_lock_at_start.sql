-- Lock-at-start for challenge mode: timestamp set when the recipient first
-- clicks START. /api/play/start (mode=challenge) does an atomic UPDATE
-- conditional on this column being NULL, guaranteeing one shot per challenge.
ALTER TABLE challenges ADD COLUMN recipient_started_at TIMESTAMPTZ;
