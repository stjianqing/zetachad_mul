-- Per-cluster global median response_ms, refreshed daily by MedianCache.
-- cluster_id values come from bucketize() in src/practice/clusters.js (e.g. 'mul_hard_large').
CREATE TABLE cluster_medians (
  cluster_id    TEXT PRIMARY KEY,
  median_ms     INTEGER NOT NULL,         -- median response_ms across non-practice correct attempts
  n             INTEGER NOT NULL,         -- attempts that contributed to this median
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
