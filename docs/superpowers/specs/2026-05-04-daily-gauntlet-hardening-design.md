# Daily Gauntlet Hardening — Design

## Problem

Two issues with the shipped Daily Gauntlet:

1. **Free mulligans.** The seed is deterministic from the SGT date — every player gets the same 60 questions. But the run is only persisted on completion, so a player who abandons mid-run (alt-F4, navigate away, kill the tab) leaves no trace and can immediately restart the same questions. Determinism + free retries = grindable leaderboard.
2. **Too long.** 60 questions is more grind than challenge. Drop to 20 to keep it a sharp daily ritual.

## Goal

- Starting a Daily Gauntlet attempt locks today for that user. Abandoning doesn't free the lock — there's exactly one shot per SGT day, finished or not.
- Reduce attempt length from 60 to 20 questions.
- Auto-submit on the 20th correct answer (already true — keep it).
- Locked-out users see a clear "you forfeited today" message, not a confusing dead-end.

## Why this fits zetachad_mul

- **Reuses the existing `runs` row + partial UNIQUE index.** We change *when* the row is written (at start, not at finish) and what `submitted_to_leaderboard` means (set once on finish), so the existing schema enforces one-shot-per-day for free.
- **Reuses session store.** Only constants and a single new persistence call change.
- **No new tables.** No daemon. No heartbeat. No client-side resume code.

## Out of scope

- Grace period / heartbeat / resume on disconnect. (Hard lock, by user choice.)
- Backfilling the leaderboard from the dropped 60-question rows.
- Migrating in-flight 60-question sessions at deploy time. The next deploy invalidates any active session naturally.
- Anti-cheat for sub-Nsec finishes (already deferred in the original spec).

---

## Behavior changes — at a glance

| | Before | After |
|---|---|---|
| Question count | 60 | 20 |
| Lock created | On 60th correct answer | On `/api/play/start` for daily-gauntlet |
| Abandon mid-run | Free retry, same questions | Locked until tomorrow (SGT) |
| Re-`/start` while session live | New session, no error | 200 `{ already_started: true, ... }` — UI redirects to forfeit/locked state |
| Re-`/start` after completion | 200 `{ already_completed: true, ... }` | Unchanged |
| Auto-submit on finish | Yes | Yes (unchanged) |

---

## User flow

### Logged-in user, first time today

1. Lands on `index.html`. Daily Hero shows `START`.
2. Clicks `START`. `play.html?mode=daily-gauntlet`.
3. `/api/play/start` with `mode: "daily-gauntlet"`:
   - Server checks `runs` for any row with `(user_id, daily_gauntlet_date=today_sgt)`. None found.
   - Server creates an in-memory session **and** inserts a `runs` row with `daily_gauntlet_date=today_sgt`, `submitted_to_leaderboard=false`, `score=0`, `duration_ms=0`. The row is the lock.
   - Server stashes `runId` on the session for the eventual finish update.
   - Returns first question + `{ mode, total_questions: 20, question_index: 0 }`.
4. Player plays. HUD shows `Q N/20`, count-up timer.
5. On 20th correct answer, server `UPDATE`s the existing row: `score=20`, `duration_ms=<elapsed>`, `submitted_to_leaderboard=true`. Then writes attempts. Returns `{ time_up: true, daily_gauntlet: true, time_ms, rank, total_today }`.
6. Score view renders.

### Logged-in user, abandoned a previous attempt today

1. Lands on `index.html`. Daily Hero shows **forfeit state** (see Frontend below).
2. If they navigate to `play.html?mode=daily-gauntlet` directly, `/api/play/start`:
   - Finds an existing row for today with `submitted_to_leaderboard=false`. Returns `{ already_started: true, forfeited: true }`.
   - Client redirects to `index.html`.

### Logged-in user, completed today

Unchanged — the existing `already_completed` branch fires. No client behavior change.

### Day rollover mid-run

The lock row's `daily_gauntlet_date` is captured at session start (using SGT today at start). Completion `UPDATE`s that same row. So a run started at 23:58 SGT and finished at 00:02 SGT counts for *yesterday* — and tomorrow's SGT day is unlocked. No change from the original spec.

### Server restart mid-run

The lock row exists. The in-memory session is gone. Player's next `/api/play/answer` returns 404. Player lands on `index.html` and sees forfeit state for today. **They've burned their attempt.** This is the intended hard-lock behavior; we don't try to be clever.

---

## Backend design

### Schema

**No migration needed.** The existing partial UNIQUE index `(user_id, daily_gauntlet_date) WHERE submitted_to_leaderboard = true` is wrong for our new semantics — we need uniqueness regardless of submission status.

**New migration `011_daily_gauntlet_lock.sql`:**

```sql
-- Replace the partial UNIQUE index so any daily-gauntlet row (started or finished)
-- locks the day for that user. The lock row is inserted at /start, updated at finish.
DROP INDEX IF EXISTS runs_user_daily_gauntlet_idx;

CREATE UNIQUE INDEX runs_user_daily_gauntlet_idx
  ON runs (user_id, daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL;
```

The `runs_daily_gauntlet_date_idx` (used by leaderboard queries) is unchanged.

**Existing column nullability:** `runs.score` and `runs.duration_ms` are NOT NULL today. The lock row needs to satisfy them. We insert with `score=0, duration_ms=0` and update on finish. No schema change needed.

**Leaderboard queries** must continue to filter on `submitted_to_leaderboard = true` so unfinished lock rows don't pollute today's rankings. They already do — `board.routes.js` and `play.routes.js:118-122` both filter on it. Audit and confirm during implementation.

### Question count

In `server/src/game/session.js:53`, change:

```js
totalQuestions: isDailyGauntlet ? 60 : null,
```

to:

```js
totalQuestions: isDailyGauntlet ? 20 : null,
```

That's the only server-side place the count appears. No magic numbers leaked into routes.

### Lock-at-start logic in `play.routes.js`

In the `mode === 'daily-gauntlet'` branch of `POST /api/play/start`:

1. Compute `today_sgt = todaySgtDateString()`.
2. Query `runs` for any row matching `(user_id = req.user.id, daily_gauntlet_date = today_sgt)`. Return the row's `id`, `duration_ms`, `played_at`, `submitted_to_leaderboard`.
3. Branch on result:
   - **No row:** insert a lock row in a transaction:
     ```sql
     INSERT INTO runs (user_id, score, duration_ms, practice, daily_gauntlet_date, submitted_to_leaderboard, seed)
     VALUES ($1, 0, 0, false, $2, false, $3)
     RETURNING id
     ```
     where `$3 = dateStringToSeed(today_sgt)`. Then create the in-memory session, set `session.runId = <inserted id>`. Return first question.
   - **Row exists, `submitted_to_leaderboard = true`:** return `{ already_completed: true, time_ms, rank }` (existing behavior).
   - **Row exists, `submitted_to_leaderboard = false`:** return `{ already_started: true, forfeited: true }`. (See Forfeit semantics below.)

**Race condition (rapid double-tap on START):** Two `/start` requests interleave; both see "no row" and both attempt INSERT. The UNIQUE index makes the second INSERT raise PG `23505`. Server catches it, refetches the row, returns `{ already_started: true, forfeited: false }` — because the *other* attempt is the one holding the lock, not a forfeit. The first request gets the legitimate session; the second gets a "you're already in another tab" response. Client treats this exactly like the forfeit case (redirect to landing) since we can't tell from the user's POV which tab is real anyway.

### Finish logic in `play.routes.js`

The current `flushRunIfRecording` function INSERTs the run + attempts on completion. For daily-gauntlet sessions we now need to **UPDATE the existing lock row** instead of inserting a new one.

Refactor `flushRunIfRecording` to branch on `session.runId`:

- **`session.runId == null`:** insert a new `runs` row (existing behavior for normal/practice modes).
- **`session.runId != null`** (daily-gauntlet, lock row pre-existing): UPDATE the row with the final score, duration, difficulty, then proceed to insert attempts using the pre-existing `runId`.

The transaction structure is the same; only the first statement changes from INSERT to UPDATE.

**Edge: lock row exists but session.runId got lost (e.g. test seam, bug).** The UPDATE-by-id touches zero rows. Guard: if `UPDATE ... RETURNING id` returns zero rows, log an error and fall through to the existing INSERT path. Defense in depth; in normal operation this never fires.

### Forfeit semantics (what the lock row "means" while unfinished)

A row with `daily_gauntlet_date IS NOT NULL AND submitted_to_leaderboard = false` is the lock. Its existence means "this user used today's attempt." We don't try to distinguish "currently playing in another tab" from "abandoned an hour ago" because:
- We can't tell reliably (no heartbeat).
- The user-visible answer is the same: "you've used your shot today."
- Concurrent dual-tab play is rare and self-correcting (only one tab can complete; the other gets a 404 on `/answer`).

UI shows the same forfeit state for both. (See Frontend.)

### Routes — full diff summary

**`POST /api/play/start`** (daily-gauntlet branch): adds the lock-row INSERT; adds the `already_started` response; returns `total_questions: 20`.

**`POST /api/play/answer`**: no behavioral change. The `r.timeUp` branch already calls `flushRunIfRecording` which now UPDATEs instead of INSERTs for daily-gauntlet sessions.

**`GET /api/leaderboard/daily`** + **`/me`**: no change. They already filter `submitted_to_leaderboard = true`, so lock rows don't appear.

---

## Frontend design

### `client/js/play.js`

- The redirect path in the existing `already_completed` handler stays.
- Add an `already_started` handler in the same place: when `/api/play/start` returns `{ already_started: true }`, redirect to `index.html?forfeit=1` (query param triggers landing-page toast — see below).
- The progress bar and `Q N/20` rendering are already driven by `total_questions` from the server payload, so reducing to 20 needs no client code change beyond verifying the math (no hardcoded `60` exists in `play.js`).

### `client/js/landing.js`

Three places mention `60`:

1. Line 31: `"Sixty problems. One you. Good luck."` taunt copy. Either update to `"Twenty problems. One you. Good luck."` or drop the count from the line entirely. **Recommendation: drop the count** — keeps the line evergreen if we ever tweak again. Replace with: `"Twenty problems. Don't waste them."` (or another acerbic variant — final wording at implementation).
2. Line 163: subtitle `'60 questions, 1 shot. Same drill worldwide today.'` → `'20 questions, 1 shot. Same drill worldwide today.'`.
3. Daily Hero forfeit state (new): when the calling user has a lock row but no completion (queried via `/api/leaderboard/daily/me` — see below), render forfeit state instead of "not played" or "completed":

   ```
   ┌──────────────────────────────────────────────────────────┐
   │ FORFEITED — see you tomorrow.                  ✗ LOCKED   │   (greyed border, dim button)
   │ One shot a day. You used yours.                           │
   └──────────────────────────────────────────────────────────┘
   ```

   If the page was reached via `?forfeit=1` (i.e. user just got rejected from `/start`), additionally show a one-line toast above the hero: `Run already started — locked until tomorrow.` Toast clears on next navigation. Style matches existing toast/error treatment.

### `/me` endpoint extension

`GET /api/leaderboard/daily/me` currently returns `{ played: false }` when no row exists. Extend to distinguish three states:

- No row: `{ played: false, forfeited: false }`.
- Lock row, unsubmitted: `{ played: false, forfeited: true }`.
- Submitted row: `{ played: true, time_ms, rank, total_today }` (unchanged).

`landing.js` uses the new `forfeited` flag to pick which Daily Hero state to render.

### Sentence-level copy updates

Search-and-replace passes (manual review for context):

- `client/js/landing.js`: "Sixty problems" line, "60 questions" subtitle.
- `server/src/copy/gauntlet-copy.js`: line 19 `"Sixty problems. One you. Good luck."` — same line as landing.js. Update or drop.
- Any docs / READMEs that mention "60 questions" — search at implementation, update if user-facing.

---

## Files touched

**New:**
- `server/migrations/011_daily_gauntlet_lock.sql` — drop + recreate the UNIQUE index without the `submitted_to_leaderboard` predicate.

**Modified:**
- `server/src/game/session.js` — `60` → `20` (one line).
- `server/src/routes/play.routes.js` — lock-at-start logic in `/api/play/start`, branch in `flushRunIfRecording` for UPDATE-vs-INSERT, `already_started` response.
- `server/src/routes/board.routes.js` — extend `/me` response with `forfeited` flag.
- `server/src/copy/gauntlet-copy.js` — update or drop the "Sixty problems" taunt entry.
- `client/js/play.js` — handle `already_started` response (redirect with `?forfeit=1`).
- `client/js/landing.js` — render forfeit state in Daily Hero; consume `forfeited` flag from `/me`; update count subtitle; show `?forfeit=1` toast.
- `client/css/styles.css` — forfeit-state Daily Hero styles (likely just a class reuse + `✗ LOCKED` button variant).

---

## Error handling & edge cases

| Scenario | Handling |
|---|---|
| User starts on tab A, opens tab B and clicks START | Tab A: session live. Tab B: `/start` sees existing lock row → `{ already_started: true }` → redirects with forfeit toast. Tab A continues to work. If A finishes, lock row gets UPDATE'd to submitted; future B-side reloads see `already_completed`. |
| Server restarts mid-run | In-memory session lost. Lock row persists. User's next answer call → 404. Landing shows forfeit state. (Intended hard-lock behavior.) |
| Lock row insert fails (DB down) | `/api/play/start` returns 500. Client surfaces error toast. Day not locked, user can retry once DB is back. |
| Concurrent first-`/start` race (PG 23505) | Catch `23505`, refetch, return `already_started`. Detailed in Backend section. |
| Lock row exists from a *completed* run when user re-clicks START | `submitted_to_leaderboard = true` → existing `already_completed` branch fires (unchanged). |
| Day rollover mid-run | Lock row's `daily_gauntlet_date` is set at start; finish UPDATE preserves it. SGT-tomorrow is a different date, lock doesn't apply. |
| Network blip drops `/api/play/answer` once | Client retries (existing behavior). Lock row unaffected. Session still in memory. |

### Existing 60-question rows in `runs`

Pre-existing `daily_gauntlet_date IS NOT NULL` rows have `submitted_to_leaderboard = true` (the old code only inserted on finish). The new UNIQUE index without the predicate doesn't conflict with them — they're already unique on `(user_id, daily_gauntlet_date)` because the OLD partial unique index enforced that within submitted rows, and there were no unsubmitted rows. **Migration is safe to apply on existing data without cleanup.**

Verify at implementation: `SELECT user_id, daily_gauntlet_date, COUNT(*) FROM runs WHERE daily_gauntlet_date IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1;` should return zero rows before applying the new index. If it doesn't (shouldn't happen, but), resolve duplicates manually first.

### In-flight sessions at deploy

A user mid-run when the new code ships has a session with `totalQuestions=60` already burned into the in-memory session, and no lock row. They can finish at 60 (the answer-handler check is `>= session.totalQuestions`), get the row inserted normally, and the new UNIQUE index won't conflict (only one row per user per day). **Acceptable as-is — no special handling.**

---

## Testing strategy

Existing daily-gauntlet test suite (`server/test/integration/daily-gauntlet.test.js`) needs updates:

| Existing test | Update |
|---|---|
| "Cleared run persists" | Solve **20**, not 60. Assert `score=20`, `submitted_to_leaderboard=true`, `runs` count for that user/date is exactly 1. |
| "Re-start blocked after completion" | Unchanged in shape. |
| "Day rollover correctness" | Solve 20, not 60. |
| Anything that solves "all 60" | Adjust to 20. |

### New tests

| Test | Asserts |
|---|---|
| Lock created on `/start` | After `/start`, a `runs` row exists with `(user_id, daily_gauntlet_date=today, submitted_to_leaderboard=false, score=0, duration_ms=0)`. |
| Re-`/start` while lock exists | Second call returns 200 `{ already_started: true, forfeited: true }`, no second row inserted. |
| Re-`/start` after completion | First call: `/start` + solve 20. Second call: returns `{ already_completed: true, time_ms, rank }` (unchanged). |
| Concurrent `/start` race | Insert a lock row directly, then call `/start`; server handles `23505` path → returns `already_started`. (Direct double-call test is timing-dependent and flaky; testing the recovery path explicitly is more robust.) |
| Finish UPDATEs lock row, doesn't insert | Before finish: 1 row with score=0. After finish: 1 row, same id, score=20, submitted=true. |
| Abandoned attempt locks the day | `/start`, then directly call `/start` again without solving anything. Second call → `already_started`. |
| `/me` returns forfeited flag | After `/start` only (no finish), `GET /me` → `{ played: false, forfeited: true }`. |
| `/me` after completion | `{ played: true, time_ms, rank, total_today, forfeited: false }` (or omit `forfeited` since `played=true` covers it — pick one in implementation, keep consistent). |
| Lock rows don't pollute leaderboard | Insert a lock row + a completed run by different users. `GET /api/leaderboard/daily` returns only the completed user. |
| Total questions is 20 | `/start` response includes `total_questions: 20`. |
| Auto-submit on Q20 | After 20 correct answers, response is `{ time_up: true, daily_gauntlet: true, time_ms, rank, total_today }` and the lock row is updated to submitted. |

### Manual verification checklist (frontend)

- Click START on landing → enters gauntlet, HUD shows `Q 1/20`.
- Solve 20 → score view fires automatically.
- Hard-refresh landing → Daily Hero shows completed state.
- Fresh account: click START, then alt-F4 / hard-refresh landing → Daily Hero shows **forfeit state** (greyed, "FORFEITED — see you tomorrow", `✗ LOCKED` button).
- From forfeit state, manually visit `play.html?mode=daily-gauntlet` → redirects to landing with `Run already started — locked until tomorrow` toast.
- Open a second tab while one is mid-run → second tab gets toast + redirect.
- Day rollover (set device clock or wait): forfeit state from yesterday clears; today's hero shows START.

---

## Spec self-review

- **Placeholders:** Final taunt copy is intentionally underspecified ("final wording at implementation") — not a TODO, just acknowledging copy gets wordsmithed late. No other gaps.
- **Internal consistency:** Backend Forfeit semantics, /me response, and Frontend forfeit-state rendering all agree on the three-state model (no row / lock row / submitted row). Migration safety is reasoned about both for existing data and in-flight sessions.
- **Scope:** One migration, ~6 modified files, no new modules. Single implementation plan.
- **Ambiguity:** "Update or drop" the Sixty taunt — implementation picks. Both are acceptable; I've stated the recommendation.
