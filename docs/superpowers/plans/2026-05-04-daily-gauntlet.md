# Daily Gauntlet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily once-per-day shared arithmetic challenge — same 60 date-seeded questions for everyone worldwide, scored by total time to clear all 60, gated to registered users, with an inline daily leaderboard on the landing page.

**Architecture:** Reuse the existing play loop end-to-end. Add a tiny date helper (`sgt-date.js`) and a tiny copy table (`gauntlet-copy.js`) on the server. Extend the session store with a `mode: "daily-gauntlet"` path that fixes question count to 60 (instead of timed) and seeds the RNG with the SGT date. Extend `/api/play/start` with a `mode` flag (auth-gated) and `/api/play/answer` to recognize "60 cleared = end-of-run." Add two new leaderboard endpoints (`GET /api/leaderboard/daily`, `GET /api/leaderboard/daily/me`). Database changes: a single nullable `daily_gauntlet_date DATE` column on `runs` plus a partial UNIQUE index for "1 attempt per user per SGT day." Client: rebuild the landing page (`index.html`) around a Daily Hero block, daily leaderboard widget, and a relocated Show Advanced; teach `play.js` to handle daily-gauntlet HUD (Q N/60, count-up timer, mode pill, daily-flavored score view); add a tab toggle to `leaderboard.html`.

**Tech Stack:** Fastify 5, Postgres 16 (via `pg`), Node `node --test` for tests, vanilla ES-module JS/HTML for client, nginx for static + proxy.

---

## Important context for the implementer

**Read this before starting Task 1.** It saves you from a few wrong turns the spec doesn't quite cover.

1. **Migration numbering.** The spec uses `00X_daily_gauntlet.sql` as a placeholder because in-progress work for an unrelated "difficulty-score" feature has untracked `007_runs_difficulty.sql` and `008_cluster_medians.sql` on `main`. **Check the actual numbering at implementation time:**
   - In the worktree: `ls server/migrations/` to see what's there.
   - Use the next available number. As of branch creation (2026-05-04), the highest *committed* migration is `006_runs_practice_flag.sql`. If the difficulty-score migrations land first, this plan's migration becomes `009`. The plan refers to it as `NNN_daily_gauntlet_date.sql` — substitute the real number everywhere.
2. **Where runs get inserted.** Runs are written by `flushRunIfRecording` in `server/src/routes/play.routes.js:56-94`. Daily-gauntlet completion goes through this same function. The function reads from `takeRunRecord(sessionId)`, which we extend in Task 4 to include `dailyGauntletDate` and `submittedToLeaderboard`. The INSERT in `flushRunIfRecording` adds those columns to the column list and values.
3. **`recordsAttempts` gates attempt persistence.** `session.js:30-32` requires `userId != null && isDefaultConfig(session.config)`. Daily-gauntlet is auth-only and uses `DEFAULT_CONFIG` directly, so attempts WILL record naturally. Don't modify this gate.
4. **Daily-gauntlet skips the submit modal.** Existing flow: time-up → `flushRunIfRecording` writes `runs` with `submitted_to_leaderboard=false`; client shows submit modal; user clicks Submit → `/api/leaderboard/submit` flips the flag. Daily-gauntlet bypasses the modal — completion = submission, atomic. So `flushRunIfRecording` for daily-gauntlet sets `submitted_to_leaderboard=true` at INSERT time.
5. **Test framework is `node --test`** (built-in, Node 22+). See existing tests in `server/test/unit/*.test.js` and `server/test/integration/*.test.js`. Integration tests skip when `TEST_DATABASE_URL` is unset (`skipIfNoDb(t)` helper).
6. **`requireAuth` middleware** is at `server/src/auth.js:111-116`. Sets `req.user` (`{id, username, sessionToken}`); returns 401 with `{error: 'auth_required'}` if missing. Use `{ preHandler: requireAuth }` in route options. Daily-gauntlet returns a different error code `register-to-play` so the frontend can distinguish "you must register" from generic auth failures — see Task 8.
7. **Time injection for tests.** The spec calls for a settable `now` to test SGT day rollover. The current `createSessionStore({ now })` already accepts `now: () => Date.now()` as a function, so we plumb a similar pattern into routes. We add an optional `nowFn` to `buildApp({ ... })` (defaults to `() => new Date()`); `play.routes.js` and `board.routes.js` close over it and pass it to `todaySgtDateString(nowFn())`. Tests pass `nowFn: () => new Date('2026-05-04T15:59:59Z')` and can mutate by replacing the closure-captured ref.
8. **Singapore has no DST.** UTC+8 is a fixed constant. No `Intl.DateTimeFormat` or `date-fns-tz` library needed.
9. **The frontend uses ES modules** (`<script type="module" src="..."></script>`). Imports resolve relative to the script location. Static-served by nginx from `/var/www/zetachad/client/`.
10. **`api.js` is the central client API helper.** Add new methods there (`startDailyGauntlet`, `dailyBoard`, `dailyMe`) — don't scatter `fetch()` calls.
11. **Existing `peek_question` mechanism.** `play.js` pre-fetches the next question for instant UI advance. This works unchanged for daily-gauntlet. The only change: when the server returns `time_up: true`, daily-gauntlet flow adds extra fields (`time_ms`, `rank`, `total_today`).

---

## File structure (what gets created/modified)

**New server files:**
- `server/src/game/sgt-date.js` — `todaySgtDateString(now)`, `dateStringToSeed(dateString)`.
- `server/src/copy/gauntlet-copy.js` — `pickPreTaunt(date)`, `pickWorshipFirst(date)`, `pickWorshipOther(date)`, `pickPostDone(date)`.
- `server/test/unit/sgt-date.test.js`
- `server/test/unit/gauntlet-copy.test.js`
- `server/test/integration/daily-gauntlet.test.js`

**New migration:**
- `server/migrations/NNN_daily_gauntlet_date.sql` (number resolved at impl — see context note 1).

**Modified server files:**
- `server/src/game/session.js` — add `mode`, `seedDate`, `totalQuestions`, `currentQuestionIndex`, `startTimeMs` fields; daily-gauntlet branch in `start()` and `answer()`.
- `server/src/routes/play.routes.js` — extend `/api/play/start` with `mode: "daily-gauntlet"`; pass `dailyGauntletDate` + `submittedToLeaderboard` through `flushRunIfRecording`.
- `server/src/routes/board.routes.js` — add `GET /api/leaderboard/daily` and `GET /api/leaderboard/daily/me`.
- `server/src/index.js` — accept optional `nowFn` in `buildApp`, plumb to play + board routes.
- `server/src/config.js` — export `ZETAMAC_DEFAULTS` (currently only `DEFAULT_CONFIG`; same shape — see Task 5 for whether to alias or duplicate).

**New client files:** None — all changes go in existing files.

**Modified client files:**
- `client/index.html` — restructure landing: Daily Hero block at top, Start buttons, daily leaderboard widget, then `<details>` Show advanced (now containing eligibility badge + default-summary).
- `client/js/landing.js` — render daily hero state machine; fetch daily leaderboard widget.
- `client/play.html` — add mode pill markup + count-up timer markup (or repurpose existing `#timer`).
- `client/js/play.js` — detect `?mode=daily-gauntlet`; swap HUD; flavored score view; redirect on `already_completed`.
- `client/js/api.js` — add `startDailyGauntlet`, `dailyBoard`, `dailyMe` methods.
- `client/leaderboard.html` — add tab toggle markup.
- `client/js/leaderboard.js` — implement tab toggle + daily leaderboard table render.
- `client/css/styles.css` — daily hero styles, mode pill, lime/magenta accent variants, daily score view, tabs, daily leaderboard widget.

**Deploy:**
- The existing nginx config serves `client/` statically and proxies `/api/*` to the Node server. Daily Gauntlet adds no new pages, so no nginx changes.
- Use `deploy/deploy-scp.sh` from Windows Git Bash to ship to the VPS (per project memory — `deploy.sh` uses rsync which isn't available on Windows).

---

## Pre-flight: verify environment

Before starting Task 1, confirm:

```bash
# In the worktree
pwd  # should be /c/Users/stjia/projects/zetachad_mul/.worktrees/daily-gauntlet (Git Bash) or equivalent
git status  # should show clean working tree (spec already committed)
git log --oneline -3  # should show "docs: spec self-review fixes" then "docs: daily-gauntlet design spec"
ls server/migrations/  # note the highest committed migration number
```

Run the existing test suite to establish a baseline:

```bash
cd server && npm install && npm test
```

Expected: all unit tests pass; integration tests SKIP unless `TEST_DATABASE_URL` is set (skip is fine — record any non-skip failures so you can detect regressions).

---

## Task 1: Database migration — add `daily_gauntlet_date` column

**Files:**
- Create: `server/migrations/NNN_daily_gauntlet_date.sql` (number resolved at impl)

- [ ] **Step 1: Determine the migration number**

```bash
ls server/migrations/
```

Take the highest existing number, add 1. Throughout this task, `NNN` means that number, zero-padded to 3 digits (e.g., `007`, `009`).

- [ ] **Step 2: Write the migration**

Create `server/migrations/NNN_daily_gauntlet_date.sql`:

```sql
-- Daily Gauntlet: track which SGT calendar day a run belongs to, with a
-- partial UNIQUE index enforcing "1 completed attempt per user per day."
ALTER TABLE runs ADD COLUMN daily_gauntlet_date DATE;

-- Enforce 1 *completed* attempt per user per day. Abandoned runs (never submitted)
-- don't lock the day — they have submitted_to_leaderboard=false and don't match.
CREATE UNIQUE INDEX runs_user_daily_gauntlet_idx
  ON runs (user_id, daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL AND submitted_to_leaderboard = true;

-- Speeds up "today's daily leaderboard" query.
CREATE INDEX runs_daily_gauntlet_date_idx
  ON runs (daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL;
```

- [ ] **Step 3: Apply locally if Postgres is available**

If `DATABASE_URL` is set:

```bash
cd server && npm run migrate
```

Expected output: `migrated: NNN_daily_gauntlet_date.sql` followed by `migrations complete`.

If you don't have local Postgres, skip — integration tests will exercise the migration via `migrate(pool)` in `server/test/integration/helper.js`.

- [ ] **Step 4: Verify schema**

```bash
psql "$DATABASE_URL" -c "\d runs"
```

Expected: `daily_gauntlet_date | date | | |` row in the column list, plus the two new indexes shown by `\d runs` under "Indexes:".

- [ ] **Step 5: Commit**

```bash
git add server/migrations/NNN_daily_gauntlet_date.sql
git commit -m "schema: add daily_gauntlet_date column with partial unique index"
```

---

## Task 2: SGT date helper — pure functions

**Files:**
- Create: `server/src/game/sgt-date.js`
- Create: `server/test/unit/sgt-date.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/test/unit/sgt-date.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todaySgtDateString, dateStringToSeed } from '../../src/game/sgt-date.js';

test('todaySgtDateString: 2026-05-04 16:00:00 UTC is 2026-05-05 in SGT', () => {
  const utc = new Date('2026-05-04T16:00:00.000Z');
  assert.equal(todaySgtDateString(utc), '2026-05-05');
});

test('todaySgtDateString: 2026-05-04 15:59:59 UTC is still 2026-05-04 in SGT', () => {
  const utc = new Date('2026-05-04T15:59:59.999Z');
  assert.equal(todaySgtDateString(utc), '2026-05-04');
});

test('todaySgtDateString: noon SGT (04:00 UTC) is the SGT date', () => {
  const utc = new Date('2026-05-04T04:00:00.000Z');
  assert.equal(todaySgtDateString(utc), '2026-05-04');
});

test('todaySgtDateString: midnight SGT exactly (16:00 UTC previous day) flips', () => {
  const utc = new Date('2026-05-04T16:00:00.000Z');
  assert.equal(todaySgtDateString(utc), '2026-05-05');
});

test('todaySgtDateString: defaults to current time when called without args', () => {
  // Just confirm it returns a YYYY-MM-DD string and doesn't throw.
  const r = todaySgtDateString();
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/);
});

test('dateStringToSeed: converts dashed date to integer', () => {
  assert.equal(dateStringToSeed('2026-05-04'), 20260504);
  assert.equal(dateStringToSeed('2099-12-31'), 20991231);
  assert.equal(dateStringToSeed('1970-01-01'), 19700101);
});

test('dateStringToSeed is deterministic', () => {
  assert.equal(dateStringToSeed('2026-05-04'), dateStringToSeed('2026-05-04'));
});
```

- [ ] **Step 2: Run the failing tests**

```bash
cd server && node --test test/unit/sgt-date.test.js
```

Expected: all tests fail with `Cannot find module '../../src/game/sgt-date.js'`.

- [ ] **Step 3: Implement the module**

Create `server/src/game/sgt-date.js`:

```js
// Singapore is a fixed UTC+8 offset (no DST). The SGT calendar date for any
// given instant is computed by shifting the timestamp +8 hours and reading the
// UTC date of the result.

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Returns the YYYY-MM-DD string for "today" in Singapore time.
 * Optionally pass a `now` Date for testing/injection.
 */
export function todaySgtDateString(now = new Date()) {
  const sgtMs = now.getTime() + SGT_OFFSET_MS;
  return new Date(sgtMs).toISOString().slice(0, 10);
}

/**
 * Convert a YYYY-MM-DD string to a numeric seed for makeRng().
 * "2026-05-04" → 20260504. Same date → same seed.
 */
export function dateStringToSeed(dateString) {
  return Number(dateString.replace(/-/g, ''));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && node --test test/unit/sgt-date.test.js
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/game/sgt-date.js server/test/unit/sgt-date.test.js
git commit -m "feat: SGT date helper for daily gauntlet seeding"
```

---

## Task 3: Gauntlet copy module — date-seeded selection

**Files:**
- Create: `server/src/copy/gauntlet-copy.js`
- Create: `server/test/unit/gauntlet-copy.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/test/unit/gauntlet-copy.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPreTaunt,
  pickWorshipFirst,
  pickWorshipOther,
  pickPostDone,
  PRE_TAUNTS,
  WORSHIP_FIRST_PLACE,
  WORSHIP_OTHER,
  POST_DONE
} from '../../src/copy/gauntlet-copy.js';

test('pickPreTaunt returns a string from the table', () => {
  const r = pickPreTaunt('2026-05-04');
  assert.equal(typeof r, 'string');
  assert.ok(PRE_TAUNTS.includes(r));
});

test('pickPreTaunt is idempotent for the same date', () => {
  assert.equal(pickPreTaunt('2026-05-04'), pickPreTaunt('2026-05-04'));
});

test('pickPreTaunt varies across dates', () => {
  // Sample 60 consecutive days; expect at least 2 distinct lines.
  const set = new Set();
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    set.add(pickPreTaunt(d.toISOString().slice(0, 10)));
  }
  assert.ok(set.size >= 2, `expected variation, got ${set.size} unique lines`);
});

test('all PRE_TAUNTS entries reachable across a year', () => {
  const seen = new Set();
  for (let i = 0; i < 365; i++) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    seen.add(pickPreTaunt(d.toISOString().slice(0, 10)));
  }
  assert.equal(seen.size, PRE_TAUNTS.length, 'every taunt should be hit at least once across 365 days');
});

test('pickWorshipFirst returns from WORSHIP_FIRST_PLACE table', () => {
  const r = pickWorshipFirst('2026-05-04');
  assert.ok(WORSHIP_FIRST_PLACE.includes(r));
});

test('pickWorshipOther returns from WORSHIP_OTHER table', () => {
  const r = pickWorshipOther('2026-05-04');
  assert.ok(WORSHIP_OTHER.includes(r));
});

test('pickPostDone returns from POST_DONE table', () => {
  const r = pickPostDone('2026-05-04');
  assert.ok(POST_DONE.includes(r));
});

test('PRE_TAUNTS has at least 14 entries', () => {
  assert.ok(PRE_TAUNTS.length >= 14, `got ${PRE_TAUNTS.length}`);
});
```

- [ ] **Step 2: Run the failing tests**

```bash
cd server && node --test test/unit/gauntlet-copy.test.js
```

Expected: all tests fail with `Cannot find module`.

- [ ] **Step 3: Implement the module**

Create `server/src/copy/gauntlet-copy.js`:

```js
import { dateStringToSeed } from '../game/sgt-date.js';

export const PRE_TAUNTS = [
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
  "Today's questions don't care about your feelings.",
  "Sixty problems. One you. Good luck.",
  "Whatever you do, don't second-guess yourself.",
  "The leaderboard hungers."
];

export const WORSHIP_FIRST_PLACE = [
  "ALL HAIL",
  "BEHOLD",
  "KNEEL BEFORE",
  "PRAISE BE TO",
  "GLORY TO",
  "WITNESS"
];

export const WORSHIP_OTHER = [
  "BEHOLD",
  "WITNESS",
  "PRESENTING",
  "ENTER"
];

export const POST_DONE = [
  "see you tomorrow.",
  "today's run: locked.",
  "the overlords have seen enough.",
  "you've been counted.",
  "go touch grass."
];

function pickByDate(table, dateString) {
  const seed = dateStringToSeed(dateString);
  return table[seed % table.length];
}

export function pickPreTaunt(dateString)     { return pickByDate(PRE_TAUNTS, dateString); }
export function pickWorshipFirst(dateString) { return pickByDate(WORSHIP_FIRST_PLACE, dateString); }
export function pickWorshipOther(dateString) { return pickByDate(WORSHIP_OTHER, dateString); }
export function pickPostDone(dateString)     { return pickByDate(POST_DONE, dateString); }
```

> **Note on the "all entries reachable" test:** It will pass iff `PRE_TAUNTS.length` and 365 share no common factor that excludes some entries. With `length=18` and 365 days, every index 0-17 is reached because `gcd(18, 365)=1` (365 = 5×73, 18 = 2×3²). If you grow the array to a length sharing a factor with 365 (e.g. 73), the test would fail. Keep the count at a value coprime to 365 (most numbers under 30 are fine — avoid 5 and 73). 18 is fine.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && node --test test/unit/gauntlet-copy.test.js
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/copy/gauntlet-copy.js server/test/unit/gauntlet-copy.test.js
git commit -m "feat: gauntlet copy tables with date-seeded selection"
```

---

## Task 4: Extend session store for daily-gauntlet mode

**Files:**
- Modify: `server/src/game/session.js`

This is a non-trivial change to a core module. We do TDD-lite — modify the store, then verify via Task 8's integration tests. No dedicated unit test (the existing session-store behavior is exercised by `play.test.js`; this task adds new branches that we'll cover in integration).

- [ ] **Step 1: Read the current session store**

```bash
cat server/src/game/session.js
```

Identify the `start()` method (lines ~35-66) and the `answer()` method (lines ~68-105). Note the existing fields: `id, userId, config, practice, weighting, startedAt, lastTouchedAt, durationMs, score, currentQuestion, peekQuestion, rng, finalized, attempts, lastQuestionAskedAt, runId`.

- [ ] **Step 2: Modify `start()` to accept `mode` and `seedDate`**

Replace the entire `start()` method. The new method signature accepts `mode` and `seedDate`; when `mode === 'daily-gauntlet'`, it uses `dateStringToSeed(seedDate)` instead of `nextSeed()`, sets `totalQuestions=60`, and ignores `durationMs`.

In `server/src/game/session.js`, add this import at the top (after the existing imports):

```js
import { dateStringToSeed } from './sgt-date.js';
```

Replace the `start()` method (currently `start({ userId, config, practice = false, weighting = null })`):

```js
start({ userId, config, practice = false, weighting = null, mode = 'normal', seedDate = null }) {
  const sessionId = makeId();
  const startedAt = now();
  const isDailyGauntlet = mode === 'daily-gauntlet';
  const rng = isDailyGauntlet
    ? makeRng(dateStringToSeed(seedDate))
    : makeRng(nextSeed());
  const session = {
    id: sessionId,
    userId: userId ?? null,
    config,
    practice,
    weighting,
    mode,
    seedDate,                              // null for normal sessions
    totalQuestions: isDailyGauntlet ? 60 : null,
    currentQuestionIndex: isDailyGauntlet ? 0 : null,
    startTimeMs: startedAt,                // wall-clock start; used for daily-gauntlet duration
    startedAt,
    lastTouchedAt: startedAt,
    durationMs: isDailyGauntlet ? null : config.durationMs,
    score: 0,
    currentQuestion: null,
    peekQuestion: null,
    rng,
    finalized: false,
    attempts: [],
    lastQuestionAskedAt: startedAt,
    runId: null
  };
  session.currentQuestion = generate(session.config, session.rng, session.weighting);
  session.peekQuestion = generate(session.config, session.rng, session.weighting);
  sessions.set(sessionId, session);
  return {
    sessionId,
    question: publicQuestion(session.currentQuestion),
    peekQuestion: publicQuestion(session.peekQuestion),
    timeLimitMs: session.durationMs,                 // null for daily-gauntlet
    mode: session.mode,
    totalQuestions: session.totalQuestions,
    questionIndex: session.currentQuestionIndex
  };
},
```

- [ ] **Step 3: Modify `answer()` for daily-gauntlet completion logic**

Replace the `answer()` method. The change: for daily-gauntlet sessions, ignore the time-up branch entirely and detect completion by `currentQuestionIndex === totalQuestions` after a correct answer.

```js
answer(sessionId, userAnswer) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const t = now();
  session.lastTouchedAt = t;

  // Time-up branch: only for non-daily-gauntlet sessions.
  if (session.mode !== 'daily-gauntlet') {
    const elapsed = t - session.startedAt;
    if (elapsed >= session.durationMs) {
      session.finalized = true;
      return { timeUp: true, finalScore: session.score };
    }
  }

  const { correct } = grade(session.currentQuestion, userAnswer);
  if (correct) session.score += 1;

  if (recordsAttempts(session)) {
    const q = session.currentQuestion;
    session.attempts.push({
      qIndex: session.attempts.length,
      op: q.op,
      lhs: q.a,
      rhs: q.b,
      answer: q.answer,
      userAnswer,
      responseMs: t - session.lastQuestionAskedAt,
      correct,
      askedAt: new Date(session.lastQuestionAskedAt)
    });
  }
  session.lastQuestionAskedAt = t;

  // Daily-gauntlet completion: 60 correct = run done.
  if (session.mode === 'daily-gauntlet' && correct) {
    session.currentQuestionIndex += 1;
    if (session.currentQuestionIndex >= session.totalQuestions) {
      session.finalized = true;
      const durationMs = t - session.startTimeMs;
      session.durationMs = durationMs; // stamp it so flushRunIfRecording can use the right value
      return {
        timeUp: true,                  // reuse the existing "run-ended" signal
        finalScore: session.score,
        dailyGauntlet: true,
        durationMs
      };
    }
  }

  // Advance: previous peek becomes current; generate fresh peek.
  session.currentQuestion = session.peekQuestion;
  session.peekQuestion = newQuestion(session);
  return {
    correct,
    nextQuestion: publicQuestion(session.currentQuestion),
    peekQuestion: publicQuestion(session.peekQuestion),
    score: session.score,
    timeRemainingMs: session.mode === 'daily-gauntlet'
      ? null
      : Math.max(0, session.durationMs - (t - session.startedAt)),
    questionIndex: session.mode === 'daily-gauntlet' ? session.currentQuestionIndex : null,
    totalQuestions: session.totalQuestions
  };
},
```

- [ ] **Step 4: Modify `takeRunRecord()` to surface daily-gauntlet metadata**

Replace the existing `takeRunRecord` (currently returns `{userId, score, durationMs, practice, attempts}`):

```js
takeRunRecord(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const attempts = session.attempts;
  session.attempts = [];
  return {
    userId: session.userId,
    score: session.score,
    durationMs: session.durationMs,
    practice: session.practice === true,
    dailyGauntletDate: session.mode === 'daily-gauntlet' ? session.seedDate : null,
    submittedToLeaderboard: session.mode === 'daily-gauntlet'   // gauntlet completion = submitted
  };
}
```

Wait — that drops `attempts` from the return value. Restore it:

```js
takeRunRecord(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const attempts = session.attempts;
  session.attempts = [];
  return {
    userId: session.userId,
    score: session.score,
    durationMs: session.durationMs,
    practice: session.practice === true,
    dailyGauntletDate: session.mode === 'daily-gauntlet' ? session.seedDate : null,
    submittedToLeaderboard: session.mode === 'daily-gauntlet',
    attempts
  };
}
```

- [ ] **Step 5: Run existing test suite to confirm no regressions**

```bash
cd server && node --test test/unit/**/*.test.js
```

Expected: all existing unit tests pass (the changes are additive — normal-mode behavior is unchanged because the new fields default appropriately).

If `TEST_DATABASE_URL` is set, also run integration tests:

```bash
node --test test/integration/**/*.test.js
```

Expected: all existing integration tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/game/session.js
git commit -m "feat: extend session store with daily-gauntlet mode (60-question fixed-count)"
```

---

## Task 5: Wire daily-gauntlet `mode` into `/api/play/start`

**Files:**
- Modify: `server/src/routes/play.routes.js`
- Modify: `server/src/index.js` — accept optional `nowFn` arg.

- [ ] **Step 1: Add `nowFn` to `buildApp` options**

Read `server/src/index.js`:

```bash
grep -n "buildApp\|export async function\|nowFn\|sessionStore" server/src/index.js
```

Find the `buildApp` function (likely starts around line 8-15) and add an optional `nowFn = () => new Date()` parameter. Then plumb it to the play and board route registrations.

In `server/src/index.js`, change the destructured options of `buildApp` to include `nowFn`:

```js
export async function buildApp({ pool, cookieSecret, cookieSecure, sessionStore, nowFn = () => new Date() } = {}) {
  // ... existing body ...

  // Find these lines and add nowFn:
  await fastify.register(playRoutes,  { sessionStore, pool, nowFn });
  await fastify.register(boardRoutes, { pool, sessionStore, nowFn });

  // ... rest ...
}
```

(The exact lines registering `playRoutes` and `boardRoutes` already exist; just add `nowFn` to the options object.)

- [ ] **Step 2: Read current `play.routes.js`**

```bash
cat server/src/routes/play.routes.js
```

You'll see `export default async function playRoutes(fastify, { sessionStore, pool })`. Add `nowFn` to the destructure.

- [ ] **Step 3: Add imports at top of `play.routes.js`**

```js
import { requireAuth } from '../auth.js';
import { todaySgtDateString } from '../game/sgt-date.js';
import { DEFAULT_CONFIG } from '../config.js';
```

- [ ] **Step 4: Replace the `/api/play/start` handler**

Find the existing handler (lines ~8-28) and replace with this version that branches on `mode`:

```js
fastify.post('/api/play/start', async (req, reply) => {
  const mode = req.body?.mode;

  // Daily Gauntlet branch.
  if (mode === 'daily-gauntlet') {
    if (!req.user) {
      return reply.code(401).send({ error: 'register-to-play' });
    }
    const today = todaySgtDateString(nowFn());

    // Check if user has already completed today's gauntlet.
    const existing = await pool.query(
      `SELECT id, duration_ms, played_at
       FROM runs
       WHERE user_id = $1
         AND daily_gauntlet_date = $2
         AND submitted_to_leaderboard = true
       LIMIT 1`,
      [req.user.id, today]
    );
    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const rank = await computeDailyRank(pool, today, row.duration_ms, row.played_at);
      return {
        already_completed: true,
        time_ms: Number(row.duration_ms),
        rank
      };
    }

    // Start a daily-gauntlet session.
    const r = sessionStore.start({
      userId: req.user.id,
      config: DEFAULT_CONFIG,
      mode: 'daily-gauntlet',
      seedDate: today
    });
    return {
      session_id: r.sessionId,
      mode: r.mode,
      total_questions: r.totalQuestions,
      question_index: r.questionIndex,
      question: r.question,
      peek_question: r.peekQuestion
    };
  }

  // Normal / practice branch (existing behavior, unchanged).
  const config = req.body?.config;
  if (!config || typeof config !== 'object') {
    return reply.code(400).send({ error: 'invalid_config' });
  }
  const r = sessionStore.start({ userId: req.user?.id ?? null, config });
  return {
    session_id: r.sessionId,
    question: r.question,
    peek_question: r.peekQuestion,
    time_limit_ms: r.timeLimitMs
  };
});
```

> **Note:** `r.question` and `r.peekQuestion` are already `publicQuestion(...)` (`{prompt, op, answer}`) — no transformation needed. The existing `start` handler explicitly mapped them, but the new `start()` already returns the public shape (verify by re-reading session.js).

Actually — re-check: in `session.js` Task 4, the return is `{ sessionId, question: publicQuestion(...), peekQuestion: publicQuestion(...), ... }`. Good — no extra mapping.

- [ ] **Step 5: Add the `computeDailyRank` helper**

At the bottom of `play.routes.js` (after `flushRunIfRecording`), add:

```js
async function computeDailyRank(pool, dateString, myDurationMs, myPlayedAt) {
  // Rank = 1 + (number of users with strictly faster duration today,
  //              OR same duration but earlier played_at).
  const { rows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank
     FROM runs
     WHERE daily_gauntlet_date = $1
       AND submitted_to_leaderboard = true
       AND (duration_ms < $2 OR (duration_ms = $2 AND played_at < $3))`,
    [dateString, myDurationMs, myPlayedAt]
  );
  return Number(rows[0].rank);
}
```

- [ ] **Step 6: Run existing tests for regressions**

```bash
cd server && node --test test/unit/**/*.test.js
```

Expected: all unit tests still pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/index.js server/src/routes/play.routes.js
git commit -m "feat: /api/play/start accepts mode='daily-gauntlet' (auth-gated, day-locked)"
```

---

## Task 6: Wire daily-gauntlet completion through `flushRunIfRecording`

**Files:**
- Modify: `server/src/routes/play.routes.js`

The existing `flushRunIfRecording` writes `runs` with `(user_id, score, duration_ms, practice)`. Daily-gauntlet adds `daily_gauntlet_date` and forces `submitted_to_leaderboard = true`.

- [ ] **Step 1: Replace the `flushRunIfRecording` body**

In `server/src/routes/play.routes.js`, replace `flushRunIfRecording` (currently lines ~56-94):

```js
async function flushRunIfRecording(req, sessionId) {
  const rec = sessionStore.takeRunRecord(sessionId);
  if (!rec || rec.userId == null || rec.attempts.length === 0) return;

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const insRun = await client.query(
      `INSERT INTO runs (user_id, score, duration_ms, practice, daily_gauntlet_date, submitted_to_leaderboard)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [rec.userId, rec.score, rec.durationMs, rec.practice, rec.dailyGauntletDate, rec.submittedToLeaderboard]
    );
    const runId = Number(insRun.rows[0].id);

    // Bulk insert attempts (unchanged from before).
    const cols = ['run_id', 'q_index', 'op', 'lhs', 'rhs', 'answer', 'user_answer', 'response_ms', 'correct', 'asked_at'];
    const values = [];
    const placeholders = rec.attempts.map((a, i) => {
      const off = i * cols.length;
      values.push(runId, a.qIndex, a.op, a.lhs, a.rhs, a.answer, a.userAnswer, a.responseMs, a.correct, a.askedAt);
      return `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, $${off + 8}, $${off + 9}, $${off + 10})`;
    });
    await client.query(
      `INSERT INTO attempts (${cols.join(',')}) VALUES ${placeholders.join(',')}`,
      values
    );
    await client.query('COMMIT');

    // Stamp runId on the live in-memory session so subsequent ops can find it.
    const live = sessionStore.get(sessionId);
    if (live) live.runId = runId;
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    // Daily-gauntlet uniqueness violation (PG 23505) is expected for race-condition
    // double-starts; log + swallow. Other errors propagate via log only (existing pattern).
    if (err.code === '23505') {
      req.log.info({ err, sessionId }, 'daily-gauntlet: duplicate completion (race) ignored');
    } else {
      req.log.error({ err }, 'analytics: failed to persist run + attempts');
    }
  } finally {
    if (client) client.release();
  }
}
```

- [ ] **Step 2: Update `/api/play/answer` to surface daily-gauntlet completion fields**

Find the existing handler (lines ~30-54). At the time-up branch, add daily-gauntlet enrichment:

```js
fastify.post('/api/play/answer', { config: { rateLimit: answerLimit } }, async (req, reply) => {
  const { session_id, answer } = req.body ?? {};
  if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });
  const session = sessionStore.get(session_id);
  const r = sessionStore.answer(session_id, typeof answer === 'string' ? answer : '');
  if (r === null) return reply.code(404).send({ error: 'unknown_session' });

  if (r.timeUp) {
    await flushRunIfRecording(req, session_id);
    if (r.dailyGauntlet) {
      // Compute daily rank from the just-written row.
      const today = session.seedDate;
      const live = sessionStore.get(session_id);
      const playedAtRow = await pool.query(
        'SELECT played_at FROM runs WHERE id = $1',
        [live?.runId]
      );
      const playedAt = playedAtRow.rows[0]?.played_at ?? new Date();
      const rank = await computeDailyRank(pool, today, r.durationMs, playedAt);
      const totalRow = await pool.query(
        `SELECT COUNT(*)::int AS n FROM runs
         WHERE daily_gauntlet_date = $1 AND submitted_to_leaderboard = true`,
        [today]
      );
      return {
        time_up: true,
        final_score: r.finalScore,
        daily_gauntlet: true,
        time_ms: r.durationMs,
        rank,
        total_today: totalRow.rows[0].n
      };
    }
    return { time_up: true, final_score: r.finalScore };
  }
  return {
    correct: r.correct,
    next_question: r.nextQuestion,
    peek_question: r.peekQuestion,
    score: r.score,
    time_remaining_ms: r.timeRemainingMs,
    question_index: r.questionIndex,
    total_questions: r.totalQuestions
  };
});
```

> **Subtle bug to avoid:** `sessionStore.get(session_id)` is called *before* `sessionStore.answer(...)` because the answer call sets `finalized=true` which we don't currently delete the session, but `seedDate` lives on the session object — fetching it before guarantees we have it. Note that `sessionStore.get` was used for `live?.runId` afterward — `flushRunIfRecording` stamps `runId` on the live session even after `finalized`, so `sessionStore.get(session_id)` returning the post-flush state is correct. Just make sure we capture `seedDate` from the pre-answer state (we do).

Actually — re-reading the snippet: we only need `session.seedDate` *after* the answer call. The session is still in the map (not deleted by `answer`). So this is fine.

- [ ] **Step 3: Run existing tests for regressions**

```bash
cd server && node --test test/unit/**/*.test.js
```

Expected: all pass.

If `TEST_DATABASE_URL` is set:

```bash
cd server && node --test test/integration/play.test.js
```

Expected: all existing play integration tests pass — the new fields are additive.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/play.routes.js
git commit -m "feat: flushRunIfRecording writes daily_gauntlet_date and submitted=true atomically"
```

---

## Task 7: Add `/api/leaderboard/daily` and `/api/leaderboard/daily/me` routes

**Files:**
- Modify: `server/src/routes/board.routes.js`

- [ ] **Step 1: Update imports and accept `nowFn`**

In `server/src/routes/board.routes.js`, update imports and signature:

```js
import { requireAuth } from '../auth.js';
import { todaySgtDateString } from '../game/sgt-date.js';

export default async function boardRoutes(fastify, { pool, sessionStore, nowFn }) {
  // existing /api/leaderboard/submit handler unchanged
  // existing /api/leaderboard handler unchanged

  // ... new handlers below ...
}
```

- [ ] **Step 2: Add `GET /api/leaderboard/daily`**

Add after the existing `GET /api/leaderboard` handler:

```js
fastify.get('/api/leaderboard/daily', async (req) => {
  const today = todaySgtDateString(nowFn());
  const date = typeof req.query?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : today;

  const limit = Math.min(Number(req.query?.limit) || 100, 500);

  const { rows } = await pool.query(
    `SELECT u.username, r.duration_ms, r.played_at
     FROM runs r
     JOIN users u ON u.id = r.user_id
     WHERE r.daily_gauntlet_date = $1 AND r.submitted_to_leaderboard = true
     ORDER BY r.duration_ms ASC, r.played_at ASC
     LIMIT $2`,
    [date, limit]
  );

  return {
    date,
    entries: rows.map((r, i) => ({
      rank: i + 1,
      username: r.username,
      time_ms: Number(r.duration_ms),
      played_at: r.played_at.toISOString()
    }))
  };
});
```

- [ ] **Step 3: Add `GET /api/leaderboard/daily/me`**

Add immediately after:

```js
fastify.get('/api/leaderboard/daily/me', { preHandler: requireAuth }, async (req) => {
  const today = todaySgtDateString(nowFn());

  const { rows } = await pool.query(
    `SELECT duration_ms, played_at
     FROM runs
     WHERE user_id = $1 AND daily_gauntlet_date = $2 AND submitted_to_leaderboard = true
     LIMIT 1`,
    [req.user.id, today]
  );

  if (rows.length === 0) {
    return { played: false };
  }

  const { duration_ms, played_at } = rows[0];

  // Rank: 1 + count of strictly-faster (or same-time-but-earlier) entries.
  const rankRows = await pool.query(
    `SELECT COUNT(*) + 1 AS rank
     FROM runs
     WHERE daily_gauntlet_date = $1
       AND submitted_to_leaderboard = true
       AND (duration_ms < $2 OR (duration_ms = $2 AND played_at < $3))`,
    [today, duration_ms, played_at]
  );

  const totalRows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM runs
     WHERE daily_gauntlet_date = $1 AND submitted_to_leaderboard = true`,
    [today]
  );

  return {
    played: true,
    time_ms: Number(duration_ms),
    rank: Number(rankRows.rows[0].rank),
    total_today: totalRows.rows[0].n
  };
});
```

- [ ] **Step 4: Run existing tests for regressions**

```bash
cd server && node --test test/unit/**/*.test.js
```

Expected: all pass (no signature changes affect unit tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/board.routes.js
git commit -m "feat: GET /api/leaderboard/daily and /me endpoints"
```

---

## Task 8: Integration tests — daily-gauntlet end-to-end

**Files:**
- Create: `server/test/integration/daily-gauntlet.test.js`
- Modify: `server/test/integration/helper.js` — accept `nowFn` in `freshApp`.

These tests exercise everything we built in Tasks 1-7. Skip when `TEST_DATABASE_URL` is unset.

- [ ] **Step 1: Extend `helper.js` to accept `nowFn`**

In `server/test/integration/helper.js`, modify `freshApp`:

```js
export async function freshApp({ nowFn } = {}) {
  const pool = await getPool();
  if (!pool) return null;
  await pool.query('TRUNCATE attempts, runs, auth_sessions, users RESTART IDENTITY CASCADE');
  const sessionStore = createSessionStore({});
  const app = await buildApp({
    pool,
    cookieSecret: TEST_COOKIE_SECRET,
    cookieSecure: false,
    sessionStore,
    nowFn   // optional; buildApp defaults to () => new Date()
  });
  return { app, pool, sessionStore };
}
```

> **Note for time-injection tests:** Because `nowFn` is captured at app-build time as a closure and called fresh on each request, tests that need to *change* the "current time" mid-test should pass a `nowFn` that closes over a mutable reference. Pattern:
>
> ```js
> let fakeNow = new Date('2026-05-04T08:00:00Z');
> const { app } = await freshApp({ nowFn: () => fakeNow });
> // later in the test:
> fakeNow = new Date('2026-05-05T08:00:00Z');  // routes will see the new time
> ```

- [ ] **Step 2: Create the integration test file**

Create `server/test/integration/daily-gauntlet.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';

async function registerAndCookie(app, username) {
  const r = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password: 'password123' } });
  return cookieFromResponse(r);
}

async function startDaily(app, cookie) {
  return app.inject({
    method: 'POST',
    url: '/api/play/start',
    payload: { mode: 'daily-gauntlet' },
    headers: cookie ? { cookie } : {}
  });
}

async function answerOne(app, cookie, sessionId, sessionStore) {
  // Read the correct answer from the in-memory session, post it, repeat.
  const sess = sessionStore.get(sessionId);
  if (!sess || !sess.currentQuestion) return null;
  const correctAnswer = String(sess.currentQuestion.answer);
  const ans = await app.inject({
    method: 'POST',
    url: '/api/play/answer',
    payload: { session_id: sessionId, answer: correctAnswer },
    headers: { cookie }
  });
  return ans.json();
}

async function clearAll60(app, cookie, sessionId, sessionStore) {
  let last;
  for (let i = 0; i < 60; i++) {
    last = await answerOne(app, cookie, sessionId, sessionStore);
    if (!last) break;
    if (last.time_up) return last;
  }
  return last;
}

test('daily-gauntlet: guest is blocked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const r = await startDaily(app, null);
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, 'register-to-play');
});

test('daily-gauntlet: logged-in start returns expected envelope', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const r = await startDaily(app, cookie);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.mode, 'daily-gauntlet');
  assert.equal(body.total_questions, 60);
  assert.equal(body.question_index, 0);
  assert.ok(body.session_id);
  assert.ok(body.question);
  assert.ok(body.peek_question);
});

test('daily-gauntlet: two users get same questions today', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cA = await registerAndCookie(app, 'alice');
  const cB = await registerAndCookie(app, 'bob');

  const rA = await startDaily(app, cA);
  const rB = await startDaily(app, cB);
  const sA = sessionStore.get(rA.json().session_id);
  const sB = sessionStore.get(rB.json().session_id);

  // Compare first 5 questions.
  for (let i = 0; i < 5; i++) {
    assert.equal(sA.currentQuestion.prompt, sB.currentQuestion.prompt, `question ${i} mismatch`);
    // Advance both by feeding correct answers.
    await answerOne(app, cA, rA.json().session_id, sessionStore);
    await answerOne(app, cB, rB.json().session_id, sessionStore);
  }
});

test('daily-gauntlet: different injected dates produce different questions', async (t) => {
  if (skipIfNoDb(t)) return;
  let fakeNow = new Date('2026-05-04T08:00:00Z');
  const { app, sessionStore } = await freshApp({ nowFn: () => fakeNow });
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const r1 = await startDaily(app, cookie);
  const q1 = sessionStore.get(r1.json().session_id).currentQuestion.prompt;

  // Tear down session 1 by clearing it (or just start a new one with a fresh user/day).
  // Instead, register a second user and shift the date.
  const c2 = await registerAndCookie(app, 'bob');
  fakeNow = new Date('2026-05-05T08:00:00Z');
  const r2 = await startDaily(app, c2);
  const q2 = sessionStore.get(r2.json().session_id).currentQuestion.prompt;

  // Two different days → two different seeded sequences. Vanishingly unlikely they match by chance.
  assert.notEqual(q1, q2, 'expected different questions across days');
});

test('daily-gauntlet: cleared run persists with daily_gauntlet_date and submitted=true', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await startDaily(app, cookie);
  const { session_id } = start.json();

  const last = await clearAll60(app, cookie, session_id, sessionStore);
  assert.equal(last.time_up, true);
  assert.equal(last.daily_gauntlet, true);
  assert.equal(last.final_score, 60);
  assert.ok(last.time_ms > 0);
  assert.equal(last.rank, 1);
  assert.equal(last.total_today, 1);

  const { rows } = await pool.query('SELECT * FROM runs WHERE user_id = (SELECT id FROM users WHERE username=$1)', ['alice']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 60);
  assert.equal(rows[0].submitted_to_leaderboard, true);
  assert.ok(rows[0].daily_gauntlet_date);
});

test('daily-gauntlet: re-start blocked after completion', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await startDaily(app, cookie);
  await clearAll60(app, cookie, start.json().session_id, sessionStore);

  const r = await startDaily(app, cookie);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.already_completed, true);
  assert.ok(typeof body.time_ms === 'number');
  assert.equal(body.rank, 1);
});

test('daily-gauntlet: leaderboard endpoint ranks by duration', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  // Three users complete with different times — we control timing by feeding answers fast.
  // Since durations are real wall-clock, we can't guarantee ordering perfectly.
  // Instead: register them, complete in order, assert the leaderboard reports them.
  const c1 = await registerAndCookie(app, 'alice');
  const s1 = await startDaily(app, c1);
  await clearAll60(app, c1, s1.json().session_id, sessionStore);

  const c2 = await registerAndCookie(app, 'bob');
  const s2 = await startDaily(app, c2);
  await clearAll60(app, c2, s2.json().session_id, sessionStore);

  const board = await app.inject({ method: 'GET', url: '/api/leaderboard/daily' });
  assert.equal(board.statusCode, 200);
  const body = board.json();
  assert.equal(body.entries.length, 2);
  // Faster duration first; we can't predict who's faster, but we can assert ordering is by duration_ms ASC.
  assert.ok(body.entries[0].time_ms <= body.entries[1].time_ms);
  assert.equal(body.entries[0].rank, 1);
  assert.equal(body.entries[1].rank, 2);
});

test('daily-gauntlet: empty day returns []', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const r = await app.inject({ method: 'GET', url: '/api/leaderboard/daily?date=2099-01-01' });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.date, '2099-01-01');
  assert.deepEqual(body.entries, []);
});

test('daily-gauntlet: /me returns played:false when not played', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const r = await app.inject({ method: 'GET', url: '/api/leaderboard/daily/me', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { played: false });
});

test('daily-gauntlet: /me returns rank and time after completion', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const s = await startDaily(app, cookie);
  await clearAll60(app, cookie, s.json().session_id, sessionStore);

  const r = await app.inject({ method: 'GET', url: '/api/leaderboard/daily/me', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.played, true);
  assert.ok(typeof body.time_ms === 'number');
  assert.equal(body.rank, 1);
  assert.equal(body.total_today, 1);
});

test('daily-gauntlet: wrong answer does not advance', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const s = await startDaily(app, cookie);
  const { session_id } = s.json();

  const beforeQuestion = sessionStore.get(session_id).currentQuestion.prompt;

  // Wrong answer.
  const r = await app.inject({
    method: 'POST',
    url: '/api/play/answer',
    payload: { session_id, answer: 'definitely-wrong' },
    headers: { cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.correct, false);
  assert.equal(body.question_index, 0);  // didn't advance

  // The current question changed because the existing flow advances on EVERY answer
  // (see session.js:96-97 — current = peek, peek = newQuestion). This is the SAME
  // behavior as practice mode. Daily-gauntlet inherits it: a wrong answer still
  // burns the question. Worth confirming this matches the design intent.
  // Spec section 4d says "Wrong-answer / silent-reject behavior: unchanged."
  // The frontend uses input-grading to ONLY submit when the answer is numerically correct,
  // so wrong-answer submissions can only happen via direct API calls (cheating attempts).
  // Behavior: wrong submissions still advance server-side; client never sends them.
});

test('daily-gauntlet: day rollover stamps yesterday on completion started yesterday', async (t) => {
  if (skipIfNoDb(t)) return;
  let fakeNow = new Date('2026-05-04T15:58:00Z');  // 23:58 SGT on 2026-05-04
  const { app, sessionStore, pool } = await freshApp({ nowFn: () => fakeNow });
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await startDaily(app, cookie);
  const { session_id } = start.json();

  // Roll past midnight SGT.
  fakeNow = new Date('2026-05-04T16:02:00Z');  // 00:02 SGT on 2026-05-05
  await clearAll60(app, cookie, session_id, sessionStore);

  const { rows } = await pool.query('SELECT daily_gauntlet_date FROM runs LIMIT 1');
  // Date written is the seedDate captured at start: 2026-05-04 (SGT).
  assert.equal(rows[0].daily_gauntlet_date.toISOString().slice(0, 10), '2026-05-04');

  // Now starting again (it's "today" SGT 2026-05-05) is allowed.
  const restart = await startDaily(app, cookie);
  assert.equal(restart.statusCode, 200);
  const body = restart.json();
  assert.equal(body.mode, 'daily-gauntlet');
  assert.equal(body.already_completed, undefined);
});
```

> **Note on the wrong-answer test comment:** the existing session-store `answer()` method advances `currentQuestion = peekQuestion` on *every* call, regardless of correctness. So a wrong answer to question 0 in daily-gauntlet still consumes that question. The frontend never sends wrong answers (input-grading on the client), so this only matters for direct API misuse / cheating. The test asserts `question_index` doesn't advance on wrong (which is correct — `currentQuestionIndex` only increments on `correct === true`), but the question prompt itself does change. This is consistent with the spec's "silent-reject" framing — the *progression counter* doesn't tick, only the prompt rotates. If you decide to lock the prompt on wrong answers, that's a separate change with broader implications; for v1, accept this behavior.

- [ ] **Step 3: Run the integration tests**

If `TEST_DATABASE_URL` is set:

```bash
cd server && node --test test/integration/daily-gauntlet.test.js
```

Expected: all 12 tests pass.

If not set, document and skip:

```bash
cd server && node --test test/integration/daily-gauntlet.test.js
# Expected: tests SKIP. Run them later in CI / before deploy.
```

- [ ] **Step 4: Run full test suite**

```bash
cd server && node --test test/unit/**/*.test.js test/integration/**/*.test.js
```

Expected: no regressions in existing tests.

- [ ] **Step 5: Commit**

```bash
git add server/test/integration/daily-gauntlet.test.js server/test/integration/helper.js
git commit -m "test: integration tests for daily gauntlet end-to-end"
```

---

## Task 9: Add daily-gauntlet API methods to client `api.js`

**Files:**
- Modify: `client/js/api.js`

- [ ] **Step 1: Read current api.js**

```bash
cat client/js/api.js
```

- [ ] **Step 2: Add new methods**

Replace the `api` export object:

```js
export const api = {
  me:        () => request('GET',  '/me'),
  register:  ({ username, password }) => request('POST', '/register', { username, password }),
  login:     ({ username, password }) => request('POST', '/login',    { username, password }),
  logout:    () => request('POST', '/logout'),
  startPlay: (config) => request('POST', '/play/start',  { config }),
  startDailyGauntlet: () => request('POST', '/play/start', { mode: 'daily-gauntlet' }),
  answer:    (session_id, answer) => request('POST', '/play/answer', { session_id, answer }),
  submit:    (session_id) => request('POST', '/leaderboard/submit', { session_id }),
  board:     () => request('GET',  '/leaderboard'),
  dailyBoard: (date) => request('GET', '/leaderboard/daily' + (date ? `?date=${date}` : '')),
  dailyMe:   () => request('GET', '/leaderboard/daily/me')
};
```

- [ ] **Step 3: Commit**

```bash
git add client/js/api.js
git commit -m "feat: client api.js exposes daily-gauntlet endpoints"
```

---

## Task 10: Restructure `index.html` — Daily Hero + leaderboard widget + relocated Show Advanced

**Files:**
- Modify: `client/index.html`

- [ ] **Step 1: Replace `<main>` body**

Read `client/index.html` first to keep the topbar and head intact:

```bash
cat client/index.html
```

Replace ONLY the contents of `<main id="app" class="narrow">...</main>` with:

```html
  <main id="app" class="narrow">
    <!-- Daily Challenge hero block (Section 4b) -->
    <section class="daily-hero" id="daily-hero" data-state="loading">
      <div class="daily-hero-text">
        <div class="daily-hero-title" id="daily-hero-title">DAILY CHALLENGE</div>
        <div class="daily-hero-sub" id="daily-hero-sub">Loading…</div>
      </div>
      <button class="daily-hero-btn" id="daily-hero-btn" disabled>—</button>
    </section>

    <div class="landing-buttons">
      <button class="primary" id="start-user">Start as User</button>
      <button class="secondary" id="start-guest">Start as Guest</button>
    </div>

    <!-- Today's Daily Leaderboard (Section 4c) -->
    <section class="daily-board" id="daily-board">
      <h2>Today's Daily Leaderboard</h2>
      <ol class="daily-board-list" id="daily-board-list">
        <li class="dim">Loading…</li>
      </ol>
      <a class="daily-board-link" href="leaderboard.html#daily">→ See all rankings</a>
    </section>

    <details class="advanced-disclosure" id="advanced">
      <summary>Show advanced (custom settings)</summary>
      <span class="eligibility-badge" id="eligibility">leaderboard-eligible</span>
      <div class="default-summary">
        <strong>Default run:</strong> all four ops · 120 s ·
        add 2–100 · sub 2–100 · mul 2–12×2–100 · div 2–12×2–100.
        Only default runs qualify for the leaderboard.
      </div>
      <div class="settings-grid" id="settings-grid">
        <fieldset class="op-card" data-op="add" style="--i: 0">
          <legend><label><input type="checkbox" name="add_enabled" checked /> <span class="op-sym">+</span> Addition</label></legend>
          <div class="range">
            <label>min <input type="number" name="add_min" min="0" max="9999" value="2" /></label>
            <label>max <input type="number" name="add_max" min="0" max="9999" value="100" /></label>
          </div>
        </fieldset>
        <fieldset class="op-card" data-op="sub" style="--i: 1">
          <legend><label><input type="checkbox" name="sub_enabled" checked /> <span class="op-sym">−</span> Subtraction</label></legend>
          <div class="range">
            <label>min <input type="number" name="sub_min" min="0" max="9999" value="2" /></label>
            <label>max <input type="number" name="sub_max" min="0" max="9999" value="100" /></label>
          </div>
          <p class="hint">Generated to keep results ≥ 0.</p>
        </fieldset>
        <fieldset class="op-card" data-op="mul" style="--i: 2">
          <legend><label><input type="checkbox" name="mul_enabled" checked /> <span class="op-sym">×</span> Multiplication</label></legend>
          <div class="range">
            <label>lhs min <input type="number" name="mul_lhsMin" min="0" max="9999" value="2" /></label>
            <label>lhs max <input type="number" name="mul_lhsMax" min="0" max="9999" value="12" /></label>
          </div>
          <div class="range-pair">
            <div class="range">
              <label>rhs min <input type="number" name="mul_rhsMin" min="0" max="9999" value="2" /></label>
              <label>rhs max <input type="number" name="mul_rhsMax" min="0" max="9999" value="100" /></label>
            </div>
          </div>
        </fieldset>
        <fieldset class="op-card" data-op="div" style="--i: 3">
          <legend><label><input type="checkbox" name="div_enabled" checked /> <span class="op-sym">÷</span> Division</label></legend>
          <div class="range">
            <label>lhs min <input type="number" name="div_lhsMin" min="0" max="9999" value="2" /></label>
            <label>lhs max <input type="number" name="div_lhsMax" min="0" max="9999" value="12" /></label>
          </div>
          <div class="range-pair">
            <div class="range">
              <label>rhs min <input type="number" name="div_rhsMin" min="0" max="9999" value="2" /></label>
              <label>rhs max <input type="number" name="div_rhsMax" min="0" max="9999" value="100" /></label>
            </div>
          </div>
          <p class="hint">Integer answers only.</p>
        </fieldset>
        <fieldset class="op-card duration-card" style="--i: 4">
          <legend><span class="op-sym">⧗</span> Duration</legend>
          <div class="range">
            <label>seconds <input type="number" name="duration" min="5" max="3600" value="120" /></label>
          </div>
          <div class="quick-picks">
            <button type="button" data-secs="30">30 s</button>
            <button type="button" data-secs="60">60 s</button>
            <button type="button" data-secs="120">120 s</button>
            <button type="button" data-secs="300">5 min</button>
          </div>
        </fieldset>
      </div>
    </details>
  </main>
```

> **What changed:**
> 1. `<h1>Multiplayer drill</h1>` removed — the daily hero is the headline.
> 2. `.eligibility-badge` and `.default-summary` moved INTO the `<details>` disclosure.
> 3. New `.daily-hero` section at the top.
> 4. New `.daily-board` widget below the start buttons.

- [ ] **Step 2: Verify HTML structure**

Open `index.html` in a text editor; confirm:
- `<header class="topbar">` is unchanged (still has Practice, Leaderboard, user-area).
- `<script type="module" src="js/landing.js"></script>` is still at the bottom.
- The eligibility badge no longer appears at the top of `<main>`.

- [ ] **Step 3: Commit**

```bash
git add client/index.html
git commit -m "ui: restructure landing — daily hero + board widget; tuck eligibility into Show Advanced"
```

---

## Task 11: Update `landing.js` — render daily hero state machine + board widget

**Files:**
- Modify: `client/js/landing.js`

The current landing.js handles the "Start as User/Guest" flow. Daily-gauntlet adds three things: render the hero state, fetch + render the daily leaderboard widget, and route the hero CTA.

- [ ] **Step 1: Replace `landing.js` content**

Replace the entire file with:

```js
import { api } from './api.js';

const DEFAULT_CONFIG = {
  ops: {
    add: { enabled: true, min: 2, max: 100 },
    sub: { enabled: true, min: 2, max: 100 },
    mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
    div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
  },
  durationMs: 120_000
};

// Mirror of server/src/copy/gauntlet-copy.js — kept in sync manually.
// (Frontend duplicates these tables to render the hero & widget without an
// extra round-trip.)
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
  "Today's questions don't care about your feelings.",
  "Sixty problems. One you. Good luck.",
  "Whatever you do, don't second-guess yourself.",
  "The leaderboard hungers."
];

const POST_DONE = [
  "see you tomorrow.",
  "today's run: locked.",
  "the overlords have seen enough.",
  "you've been counted.",
  "go touch grass."
];

const WORSHIP_FIRST = ["ALL HAIL", "BEHOLD", "KNEEL BEFORE", "PRAISE BE TO", "GLORY TO", "WITNESS"];

function todaySgtDateString() {
  // Mirror of server/src/game/sgt-date.js for client display purposes.
  const now = new Date();
  const sgtMs = now.getTime() + 8 * 60 * 60 * 1000;
  return new Date(sgtMs).toISOString().slice(0, 10);
}

function dateStringToSeed(s) { return Number(s.replace(/-/g, '')); }
function pickByDate(table, dateString) { return table[dateStringToSeed(dateString) % table.length]; }

function formatTimeMs(ms) {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function readCustomConfig() {
  const v = (name) => Number(document.querySelector(`[name="${name}"]`).value);
  const c = (name) => document.querySelector(`[name="${name}"]`).checked;
  const duration = v('duration');
  return {
    ops: {
      add: { enabled: c('add_enabled'), min: v('add_min'), max: v('add_max') },
      sub: { enabled: c('sub_enabled'), min: v('sub_min'), max: v('sub_max') },
      mul: { enabled: c('mul_enabled'), lhsMin: v('mul_lhsMin'), lhsMax: v('mul_lhsMax'), rhsMin: v('mul_rhsMin'), rhsMax: v('mul_rhsMax') },
      div: { enabled: c('div_enabled'), lhsMin: v('div_lhsMin'), lhsMax: v('div_lhsMax'), rhsMin: v('div_rhsMin'), rhsMax: v('div_rhsMax') }
    },
    durationMs: duration * 1000
  };
}

function renderUserArea(user) {
  const el = document.getElementById('user-area');
  if (user) {
    el.innerHTML = `<span class="user-chip">${user.username} <a href="#" id="logout">log out</a></span>`;
    document.getElementById('logout').addEventListener('click', async (e) => {
      e.preventDefault();
      const link = e.currentTarget;
      if (link.dataset.busy === '1') return;
      link.dataset.busy = '1';
      link.textContent = 'logging out…';
      link.style.pointerEvents = 'none';
      try { await api.logout(); }
      catch (ex) { console.warn('logout request failed; navigating anyway', ex); }
      location.href = location.pathname;
    });
  } else {
    el.innerHTML = `<a href="login.html">Log in</a> <a href="register.html">Register</a>`;
  }
}

function setEligibility(advancedOpen) {
  const badge = document.getElementById('eligibility');
  if (!badge) return;
  if (advancedOpen) {
    badge.textContent = 'custom run — not eligible';
    badge.classList.add('dim');
  } else {
    badge.textContent = 'leaderboard-eligible';
    badge.classList.remove('dim');
  }
}

function startGame(mode /* 'user' | 'guest' */) {
  const advancedOpen = document.getElementById('advanced').open;
  const config = advancedOpen ? readCustomConfig() : DEFAULT_CONFIG;
  sessionStorage.setItem('zc_config', JSON.stringify(config));
  sessionStorage.setItem('zc_mode', mode);
  location.href = 'play.html';
}

async function renderDailyHero(user) {
  const hero = document.getElementById('daily-hero');
  const titleEl = document.getElementById('daily-hero-title');
  const subEl = document.getElementById('daily-hero-sub');
  const btn = document.getElementById('daily-hero-btn');
  const today = todaySgtDateString();

  if (!user) {
    // State C: guest.
    hero.dataset.state = 'guest';
    titleEl.textContent = 'DAILY CHALLENGE — register to play.';
    subEl.textContent = 'One shot a day. Worldwide ranking.';
    btn.textContent = 'REGISTER →';
    btn.disabled = false;
    btn.addEventListener('click', () => { location.href = 'register.html'; });
    return;
  }

  // Logged in — fetch /me to determine completion state.
  let me = null;
  try { me = await api.dailyMe(); } catch { /* default to "ready" */ }

  if (me && me.played) {
    // State B: completed.
    hero.dataset.state = 'completed';
    titleEl.textContent = `CLEARED IN ${formatTimeMs(me.time_ms)} — ${pickByDate(POST_DONE, today)}`;
    // Fetch top entry to show today's overlord.
    try {
      const board = await api.dailyBoard();
      if (board.entries.length > 0) {
        const top = board.entries[0];
        const verb = pickByDate(WORSHIP_FIRST, today);
        subEl.textContent = `Today's overlord: ${verb} ${top.username} · ${formatTimeMs(top.time_ms)}`;
      } else {
        subEl.textContent = 'You posted today\'s only run. Lonely at the top.';
      }
    } catch { subEl.textContent = ''; }
    btn.textContent = '✓ DONE';
    btn.disabled = true;
    return;
  }

  // State A: not played yet.
  hero.dataset.state = 'ready';
  titleEl.textContent = `DAILY CHALLENGE — ${pickByDate(PRE_TAUNTS, today)}`;
  subEl.textContent = '60 questions, 1 shot. Same drill worldwide today.';
  btn.textContent = 'START';
  btn.disabled = false;
  btn.addEventListener('click', () => { location.href = 'play.html?mode=daily-gauntlet'; });
}

async function renderDailyBoardWidget(user) {
  const list = document.getElementById('daily-board-list');
  let board, me;
  try {
    board = await api.dailyBoard();
    if (user) {
      try { me = await api.dailyMe(); } catch {}
    }
  } catch (ex) {
    list.innerHTML = `<li class="dim">Could not load today's leaderboard.</li>`;
    return;
  }

  if (board.entries.length === 0) {
    list.innerHTML = `<li class="dim">Nobody's stepped up yet today.</li>`;
    return;
  }

  const today = todaySgtDateString();
  const top5 = board.entries.slice(0, 5);
  const items = top5.map((e, i) => {
    if (i === 0) {
      const verb = pickByDate(WORSHIP_FIRST, today);
      return `<li class="overlord">${verb} <strong>${escapeHtml(e.username)}</strong> · today's arithmetic overlord · ${formatTimeMs(e.time_ms)}</li>`;
    }
    return `<li>${i + 1}. ${escapeHtml(e.username)} <span class="dim">·</span> ${formatTimeMs(e.time_ms)}</li>`;
  });

  // Append "you" row if user played and isn't in top 5.
  if (me && me.played && me.rank > 5) {
    items.push(`<li class="you">${me.rank}. you <span class="dim">·</span> ${formatTimeMs(me.time_ms)}</li>`);
  }

  list.innerHTML = items.join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.duration-card .quick-picks button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector('[name="duration"]').value = b.dataset.secs;
    });
  });

  const adv = document.getElementById('advanced');
  if (adv) adv.addEventListener('toggle', () => setEligibility(adv.open));

  document.getElementById('start-guest').addEventListener('click', () => startGame('guest'));
  document.getElementById('start-user').addEventListener('click', async () => {
    const advancedOpen = document.getElementById('advanced').open;
    const config = advancedOpen ? readCustomConfig() : DEFAULT_CONFIG;
    sessionStorage.setItem('zc_config', JSON.stringify(config));
    sessionStorage.setItem('zc_mode', 'user');
    let me = null;
    try { me = (await api.me()).user; } catch {}
    if (!me) {
      location.href = `login.html?next=${encodeURIComponent('play')}`;
      return;
    }
    location.href = 'play.html';
  });

  // Top-right user area + daily hero state.
  let user = null;
  try { user = (await api.me()).user; } catch {}
  renderUserArea(user);
  await renderDailyHero(user);
  await renderDailyBoardWidget(user);
});
```

> **Note on duplication:** The PRE_TAUNTS / POST_DONE / WORSHIP_FIRST tables are duplicated between `client/js/landing.js` and `server/src/copy/gauntlet-copy.js`. This is intentional for v1 — the server uses them in API responses (potential future use; not strictly needed today since the client makes display decisions); the client uses them locally to avoid an extra round-trip. The shared dependency is `dateStringToSeed` arithmetic — if you change a copy table on one side without the other, the rendered text drifts (which is mostly cosmetic). A future refactor could ship the tables via an `/api/copy/gauntlet` endpoint or build-time codegen; not v1.

- [ ] **Step 2: Manual verification**

If you have a local dev server running, open http://localhost:3000/. With no auth, the hero should show State C (REGISTER). After registering, refresh — should show State A (rotating taunt + START). The daily-board widget should say "Nobody's stepped up yet today."

- [ ] **Step 3: Commit**

```bash
git add client/js/landing.js
git commit -m "feat: landing.js renders daily hero (3 states) and daily board widget"
```

---

## Task 12: Teach `play.js` to handle `?mode=daily-gauntlet`

**Files:**
- Modify: `client/js/play.js`
- Modify: `client/play.html` — add mode-pill markup.

The play page is the most behavior-heavy change. It needs to detect the URL param, swap HUD semantics (Q N/60 progress vs time-based), count up vs down, and render a daily-flavored score view.

- [ ] **Step 1: Add mode pill markup to play.html**

Read `client/play.html`:

```bash
cat client/play.html
```

Find the `<section id="drill">` (or equivalent — the drill-bar area). Add a mode pill element next to the time bar. Search for `<div class="time-bar">`. Add IMMEDIATELY before that line:

```html
      <div class="mode-pill hidden" id="mode-pill">DAILY GAUNTLET</div>
```

- [ ] **Step 2: Replace `play.js` content**

Read the current `play.js`:

```bash
cat client/js/play.js
```

Replace the entire file. The new version detects daily-gauntlet via URL param, branches in `start()` and `tickClock()` and `finalizeOnTimeout()` and `finish()`:

```js
import { api } from './api.js';

// Mirror of server gauntlet-copy.js for client-side score-view rendering.
const WORSHIP_FIRST = ["ALL HAIL", "BEHOLD", "KNEEL BEFORE", "PRAISE BE TO", "GLORY TO", "WITNESS"];
const WORSHIP_OTHER = ["BEHOLD", "WITNESS", "PRESENTING", "ENTER"];
const POST_DONE = [
  "see you tomorrow.",
  "today's run: locked.",
  "the overlords have seen enough.",
  "you've been counted.",
  "go touch grass."
];

function todaySgtDateString() {
  const now = new Date();
  const sgtMs = now.getTime() + 8 * 60 * 60 * 1000;
  return new Date(sgtMs).toISOString().slice(0, 10);
}

function dateStringToSeed(s) { return Number(s.replace(/-/g, '')); }
function pickByDate(table, dateString) { return table[dateStringToSeed(dateString) % table.length]; }

function formatTimeMs(ms) {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

const els = {
  score: () => document.getElementById('score'),
  timer: () => document.getElementById('timer'),
  bar: () => document.getElementById('time-bar-fill'),
  prompt: () => document.getElementById('prompt-text'),
  form: () => document.getElementById('answer-form'),
  input: () => document.getElementById('answer'),
  scoreScreen: () => document.getElementById('score-screen'),
  finalScore: () => document.getElementById('final-score'),
  postNote: () => document.getElementById('post-note'),
  modalRoot: () => document.getElementById('modal-root'),
  playAgain: () => document.getElementById('play-again'),
  modePill: () => document.getElementById('mode-pill')
};

const state = {
  sessionId: null,
  config: null,
  mode: 'guest',
  dailyGauntlet: false,
  authedUser: null,
  isDefaultConfig: true,
  timeLimitMs: 0,        // null for daily-gauntlet
  startedAt: 0,
  finished: false,
  finalScore: 0,
  currentAnswer: null,
  peekQuestion: null,
  timerExpired: false,
  practice: false,
  // Daily-gauntlet specific:
  totalQuestions: null,
  questionIndex: 0,
  // Op-summary accumulator (built client-side from /answer responses).
  opStats: { add: [], sub: [], mul: [], div: [] }
};

function readPracticeSession() {
  try {
    const raw = sessionStorage.getItem('zc_practice_session');
    if (!raw) return null;
    sessionStorage.removeItem('zc_practice_session');
    return JSON.parse(raw);
  } catch { return null; }
}

function isDefaultConfig(c) {
  if (!c) return false;
  const D = {
    ops: {
      add: { enabled: true, min: 2, max: 100 },
      sub: { enabled: true, min: 2, max: 100 },
      mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
      div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
    },
    durationMs: 120_000
  };
  return JSON.stringify(c) === JSON.stringify(D);
}

function tickClock() {
  if (state.finished) return;
  const elapsed = performance.now() - state.startedAt;
  if (state.dailyGauntlet) {
    // Count UP, no time-up.
    els.timer().textContent = formatTimeMs(elapsed);
    // Bar tracks Q progress, not time.
    const frac = state.questionIndex / state.totalQuestions;
    els.bar().style.transform = `scaleX(${frac})`;
  } else {
    const remaining = Math.max(0, state.timeLimitMs - elapsed);
    els.timer().textContent = Math.ceil(remaining / 1000);
    els.bar().style.transform = `scaleX(${remaining / state.timeLimitMs})`;
    if (remaining <= 10_000) els.timer().classList.add('low');
    if (remaining <= 0 && !state.timerExpired) {
      state.timerExpired = true;
      finalizeOnTimeout();
      return;
    }
  }
  requestAnimationFrame(tickClock);
}

async function finalizeOnTimeout() {
  let r;
  try { r = await api.answer(state.sessionId, ''); }
  catch (ex) { finish({ final_score: state.finalScore }); return; }
  if (r && r.time_up) finish(r);
  else finish({ final_score: state.finalScore });
}

async function startDailyGauntlet() {
  state.dailyGauntlet = true;
  state.mode = 'user';
  state.isDefaultConfig = true;

  let r;
  try { r = await api.startDailyGauntlet(); }
  catch (e) {
    if (e.status === 401) { location.href = 'register.html'; return; }
    alert('Could not start daily gauntlet: ' + e.message);
    location.href = 'index.html';
    return;
  }

  if (r.already_completed) {
    location.href = 'index.html';
    return;
  }

  state.sessionId = r.session_id;
  state.totalQuestions = r.total_questions;
  state.questionIndex = r.question_index;
  state.timeLimitMs = null;
  state.startedAt = performance.now();

  els.modePill().classList.remove('hidden');
  els.prompt().textContent = r.question.prompt;
  els.timer().textContent = '0:00';
  els.score().textContent = `${state.questionIndex} / ${state.totalQuestions}`;
  state.currentAnswer = r.question.answer;
  state.peekQuestion = r.peek_question;
  requestAnimationFrame(tickClock);
}

async function start() {
  const url = new URL(location.href);
  if (url.searchParams.get('mode') === 'daily-gauntlet') {
    try { state.authedUser = (await api.me()).user; } catch {}
    if (!state.authedUser) { location.href = 'register.html'; return; }
    return startDailyGauntlet();
  }

  const practice = readPracticeSession();
  if (practice) {
    try { state.authedUser = (await api.me()).user; } catch {}
    state.practice = true;
    state.mode = 'user';
    state.isDefaultConfig = true;
    state.sessionId = practice.sessionId;
    state.timeLimitMs = practice.timeLimitMs;
    state.startedAt = performance.now();
    els.prompt().textContent = practice.question.prompt;
    els.timer().textContent = Math.ceil(practice.timeLimitMs / 1000);
    state.currentAnswer = practice.question.answer;
    state.peekQuestion = practice.peekQuestion;
    document.getElementById('practice-badge').classList.remove('hidden');
    requestAnimationFrame(tickClock);
    return;
  }

  const cfg = JSON.parse(sessionStorage.getItem('zc_config') || 'null');
  state.config = cfg;
  state.mode = sessionStorage.getItem('zc_mode') || 'guest';
  state.isDefaultConfig = isDefaultConfig(cfg);

  if (!cfg) { location.href = 'index.html'; return; }

  try { state.authedUser = (await api.me()).user; } catch {}

  let r;
  try { r = await api.startPlay(cfg); }
  catch (e) { alert('Could not start: ' + e.message); location.href = 'index.html'; return; }

  state.sessionId = r.session_id;
  state.timeLimitMs = r.time_limit_ms;
  state.startedAt = performance.now();
  els.prompt().textContent = r.question.prompt;
  els.timer().textContent = Math.ceil(r.time_limit_ms / 1000);
  state.currentAnswer = r.question.answer;
  state.peekQuestion = r.peek_question;
  requestAnimationFrame(tickClock);
}

function submitCorrectAnswer(value) {
  if (state.peekQuestion == null) {
    return submitAnswerAwaited(value);
  }
  const advancedTo = state.peekQuestion;
  state.currentAnswer = advancedTo.answer;
  state.peekQuestion = null;
  els.input().value = '';
  els.prompt().textContent = advancedTo.prompt;
  els.input().classList.add('correct');
  setTimeout(() => els.input().classList.remove('correct'), 220);
  postAnswer(value);
}

async function postAnswer(value) {
  let r;
  try { r = await api.answer(state.sessionId, value); }
  catch (ex) {
    if (ex.status === 404) { alert('Server hiccuped — please start a new run.'); location.href = 'index.html'; return; }
    return;
  }
  if (r.time_up) return finish(r);
  // Track op stats client-side (for the score-view summary).
  if (r.correct && state.dailyGauntlet) {
    // The PREVIOUS question (the one we just answered) is what mattered for
    // op stats. We don't have its op directly here, but we track via the
    // current/peek transitions implicitly. Simpler: skip op breakdown here
    // and reconstruct from server response if needed. For v1, accept that
    // op breakdown isn't shown in daily-gauntlet score view.
  }
  if (state.dailyGauntlet && typeof r.question_index === 'number') {
    state.questionIndex = r.question_index;
    els.score().textContent = `${state.questionIndex} / ${state.totalQuestions}`;
  } else {
    els.score().textContent = r.score;
    state.finalScore = r.score;
  }
  state.peekQuestion = r.peek_question;
}

async function submitAnswerAwaited(value) {
  if (state.finished || state.timerExpired) return;
  els.input().value = '';
  let r;
  try { r = await api.answer(state.sessionId, value); }
  catch (ex) {
    if (ex.status === 404) { alert('Server hiccuped — please start a new run.'); location.href = 'index.html'; return; }
    return;
  }
  if (r.time_up) return finish(r);
  if (state.dailyGauntlet && typeof r.question_index === 'number') {
    state.questionIndex = r.question_index;
    els.score().textContent = `${state.questionIndex} / ${state.totalQuestions}`;
  } else {
    els.score().textContent = r.score;
    state.finalScore = r.score;
  }
  els.prompt().textContent = r.next_question.prompt;
  state.currentAnswer = r.next_question.answer;
  state.peekQuestion = r.peek_question;
  if (r.correct) {
    els.input().classList.add('correct');
    setTimeout(() => els.input().classList.remove('correct'), 220);
  }
}

function onInput() {
  if (state.finished || state.timerExpired) return;
  if (state.currentAnswer == null) return;
  const value = els.input().value;
  if (!/^-?\d+$/.test(value)) return;
  if (Number(value) !== state.currentAnswer) return;
  submitCorrectAnswer(value);
}

async function finish(payload) {
  state.finished = true;
  document.body.classList.remove('drilling');
  els.form().classList.add('hidden');
  document.querySelector('.drill-bar').classList.add('hidden');
  document.querySelector('.time-bar').classList.add('hidden');
  els.scoreScreen().classList.remove('hidden');

  if (state.dailyGauntlet && payload.daily_gauntlet) {
    await renderDailyGauntletScoreView(payload);
    return;
  }

  state.finalScore = payload.final_score ?? state.finalScore;
  els.finalScore().textContent = state.finalScore;

  if (state.practice) {
    els.postNote().textContent = 'Practice complete — your updated weak spots will be ready next time you visit Practice.';
    const actions = els.scoreScreen().querySelector('.actions');
    actions.innerHTML = '';
    const a1 = document.createElement('a');
    a1.className = 'primary';
    a1.href = 'practice.html';
    a1.textContent = 'Practice again';
    const a2 = document.createElement('a');
    a2.className = 'secondary';
    a2.href = 'index.html';
    a2.textContent = 'Play normally';
    actions.appendChild(a1);
    actions.appendChild(a2);
    api.submit(state.sessionId).catch(() => {});
    return;
  }

  if (state.authedUser && state.isDefaultConfig) {
    showSubmitModal();
  } else if (!state.authedUser) {
    els.postNote().textContent = 'Log in to submit scores to the leaderboard.';
  } else {
    els.postNote().textContent = 'Custom runs aren\'t eligible for the leaderboard.';
  }

  els.playAgain().addEventListener('click', () => { location.href = 'index.html'; });
}

async function renderDailyGauntletScoreView(payload) {
  const today = todaySgtDateString();
  const username = state.authedUser?.username ?? 'you';

  // Replace the score screen content with daily-flavored layout.
  const screen = els.scoreScreen();
  screen.innerHTML = '';

  const verb = payload.rank === 1
    ? pickByDate(WORSHIP_FIRST, today)
    : pickByDate(WORSHIP_OTHER, today);
  const subtitle = payload.rank === 1
    ? `today's arithmetic overlord · cleared in ${formatTimeMs(payload.time_ms)}`
    : `cleared in ${formatTimeMs(payload.time_ms)} · #${payload.rank} today`;

  screen.innerHTML = `
    <h1 class="daily-finish-headline">${escapeHtml(verb)} ${escapeHtml(username)}</h1>
    <p class="daily-finish-sub">${escapeHtml(subtitle)}</p>
    <div class="daily-finish-time">[ ${formatTimeMs(payload.time_ms)} ]</div>
    <h2>TODAY'S DAILY LEADERBOARD</h2>
    <ol class="daily-board-list" id="score-daily-board"><li class="dim">Loading…</li></ol>
    <div class="actions">
      <a class="secondary" href="index.html">← Back to drill</a>
      <a class="primary" href="leaderboard.html#daily">View all rankings →</a>
    </div>
  `;

  // Fetch and render today's leaderboard.
  let board;
  try { board = await api.dailyBoard(); }
  catch { document.getElementById('score-daily-board').innerHTML = '<li class="dim">Could not load leaderboard.</li>'; return; }

  const list = document.getElementById('score-daily-board');
  const items = board.entries.slice(0, 5).map((e, i) => {
    if (i === 0) {
      const v = pickByDate(WORSHIP_FIRST, today);
      return `<li class="overlord">${v} <strong>${escapeHtml(e.username)}</strong> · today's arithmetic overlord · ${formatTimeMs(e.time_ms)}</li>`;
    }
    const isYou = e.username === username;
    return `<li${isYou ? ' class="you"' : ''}>${i + 1}. ${escapeHtml(e.username)} <span class="dim">·</span> ${formatTimeMs(e.time_ms)}</li>`;
  });

  // If user not in top 5, append their row.
  if (payload.rank > 5) {
    items.push(`<li class="you">${payload.rank}. you <span class="dim">·</span> ${formatTimeMs(payload.time_ms)}</li>`);
  }

  list.innerHTML = items.join('');
}

function showSubmitModal() {
  const root = els.modalRoot();
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-bd">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">Submit score?</h2>
        <p>Submit ${state.finalScore} to the leaderboard? Your username and score will appear publicly.</p>
        <div class="actions">
          <button class="secondary" id="modal-no">No thanks</button>
          <button class="primary" id="modal-yes">Submit</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  document.getElementById('modal-no').addEventListener('click', close);
  document.getElementById('modal-yes').addEventListener('click', async () => {
    try {
      const r = await api.submit(state.sessionId);
      els.postNote().textContent = `Submitted! You are #${r.rank}.`;
    } catch (ex) {
      if (ex.status === 401) {
        localStorage.setItem('zc_pending_submit', state.sessionId);
        els.postNote().textContent = 'You got logged out — log back in to submit.';
      } else if (ex.status === 422) {
        els.postNote().textContent = 'This run is not eligible for the leaderboard.';
      } else {
        els.postNote().textContent = 'Submit failed: ' + ex.message;
      }
    }
    close();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  els.form().addEventListener('submit', (e) => e.preventDefault());
  els.input().addEventListener('input', onInput);
  start();
});
```

> **Op-summary table is dropped from v1 daily-gauntlet score view.** The spec called for it but the current play.js doesn't track per-question op metadata in a way that's recoverable on the client (we only have `op` for the *current* question, not historic). Adding it would require capturing each completed question's op as we advance — a small change in `submitCorrectAnswer`/`postAnswer`. Decision for v1: ship without op-summary; if the demo lands well, add op-tracking in a follow-up. The big finish-time + daily leaderboard are the meaningful cards anyway.
>
> If you want op-summary in v1, add a `state.opStats` accumulator: in `submitCorrectAnswer`, before swapping to peek, push `{op: state.currentQuestionOp, ms: timeSpent}` to the array, where `state.currentQuestionOp` is captured from the question object stored at advance time. This is ~10 extra lines; add if you're willing to add the bookkeeping.

- [ ] **Step 3: Manual verification**

If running locally:
1. Register an account, log in.
2. Land on `index.html` → Daily Hero shows State A.
3. Click START → goes to `play.html?mode=daily-gauntlet` → mode pill visible, score reads `0 / 60`, timer counts up.
4. Solve a few questions → score advances `1 / 60`, `2 / 60`, etc.
5. Solve all 60 (tedious — for testing, you can read answers from the network response in DevTools).
6. Score view shows worship line, big finish-time, today's leaderboard (just you).
7. Reload `index.html` → Daily Hero shows State B (CLEARED IN m:ss).
8. Click DONE → does nothing (disabled).
9. Manually navigate to `play.html?mode=daily-gauntlet` → redirects back to `index.html`.

- [ ] **Step 4: Commit**

```bash
git add client/js/play.js client/play.html
git commit -m "feat: play.js handles ?mode=daily-gauntlet (HUD, score view, redirect-on-done)"
```

---

## Task 13: Add daily tab to `leaderboard.html`

**Files:**
- Modify: `client/leaderboard.html`
- Modify: `client/js/leaderboard.js`

- [ ] **Step 1: Read current leaderboard.html and js**

```bash
cat client/leaderboard.html
cat client/js/leaderboard.js
```

- [ ] **Step 2: Add tab markup to leaderboard.html**

Find the `<main>` section. Above the existing leaderboard table, add:

```html
    <nav class="board-tabs" id="board-tabs">
      <button class="tab active" data-tab="all-time">ALL-TIME</button>
      <button class="tab" data-tab="daily">TODAY'S DAILY</button>
    </nav>
```

The existing leaderboard table likely lives in a `<section id="all-time-board">` or similar — wrap it with that ID if it's not already wrapped, and add a sibling section for daily:

```html
    <section id="all-time-board">
      <!-- existing all-time leaderboard markup -->
    </section>
    <section id="daily-board-section" class="hidden">
      <h2 id="daily-board-heading">Today's Daily Leaderboard</h2>
      <table class="board-table" id="daily-board-table">
        <thead><tr><th>#</th><th>Player</th><th>Time</th><th>Played</th></tr></thead>
        <tbody><tr><td colspan="4" class="dim">Loading…</td></tr></tbody>
      </table>
    </section>
```

- [ ] **Step 3: Add tab logic to leaderboard.js**

Add at the top of the existing logic in `leaderboard.js`:

```js
import { api } from './api.js';

function formatTimeMs(ms) {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function showTab(name) {
  document.querySelectorAll('#board-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('all-time-board').classList.toggle('hidden', name !== 'all-time');
  document.getElementById('daily-board-section').classList.toggle('hidden', name !== 'daily');
}

async function loadDailyBoard() {
  const tbody = document.querySelector('#daily-board-table tbody');
  let board;
  try { board = await api.dailyBoard(); }
  catch { tbody.innerHTML = '<tr><td colspan="4" class="dim">Could not load.</td></tr>'; return; }
  document.getElementById('daily-board-heading').textContent = `Daily Leaderboard — ${board.date}`;
  if (board.entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="dim">Nobody has played today yet.</td></tr>';
    return;
  }
  tbody.innerHTML = board.entries.map(e => `
    <tr>
      <td>${e.rank}</td>
      <td>${escapeHtml(e.username)}</td>
      <td>${formatTimeMs(e.time_ms)}</td>
      <td class="dim">${new Date(e.played_at).toLocaleTimeString()}</td>
    </tr>
  `).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#board-tabs .tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.tab;
      showTab(name);
      if (name === 'daily') await loadDailyBoard();
    });
  });

  // Honor #daily anchor on initial load.
  if (location.hash === '#daily') {
    showTab('daily');
    loadDailyBoard();
  }
});
```

> **Important:** Don't replace the existing all-time-board logic in `leaderboard.js`. ADD the snippet above. The all-time logic continues to populate `#all-time-board` on page load as before.

- [ ] **Step 4: Manual verification**

1. Open `leaderboard.html` → ALL-TIME tab active by default; classic leaderboard shows.
2. Click TODAY'S DAILY tab → switches view; daily board loads.
3. Open `leaderboard.html#daily` directly → opens to daily tab.

- [ ] **Step 5: Commit**

```bash
git add client/leaderboard.html client/js/leaderboard.js
git commit -m "feat: leaderboard.html tabs (ALL-TIME / TODAY'S DAILY) + daily table"
```

---

## Task 14: Add CSS — daily hero, mode pill, daily score view, daily-board widget, tabs

**Files:**
- Modify: `client/css/styles.css`

- [ ] **Step 1: Read current CSS**

```bash
grep -n "^\.[a-z]\|^@\|^:root\|^body\|^main" client/css/styles.css | head -50
```

Note the existing palette variables (`--magenta`, `--cyan`, `--lime`, `--orange`, etc.) and the brutalist arcade conventions (sharp corners, offset shadows, JetBrains Mono).

- [ ] **Step 2: Append new styles**

Add at the end of `client/css/styles.css`:

```css
/* ============================================================
   Daily Gauntlet
   ============================================================ */

/* Hero block on landing — three states via [data-state] */
.daily-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border: 2px solid var(--lime);
  background: linear-gradient(180deg, rgba(155,255,91,0.07), rgba(155,255,91,0));
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border-radius: 2px;
}
.daily-hero[data-state="completed"],
.daily-hero[data-state="guest"] {
  border-color: var(--ink-faint);
  background: var(--bg-elev);
}
.daily-hero-text {
  flex: 1;
  min-width: 0;
}
.daily-hero-title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.1rem;
  letter-spacing: -0.01em;
  color: var(--lime);
  text-transform: uppercase;
}
.daily-hero[data-state="completed"] .daily-hero-title,
.daily-hero[data-state="guest"]     .daily-hero-title {
  color: var(--ink-dim);
}
.daily-hero-sub {
  color: var(--ink-dim);
  font-size: 0.85rem;
  margin-top: 0.2rem;
}
.daily-hero-btn {
  background: var(--lime);
  color: var(--bg-deep);
  border: 2px solid var(--lime);
  box-shadow: 4px 4px 0 var(--magenta);
  padding: 0.55rem 1.2rem;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.9rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 80ms ease, box-shadow 80ms ease;
}
.daily-hero-btn:hover:not(:disabled) {
  transform: translate(-2px, -2px);
  box-shadow: 6px 6px 0 var(--magenta);
}
.daily-hero-btn:active:not(:disabled) {
  transform: translate(0, 0);
  box-shadow: 0 0 0 var(--magenta);
}
.daily-hero-btn:disabled {
  background: transparent;
  color: var(--ink-faint);
  border-color: var(--ink-faint);
  box-shadow: none;
  cursor: not-allowed;
}
.daily-hero[data-state="guest"] .daily-hero-btn {
  background: transparent;
  color: var(--magenta);
  border-color: var(--magenta);
  box-shadow: none;
  cursor: pointer;
}

/* Today's daily leaderboard widget on landing */
.daily-board {
  margin: 1.25rem 0;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}
.daily-board h2 {
  font-family: var(--font-display);
  font-size: 0.9rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin: 0 0 0.5rem;
  color: var(--ink-dim);
  border-bottom: 0;
  padding-bottom: 0;
}
.daily-board-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  line-height: 1.6;
}
.daily-board-list li.overlord {
  color: var(--lime);
  font-weight: 500;
}
.daily-board-list li.overlord strong {
  color: var(--magenta);
  font-weight: 700;
}
.daily-board-list li.you {
  color: var(--cyan);
}
.daily-board-list .dim {
  color: var(--ink-faint);
}
.daily-board-link {
  display: inline-block;
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: var(--cyan);
  text-decoration: none;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.daily-board-link:hover { color: var(--magenta); }

/* Mode pill on play page */
.mode-pill {
  display: inline-block;
  background: transparent;
  color: var(--lime);
  border: 1px solid var(--lime);
  padding: 0.15rem 0.5rem;
  font-family: var(--font-display);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 0.5rem;
  align-self: flex-start;
}

/* Daily-finish score view */
.daily-finish-headline {
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 1rem 0 0.25rem;
  color: var(--lime);
  text-align: center;
}
.daily-finish-sub {
  color: var(--ink-dim);
  text-align: center;
  margin: 0 0 1rem;
}
.daily-finish-time {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 3rem;
  text-align: center;
  color: var(--cyan);
  margin: 0.5rem 0 1.5rem;
  letter-spacing: 0.04em;
}

/* Tabs on leaderboard.html */
.board-tabs {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.board-tabs .tab {
  background: transparent;
  color: var(--ink-dim);
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 0.5rem 1rem;
  font-family: var(--font-display);
  font-size: 0.85rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.board-tabs .tab:hover { color: var(--cyan); }
.board-tabs .tab.active {
  color: var(--lime);
  border-bottom-color: var(--lime);
}

/* Mobile (≤640px): daily hero stacks; keep widget readable */
@media (max-width: 640px) {
  .daily-hero {
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
  }
  .daily-hero-btn { align-self: flex-end; }
  .daily-finish-headline { font-size: 1.5rem; }
  .daily-finish-time { font-size: 2.25rem; }
}
```

- [ ] **Step 3: Manual visual check**

Open the landing page in a browser at desktop and at ≤640px. Confirm:
- Daily hero block has lime border, lime button with magenta offset shadow.
- State B/C use dimmed colors (greyed border, magenta link for guest).
- Daily board widget readable, top entry highlighted lime/magenta.
- Mode pill on play page is small, lime, sits above the time bar.
- Score view's headline is big, lime, centered; finish-time is big cyan.
- Tabs on leaderboard.html — active tab has lime underline.

- [ ] **Step 4: Commit**

```bash
git add client/css/styles.css
git commit -m "ui: styles for daily hero, mode pill, daily score view, board widget, tabs"
```

---

## Task 15: End-to-end smoke test

**Files:** None (manual run-through).

This is a final integration check before declaring the feature complete.

- [ ] **Step 1: Local server up**

```bash
cd server && npm run dev
# Or: node src/index.js
```

Confirm the server boots without errors and applies all migrations including the new one.

- [ ] **Step 2: Check landing as guest**

Open http://localhost:3000/ in a fresh browser (or incognito). Confirm:
- Daily Hero shows State C: greyed border, "DAILY CHALLENGE — register to play.", REGISTER → button (links to register.html).
- Daily board widget shows "Nobody's stepped up yet today." (or has data if you've tested before).
- Show advanced is collapsed; clicking it reveals eligibility badge + default-summary + settings grid.

- [ ] **Step 3: Register and check landing as user**

Register `alice` with any password. After redirect, confirm:
- Daily Hero shows State A: lime border, rotating taunt copy, big START button.
- Subtitle: "60 questions, 1 shot. Same drill worldwide today."

- [ ] **Step 4: Play the gauntlet**

Click START. Confirm:
- URL becomes `play.html?mode=daily-gauntlet`.
- Mode pill "DAILY GAUNTLET" visible.
- Score reads `0 / 60`.
- Timer reads `0:00` and counts up.

Solve a few questions (use DevTools to peek answers if needed). Confirm:
- Score advances `1 / 60`, `2 / 60`, etc.
- Time bar fills proportionally to progress (not time elapsed).
- Wrong answer → no advance (silent reject).

Solve all 60 (or use a dev shortcut). Confirm:
- Score view shows worship headline, subtitle with rank/time, big finish-time, daily leaderboard with you at #1.
- "← Back to drill" returns to landing.

- [ ] **Step 5: Check landing post-completion**

Reload index.html. Confirm:
- Daily Hero shows State B: greyed, "CLEARED IN m:ss — see you tomorrow." (or rotating equivalent), DONE button (disabled).
- Daily board widget shows you at #1 with worship copy.

- [ ] **Step 6: Try to re-play**

Manually navigate to `play.html?mode=daily-gauntlet`. Confirm:
- Redirects back to index.html (server returned `already_completed: true`).

- [ ] **Step 7: Check leaderboard tabs**

Open `leaderboard.html`. Confirm:
- ALL-TIME tab active by default; existing classic leaderboard renders.
- Click TODAY'S DAILY → switches to daily table; you're listed.
- Open `leaderboard.html#daily` directly → opens to daily tab.

- [ ] **Step 8: Cross-browser / cross-account same-questions check**

Open a second browser (or incognito), register `bob`. Click START on daily-gauntlet. Solve first question. Open `alice`'s session in DevTools (network tab `/api/play/start` response from earlier) and compare the first question's prompt — should be identical (`a + b = ?`).

- [ ] **Step 9: Verify regular play still works**

Log out. Click "Start as Guest" on landing → goes to play.html with classic 120-second drill. Solve a few. Confirm:
- Mode pill is hidden (no daily-gauntlet artifacts).
- Timer counts down from 120.
- Score is integer count, not "N / 60".

- [ ] **Step 10: Run automated tests one more time**

```bash
cd server && node --test test/unit/**/*.test.js test/integration/**/*.test.js
```

Expected: all green (or skipped if no test DB).

- [ ] **Step 11: Commit (if any final tweaks)**

If smoke testing surfaced issues that needed fixing, commit them with focused messages. Otherwise:

```bash
git log --oneline -20  # review the feature branch
```

---

## Spec coverage check

Mapping spec sections to tasks:

| Spec section | Task(s) |
|---|---|
| Goal / problem / out-of-scope | Documented in plan header |
| User flow — logged-in not-played | Task 5 (start), Task 6 (completion), Task 11 (hero State A), Task 12 (play.js) |
| User flow — logged-in already-played | Task 5 (server check), Task 11 (hero State B), Task 12 (redirect) |
| User flow — guest | Task 5 (401), Task 11 (hero State C) |
| Edge: day rollover | Task 4 (seedDate captured at start), Task 8 (rollover test) |
| Edge: reload mid-run | Task 5/6 (in-memory session — no flush until 60 cleared) |
| Schema changes | Task 1 |
| Date helper (SGT) | Task 2 |
| Session store extension | Task 4 |
| Routes — /api/play/start | Task 5 |
| Routes — /api/play/answer | Task 6 |
| Routes — /api/leaderboard/daily | Task 7 |
| Routes — /api/leaderboard/daily/me | Task 7 |
| Score semantics (score=60, rank by duration_ms) | Task 6 (insert), Task 7 (query) |
| Frontend — landing layout | Task 10 |
| Frontend — Daily Hero 3 states | Task 11 |
| Frontend — daily leaderboard widget | Task 11 |
| Frontend — play.html HUD | Task 12 (markup) |
| Frontend — play.js daily mode | Task 12 |
| Frontend — score view | Task 12 (renderDailyGauntletScoreView) |
| Frontend — leaderboard.html tabs | Task 13 |
| Copy table | Task 3 |
| CSS / styles | Task 14 |
| Unit tests — sgt-date | Task 2 |
| Unit tests — gauntlet-copy | Task 3 |
| Integration tests | Task 8 |
| Manual frontend verification | Task 15 |

**Gap:** Op-summary table on the daily score view is documented as "out of v1" in Task 12 with rationale. Spec section 4e mentions it; if the user wants it in v1, add it back via a state.opStats accumulator (sketched in Task 12 note).

**No other gaps.**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-daily-gauntlet.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
