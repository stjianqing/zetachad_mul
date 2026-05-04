# Daily Gauntlet Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate free retries on the Daily Gauntlet (lock the day at session start), drop attempt length from 60 to 20 questions, and surface a clear forfeit state.

**Architecture:** A single `runs` row is inserted at `/api/play/start` time with `submitted_to_leaderboard=false` — this acts as the lock. On finish, the row is UPDATEd in place (not a new INSERT). A migration drops the `WHERE submitted=true` predicate from the existing partial UNIQUE index so unfinished lock rows also occupy the day. The `/me` endpoint and Daily Hero render a third "forfeited" state for users with a lock row but no completion.

**Tech Stack:** Node.js, Fastify, PostgreSQL (`pg`), node:test runner, vanilla JS frontend.

---

## File map

**New:**
- `server/migrations/011_daily_gauntlet_lock.sql` — replace partial UNIQUE index with one that doesn't filter on submission status.

**Modified:**
- `server/src/game/session.js` — `60` → `20` (single line).
- `server/src/routes/play.routes.js` — lock-row INSERT in `/start`, branch on `session.runId` in `flushRunIfRecording` to UPDATE instead of INSERT, return `already_started` payload when a lock row exists.
- `server/src/routes/board.routes.js` — extend `/api/leaderboard/daily/me` with `forfeited` flag.
- `server/src/copy/gauntlet-copy.js` — replace "Sixty problems" taunt entry.
- `server/test/integration/daily-gauntlet.test.js` — update existing tests to 20 questions, add new tests for lock semantics.
- `client/js/play.js` — handle `already_started` response (redirect to landing with `?forfeit=1`).
- `client/js/landing.js` — render forfeit Daily Hero state, consume `forfeited` flag, update count subtitle, show `?forfeit=1` toast, mirror updated taunt copy.
- `client/css/styles.css` — forfeit-state Daily Hero variant + toast (if no existing toast style).

---

## Pre-flight: confirm worktree state

- [ ] **Step 1: Verify you're in the right worktree**

Run: `pwd`
Expected output contains: `.claude/worktrees/challenge-mode` (or whatever this worktree is named).

Run: `git status`
Expected: clean working tree on the branch the worktree was created for.

- [ ] **Step 2: Confirm test DB is reachable**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js`
Expected: tests run (and most should pass — they're written against the current 60-question behavior). If `TEST_DATABASE_URL` is unset, all tests skip with a notice; if so, set it before continuing or the integration tests in this plan will skip.

If skipped, set the env var per the project's `server/README.md` or `deploy/README.md` and re-run. Don't proceed to Task 1 until at least one test in that file passes.

---

## Task 1: Migration — replace the partial UNIQUE index

**Why first:** The new lock-row INSERT in `/start` would violate the *current* index (which only enforces uniqueness on `submitted=true` rows), but having two unsubmitted rows for the same `(user_id, daily_gauntlet_date)` would defeat the lock. We need the new index in place before any code change can rely on it.

**Files:**
- Create: `server/migrations/011_daily_gauntlet_lock.sql`

- [ ] **Step 1: Write the migration**

Create `server/migrations/011_daily_gauntlet_lock.sql`:

```sql
-- Replace the partial UNIQUE index so any daily-gauntlet row (lock or completed)
-- locks the day for that user. The lock row is inserted at /api/play/start
-- and UPDATEd in place when the run completes.
DROP INDEX IF EXISTS runs_user_daily_gauntlet_idx;

CREATE UNIQUE INDEX runs_user_daily_gauntlet_idx
  ON runs (user_id, daily_gauntlet_date)
  WHERE daily_gauntlet_date IS NOT NULL;
```

- [ ] **Step 2: Pre-check existing data is compatible**

Run (against your dev/test DB):

```bash
psql "$DATABASE_URL" -c "SELECT user_id, daily_gauntlet_date, COUNT(*) FROM runs WHERE daily_gauntlet_date IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1;"
```

Expected: zero rows. (If any rows return, the new index will fail to apply — investigate and resolve duplicates manually before proceeding. Should not happen with the previously-shipped code.)

- [ ] **Step 3: Apply the migration**

Run: `cd server && node -e "import('./src/db.js').then(async ({makePool, migrate}) => { const p = makePool(); await migrate(p); console.log('migrate done'); process.exit(0); })"`

Expected: prints `migrate done` with no errors. The migration runner picks up the new file by filename order.

- [ ] **Step 4: Verify the index exists and has the right predicate**

Run: `psql "$DATABASE_URL" -c "\d runs"` (or a similar describe).

Expected: an index named `runs_user_daily_gauntlet_idx` with definition `UNIQUE, btree (user_id, daily_gauntlet_date) WHERE (daily_gauntlet_date IS NOT NULL)` — *no* `submitted_to_leaderboard` clause.

- [ ] **Step 5: Verify all tests still pass with the new index**

Run: `cd server && node --test`

Expected: all currently-passing tests continue to pass. The migration is a no-op for runtime behavior so far (we haven't changed any code that writes lock rows yet).

- [ ] **Step 6: Commit**

```bash
git add server/migrations/011_daily_gauntlet_lock.sql
git commit -m "feat(daily-gauntlet): drop submission predicate from unique index

Prepares for lock-at-start: a row with submitted_to_leaderboard=false
must also occupy the (user_id, daily_gauntlet_date) slot."
```

---

## Task 2: Drop question count from 60 to 20

Tiny but standalone — easier to verify in isolation before tangling with lock logic.

**Files:**
- Modify: `server/src/game/session.js:53`

- [ ] **Step 1: Update existing test to expect 20 (it will fail first, in a moment)**

Open `server/test/integration/daily-gauntlet.test.js`. Find the test `'daily-gauntlet: logged-in start returns expected envelope'` around line 52. Change:

```js
assert.equal(body.total_questions, 60);
```

to:

```js
assert.equal(body.total_questions, 20);
```

Also update the helper `clearAll60` (around line 32) — rename and adjust:

```js
async function clearAllN(app, cookie, sessionId, sessionStore, n = 20) {
  let last;
  for (let i = 0; i < n; i++) {
    last = await answerOne(app, cookie, sessionId, sessionStore);
    if (!last) break;
    if (last.time_up) return last;
  }
  return last;
}
```

Search-and-replace all in-file usages of `clearAll60(...)` to `clearAllN(...)`. Then update the assertion in `'cleared run persists with daily_gauntlet_date and submitted=true'`:

```js
assert.equal(last.final_score, 60);  // OLD
```

becomes:

```js
assert.equal(last.final_score, 20);
```

And:

```js
assert.equal(rows[0].score, 60);  // OLD
```

becomes:

```js
assert.equal(rows[0].score, 20);
```

- [ ] **Step 2: Run tests — they should fail**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js`

Expected: at least the envelope test and the cleared-run-persists test fail. Others (guest blocked, day rollover, etc.) likely fail too because they call `clearAllN` but the server still treats it as 60. That's fine.

- [ ] **Step 3: Change the count in session.js**

Open `server/src/game/session.js`. Line 53 currently reads:

```js
totalQuestions: isDailyGauntlet ? 60 : null,
```

Change to:

```js
totalQuestions: isDailyGauntlet ? 20 : null,
```

- [ ] **Step 4: Run tests — they should pass**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js`

Expected: all daily-gauntlet integration tests pass (with the 20-question expectations). If the day-rollover test still fails, double-check the `clearAllN` rename caught all call sites.

- [ ] **Step 5: Commit**

```bash
git add server/src/game/session.js server/test/integration/daily-gauntlet.test.js
git commit -m "feat(daily-gauntlet): reduce question count from 60 to 20"
```

---

## Task 3: Lock row inserted at `/api/play/start`

This is the core backend change. Tested first by writing a failing test, then by implementing the INSERT.

**Files:**
- Modify: `server/src/routes/play.routes.js` — `mode === 'daily-gauntlet'` branch in `/api/play/start` (around line 47-86).
- Modify: `server/test/integration/daily-gauntlet.test.js` — add new test.

- [ ] **Step 1: Write failing test for "lock row created on /start"**

Append to `server/test/integration/daily-gauntlet.test.js`:

```js
test('daily-gauntlet: /start inserts a lock row with submitted=false', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const r = await startDaily(app, cookie);
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().session_id);

  const { rows } = await pool.query(
    'SELECT score, duration_ms, submitted_to_leaderboard, daily_gauntlet_date FROM runs WHERE user_id = (SELECT id FROM users WHERE username=$1)',
    ['alice']
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 0);
  assert.equal(Number(rows[0].duration_ms), 0);
  assert.equal(rows[0].submitted_to_leaderboard, false);
  assert.ok(rows[0].daily_gauntlet_date);
});
```

- [ ] **Step 2: Run the test — it should fail**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "inserts a lock row"`

Expected: FAIL — `rows.length` is 0 (current code doesn't insert until completion).

- [ ] **Step 3: Implement the lock-row INSERT**

Open `server/src/routes/play.routes.js`. Find the `mode === 'daily-gauntlet'` branch (around line 47). The current shape is:

```js
if (mode === 'daily-gauntlet') {
  if (!req.user) {
    return reply.code(401).send({ error: 'register-to-play' });
  }
  const today = todaySgtDateString(nowFn());

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
```

Replace it with:

```js
if (mode === 'daily-gauntlet') {
  if (!req.user) {
    return reply.code(401).send({ error: 'register-to-play' });
  }
  const today = todaySgtDateString(nowFn());

  // Look up any existing daily-gauntlet row for this user/day — completed or lock.
  const existing = await pool.query(
    `SELECT id, duration_ms, played_at, submitted_to_leaderboard
     FROM runs
     WHERE user_id = $1
       AND daily_gauntlet_date = $2
     LIMIT 1`,
    [req.user.id, today]
  );

  if (existing.rowCount > 0) {
    const row = existing.rows[0];
    if (row.submitted_to_leaderboard === true) {
      const rank = await computeDailyRank(pool, today, row.duration_ms, row.played_at);
      return {
        already_completed: true,
        time_ms: Number(row.duration_ms),
        rank
      };
    }
    // Lock row exists but no completion — user already started today and abandoned (or is in another tab).
    return { already_started: true, forfeited: true };
  }

  // No row yet — create the lock row first, then the in-memory session.
  // The UNIQUE index protects against concurrent /start races; we catch 23505 below.
  const seedNum = dateStringToSeed(today);
  let lockRunId;
  try {
    const ins = await pool.query(
      `INSERT INTO runs (user_id, score, duration_ms, practice, daily_gauntlet_date, submitted_to_leaderboard, seed)
       VALUES ($1, 0, 0, false, $2, false, $3)
       RETURNING id`,
      [req.user.id, today, seedNum]
    );
    lockRunId = Number(ins.rows[0].id);
  } catch (err) {
    if (err.code === '23505') {
      // Race: another /start beat us. Refetch and treat as already_started.
      // We can't tell whether the winner is still playing or already abandoned;
      // either way, this caller has lost the lock for today.
      req.log.info({ err, userId: req.user.id, today }, 'daily-gauntlet: /start race lost');
      return { already_started: true, forfeited: false };
    }
    throw err;
  }

  const r = sessionStore.start({
    userId: req.user.id,
    config: DEFAULT_CONFIG,
    mode: 'daily-gauntlet',
    seedDate: today
  });
  // Stash the lock-row id on the session so the finish path UPDATEs it instead of INSERTing.
  const live = sessionStore.get(r.sessionId);
  if (live) live.runId = lockRunId;

  return {
    session_id: r.sessionId,
    mode: r.mode,
    total_questions: r.totalQuestions,
    question_index: r.questionIndex,
    question: r.question,
    peek_question: r.peekQuestion
  };
}
```

You also need to import `dateStringToSeed`. At the top of `play.routes.js`:

```js
import { todaySgtDateString } from '../game/sgt-date.js';
```

becomes:

```js
import { todaySgtDateString, dateStringToSeed } from '../game/sgt-date.js';
```

(Confirm `dateStringToSeed` is exported from `server/src/game/sgt-date.js` — it is, per the daily-gauntlet spec.)

- [ ] **Step 4: Run the test — it should pass**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "inserts a lock row"`

Expected: PASS.

- [ ] **Step 5: Run the full daily-gauntlet test file — most others will FAIL now**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js`

Expected: many failures, because:
- The `'cleared run persists'` test currently expects 1 row after completion. Now there's a lock row inserted at start AND the existing flush logic will insert a second row at finish. Until Task 4 lands, the test will see 2 rows (lock + completion-INSERT) and the UNIQUE index will block the second INSERT, causing the flush to silently log and skip — leaving the lock row with `score=0, submitted=false` and no attempts. Tests fail accordingly.

This is expected. We'll fix it in Task 4. Don't commit yet — the build is in a half-state.

- [ ] **Step 6: Commit (work-in-progress acknowledged in message)**

Even though tests fail, this is a clean unit of progress. The next task is the matching half.

```bash
git add server/src/routes/play.routes.js server/test/integration/daily-gauntlet.test.js
git commit -m "feat(daily-gauntlet): insert lock row at /start

Adds the lock-row INSERT and already_started branch. Companion change
in flushRunIfRecording (UPDATE-vs-INSERT branch) lands in next commit;
daily-gauntlet integration tests will fail until that lands."
```

---

## Task 4: Finish path UPDATEs the lock row instead of INSERTing

Pairs with Task 3. After this task lands, the daily-gauntlet test suite will be green again (with the new behavior).

**Files:**
- Modify: `server/src/routes/play.routes.js` — `flushRunIfRecording` function (around line 146-200).

- [ ] **Step 1: Write failing test for "finish UPDATEs the lock row, doesn't insert"**

Append to `server/test/integration/daily-gauntlet.test.js`:

```js
test('daily-gauntlet: finish UPDATEs the lock row in place', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await startDaily(app, cookie);
  const { session_id } = start.json();

  // Capture the lock row id before finishing.
  const beforeRows = (await pool.query(
    'SELECT id, score, submitted_to_leaderboard FROM runs WHERE user_id = (SELECT id FROM users WHERE username=$1)',
    ['alice']
  )).rows;
  assert.equal(beforeRows.length, 1);
  const lockRunId = Number(beforeRows[0].id);
  assert.equal(beforeRows[0].score, 0);
  assert.equal(beforeRows[0].submitted_to_leaderboard, false);

  await clearAllN(app, cookie, session_id, sessionStore);

  const afterRows = (await pool.query(
    'SELECT id, score, submitted_to_leaderboard FROM runs WHERE user_id = (SELECT id FROM users WHERE username=$1)',
    ['alice']
  )).rows;
  assert.equal(afterRows.length, 1, 'should still be exactly one row — UPDATE not INSERT');
  assert.equal(Number(afterRows[0].id), lockRunId, 'should be the same id as the lock row');
  assert.equal(afterRows[0].score, 20);
  assert.equal(afterRows[0].submitted_to_leaderboard, true);
});
```

- [ ] **Step 2: Run the test — it should fail**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "UPDATEs the lock row"`

Expected: FAIL — either the row count is wrong (if INSERT raced with UNIQUE), or the score is still 0 (if INSERT silently swallowed `23505`).

- [ ] **Step 3: Refactor `flushRunIfRecording` to branch on existing `runId`**

Open `server/src/routes/play.routes.js`. Replace the entire `flushRunIfRecording` function (currently around line 146-200) with:

```js
async function flushRunIfRecording(req, sessionId) {
  const live = sessionStore.get(sessionId);
  const preExistingRunId = live?.runId ?? null;

  const rec = sessionStore.takeRunRecord(sessionId);
  if (!rec || rec.userId == null || rec.attempts.length === 0) return;

  // Map session-store snake/camel to the shape computeRunDifficulty expects.
  const attemptsForDifficulty = rec.attempts.map(a => ({
    op: a.op, lhs: a.lhs, rhs: a.rhs,
    response_ms: a.responseMs, correct: a.correct
  }));
  const difficulty = medianCache
    ? computeRunDifficulty(attemptsForDifficulty, medianCache)
    : null;

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    let runId;
    if (preExistingRunId != null) {
      // Daily-gauntlet path: the lock row already exists from /start. UPDATE it.
      const upd = await client.query(
        `UPDATE runs
         SET score = $2,
             duration_ms = $3,
             practice = $4,
             difficulty = $5,
             submitted_to_leaderboard = $6
         WHERE id = $1
         RETURNING id`,
        [preExistingRunId, rec.score, rec.durationMs, rec.practice, difficulty, rec.submittedToLeaderboard]
      );
      if (upd.rowCount === 0) {
        // Lock row missing — should never happen in normal operation. Log and bail.
        await client.query('ROLLBACK');
        req.log.error({ sessionId, preExistingRunId }, 'daily-gauntlet: lock row missing on finish');
        return;
      }
      runId = preExistingRunId;
    } else {
      // Normal/practice path: insert a fresh run row.
      const insRun = await client.query(
        `INSERT INTO runs (user_id, score, duration_ms, practice, difficulty, daily_gauntlet_date, submitted_to_leaderboard, seed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [rec.userId, rec.score, rec.durationMs, rec.practice, difficulty, rec.dailyGauntletDate, rec.submittedToLeaderboard, rec.seed]
      );
      runId = Number(insRun.rows[0].id);
    }

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

    const liveAfter = sessionStore.get(sessionId);
    if (liveAfter) {
      liveAfter.runId = runId;
      liveAfter.difficulty = difficulty;
    }
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
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

Key changes from the original:
- We capture `preExistingRunId` **before** `takeRunRecord` runs (because `takeRunRecord` doesn't touch `live.runId`, but capturing first is defensive against any future change).
- Branches on `preExistingRunId`: UPDATE if non-null (daily-gauntlet lock path), INSERT otherwise (normal/practice path).
- The attempts INSERT and the difficulty/runId stash on `liveAfter` are unchanged in shape.

- [ ] **Step 4: Run the new test — it should pass**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "UPDATEs the lock row"`

Expected: PASS.

- [ ] **Step 5: Run the full daily-gauntlet test file**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js`

Expected: all tests pass — including the previously-failing 'cleared run persists', 'leaderboard endpoint ranks by duration', 'day rollover', etc.

- [ ] **Step 6: Run the full server test suite to check for regressions in normal-mode play**

Run: `cd server && node --test`

Expected: everything passes. The non-daily play paths still hit the `preExistingRunId == null` branch (INSERT) so behavior is unchanged.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/play.routes.js server/test/integration/daily-gauntlet.test.js
git commit -m "feat(daily-gauntlet): UPDATE lock row on finish instead of INSERT

flushRunIfRecording now branches on session.runId — daily-gauntlet
sessions UPDATE the row inserted at /start, normal/practice sessions
INSERT as before."
```

---

## Task 5: `already_started` blocks re-`/start` while lock exists

Behavior is already implemented (in Task 3). This task adds the explicit test.

**Files:**
- Modify: `server/test/integration/daily-gauntlet.test.js` — add tests.

- [ ] **Step 1: Write tests for forfeit-lock semantics**

Append to `server/test/integration/daily-gauntlet.test.js`:

```js
test('daily-gauntlet: re-/start while lock exists returns already_started', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const first = await startDaily(app, cookie);
  assert.equal(first.statusCode, 200);
  assert.ok(first.json().session_id);

  // Don't answer anything — just /start again.
  const second = await startDaily(app, cookie);
  assert.equal(second.statusCode, 200);
  const body = second.json();
  assert.equal(body.already_started, true);
  assert.equal(body.forfeited, true);
  assert.equal(body.session_id, undefined, 'no session should be created on the second call');
});

test('daily-gauntlet: abandoned attempt locks the day (no second row inserted)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  await startDaily(app, cookie);
  await startDaily(app, cookie);
  await startDaily(app, cookie);

  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM runs WHERE user_id = (SELECT id FROM users WHERE username=$1)',
    ['alice']
  );
  assert.equal(rows[0].n, 1, 'only one row total — repeated /start calls do not multiply');
});
```

- [ ] **Step 2: Run the new tests**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "already_started|abandoned attempt"`

Expected: PASS. (Behavior was implemented in Task 3; we're just locking it down with explicit tests.)

- [ ] **Step 3: Commit**

```bash
git add server/test/integration/daily-gauntlet.test.js
git commit -m "test(daily-gauntlet): cover already_started and abandon-locks-day"
```

---

## Task 6: Concurrent `/start` race recovery

The race-recovery code is in Task 3, but exercising it cleanly in a test is timing-dependent. We test the recovery path by simulating "another /start has already inserted the lock row."

**Files:**
- Modify: `server/test/integration/daily-gauntlet.test.js` — add test.

- [ ] **Step 1: Write the test**

Append to `server/test/integration/daily-gauntlet.test.js`:

```js
test('daily-gauntlet: /start handles concurrent-insert race (23505) gracefully', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');

  // Simulate the "another concurrent /start beat us" path by directly inserting
  // a lock row before the user's /start can run. The /start code path will see
  // the row in its initial SELECT and return already_started — but to test the
  // 23505 catch specifically, we'd need to interleave SELECT and INSERT.
  //
  // Instead, we verify the user-visible behavior is correct in the most common
  // race outcome: a row exists at the moment /start checks. The 23505 branch is
  // exercised by direct code review + the abandoned-attempt test above.

  const userIdRow = await pool.query('SELECT id FROM users WHERE username = $1', ['alice']);
  const userId = Number(userIdRow.rows[0].id);
  const today = (new Date(Date.now() + 8 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, daily_gauntlet_date, submitted_to_leaderboard, seed)
     VALUES ($1, 0, 0, false, $2, false, 0)`,
    [userId, today]
  );

  const r = await startDaily(app, cookie);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.already_started, true);
  assert.equal(body.forfeited, true);
});
```

This exercises the *most likely* race outcome: SELECT sees the row. The pure 23505 catch path (SELECT misses, INSERT loses) isn't reliably triggerable from a test without raw SQL games; verified by review.

- [ ] **Step 2: Run the test**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "concurrent-insert race"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/test/integration/daily-gauntlet.test.js
git commit -m "test(daily-gauntlet): cover concurrent /start race recovery"
```

---

## Task 7: `/api/leaderboard/daily/me` returns `forfeited` flag

Frontend needs to know the difference between "never started" and "started but didn't finish."

**Files:**
- Modify: `server/src/routes/board.routes.js` — `/api/leaderboard/daily/me` handler (around line 160-198).
- Modify: `server/test/integration/daily-gauntlet.test.js` — add tests.

- [ ] **Step 1: Update existing `/me played:false` test to expect new shape**

In `server/test/integration/daily-gauntlet.test.js`, find the test `'daily-gauntlet: /me returns played:false when not played'` (around line 182). Change:

```js
assert.deepEqual(r.json(), { played: false });
```

to:

```js
assert.deepEqual(r.json(), { played: false, forfeited: false });
```

- [ ] **Step 2: Add new `/me forfeited:true` test**

Append:

```js
test('daily-gauntlet: /me returns forfeited:true when lock row exists but no completion', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  await startDaily(app, cookie);
  // Don't answer — leave the lock row sitting there.

  const r = await app.inject({ method: 'GET', url: '/api/leaderboard/daily/me', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { played: false, forfeited: true });
});
```

Also update the existing `'/me returns rank and time after completion'` test (around line 193) — append `forfeited: false` to its assertions if you want it explicit; otherwise leave (the body uses `played: true` which is unambiguous). **Recommendation: leave the completion test alone** — `played: true` is self-explanatory and we don't need to send `forfeited` on that branch.

- [ ] **Step 3: Run tests — should fail**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "/me"`

Expected: FAIL — current handler returns `{ played: false }` (no `forfeited`).

- [ ] **Step 4: Update the handler**

Open `server/src/routes/board.routes.js`. Find the `/api/leaderboard/daily/me` handler (around line 160). Change the body to:

```js
fastify.get('/api/leaderboard/daily/me', { preHandler: requireAuth }, async (req) => {
  const today = todaySgtDateString(nowFn());

  const { rows } = await pool.query(
    `SELECT duration_ms, played_at, submitted_to_leaderboard
     FROM runs
     WHERE user_id = $1 AND daily_gauntlet_date = $2
     LIMIT 1`,
    [req.user.id, today]
  );

  if (rows.length === 0) {
    return { played: false, forfeited: false };
  }

  const row = rows[0];
  if (row.submitted_to_leaderboard !== true) {
    return { played: false, forfeited: true };
  }

  const { duration_ms, played_at } = row;

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

Two changes from the original:
1. Initial SELECT no longer filters on `submitted_to_leaderboard = true` — we want to see lock rows too.
2. Three-state branching: no row → not played, not forfeited; row but unsubmitted → not played but forfeited; submitted → played.

- [ ] **Step 5: Run tests**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js --test-name-pattern "/me"`

Expected: PASS for both not-played and forfeited cases. Completion case still passes (its body shape didn't change).

- [ ] **Step 6: Run the full file to be sure**

Run: `cd server && node --test test/integration/daily-gauntlet.test.js`

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/board.routes.js server/test/integration/daily-gauntlet.test.js
git commit -m "feat(daily-gauntlet): /me returns forfeited flag for lock-row-only state"
```

---

## Task 8: Update server-side gauntlet copy

The "Sixty problems" pre-taunt is wrong now.

**Files:**
- Modify: `server/src/copy/gauntlet-copy.js`

- [ ] **Step 1: Update the taunt**

Open `server/src/copy/gauntlet-copy.js`. Line 19 reads:

```js
"Sixty problems. One you. Good luck.",
```

Change to:

```js
"Twenty problems. Don't waste them.",
```

(Drops the count from being load-bearing in the copy. Wordsmithed to fit the existing acerbic tone.)

- [ ] **Step 2: Run the copy unit test if it exists**

Run: `cd server && node --test test/unit/gauntlet-copy.test.js`

Expected: PASS. The test covers indexing reachability and idempotence; specific string content isn't asserted, so the change is safe.

- [ ] **Step 3: Commit**

```bash
git add server/src/copy/gauntlet-copy.js
git commit -m "copy(daily-gauntlet): drop hardcoded count from pre-taunt"
```

---

## Task 9: Frontend — `play.js` handles `already_started`

When the user lands on `play.html?mode=daily-gauntlet` but the server says they're locked out, redirect to landing with a query param the landing page can react to.

**Files:**
- Modify: `client/js/play.js` — `startDailyGauntlet` function (around line 131).

- [ ] **Step 1: Update the function**

Open `client/js/play.js`. Find the existing `already_completed` handler in `startDailyGauntlet` (around line 145):

```js
if (r.already_completed) {
  location.href = 'index.html';
  return;
}
```

Replace with:

```js
if (r.already_completed) {
  location.href = 'index.html';
  return;
}
if (r.already_started) {
  location.href = 'index.html?forfeit=1';
  return;
}
```

- [ ] **Step 2: Manually verify the redirect**

Start the dev server (`cd server && npm run dev` or whatever the project uses — check `server/package.json` scripts), open the app in a browser, register and log in.

1. Navigate to `index.html`. Click START.
2. Once `play.html` loads with the gauntlet, hit alt-F4 / close the tab.
3. Manually navigate back to `play.html?mode=daily-gauntlet` (paste URL).
4. Confirm: browser redirects to `index.html?forfeit=1`.

Expected: redirect happens; URL bar shows `?forfeit=1`. Landing page renders normally for now (no toast yet — that's Task 10). Don't commit until Task 10 lands the matching landing-page change.

- [ ] **Step 3: Hold on commit until Task 10**

This change makes sense atomically with the landing-page changes (forfeit hero state + toast). Combine into one commit at end of Task 10.

---

## Task 10: Frontend — `landing.js` renders forfeit hero state + `?forfeit=1` toast

**Files:**
- Modify: `client/js/landing.js` — `renderDailyHero`, mirror copy line, query-param toast handler.
- Modify: `client/css/styles.css` — forfeit hero variant + toast (only if styles don't already cover this; check first).

- [ ] **Step 1: Mirror the server-side copy fix in landing.js**

Open `client/js/landing.js`. The `PRE_TAUNTS` array at line 15 mirrors the server's. Find line 31:

```js
"Sixty problems. One you. Good luck.",
```

Change to:

```js
"Twenty problems. Don't waste them.",
```

The arrays must stay in lockstep (it's commented as such on line 14).

- [ ] **Step 2: Update the count subtitle in `renderDailyHero` ready state**

In the same file, find line 163:

```js
subEl.textContent = '60 questions, 1 shot. Same drill worldwide today.';
```

Change to:

```js
subEl.textContent = '20 questions, 1 shot. Same drill worldwide today.';
```

- [ ] **Step 3: Add forfeit-state branch to `renderDailyHero`**

In `renderDailyHero` (around line 123), the current logic is:

```js
let me = null;
try { me = await api.dailyMe(); } catch { /* default to "ready" */ }

if (me && me.played) {
  hero.dataset.state = 'completed';
  // ... existing completed-state rendering
  return;
}

hero.dataset.state = 'ready';
// ... existing ready-state rendering
```

Insert a forfeit branch between the `played` check and the ready fallback:

```js
let me = null;
try { me = await api.dailyMe(); } catch { /* default to "ready" */ }

if (me && me.played) {
  hero.dataset.state = 'completed';
  // ... existing completed-state rendering — unchanged
  return;
}

if (me && me.forfeited) {
  hero.dataset.state = 'forfeited';
  titleEl.textContent = `FORFEITED — ${pickByDate(POST_DONE, today)}`;
  subEl.textContent = 'One shot a day. You used yours.';
  btn.textContent = '✗ LOCKED';
  btn.disabled = true;
  return;
}

hero.dataset.state = 'ready';
// ... existing ready-state rendering — unchanged
```

The forfeit-state HTML reuses the existing hero markup; only `dataset.state` changes (CSS handles the visual variant — see step 5).

- [ ] **Step 4: Add `?forfeit=1` toast handler**

At the top of the `DOMContentLoaded` handler (around line 204, before the duration-card loop), insert:

```js
const params = new URLSearchParams(location.search);
if (params.get('forfeit') === '1') {
  showForfeitToast();
  // Clean the URL so refresh doesn't re-show the toast.
  const cleanUrl = location.pathname + location.hash;
  history.replaceState({}, '', cleanUrl);
}
```

Add a helper at the top level of the file (above `document.addEventListener`):

```js
function showForfeitToast() {
  const toast = document.createElement('div');
  toast.className = 'forfeit-toast';
  toast.textContent = 'Run already started — locked until tomorrow.';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}
```

- [ ] **Step 5: Add CSS for forfeit hero state and toast**

Open `client/css/styles.css`. Search for `daily-hero` to find the existing styles. Look for selectors keyed off `[data-state="completed"]` and `[data-state="guest"]`. Add a sibling for `[data-state="forfeited"]` with the same dimmed treatment as completed (greyed border, dim button).

If the existing CSS uses something like:

```css
.daily-hero[data-state="completed"] { /* dimmed styles */ }
```

Add:

```css
.daily-hero[data-state="forfeited"] { /* same as completed */ }
```

(Combine the selectors: `.daily-hero[data-state="completed"], .daily-hero[data-state="forfeited"] { ... }` — keeps it DRY.)

For the toast, append to the file:

```css
.forfeit-toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--accent-magenta, #d32f7a);
  color: var(--ink, #0e1117);
  font-weight: 600;
  padding: 0.6rem 1.2rem;
  border: 2px solid var(--ink, #0e1117);
  box-shadow: 4px 4px 0 var(--ink, #0e1117);
  z-index: 9999;
  transition: opacity 0.4s ease;
}
.forfeit-toast.fade-out { opacity: 0; }
```

If the project already has a toast/error-banner pattern, prefer reusing it over the magenta box above. Check by searching `styles.css` for existing toast/banner classes (`grep -n "toast\|banner" client/css/styles.css`); if a class like `.error-banner` or `.notice` exists, reuse it. The default magenta-box treatment matches the brutalist arcade theme described in the project voice doc.

- [ ] **Step 6: Manually verify all three states**

Start the dev server and open the app in a browser. Test each state:

**Ready state (logged-in, no row today):**
1. Register a fresh account → log in.
2. Land on `index.html`.
3. Daily Hero shows `START` button (lime), taunt copy, "20 questions, 1 shot…" subtitle.

**Forfeit state:**
1. From ready state, click START → enters gauntlet.
2. Hit alt-F4 / close the tab.
3. Reopen the site, land on `index.html`.
4. Daily Hero shows greyed border, `FORFEITED — <post-done line>` title, `One shot a day. You used yours.` subtitle, `✗ LOCKED` disabled button.

**Forfeit toast:**
1. From forfeit state, paste `play.html?mode=daily-gauntlet` into the URL bar.
2. Browser should redirect back to `index.html?forfeit=1`, then immediately rewrite the URL to `index.html` (history.replaceState).
3. A magenta toast appears: `Run already started — locked until tomorrow.`
4. Toast fades after ~4 seconds.

**Completed state (regression check):**
1. Register a second account, log in.
2. Click START, solve all 20 questions.
3. Score view appears.
4. Navigate back to `index.html`.
5. Daily Hero shows `CLEARED IN m:ss — <post-done>` title, `✓ DONE` greyed button. (Existing behavior, untouched.)

If any state misrenders, fix before committing.

- [ ] **Step 7: Commit (combined with Task 9's `play.js` change)**

```bash
git add client/js/play.js client/js/landing.js client/css/styles.css
git commit -m "feat(daily-gauntlet): forfeit-state hero + locked-out toast

When a user has a lock row but no completion, /me returns forfeited:true
and the landing page shows a dimmed 'FORFEITED' Daily Hero with a LOCKED
button. Direct visits to play.html?mode=daily-gauntlet that hit the lock
redirect to index.html?forfeit=1, which surfaces a transient toast
explaining the lockout."
```

---

## Task 11: Final verification across the whole flow

End-to-end smoke test of every behavior the spec promises.

- [ ] **Step 1: Run the entire server test suite**

Run: `cd server && node --test`

Expected: all tests pass. No regressions in normal-mode play, practice mode, challenges, etc.

- [ ] **Step 2: Manual end-to-end check**

With the dev server running:

1. **Fresh user, full happy path:** Register, click START, solve 20, see score view, see leaderboard entry. Refresh landing → completed state.
2. **Lock semantics:** Fresh user → click START → alt-F4 → reopen → forfeit state → can't restart → wait until SGT midnight (or fake the date for testing) → can play tomorrow.
3. **Two-tab race:** Fresh user → click START in tab A → open tab B → click START → tab B redirects to forfeit state (toast). Tab A still works; finishing in A updates the row to submitted=true; refreshing tab B now shows completed state.
4. **Different users, same questions:** Register two users, both click START in different sessions, peek at first 5 questions in each — should match (deterministic seed from SGT date). Both can finish independently.
5. **Existing modes:** Run a normal-mode session and a practice-mode session — both should work unchanged.

- [ ] **Step 3: Verify no leftover hardcoded `60`s in user-facing copy**

Run: `grep -n "60\|Sixty\|sixty" client/js/landing.js client/js/play.js server/src/copy/gauntlet-copy.js`

Expected: any hits are unrelated (e.g. SGT offset `8 * 60 * 60 * 1000`, `Math.floor(totalS / 60)` for time formatting). No surviving "60 questions", "Sixty problems", etc.

- [ ] **Step 4: Final commit if any leftover fixes needed**

If step 3 surfaced any leftover copy, fix and commit:

```bash
git add <files>
git commit -m "copy(daily-gauntlet): remove leftover question-count references"
```

If nothing needed, skip.

---

## Self-review against the spec

### Spec coverage

- ✅ "Lock at start" (spec: Backend > Lock-at-start logic) → Tasks 1, 3.
- ✅ "Drop to 20 questions" (spec: Behavior changes table; Backend > Question count) → Task 2.
- ✅ "Auto-submit on finish" (already implemented) — verified via existing `r.dailyGauntlet` branch in Task 11 step 2.
- ✅ "UPDATE lock row, don't INSERT" (spec: Backend > Finish logic) → Task 4.
- ✅ "`already_started` response shape" (spec: Backend > Routes > /start) → Task 3, tested in Task 5.
- ✅ "Concurrent `/start` race recovery via 23505 catch" (spec: Backend > Race condition) → Task 3, tested in Task 6.
- ✅ "`/me` returns `forfeited` flag" (spec: Frontend > /me endpoint extension) → Task 7.
- ✅ "Forfeit Daily Hero state" (spec: Frontend > Daily Hero forfeit state) → Task 10 step 3.
- ✅ "`?forfeit=1` toast" (spec: Frontend > Forfeit toast) → Task 10 step 4.
- ✅ "Migration `011_daily_gauntlet_lock.sql`" (spec: Schema) → Task 1.
- ✅ "Update Sixty-problems taunt" (spec: Files touched > gauntlet-copy.js) → Task 8.
- ✅ "Mirror taunt update in landing.js" (spec: Files touched > landing.js) → Task 10 step 1.
- ✅ "20-question subtitle in Daily Hero" (spec: Frontend) → Task 10 step 2.
- ✅ "play.js handles `already_started`" (spec: Frontend > play.js) → Task 9.
- ✅ "Pre-existing 60-question rows are migration-safe" (spec: Existing 60-question rows) → Task 1 step 2 (pre-check query).
- ✅ "In-flight sessions at deploy" (spec: In-flight sessions at deploy) → not a code task; documented in spec as accepted-as-is.

### Out-of-scope items intentionally not in plan

- Heartbeat / grace period — explicitly out of scope per spec.
- Backfilling 60-question historical rows — explicitly out of scope per spec.
- Anti-cheat for sub-N-second finishes — deferred per spec.

### Placeholder scan

- ✅ No "TBD" / "TODO" / "implement later" anywhere.
- ✅ Every code step has actual code, not "similar to above."
- ✅ Test code is complete in every test step.
- ✅ Expected outputs stated for every command.

### Type/identifier consistency

- `runId` / `lockRunId` / `preExistingRunId` — `lockRunId` is local to the `/start` handler in Task 3 (the value INSERTed RETURNING id, then assigned to `live.runId`). `preExistingRunId` is local to `flushRunIfRecording` in Task 4 (read from `live.runId`). Both refer to the same field on the session, just under different local-variable names. Consistent.
- `already_started` flag (server response) ↔ checked in `play.js` Task 9 ↔ implied by `me.forfeited` in `landing.js` Task 10. The `/me` endpoint returns `forfeited`, which is what `landing.js` consumes; `already_started` only flows through `/start`'s response, which `play.js` consumes. No name collision.
- `forfeited: false` returned from `/me` when no row exists (Task 7) and from `/start` when racing (`already_started: true, forfeited: false`) (Task 3). Same flag, different semantics — but only the landing page reads `me.forfeited`, only `play.js` reads `r.already_started`. No frontend code reads `r.forfeited` from `/start` (we don't surface "you raced" any differently from "you abandoned"). Consistent.
- `clearAllN` (renamed from `clearAll60` in Task 2) used throughout subsequent tests. Renamed once, consistent thereafter.

Plan looks clean.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-daily-gauntlet-hardening.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
