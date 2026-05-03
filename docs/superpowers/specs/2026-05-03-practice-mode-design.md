# Practice Mode — Design

**Status:** approved, ready for implementation plan
**Date:** 2026-05-03
**Route:** `https://zetachad.duckdns.org/practice`

## Summary

A new mode where a logged-in user can do a 2-minute drill biased toward their personally-weakest areas. The system identifies weakness from the user's last 500 attempts, buckets them into 18 predefined conceptual clusters (e.g. "multiplying 7, 8, 9 or 12 by numbers above 30"), and weights the question generator so that 70% of the drill targets the user's top 3 weak clusters and 30% is normal random play. Practice runs do not affect the leaderboard but their attempts feed back into future weakness analysis.

## Goals

- Surface real, conceptually-meaningful weak spots ("the 12-times table with big numbers") rather than per-question failures.
- Give a focused drill that feels like the existing game — same UI, same timer, same loop.
- Show the user *why* each cluster was chosen (transparency, motivation).
- Reuse existing systems (session store, generator, grader, submit pipeline) — practice is normal play with a different generator config and a flag.

## Non-goals (v1)

- Letting the user customize duration, weight ratio, or which clusters to practice.
- Real-time adaptive re-weighting mid-run.
- Per-cell drilling (e.g., "specifically practice 12×52 because you got it wrong once").
- Cross-user comparison or social features.
- Background pre-computation of weakness; analyzer runs on-request.

---

## The 18-cluster weakness model

The unit of weakness is a **cluster** — a 2D region in the (op, lhs, rhs) space defined by semantically meaningful boundaries derived from the production attempts dataset (4332 attempts across 8 users, 2026-04-26 to 2026-05-03).

### Multiplication — 6 clusters (2 axes)

Axis 1: **times-table difficulty group** (the smaller operand, lhs ∈ 2..12 by config):
- Easy: lhs ∈ {2, 5, 10}
- Medium: lhs ∈ {3, 4, 6, 11}
- Hard: lhs ∈ {7, 8, 9, 12}

Axis 2: **partner size** (the larger operand, rhs ∈ 2..100 by config):
- Small: rhs ≤ 30
- Large: rhs > 30

| id | label |
|---|---|
| `mul_easy_small` | Multiplying 2, 5 or 10 by numbers up to 30 |
| `mul_easy_large` | Multiplying 2, 5 or 10 by numbers above 30 |
| `mul_med_small`  | Multiplying 3, 4, 6 or 11 by numbers up to 30 |
| `mul_med_large`  | Multiplying 3, 4, 6 or 11 by numbers above 30 |
| `mul_hard_small` | Multiplying 7, 8, 9 or 12 by numbers up to 30 |
| `mul_hard_large` | Multiplying 7, 8, 9 or 12 by numbers above 30 |

### Division — 6 clusters (mirror of mul)

For division, `attempts.lhs` is the dividend and `attempts.rhs` is the divisor. The "table difficulty" axis is determined by the **answer** (`lhs / rhs`), since the divisor in the default config is in 2..12 (matching mul's lhs range). Conceptually, dividing by 7, 8, 9 or 12 is the inverse skill of multiplying by them.

Axis 1 — answer / divisor:
- Easy: divisor ∈ {2, 5, 10}
- Medium: divisor ∈ {3, 4, 6, 11}
- Hard: divisor ∈ {7, 8, 9, 12}

Axis 2 — dividend size:
- Small: dividend ≤ 300
- Large: dividend > 300

| id | label |
|---|---|
| `div_easy_small` | Dividing by 2, 5 or 10, dividends up to 300 |
| `div_easy_large` | Dividing by 2, 5 or 10, dividends above 300 |
| `div_med_small`  | Dividing by 3, 4, 6 or 11, dividends up to 300 |
| `div_med_large`  | Dividing by 3, 4, 6 or 11, dividends above 300 |
| `div_hard_small` | Dividing by 7, 8, 9 or 12, dividends up to 300 |
| `div_hard_large` | Dividing by 7, 8, 9 or 12, dividends above 300 |

### Addition — 3 clusters (1 axis)

Add doesn't have a "table" structure (lhs and rhs are symmetric in the default config, both 2..100). The data shows only a flat "bigger numbers = slower" effect. Bucket by `max(lhs, rhs)`:

| id | label |
|---|---|
| `add_small` | Adding numbers up to 20 |
| `add_med`   | Adding numbers between 21 and 50 |
| `add_large` | Adding numbers above 50 |

### Subtraction — 3 clusters (mirror of add)

| id | label |
|---|---|
| `sub_small` | Subtracting numbers up to 20 |
| `sub_med`   | Subtracting numbers between 21 and 50 |
| `sub_large` | Subtracting numbers above 50 |

**Total: 18 clusters.** The cluster definitions live as a frozen constant in `server/src/practice/clusters.js`, used by both the analyzer and the generator (single source of truth).

---

## Weakness scoring algorithm

```
score(c) = avgMs(c) − globalP50(op(c)) + wrongCount(c) × 1000
```

- **`avgMs(c)`** — average response time for the user's attempts in cluster c (last 500 attempts).
- **`globalP50(op)`** — population-wide median response time for that op, frozen as a constant in `clusters.js`. Current values, computed from the 2026-05-03 dataset:
  - `add`: 2125 ms
  - `sub`: 1898 ms
  - `mul`: 2661 ms
  - `div`: 2820 ms
- **`wrongCount(c)`** — count of incorrect attempts in cluster c. Penalty is 1 second per wrong answer. With observed ~1% wrong rates this rarely changes rankings, but ensures a slow-and-wrong cluster outranks a slow-only one.

**Why subtract `globalP50(op)`:** without normalisation, mul/div clusters always dominate rankings simply because mul takes longer than add. Subtracting the population median per-op surfaces the user's *relative* weakness — being 3 seconds slower than typical on hard mul beats being 0.5 seconds slower than typical on hard add.

**Why frozen constants instead of querying live:** the population p50 barely moves with more data, doesn't need a runtime query, and freezing it means a user's diagnosis is reproducible — their rankings don't shift just because someone else played fast yesterday. Constants are documented in `clusters.js` with the date and dataset they were computed from; a comment notes they should be re-derived if the dataset 10×s.

### Eligibility rules

A cluster is **eligible to rank** only if the user has ≥5 attempts in it from their last 500 (below 5, the average is too noisy).

A user qualifies for practice mode only if they have **≥50 lifetime attempts overall**. Below that, `/api/practice/diagnose` returns `{ topWeak: [], reason: "need_more_data" }`.

### Tie-breaking

If two clusters' scores are within 50 ms of each other, the one with more attempts wins (more confidence). Stable enough to avoid recommendation oscillation between visits.

### Top-N selection

Return the **top 3** clusters by score (descending). Three is enough to make a 2-minute run feel varied, few enough to display cleanly, and statistically more stable than top-5 with the current data volume.

---

## API

### `GET /api/practice/diagnose`

Auth: requires logged-in cookie session.

**200 response (eligible user):**
```json
{
  "totalAttemptsAnalyzed": 487,
  "topWeak": [
    { "id": "mul_hard_large", "label": "Multiplying 7, 8, 9 or 12 by numbers above 30",
      "n": 42, "avgMs": 8214 },
    { "id": "mul_hard_small", "label": "Multiplying 7, 8, 9 or 12 by numbers up to 30",
      "n": 38, "avgMs": 5102 },
    { "id": "div_hard_large", "label": "Dividing by 7, 8, 9 or 12, dividends above 300",
      "n": 29, "avgMs": 6877 }
  ]
}
```

**200 response (insufficient data):**
```json
{ "totalAttemptsAnalyzed": 12, "topWeak": [], "reason": "need_more_data" }
```

**401:** unauthenticated.

The `score` field is internal-only and not exposed.

### `POST /api/practice/start`

Auth: requires logged-in cookie session. Body: empty.

The server **re-runs** the analysis (does not trust client-supplied cluster ids) and creates a session.

**200 response:**
```json
{
  "sessionId": "abc123",
  "durationMs": 120000,
  "clusters": ["mul_hard_large", "mul_hard_small", "div_hard_large"]
}
```

**422 response (insufficient data):**
```json
{ "reason": "need_more_data" }
```

**401:** unauthenticated.

### `POST /api/play/answer` and `POST /api/leaderboard/submit`

**Unchanged endpoints, reused as-is.** The session knows it's a practice session (stored in session state, set by `/api/practice/start`), so when submit is called, the route writes `runs.practice = true` and skips the leaderboard insertion path. Submit response shape becomes `{ run_id, leaderboard: null }` for practice runs (instead of the rank object).

---

## Generator weighting

Current generator signature: `generate(config) → { op, lhs, rhs, answer }`.
New signature: `generate(config, weighting?) → { op, lhs, rhs, answer }`.

When `weighting` is supplied (only in practice sessions), the per-question algorithm is:

1. Roll a coin with `p = weighting.weakBias` (= 0.7).
2. **Heads (70%):** Pick one of the 3 weak cluster ids **uniformly at random**. Sample operands within that cluster's bounds.
   - Example: for `mul_hard_large`: lhs ∈ {7, 8, 9, 12} uniform, rhs ∈ [31, 100] uniform.
3. **Tails (30%):** Generate exactly as in normal play (full random across all 4 ops, full ranges).

**Why uniform among 3 (not score-weighted):** weighting by score makes the #1 weak cluster dominate (~50%), feeling grindy and lopsided. Uniform-among-3 gives ~23% to each weak cluster + ~30% random — varied without diluting the practice signal.

**Why 70/30:** 100% weak would be exhausting and pedagogically worse (variety helps consolidation, also surfaces *new* weak spots). 50/50 dilutes the signal too much. 70/30 ≈ 84 weak-cluster questions vs 36 random in a typical 120-question run.

`weakBias` and `topN` (= 3) live as named consts at the top of `practice.routes.js` for trivially-tunable iteration.

---

## Session state

Existing session shape (in `server/src/game/session.js`):
```js
{ userId, config, startedAt, durationMs, questions[], answers[] }
```

Practice sessions add two fields:
```js
{
  ...existing,
  practice: true,
  weighting: {
    clusters: ['mul_hard_large', 'mul_hard_small', 'div_hard_large'],
    weakBias: 0.7
  }
}
```

Normal-play sessions never set these fields, so existing behavior is unchanged. The next-question call reads `session.practice` and passes `session.weighting` to `generate()` when set.

---

## Submit path changes

`POST /api/leaderboard/submit` is the existing endpoint. Two minimal changes:

1. When `session.practice === true`:
   - Insert into `runs` with `practice = true` (new column from migration 006).
   - Skip the leaderboard rank computation and insertion entirely.
   - Return `{ run_id, leaderboard: null }` instead of the rank object.
2. The `attempts` rows are written exactly as in normal play.

This is what makes practice attempts feed back into the next weakness analysis — desirable per design (the model needs to know when you've improved).

### Note on the feedback loop

Practice biases questions toward weak clusters → those clusters accumulate more attempts → they get more sample weight in the next analysis. If you're improving, they drop in ranking faster (good); if not, they stay pinned (also fine, that's what practice is for). Self-correcting and intended. Future maintainers should not "fix" this by excluding practice attempts.

---

## Database migration

`server/migrations/006_runs_practice_flag.sql`:

```sql
ALTER TABLE runs ADD COLUMN practice BOOLEAN NOT NULL DEFAULT false;

-- Backfill not needed — all existing runs are non-practice (the default).

CREATE INDEX runs_practice_idx ON runs(user_id, played_at DESC) WHERE practice = false;
```

The partial index speeds up the leaderboard query, which must be updated to filter `WHERE practice = false`. Without the index, that filter would scan all runs.

**Other queries against `runs` that must be reviewed:**
- `board.routes.js` — leaderboard read and submit-rank computation: filter `WHERE practice = false`. Practice runs do not appear on or affect the leaderboard.
- `admin.routes.js` — multiple queries against `runs` for the admin dashboard. Default behavior: **include** practice runs in counts and per-user views (admin should see all activity). Add a column or visual indicator distinguishing practice vs leaderboard runs in the per-user runs view. Per-cluster heatmaps and time-bucket analytics in the dashboard should include practice runs (they're real attempts and reflect real user behavior). The implementation plan should enumerate each admin query and confirm the include/exclude decision.

---

## Client UX

### `/practice` route

A new static page (`client/practice.html`, `client/js/practice.js`). nginx config gets a new location block — the page itself is served from `/var/www/zetachad/practice.html`.

**Diagnosis screen (eligible user — Layout A, minimal list):**
- Title: "Practice mode"
- Subtitle: "A 2-minute run focused on your 3 weakest areas. Won't affect your leaderboard score."
- A list of the 3 weak clusters: each row shows the cluster `label`, attempt count, and `avgMs` formatted as e.g. "8.2s avg" in red.
- A primary "Start practice" button at the bottom.

**Diagnosis screen (need_more_data state):**
- Title: "Practice mode"
- Body: "Play a few normal rounds first — practice mode unlocks once we have enough data to find your weak spots." (50-attempt threshold not exposed numerically.)
- Primary button: "Go to play" → links to `/play`.

**During a practice run:**
- The existing play screen (`/play`) is reused. A small "PRACTICE" badge is rendered in a corner so the user remembers this isn't a leaderboard run.
- **How the client knows it's a practice run:** the `POST /api/practice/start` response includes a `practice: true` field. The `practice.html` page stores this (and the `sessionId`) in `sessionStorage` before redirecting to `/play`, and `play.js` reads `sessionStorage` on load to decide whether to render the badge and to choose the post-run copy. Using `sessionStorage` (not query param, not server round-trip) avoids URL pollution and survives a refresh of `/play`.

**Post-run screen:**
- The existing score screen, with the rank/leaderboard panel replaced by:
  - "Practice complete — your updated weak spots will be ready next time you visit /practice."
  - Two buttons: "Practice again" → `/practice`, "Play normally" → `/play`.

**Navigation:**
- Add a "Practice" link next to "Play" in the top nav on every page (`landing.html`, `play.html`, `leaderboard.html`, `practice.html`).

**Auth:**
- `/practice` requires login. Logged-out users hitting it are redirected to `/login?next=/practice`. Same pattern as existing protected pages.

### XSS hardening

The cluster labels are server-controlled constants and contain no user input, so they're safe to inject directly. The user-facing numbers (`n`, `avgMs`) are integers from the analyzer and similarly safe. No new `innerHTML` user-input paths are introduced.

---

## File changes summary

**New server files:**
- `server/src/practice/clusters.js` — cluster definitions, `bucketize(op, lhs, rhs) → clusterId`, `globalP50` constants, `topN` constant.
- `server/src/practice/analyzer.js` — `analyzeUser(userId, db) → { totalAttemptsAnalyzed, topWeak[], reason? }`.
- `server/src/routes/practice.routes.js` — the two endpoints; named consts for `weakBias`, `topN`.
- `server/test/unit/practice/clusters.test.js` — bucketize correctness, edge cases.
- `server/test/unit/practice/analyzer.test.js` — fixture-based scoring, eligibility, tie-breaking.
- `server/test/integration/practice.test.js` — end-to-end: diagnose → start → answer → submit (skipped when no `TEST_DATABASE_URL`).

**Modified server files:**
- `server/src/game/generator.js` — accept optional `weighting` param.
- `server/src/game/session.js` — store `practice`, `weighting` in session shape; pass `weighting` to generator.
- `server/src/routes/play.routes.js` — leave alone (no changes; submit lives in board.routes.js).
- `server/src/routes/board.routes.js` — submit path: when `session.practice`, write `runs.practice = true` and skip rank computation; leaderboard query filters `WHERE practice = false`.
- `server/src/index.js` — register the new practice routes plugin.

**New client files:**
- `client/practice.html`
- `client/js/practice.js`

**Modified client files:**
- `client/play.html` — render PRACTICE badge when in practice mode.
- `client/js/play.js` — read practice flag, suppress leaderboard rank panel post-run, render practice-complete copy + buttons.
- `client/index.html`, `client/leaderboard.html`, `client/login.html`, `client/register.html` — add Practice nav link.
- `client/css/*` — minor: badge styling, weak-spot list row styling.

**Migrations:**
- `server/migrations/006_runs_practice_flag.sql` (above).

**Deploy:**
- `deploy/nginx/zetachad-mul.conf` (or wherever the production nginx config lives) — add location block for `/practice` that serves the static page from the client root. (The `/api/practice/...` routes are already covered by the existing `/api/` proxy.)

---

## Test plan

**Unit tests:**
- `clusters.bucketize` — every op/operand combo maps to the correct cluster id; out-of-config inputs (e.g., div with rhs > 12) handled defensively.
- `analyzer.analyzeUser`:
  - Fresh user (0 attempts) → `need_more_data`.
  - User with 49 attempts → `need_more_data` (boundary).
  - User with 50 attempts but no cluster ≥5 → empty topWeak.
  - User with realistic distribution → top-3 ranked by score formula.
  - Tie-breaking: two clusters within 50ms → larger n wins.
  - Wrong-answer penalty applies.
- `generator.generate` with weighting:
  - 70/30 split holds within tolerance over N=10000 calls.
  - Weak-cluster picks are uniform across the 3 clusters.
  - Operands sampled fall within cluster bounds.

**Integration tests** (skip without `TEST_DATABASE_URL`):
- `GET /api/practice/diagnose` for a user with seeded attempts returns expected topWeak.
- `POST /api/practice/start` creates a session with `practice=true` and the right weighting.
- A full practice run: start → answer 5 questions → submit → row in `runs` has `practice=true` → no leaderboard insertion → attempts rows present.
- Practice attempts feed back into next diagnose call.

**Manual / VPS smoke test:**
- Eligible user: open `/practice`, see 3 weak spots, click Start, play 2 mins, see practice-complete screen.
- Insufficient-data user: open `/practice`, see "play a few rounds first" message.
- Unauthenticated: open `/practice` → redirect to `/login?next=/practice`.
- Practice run does not appear on the leaderboard.
- Subsequent diagnose call reflects the practice run's attempts.

---

## Constants summary (one place to look later)

| Constant | Value | Location | Reason |
|---|---|---|---|
| `weakBias` | 0.7 | `practice.routes.js` | 70% weak / 30% random — varied without diluting |
| `topN` | 3 | `practice.routes.js` | Few enough to display, varied enough to feel like practice |
| `MIN_LIFETIME_ATTEMPTS` | 50 | `analyzer.js` | Below this, no cluster has enough data |
| `MIN_CLUSTER_ATTEMPTS` | 5 | `analyzer.js` | Below this, cluster avg is too noisy |
| `RECENT_WINDOW` | 500 | `analyzer.js` | Last 500 attempts feed the analysis |
| `TIE_TOLERANCE_MS` | 50 | `analyzer.js` | Score differences below this are ties |
| `WRONG_PENALTY_MS` | 1000 | `analyzer.js` | Each wrong answer adds 1s to score |
| `globalP50.add/sub/mul/div` | 2125/1898/2661/2820 | `clusters.js` | Per-op normalization, frozen 2026-05-03 |

---

## Out of scope / future work

- Letting the user override the recommended clusters (e.g., "skip the 12s today").
- Custom duration for practice runs.
- A "practice history" view showing weak-spot trends over time.
- Cross-user comparisons ("you're slower than 80% of players on this cluster").
- Adaptive mid-run re-weighting.
- Re-deriving `globalP50` constants automatically from a maintenance job.
