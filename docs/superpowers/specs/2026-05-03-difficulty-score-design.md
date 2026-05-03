# Run Difficulty Score — Design

**Date:** 2026-05-03
**Status:** Approved (brainstorm)
**Scope:** v1 display-only difficulty badge for completed runs.

## Problem

Some runs are obviously harder than others — single-digit addition vs. all-multiplication, easy operand ranges vs. hard ones. Today the leaderboard shows raw score and run length, with no signal about how hard the questions actually were. We want a per-run difficulty number so a viewer can tell at a glance that a 30-pt run was on hard questions or that a 50-pt run rode on easy ones.

The challenge: runs have different question counts. A naive sum makes long runs look harder by virtue of length; a naive average drowns rare hard questions in a sea of easies.

## Decision summary

- **Use:** display only. No effect on leaderboard ranking. (May revisit later.)
- **Computation:** time-weighted mean of per-question difficulty, normalized to a 0-10 scale, computed once at run-finalization and stored on the run.
- **Per-question difficulty:** derived from the global median response time of the question's cluster (using the existing 18-cluster `bucketize` from practice mode).
- **Median freshness:** in-memory cache, refreshed daily from a `cluster_medians` table of materialized medians.
- **Wrong answers:** included in *run* difficulty (their time still counts), excluded from *cluster median* calibration (we want medians of solved questions, not abandoned ones).
- **Practice runs:** excluded from median computation (biased question selection); still receive a difficulty score themselves.

## Per-question difficulty

For attempt `i` with `(op, lhs, rhs)`:

1. `clusterId = bucketize(op, lhs, rhs)` — the existing JS function from practice mode.
2. `m_c = medianCache.get(clusterId)` — the global median `response_ms` for that cluster, computed across all non-practice correct attempts.
3. Normalize to 0-10:

```
d_i = clamp(0, 10, 10 × (m_c − FLOOR_MS) / (CEIL_MS − FLOOR_MS))
```

with `FLOOR_MS = 1500`, `CEIL_MS = 7000`. These constants map raw cluster-median times onto the 0-10 dial. Calibration rationale: live data shows easy clusters cluster around 2s and the hardest (mul_hard_large) around 5-6s, so a 1.5–7s window spreads meaningfully without saturating either end.

If `bucketize` returns null (operand outside any cluster), the attempt is skipped from the difficulty computation.

If `medianCache.get(clusterId)` returns null (cluster has no data yet — possible early on, or for clusters that no one has hit), fall back to the median of all known cluster medians. If the cache is fully empty (cold start before first refresh ever runs), `D_run = null`.

## Run difficulty

Time-weighted mean across all attempts in the run, including wrong answers:

```
D_run = Σ(d_i × t_i) / Σ(t_i)
```

where `t_i = min(response_ms_i, TIME_CAP_MS)` with `TIME_CAP_MS = 15000` (15s). The cap keeps a single timeout from dominating the weighting. Final value is rounded to 2 decimals.

Edge case: `Σ(t_i) = 0` (empty run) → `D_run = null`.

## Storage

### Schema changes

**Migration `007_runs_difficulty.sql`:**

```sql
ALTER TABLE runs ADD COLUMN difficulty NUMERIC(4,2) NULL;
```

**Migration `008_cluster_medians.sql`:**

```sql
CREATE TABLE cluster_medians (
  cluster_id    TEXT PRIMARY KEY,
  median_ms     INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Why a table instead of a JSON file

- SQL is the source of truth that survives restarts.
- Lets the daily refresh be self-contained and inspectable (`SELECT * FROM cluster_medians`).
- The in-memory cache sits *on top* of this table — populated from it at startup and on refresh.

## Daily refresh

A `MedianCache` module (`server/src/run-difficulty/median-cache.js`):

- On server startup, reads `cluster_medians` into a `Map`.
- Schedules `setInterval(refresh, 24 * 60 * 60 * 1000)`.
- Exposes `get(clusterId)`, `getAll()`, `refresh()`.
- Hand-trigger admin endpoint: `POST /api/admin/refresh-medians` (gated by existing admin auth).

`refresh()` does the recomputation in Node, not SQL — `bucketize` is JS and we don't want a second implementation in SQL drifting out of sync.

```
1. SELECT a.op, a.lhs, a.rhs, a.response_ms
   FROM attempts a
   JOIN runs r ON r.id = a.run_id
   WHERE a.correct = true
     AND COALESCE(r.practice, false) = false
2. Bucket each row in JS via bucketize(); group response_ms by clusterId.
3. For each cluster, compute the median (sort + middle, or quickselect).
4. UPSERT into cluster_medians.
5. Reload the in-memory Map from the table.
```

Excluded from the median: practice attempts (biased question selection), wrong attempts (we want "how long to *solve* this", not "how long to give up").

The full table scan is cheap at current data volume (~3.5k attempts) and bounded by the `attempts_op_idx`. If volume grows past ~1M attempts, revisit.

## Compute path at run finalization

The current code path: when the time-up flush fires inside the session store, it inserts a row into `runs` and `attempts` rows for that session. The new step:

1. After collecting the in-memory attempts list for the session, call `computeRunDifficulty(attempts, medianCache)`.
2. Pass the resulting number (or `null`) into the existing `INSERT INTO runs (..., difficulty) VALUES (...)`.

`computeRunDifficulty` (pure function, in `server/src/run-difficulty/compute.js`):

```javascript
export function computeRunDifficulty(attempts, medianCache) {
  if (attempts.length === 0) return null;
  let weightedSum = 0;
  let totalTime = 0;
  for (const a of attempts) {
    const clusterId = bucketize(a.op, a.lhs, a.rhs);
    if (clusterId == null) continue;
    let m_c = medianCache.get(clusterId);
    if (m_c == null) m_c = medianCache.fallbackMedian();
    if (m_c == null) return null;
    const t = Math.min(a.response_ms, 15000);
    const d = Math.max(0, Math.min(10, 10 * (m_c - 1500) / (7000 - 1500)));
    weightedSum += d * t;
    totalTime += t;
  }
  if (totalTime === 0) return null;
  return Math.round((weightedSum / totalTime) * 100) / 100;
}
```

Note that `D_run` is computed **once** at finalization and never re-derived. Historical runs keep their original difficulty even as cluster medians drift over time. New runs use the latest medians. This keeps history stable and queries cheap.

## Backfill

One-shot script `server/scripts/backfill-difficulty.js`:

- Selects all `runs` rows where `difficulty IS NULL`.
- For each, pulls the run's attempts, calls `computeRunDifficulty`, UPDATEs.
- Idempotent: re-running only touches rows still null.
- Runs once on the VPS after migrations apply.

## Display

### Leaderboard (`leaderboard.html`)

New "Diff" column between Score and Played. Cell shows `7.2` (or `—` if null), with a subtle color band:

| Range | Color (CSS var) |
|---|---|
| ≤ 4 | `--lime` |
| 4 – 6 | `--cyan` |
| 6 – 8 | `--magenta` |
| ≥ 8 | `--orange` |

### Post-run summary

Add "Run difficulty: 7.2 / 10" near the score on the post-submit screen.

### Not in v1

- No difficulty badge on `index.html` (already crowded with champion + speed kings).
- No difficulty on the player's own run history (no current UI for that).

### API changes

- `GET /api/leaderboard` response: each entry gains `difficulty: 7.2 | null`.
- `GET /api/leaderboard/champion`, `/speed`: unchanged.

## Testing

### Unit tests for `computeRunDifficulty`

| Scenario | Expectation |
|---|---|
| Empty attempts list | `null` |
| Single-cluster, all-correct, uniform `response_ms` | Equals `clamp(0, 10, 10 × (m_c − 1500) / 5500)` |
| 40 easy + 5 hard, where time-weighted ≠ naive mean | Closer to hard difficulty than naive mean would be |
| Wrong answer + correct answer with same `response_ms` | Both contribute equally to weighting |
| `response_ms > 15000` | Time gets capped at 15000 in the weighting |
| Cluster median missing for one attempt's cluster | Falls back to the median of all known cluster medians |
| Cache fully empty (cold start) | `null` |
| `bucketize` returns null for some attempts | Those attempts are skipped; the rest still produce a value |

### Integration test

A full play → submit cycle inserts a row in `runs` with non-null `difficulty`. The stored value matches `computeRunDifficulty(attempts, medianCache)` recomputed from the attempts table.

### MedianCache test

Seed `attempts` with known data, call `refresh()`, verify cache contents match the median of seeded data per cluster. Verify practice runs are excluded.

## Out of scope (deliberately)

- Difficulty-adjusted leaderboard ranking.
- Difficulty tiers or segmented leaderboards.
- Per-player / skill-relative difficulty.
- Time-breakdown UI ("you spent 60% of your time on hard questions").
- Showing difficulty in the player's run history (no current UI for that view).

If the badge proves useful and players ask why it doesn't affect ranking, that's the trigger to revisit a difficulty-adjusted score.

## Files changed / created

**Created:**
- `server/migrations/007_runs_difficulty.sql`
- `server/migrations/008_cluster_medians.sql`
- `server/src/run-difficulty/compute.js`
- `server/src/run-difficulty/median-cache.js`
- `server/scripts/backfill-difficulty.js`
- `server/test/unit/run-difficulty.test.js`
- `server/test/integration/run-difficulty.test.js`

**Modified:**
- `server/src/index.js` — wire `MedianCache` into app lifecycle.
- `server/src/routes/play.routes.js` — call `computeRunDifficulty` at time-up flush, include `difficulty` in the existing INSERT into `runs`.
- `server/src/routes/board.routes.js` — return `difficulty` from `/api/leaderboard`.
- `server/src/routes/admin.routes.js` — add `POST /api/admin/refresh-medians`.
- `client/leaderboard.html`, `client/js/leaderboard.js`, `client/css/styles.css` — Diff column.
- `client/play.html`, `client/js/play.js` — post-run summary line.
- `deploy/deploy-scp.sh` — ship new server files (already wholesale-syncs `src/` and `migrations/`, so no manifest change; verify).
