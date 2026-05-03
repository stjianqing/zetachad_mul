# Daily Gauntlet — Design

## Problem

The leaderboard ranks users by their best-ever practice score, but every player customizes their session and configurations vary subtly. Even with eligibility rules, the daily activity flow is "warm up, grind for a personal best." There's no shared moment, no reason to come back today specifically, no rivalry around a single artifact.

## Goal

A once-per-day shared arithmetic challenge. Every registered user sees the same 60 questions today (date-seeded server-side); one attempt per Singapore calendar day; scored by total time to clear all 60 (lower = better). Today's daily leaderboard appears on the landing page next to a prominent CTA. Cheeky/mock-worship tone matching the existing leaderboard's `ALL HAIL <name>` voice.

## Why this fits zetachad_mul

- **Reuses existing play flow.** `POST /api/play/start` gets a new `mode: "daily-gauntlet"` flag; the server's existing in-memory session store, `makeRng()`, generator, and grader work unchanged.
- **Reuses existing auth.** Daily gauntlet requires `requireAuth()`. Guests see a disabled button on the landing page.
- **Reuses existing `runs` + `attempts` tables.** A nullable `daily_gauntlet_date DATE` column on `runs`, plus a partial UNIQUE index, enforces "1 completed attempt per user per SGT day" at the database layer.
- **Daily leaderboard is a separate query**, not a filter on the existing leaderboard — different ranking semantics (score = time, lower = better) and different scope (today only).

## Out of scope (v1)

- All-time daily leaderboard ("best gauntlet time ever").
- Browsing past days' daily leaderboards via date picker.
- Gauntlet-specific stats / heatmaps in History.
- Notifications, streak tracking, share buttons.
- Anti-cheat / suspicious-time detection.

---

## User Flow

### Logged-in user, hasn't played today

1. Lands on `index.html`. Sees the **Daily Hero** block at the top of `<main>`: lime-bordered card with rotating taunt copy (e.g. `DAILY CHALLENGE — Don't choke.`) and a `START` button.
2. Clicks `START`. Browser navigates to `play.html?mode=daily-gauntlet`.
3. `play.js` detects the `mode=daily-gauntlet` query param and calls `POST /api/play/start` with `{ mode: "daily-gauntlet" }` (no client config payload — server uses canonical Zetamac defaults).
4. Server: verifies auth (401 if guest), checks `runs` for a submitted row with `(user_id, daily_gauntlet_date=today_sgt)`. If found → returns `{ already_completed: true, time_ms, rank }`. Otherwise seeds the session with `dateStringToSeed(today_sgt)` and the canonical config, returns first question + session ID + `{ mode, total_questions: 60, question_index: 0 }`.
5. Drill HUD: top progress bar shows `Q N/60` fill; HUD timer counts up from `0:00`; score counter shows `47 / 60`. Otherwise visually identical to a regular drill.
6. Player solves all 60 (silent-reject on wrong answers — existing behavior).
7. On 60th correct answer, server flushes the run with `daily_gauntlet_date = session.seed_date`, computes daily rank, returns `{ time_up: true, time_ms, rank, total_today }`.
8. Score view: rotating worship headline (`ALL HAIL <username>` or variant), `today's arithmetic overlord · cleared in 1:43` subtitle, big finish-time, op-summary table, inline today's daily leaderboard (top 5 + the user's row if not in top 5).

### Logged-in user, already played today

- Daily Hero on landing renders **completed state**: button greyed/disabled, copy `CLEARED IN 1:43 — see you tomorrow.`
- If they manually navigate to `play.html?mode=daily-gauntlet`, server returns `{ already_completed: true }` and `play.js` redirects to `index.html`.

### Guest (not logged in)

- Daily Hero renders **disabled state**: copy `DAILY CHALLENGE — register to play.`, button greyed and unclickable, register link visible.
- Regular `Start as User` / `Start as Guest` buttons below the hero still work for normal practice.

### Edge: day rollover mid-run

The session captures `seed_date = today_sgt` at start. Completion writes `daily_gauntlet_date = session.seed_date`, **not** the date at completion time. So a run started at 23:58 SGT and finished at 00:02 SGT counts for *yesterday*. Tomorrow's gauntlet remains unblocked (the unique-index constraint is on a different date).

### Edge: reload mid-run / server restart mid-run

The run is not persisted until the 60th question is solved. Reload abandons the session; user can restart by clicking Daily Challenge again. No attempt is consumed until completion.

---

## Backend Design

### Schema changes

New migration `00X_daily_gauntlet.sql` (number resolved at implementation time to avoid collision with concurrent in-progress migrations):

```sql
ALTER TABLE runs ADD COLUMN daily_gauntlet_date DATE;

CREATE UNIQUE INDEX runs_user_daily_gauntlet_idx
  ON runs (user_id, daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL AND submitted_to_leaderboard = true;

CREATE INDEX runs_daily_gauntlet_date_idx
  ON runs (daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL;
```

- `daily_gauntlet_date IS NULL` for regular runs — no behavioral change to existing flow.
- The partial UNIQUE index enforces "1 completed attempt per user per SGT day." Abandoned runs (never submitted) don't lock the day.
- The plain index supports today's daily-leaderboard query.

### Date helper (Singapore timezone)

New module `server/src/game/sgt-date.js`:

```js
// Returns YYYY-MM-DD for "today" in Singapore time (UTC+8, no DST).
export function todaySgtDateString(now = new Date()) {
  const sgtMs = now.getTime() + 8 * 60 * 60 * 1000;
  return new Date(sgtMs).toISOString().slice(0, 10);
}

// "2026-05-04" → 20260504 (numeric seed for makeRng).
export function dateStringToSeed(dateString) {
  return Number(dateString.replace(/-/g, ""));
}
```

The seed is identical for everyone worldwide on a given SGT day. Tests inject the optional `now` parameter for deterministic verification.

### Session store extension

`server/src/game/session.js` adds new fields per session:

- `mode: "normal" | "daily-gauntlet"` (default `"normal"`).
- `seed_date: string | null` (set only for daily-gauntlet — captures the date at session start so completion writes use the correct date if midnight rolls over mid-run).
- `total_questions: number | null` (60 for daily-gauntlet; `null` for normal).
- `current_question_index: number` (0-59 for daily-gauntlet; tracks progress).
- `start_time_ms: number` (used to compute `duration_ms` at completion).

For daily-gauntlet sessions, the run ends when `current_question_index === 60` (60th correct answer) instead of when a countdown timer hits zero. The peek-question machinery already in the session store works as-is.

### Routes

**`POST /api/play/start`** — extend existing route:

- New optional body field `mode: "daily-gauntlet"`.
- If `mode === "daily-gauntlet"`:
  - Require auth: 401 with `{ error: "register-to-play" }` for guests.
  - Compute `today_sgt = todaySgtDateString()`.
  - Query `runs` for an existing submitted row with `(user_id = req.user.id, daily_gauntlet_date = today_sgt, submitted_to_leaderboard = true)`. If found, return `{ already_completed: true, time_ms, rank }` (200, not error).
  - Otherwise create a session with: `mode="daily-gauntlet"`, `seed_date=today_sgt`, `rng_seed=dateStringToSeed(today_sgt)`, `config=ZETAMAC_DEFAULTS` (canonical server-side constant), `total_questions=60`. Ignore any client-supplied config payload.
  - Return first question + session ID + `{ mode, total_questions: 60, question_index: 0 }`.
- If `mode` is unset or `"normal"`: existing behavior unchanged.

**`POST /api/play/answer`** — minimal change:

- Existing logic grades the answer. For daily-gauntlet sessions, on a correct answer, increment `current_question_index`. When it reaches 60, trigger the same flush path as time-up but with `daily_gauntlet_date = session.seed_date` set on the run row, `score = 60`, `duration_ms = now - session.start_time_ms`, `submitted_to_leaderboard = true`.
- Response payload adds `{ question_index, total_questions }` for daily-gauntlet sessions so the client can render the `Q N/60` progress.

**`GET /api/leaderboard/daily`** — new public route:

- Optional query param `date` (defaults to `todaySgtDateString()`). For v1 we only fully support today; the param is reserved for future browsability.
- Returns top N entries (default 100, capped at 500) ranked by `runs.duration_ms ASC`, tiebreaker `runs.played_at ASC`.
- Each entry: `{ rank, username, time_ms, played_at }`.
- Public: anyone can view today's leaderboard, even guests.

**`GET /api/leaderboard/daily/me`** — new authenticated route:

- Returns the calling user's daily run if it exists for today, with rank.
- Response: `{ time_ms, rank, total_today }` if played, `{ played: false }` otherwise.
- Used by the landing page to render the Daily Hero's completed state and by the score view.

### Score semantics

Existing `runs.score` means "count of correct answers" (higher = better). For daily-gauntlet, the meaningful score is `runs.duration_ms` (lower = better). Decision:

- **Store `runs.score = 60`** (always — they cleared all 60).
- **Use `runs.duration_ms` as the daily-leaderboard ranking key**.
- No new column; no schema change to `score`.

The daily leaderboard query orders by `duration_ms ASC, played_at ASC`.

---

## Frontend Design

### Landing page (`client/index.html`)

Restructured layout, top to bottom inside `<main>`:

1. **Daily Hero block** (lime, prominent — see below).
2. **Start as User / Start as Guest** (existing buttons, unchanged).
3. **Today's Daily Leaderboard widget** (top 5 + user's row if not in top 5).
4. **`<details>` Show advanced** (existing disclosure) — now contains:
   - Eligibility badge (moved from top of `<main>` into here).
   - Default-run summary div (moved from top of `<main>` into here).
   - Settings grid (existing).

The current `<h1>Multiplayer drill</h1>` is dropped; the daily hero and the leaderboard widget *are* the headlines.

### Daily Hero block — three states

**State A — logged-in, not played today:**

```
┌──────────────────────────────────────────────────────────┐
│ DAILY CHALLENGE — Don't choke.                    START   │   (lime border, lime button)
│ 60 questions, 1 shot. Same drill worldwide today.         │
└──────────────────────────────────────────────────────────┘
```

The taunt line is one of ~14-21 date-seeded rotating options — same line for everyone today, changes daily.

**State B — logged-in, already played today:**

```
┌──────────────────────────────────────────────────────────┐
│ CLEARED IN 1:43 — see you tomorrow.              ✓ DONE   │   (greyed border, dim button)
│ Today's overlord: ALL HAIL <name> · 1:23                  │
└──────────────────────────────────────────────────────────┘
```

Subtitle shows today's #1 leader for social proof.

**State C — guest:**

```
┌──────────────────────────────────────────────────────────┐
│ DAILY CHALLENGE — register to play.        REGISTER →     │   (greyed border, magenta link)
│ One shot a day. Worldwide ranking.                        │
└──────────────────────────────────────────────────────────┘
```

The "REGISTER →" is a link to `/register.html`.

Styling: lime accents (border + active button background) consistent with the existing brutalist arcade theme. Magenta offset shadow on the active button. State B/C use dimmed colors (`--ink-dim`).

### Today's Daily Leaderboard widget (landing page)

Compact list, top 5 entries plus the calling user's row if they've played and aren't in top 5.

```
TODAY'S DAILY LEADERBOARD
1. ALL HAIL stjia · today's arithmetic overlord · 1:23
2. someuser ··················· 1:31
3. anotheruser ················ 1:45
4. fourth ····················· 2:02
5. fifth ······················ 2:18
                                       (...)
12. you ······················· 2:47       (highlighted if logged-in & played)

→ See all rankings  (link to leaderboard.html#daily)
```

Rank #1 gets the worship headline; ranks 2-5 are clean. If the user is in the top 5, no separate "you" row. If they haven't played today, no "you" row. If nobody has played yet today: `Nobody's stepped up yet today.` (single dim line — first-mover encouragement).

### `play.html` — daily-gauntlet HUD

Same page, conditional rendering when `?mode=daily-gauntlet` is in the URL:

- Top progress bar fills based on `Q N/60` (questions cleared) instead of time-elapsed.
- Score counter displays `12 / 60` (cleared / total) instead of a single integer.
- Timer counts up (`0:00 → 1:43`) instead of down.
- A small `DAILY GAUNTLET` mode pill appears in lime above the progress bar so the player knows which mode they're in.
- Wrong-answer / silent-reject behavior: unchanged.

If the server returns `{ already_completed: true }` on `/api/play/start`, `play.js` redirects to `/index.html`.

### Score view (post-completion, daily-gauntlet)

```
ALL HAIL stjia                                  (rotating worship line, big)
today's arithmetic overlord · cleared in 1:43

[ 1:43 ]                                        (big finish-time)

OPERATION SUMMARY                               (existing op-table — count + mean time per op)
+ ADDITION       18    0.74s
− SUBTRACTION    14    0.96s
× MULTIPLICATION 16    1.34s
÷ DIVISION       12    1.51s

TODAY'S DAILY LEADERBOARD
1. ALL HAIL stjia · today's arithmetic overlord · 1:23
2. ...
3. ...

← Back to drill                  View all rankings →
```

If the user is not #1, the worship line tones down: `BEHOLD stjia · cleared in 1:43 · #12 today.` (Rotating set of date-seeded variations.)

### Leaderboard page (`client/leaderboard.html`)

Add tabs at the top: `[ ALL-TIME ]  [ TODAY'S DAILY ]`. Default tab is All-Time. Daily tab renders today's daily leaderboard (full list, not just top 5). Anchor `#daily` opens the page directly to the daily tab (used by landing-widget link).

### Files touched

| File | Change |
|------|--------|
| `client/index.html` | Add daily hero + daily leaderboard widget. Move eligibility badge + default-summary into Show Advanced. |
| `client/js/landing.js` | Fetch daily-leaderboard + `/me`; render hero state; wire START → `/play.html?mode=daily-gauntlet`. |
| `client/js/play.js` | Detect `?mode=daily-gauntlet`; swap HUD semantics; handle `already_completed` redirect; render daily score view. |
| `client/play.html` | Add mode-pill markup + count-up timer support. |
| `client/js/leaderboard.js` | Add tab toggle; render daily leaderboard table. |
| `client/leaderboard.html` | Add tabs `[ ALL-TIME ]  [ TODAY'S DAILY ]` + `#daily` anchor support. |
| `client/css/styles.css` | Daily hero card styles, lime/magenta accent variants, mode pill, daily score view, tabs. |
| `server/migrations/00X_daily_gauntlet.sql` | Add `daily_gauntlet_date` column + indexes. Number resolved at implementation. |
| `server/src/game/sgt-date.js` | New module: `todaySgtDateString()`, `dateStringToSeed()`. |
| `server/src/game/session.js` | Add `mode`, `seed_date`, `total_questions`, `current_question_index`, `start_time_ms` fields. |
| `server/src/routes/play.routes.js` | Extend `/start` and `/answer` for daily-gauntlet mode. |
| `server/src/routes/board.routes.js` | Add `GET /api/leaderboard/daily` and `GET /api/leaderboard/daily/me`. |
| `server/src/copy/gauntlet-copy.js` | New module: rotating taunt + worship line tables (date-seeded selection). |

### Copy table (rough sketch — wordsmithed at implementation)

```js
const PRE_TAUNTS = [
  "Don't choke.",
  "Try not to embarrass yourself.",
  "Show us your worth.",
  "Pretend you can do math.",
  "One shot. Make it count.",
  "Time to find out who you really are.",
  "The numbers are watching.",
  "No second chances. No mercy.",
  "Step up or step aside.",
  "Today's not the day to be average.",
  "Math waits for no one.",
  "Prove you deserve to be here.",
  "The overlords demand tribute.",
  "Glory or shame. Pick one.",
  // 14-21 entries total
];

const WORSHIP_FIRST_PLACE = ["ALL HAIL", "BEHOLD", "KNEEL BEFORE", "PRAISE BE TO", "GLORY TO", "WITNESS"];
const WORSHIP_OTHER       = ["BEHOLD", "WITNESS", "PRESENTING", "ENTER"];

const POST_DONE = [
  "see you tomorrow.",
  "today's run: locked.",
  "the overlords have seen enough.",
  "you've been counted.",
  // ...
];
```

Date-seeded selection: `i = dateStringToSeed(today) % array.length`. Same line for everyone today; changes daily.

---

## Error Handling & Edge Cases

### Auth failures

| Scenario | Handling |
|---|---|
| Guest hits `/api/play/start` with `mode: "daily-gauntlet"` | 401 `{ error: "register-to-play" }`. Frontend shouldn't trigger this (button disabled), but server enforces. |
| Cookie expires mid-run | Auth-hook logs them out; next answer-submit gets 401. Client redirects to login. Lost run is acceptable (rare; no attempt consumed since not flushed). |

### Already-played enforcement (defense in depth)

1. **Soft (UX):** `/api/play/start` checks for an existing submitted run for today and returns `{ already_completed: true, time_ms, rank }` (200) before starting a session. Client redirects to landing.
2. **Hard (DB):** The partial UNIQUE index `(user_id, daily_gauntlet_date) WHERE submitted=true` makes a duplicate write fail. Race condition (rapid double-tap on START) → second insert raises PG `23505`. Server catches it, refetches the existing row, returns the same `{ already_completed: true }` payload.

### Server restart mid-run

In-memory session lost. Next answer submission returns 404 `{ error: "session-not-found" }`. Frontend redirects to landing with toast: `Run lost. Click DAILY CHALLENGE to restart — your attempt is still valid.` Day is not locked (no flush happened), so user can restart.

### Crash after run-write but before response

Run is persisted; client gets a connection error. Next landing load uses `/api/leaderboard/daily/me` to detect the run; Daily Hero shows State B. Score view UI is not shown for that run. Acceptable for v1 — the data is durable; the celebration moment is missed in this rare race.

### Clock skew / spoofing

Server clock is the source of truth. `todaySgtDateString()` uses `new Date()` server-side. Singapore has no DST → fixed `+8h` offset, no timezone library needed. If the server clock is wrong, the seed and uniqueness window drift accordingly. Out of scope.

### First-mover (empty leaderboard)

`GET /api/leaderboard/daily` with no rows for today → returns `{ entries: [], date: "YYYY-MM-DD" }`. Landing widget renders `Nobody's stepped up yet today.` (single dim line). Score view shows the first finisher at #1; `total_today: 1`.

### Out-of-scope (deferred)

- **Anti-cheat / suspicious times.** A sub-1-second gauntlet would obviously be scripted. v1 trusts server-measured `duration_ms`. If gaming becomes a real problem, add per-question minimum-time threshold + anomaly flagging.
- **Rate limiting on `/api/play/answer`.** Existing `@fastify/rate-limit` may already cover this; verify but don't extend in v1.

---

## Testing Strategy

The project uses Node test runner (`node --test`) for unit + integration. No frontend tests exist (matches existing convention; we continue that — frontend verified manually).

### New unit tests (`server/test/unit/`)

**`sgt-date.test.js`** — pure, fast, easy:

- `todaySgtDateString(now)` returns correct date for known UTC inputs.
- Boundary: `2026-05-04 15:59:59 UTC` → `"2026-05-04"`; `2026-05-04 16:00:00 UTC` → `"2026-05-05"`.
- `dateStringToSeed("2026-05-04")` → `20260504` (number).
- Determinism: same input → same output, always.

**`gauntlet-copy.test.js`** — date-seeded selection:

- `pickPreTaunt("2026-05-04")` returns a string from the table.
- Same date → same line (idempotent).
- Different dates → can return different lines.
- All array indices reachable across a year of dates (no off-by-one excluding entries).

### New integration tests (`server/test/integration/daily-gauntlet.test.js`)

Use existing `freshApp()` + `registerAndCookie()` fixtures.

| Test | Asserts |
|---|---|
| Guest blocked | `POST /api/play/start { mode: "daily-gauntlet" }` without cookie → 401, `{ error: "register-to-play" }`. |
| Logged-in starts | Authed `/start` daily-gauntlet → 200, returns first question + session ID + `{ mode, total_questions: 60, question_index: 0 }`. |
| Two users get same questions | Register A and B; both `/start` daily-gauntlet; assert first 5 questions identical. |
| Different days different questions | Inject distinct `now` values via DI; assert questions differ across days. |
| Cleared run persists | Authed user solves all 60; assert `runs` row with `daily_gauntlet_date=today`, `score=60`, `submitted_to_leaderboard=true`, `duration_ms > 0`. |
| Re-start blocked after completion | After clearing, second `/start` → 200 `{ already_completed: true, time_ms, rank }`. |
| DB unique-constraint defense | Manually insert a daily-gauntlet run for user A today, then call `/start` → returns `already_completed`. |
| Day rollover correctness | Start with injected `now=23:58 SGT yesterday`; record `seed_date=yesterday`; finish 60 with injected `now=00:02 SGT today`; assert `runs.daily_gauntlet_date = yesterday`. Then fresh `/start` with `now=today` → not blocked. |
| Daily leaderboard endpoint | 3 users complete with distinct times; `GET /api/leaderboard/daily` returns ranked by `duration_ms ASC`. |
| Daily leaderboard tiebreaker | 2 users with identical `duration_ms`; earlier `played_at` ranks first. |
| Daily leaderboard empty day | `GET /api/leaderboard/daily?date=2099-01-01` → 200 `{ entries: [], date: "2099-01-01" }`. |
| `/me` endpoint, played | After completion: `GET /api/leaderboard/daily/me` → `{ time_ms, rank, total_today }`. |
| `/me` endpoint, not played | Before completion: `GET /api/leaderboard/daily/me` → `{ played: false }`. |
| Wrong answer doesn't advance | Submit wrong answer → response says not-correct; `question_index` still 0. |
| No regression on existing modes | Existing practice-mode + normal-mode integration tests still pass. |

### Manual frontend verification checklist

- Landing as guest: Daily Hero shows "register to play" state; button disabled; register link visible.
- Landing as logged-in user, never played: Daily Hero shows rotating taunt + START.
- Click START → lands on `play.html?mode=daily-gauntlet`; HUD shows `Q 1/60`; count-up timer starts at 0:00; mode pill visible.
- Wrong answer: silent reject, no advance.
- Correct answer: advances to next question.
- Solve all 60 → score view shows worship line, big finish-time, op-summary, inline daily leaderboard with the user in it.
- Reload landing: Daily Hero shows "CLEARED IN m:ss" state; button greyed; today's overlord visible.
- Open `leaderboard.html#daily`: tabs visible, daily tab open, today's entries listed.
- Open Show Advanced: eligibility badge + default-summary visible inside.
- Different account / browser today: same first 5 questions when starting gauntlet.
- Mobile (≤640px): daily hero block doesn't break layout; leaderboard widget fits.

### Test seams

For test injectability:

- `todaySgtDateString(now?)` accepts an optional `now`.
- A `now` value plumbed through routes via DI (e.g., `freshApp({ now })` fixture extension). Implementation finds the cleanest seam.

---

## Files summary

**New files:**
- `server/migrations/00X_daily_gauntlet.sql` (number resolved at impl)
- `server/src/game/sgt-date.js`
- `server/src/copy/gauntlet-copy.js`
- `server/test/unit/sgt-date.test.js`
- `server/test/unit/gauntlet-copy.test.js`
- `server/test/integration/daily-gauntlet.test.js`

**Modified files:**
- `client/index.html`
- `client/js/landing.js`
- `client/js/play.js`
- `client/play.html`
- `client/js/leaderboard.js`
- `client/leaderboard.html`
- `client/css/styles.css`
- `server/src/game/session.js`
- `server/src/routes/play.routes.js`
- `server/src/routes/board.routes.js`
