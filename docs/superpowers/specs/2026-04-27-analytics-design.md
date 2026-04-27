# Analytics Database & Admin Dashboard — Design Spec

**Date:** 2026-04-27
**Status:** Approved, ready for plan

## Goal

Capture per-question data for every completed default-config run by a logged-in user, and expose an admin-only dashboard at `/admin/` that mirrors the analytics surface of the single-player zetachad reference (history page) — score-over-time, per-op summary, weak spots, mul/div heatmaps, sessions table, session detail. Dashboard answers the user's question "is hosting this server worth it?"

## Cohort

Analytics records **only**:
- Logged-in users (`session.userId != null`)
- Default config runs (`isDefaultConfig(session.config) === true`)

Guests, custom-config runs, and any other variation: zero rows written.

## Run inclusion: drill end vs. submit

- A run is **persisted to the database** when the drill ends server-side (the `/api/play/answer` time-up branch). Both the `runs` row and all its `attempts` rows are inserted in a single transaction at this moment.
- Whether the run appears on the public leaderboard is a separate flag (`submitted_to_leaderboard`) flipped by `/api/leaderboard/submit`.
- Mid-drill abandonment (browser closed before time-up): no write. Acceptable — abandoned runs are noise.

## Architecture

```
play.js  ── POST /api/play/answer ──►  play.routes.js
                                          │ session.answer() grades + advances
                                          │ if recordsAttempts(session):
                                          │   stage attempt in session.attempts[]
                                          │
                                          │ on time-up:
                                          ▼
                                       INSERT runs RETURNING id
                                       INSERT attempts (bulk)  -- one txn
                                       session.runId = id

play.js  ── POST /api/leaderboard/submit ──►  board.routes.js
                                                UPDATE runs SET submitted_to_leaderboard = true
                                                compute rank

admin/index.html  ── GET /admin/api/* ──►  admin.routes.js
                                              SQL aggregations over runs + attempts
                                          ▲
                       nginx Basic Auth ──┘  (gate at edge)
```

Server-measured timing: for question N, `response_ms = answer_arrival_time(N) − answer_arrival_time(N-1)`; question 0 measured from `session.startedAt`. Includes network RTT (~30–80ms typical) but is consistent across all measurements.

## Database schema

### Migration 004_attempts.sql

```sql
CREATE TABLE attempts (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  q_index       INTEGER NOT NULL,
  op            TEXT NOT NULL,            -- 'add' | 'sub' | 'mul' | 'div'
  lhs           INTEGER NOT NULL,
  rhs           INTEGER NOT NULL,
  answer        INTEGER NOT NULL,
  user_answer   TEXT,                     -- preserves leading zeros, empty, non-numeric; NULL on timeout
  response_ms   INTEGER NOT NULL,
  correct       BOOLEAN NOT NULL,
  asked_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX attempts_run_id_idx ON attempts(run_id);
CREATE INDEX attempts_op_idx     ON attempts(op);
```

### Migration 005_runs_leaderboard_flag.sql

```sql
ALTER TABLE runs ADD COLUMN submitted_to_leaderboard BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing runs were all submitted (today, runs are inserted only at submit).
UPDATE runs SET submitted_to_leaderboard = true;

CREATE INDEX runs_played_at_idx ON runs(played_at DESC);
```

All timestamps are `TIMESTAMPTZ` (Postgres stores UTC). Singapore Time (UTC+8) display is a render-time concern only.

## Server changes

### `server/src/game/session.js`

Session record gains:
- `attempts: []` — staged per-question rows for this run.
- `lastQuestionAskedAt: number` — initialized to `startedAt`.
- `runId: number | null` — set by the route after the time-up flush.

New helper:
```js
function recordsAttempts(session) {
  return session.userId != null && isDefaultConfig(session.config);
}
```

Inside `answer(sessionId, userAnswer)`, before the question advance, when `recordsAttempts(session)`:
- Compute `responseMs = t - session.lastQuestionAskedAt`.
- Push to `session.attempts`:
  ```js
  {
    qIndex: session.attempts.length,
    op: session.currentQuestion.op,
    lhs: session.currentQuestion.lhs,
    rhs: session.currentQuestion.rhs,
    answer: session.currentQuestion.answer,
    userAnswer,                          // raw string from client
    responseMs,
    correct,
    askedAt: new Date(session.lastQuestionAskedAt)
  }
  ```
- Update `session.lastQuestionAskedAt = t`.

New method `takeRunRecord(sessionId)`:
- Returns `{ userId, score, durationMs, attempts }` and clears `session.attempts`.
- Called by the route after `r.timeUp` is observed.

### `server/src/routes/play.routes.js`

- Accept `pool` in route options.
- After `sessionStore.answer(...)` returns `r.timeUp === true`:
  - If the session was a recording session (had attempts staged), call `sessionStore.takeRunRecord(sessionId)`.
  - Open a transaction:
    ```sql
    INSERT INTO runs (user_id, score, duration_ms) VALUES ($1, $2, $3) RETURNING id;
    INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
    VALUES ...;  -- bulk, one row per staged attempt
    COMMIT;
    ```
  - Store the new `run_id` on the in-memory session (`session.runId`) so submit can find it.
- DB failure during this flush is logged but **does not** propagate to the client. The player still receives the normal `time_up: true` response with `final_score`. Only the analytics record for that one run is lost. `session.runId` remains `null`, so a subsequent submit attempt for this session returns `409 not_finalized` (rare; logged for follow-up).

### `server/src/routes/board.routes.js`

`/api/leaderboard/submit` becomes a flag flip. Order of checks (matches existing 401/403/422 semantics):
1. `requireAuth` (existing, returns 401).
2. Owner check `session.userId === req.user.id` (existing, 403).
3. Eligibility via `sessionStore.finish(session_id)` (existing — returns `qualifies: false` → 422 for custom-config).
4. Idempotency check (existing — `session.submitted` short-circuits).
5. **New:** look up `session.runId`. If absent (DB flush at time-up failed), return `409 not_finalized`.
6. **New behavior:** instead of `INSERT INTO runs ...`, do `UPDATE runs SET submitted_to_leaderboard = true WHERE id = $1`.
7. Existing rank computation: update both inner queries to filter `WHERE submitted_to_leaderboard = true` so unsubmitted runs don't move the leaderboard.

`GET /api/leaderboard` query: add `WHERE b.submitted_to_leaderboard = true` (or filter inside the DISTINCT ON CTE).

### `server/src/routes/admin.routes.js` (new)

See "Admin API endpoints" below. Mounted under `/admin/api/`.

### `server/src/index.js`

- Pass `pool` to `playRoutes`.
- Register `adminRoutes` with `pool`.

## Admin API endpoints

All under `/admin/api/`. All read-only. All gated by `requireAdmin` preHandler (Section: Auth). JSON, snake_case keys.

### `GET /admin/api/players`
```json
{ "players": [
  { "user_id": 1, "username": "alice", "run_count": 12,
    "best_score": 47, "last_played_at": "2026-04-27T05:30:00Z",
    "total_attempts": 480 }
]}
```

### `GET /admin/api/runs?user_id=<id>&limit=<n>&offset=<n>`
`user_id` optional; `limit` defaults to 50, max 200.
```json
{ "runs": [
  { "run_id": 42, "user_id": 1, "username": "alice", "score": 38,
    "duration_ms": 120000, "played_at": "2026-04-27T05:30:00Z",
    "submitted_to_leaderboard": true, "attempts_count": 41,
    "accuracy_pct": 92.7, "mean_response_ms": 2854 }
], "total": 12 }
```

### `GET /admin/api/runs/:run_id/attempts`
```json
{ "run": { "run_id": 42, "user_id": 1, "username": "alice", "score": 38,
           "duration_ms": 120000, "played_at": "2026-04-27T05:30:00Z",
           "submitted_to_leaderboard": true, "attempts_count": 41,
           "accuracy_pct": 92.7, "mean_response_ms": 2854 },
  "attempts": [
    { "q_index": 0, "op": "mul", "lhs": 7, "rhs": 8, "answer": 56,
      "user_answer": "56", "response_ms": 2310, "correct": true,
      "asked_at": "2026-04-27T05:30:00Z" }
  ]}
```

### `GET /admin/api/per-op?user_id=<id>`
`user_id` optional (omit for all-players aggregate).
```json
{ "per_op": [
  { "op": "add", "attempts": 120, "correct": 115,
    "accuracy_pct": 95.8, "mean_response_ms": 1820, "median_response_ms": 1700 },
  { "op": "sub", ... },
  { "op": "mul", ... },
  { "op": "div", ... }
]}
```

### `GET /admin/api/heatmap?op=<mul|div>&user_id=<id>`
`user_id` optional.
```json
{ "op": "mul",
  "cells": [
    { "lhs": 7, "rhs": 8, "attempts": 14, "correct": 13,
      "mean_response_ms": 2400, "accuracy_pct": 92.9 }
  ]}
```
Cells with zero attempts omitted; client renders blanks.

### `GET /admin/api/weak-spots?user_id=<id>`
Buckets with `attempts >= 10` only.
```json
{ "slowest": [
    { "op": "mul", "lhs": 7, "rhs": 8, "attempts": 14, "mean_response_ms": 4200 }
  ],
  "least_accurate": [
    { "op": "div", "lhs": 12, "rhs": 96, "attempts": 11, "accuracy_pct": 54.5 }
  ]}
```

### `GET /admin/api/score-timeseries?user_id=<id>&window=<7|30|all>`
One point per run, ordered by `played_at` ascending. `user_id` optional (omit → returns all players' points in one flat array; the client groups by `username` to render one line per player).
```json
{ "points": [
  { "played_at": "2026-04-27T05:30:00Z", "score": 38,
    "run_id": 42, "username": "alice" }
]}
```
`window=7` filters `played_at >= now() - interval '7 days'`. `window=30` similar. `window=all` no filter.

## Auth for the admin surface

### Layer 1 — nginx Basic Auth (primary)

```nginx
location /admin/ {
  auth_basic           "ZetaChad admin";
  auth_basic_user_file /etc/nginx/zetachad-admin.htpasswd;
  alias                /var/www/zetachad-mul/admin/;
  try_files            $uri $uri/ =404;
}

location /admin/api/ {
  auth_basic           "ZetaChad admin";
  auth_basic_user_file /etc/nginx/zetachad-admin.htpasswd;
  proxy_pass           http://127.0.0.1:3000/admin/api/;
  proxy_set_header     Host $host;
}
```

One-time bootstrap on the VPS:
```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -cB /etc/nginx/zetachad-admin.htpasswd stjianqing
# enter: tns6e123
sudo chown root:www-data /etc/nginx/zetachad-admin.htpasswd
sudo chmod 640 /etc/nginx/zetachad-admin.htpasswd
sudo nginx -t && sudo systemctl reload nginx
```

Credentials live only on the VPS in `/etc/nginx/zetachad-admin.htpasswd`. Never in the repo, deploy scripts, or env vars.

### Layer 2 — Fastify defense-in-depth

Shared preHandler `requireAdmin` on every `/admin/api/*` route:
- Reject (401) if `req.headers['authorization']` is missing or doesn't start with `Basic `.
- Does **not** re-validate the password (nginx already did). Purpose: refuse requests that bypassed nginx (e.g., direct hit to port 3000 from inside the VPS).

Player auth (cookie-based `requireAuth` on `/api/...`) is unchanged and unrelated to admin auth.

## Dashboard frontend

### Files
```
client/admin/
  index.html
  css/admin.css
  js/admin.js          -- page controller
  js/admin-api.js      -- fetch wrapper
  js/heatmap.js        -- canvas heatmap renderer
  js/chart.js          -- SVG line chart renderer
```

Vanilla browser ESM. No framework. No build step. Deployed to `/var/www/zetachad-mul/admin/`.

### Page layout (top → bottom)

1. **Header bar** — title, player picker (`All players` + each player from `/admin/api/players`), window selector (7 / 30 / all).
2. **Activity leaderboard** *(only when "All players" selected)* — table from `/admin/api/players`, sorted by `run_count` desc.
3. **Score over time** — line chart from `/admin/api/score-timeseries`. One line per player when "All players".
4. **Per-op summary** — four cards (add / sub / mul / div) from `/admin/api/per-op`.
5. **Weak spots** — two columns from `/admin/api/weak-spots`: slowest left, least accurate right.
6. **Multiplication heatmap** — canvas grid, lhs 2..12 × rhs 2..100. Color: linear from p10 to p90 of mean response times. Hover tooltip shows ms + attempts.
7. **Division heatmap** — same shape as #6, `?op=div`.
8. **Sessions table** — paginated, click row to expand.
9. **Session detail panel** — inline expansion, full question log from `/admin/api/runs/:id/attempts`.

### Time display

All `played_at` and `asked_at` rendered via `Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', ... })`. Single helper in `admin-api.js`.

### State

No client-side caching. Player picker / window change re-fetches everything. Data volume is small at this scale.

## Deployment

### Repo additions
- `client/admin/` directory (new).
- Update `deploy/nginx-zetachad.conf` template — add the two `location /admin/...` blocks.
- Update `deploy/deploy.sh` — rsync `client/admin/` to `/var/www/zetachad-mul/admin/` alongside the existing client rsync.

### One-time VPS bootstrap
Documented in `docs/deploy-runbook.md` under a new "Admin dashboard setup" section. Not run by `deploy.sh`. See nginx Basic Auth bootstrap above.

### Migrations
`004_attempts.sql` and `005_runs_leaderboard_flag.sql` run automatically on server startup via the existing `migrate(pool)` call.

### Rollout sequence
1. Push to main.
2. SSH to VPS, `git pull`.
3. Run server rsync (server picks up new routes + migrations on restart).
4. Run admin client rsync.
5. Update nginx config + reload.
6. Run htpasswd bootstrap (first deploy only).
7. Restart `zetachad` systemd unit.

### Backups
Existing nightly `pg_dump` covers the new tables. No change.

## Testing strategy

### Unit (`server/test/unit/`)

- `session.test.js` (extend):
  - Attempts staged for logged-in default-config sessions only.
  - Not staged for guest sessions.
  - Not staged for custom-config sessions.
  - `responseMs` math correct against fake clock.
  - `takeRunRecord` returns the staged data and clears it.

- `attempts.test.js` (new) — exercise SQL aggregation helpers if they're factored out of route handlers; otherwise covered by integration tests.

### Integration (`server/test/integration/`)

- `play.test.js` (extend):
  - Time-up on logged-in default-config run inserts one `runs` row + N `attempts` rows in a single transaction.
  - Time-up on guest run writes nothing.
  - Time-up on custom-config run writes nothing.
  - DB failure during flush does not break the time-up response to the client.

- `board.test.js` (extend):
  - Submit flips `submitted_to_leaderboard` to true.
  - Public leaderboard query excludes `submitted_to_leaderboard = false`.
  - Rank computation uses only submitted runs.

- `admin.test.js` (new) — every endpoint:
  - Returns 401 without `Authorization: Basic ...` header.
  - Returns sane data with the header present.
  - Cohort filter holds: guest sessions never appear; custom-config runs never appear.

### Smoke test post-deploy

1. Log in, finish a drill, click Submit. Check `/admin/api/runs?user_id=X` shows the run.
2. Log in, finish a drill, click "No thanks". Run appears in admin but not on public `/api/leaderboard`.
3. Guest finishes a drill. Nothing in admin.
4. `/admin/` without credentials → nginx Basic Auth prompt. Wrong → reject. Right → page loads.
5. Open dashboard, switch player picker, switch window, click a sessions row, hover a heatmap cell. Everything renders.

## Out of scope

- Real-time updates / websockets. Refresh the page to see new data.
- Export / wipe data buttons. Add later if useful.
- Per-player password (the dashboard is for a single admin).
- Mobile-friendly admin layout. Desktop only.
- IP-level analytics. We don't track IP for analytics.
- Charts beyond line chart (no bar / pie / etc).
