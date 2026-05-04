# Challenge Lock-at-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent recipients from grinding the challenger's deterministic seed by locking the challenge at first `/api/play/start`. A second `/start` (from another tab, after abandoning, or from refresh) is rejected.

**Architecture:** Add a nullable `recipient_started_at` column on `challenges`. The mode=challenge branch of `/api/play/start` does an atomic UPDATE that sets this column iff it's currently NULL — winning callers get a session, losers get `{ already_started: true }`. The forfeit sweep uses `COALESCE(recipient_started_at, responded_at)` for staleness so a recipient who actually started gets a fresh 30-minute clock from start time.

**Tech Stack:** Node.js, Fastify, PostgreSQL (`pg`), node:test runner, vanilla JS frontend.

---

## File map

**New:**
- `server/migrations/012_challenge_lock_at_start.sql` — single ALTER TABLE adding the nullable timestamp column.
- `server/test/unit/forfeit-sweep.test.js` — small regression guard for the sweep WHERE clause.

**Modified:**
- `server/src/routes/play.routes.js` — replace mode=challenge branch in `/api/play/start` with the atomic-claim version.
- `server/src/jobs/forfeit-sweep.js` — change WHERE clause to use COALESCE.
- `client/js/play.js` — add `already_started` branch in `startChallenge`.
- `client/js/landing.js` — generalize toast text.
- `server/test/integration/challenges.test.js` — append new tests for lock semantics + updated sweep behavior.

---

## Pre-flight

- [ ] **Step 1: Confirm worktree state**

Run: `pwd`
Expected: contains `.claude/worktrees/challenge-mode` (or whatever this worktree is named).

Run: `git status`
Expected: clean working tree, on branch `feature/challenge-lock-at-start` (or whatever branch was created for this work).

Run: `git log --oneline -5`
Expected: most recent commit is the spec for this feature (`docs(challenge): spec for lock-at-start hardening`). Branch is downstream of `main` after the daily-gauntlet-hardening work and the `played_at` fix.

- [ ] **Step 2: Confirm baseline tests pass**

Run: `cd server && npm run test:unit`
Expected: `pass 117` (give or take — the daily-gauntlet hardening shipped some unit tests; whatever the current baseline is, it should be green).

If the baseline is red, stop and figure out why before touching anything in this plan.

**No local Postgres available.** All integration tests in this plan are written but cannot be run locally — they skip via `skipIfNoDb(t)`. The user will run them on a dev DB. Do NOT attempt to apply the migration locally; do NOT run `npm run test:integration`.

---

## Task 1: Migration — add `recipient_started_at` column

Smallest possible change: one nullable column. Lands first so subsequent code can rely on it.

**Files:**
- Create: `server/migrations/012_challenge_lock_at_start.sql`

- [ ] **Step 1: Write the migration**

Create `server/migrations/012_challenge_lock_at_start.sql`:

```sql
-- Lock-at-start for challenge mode: timestamp set when the recipient first
-- clicks START. /api/play/start (mode=challenge) does an atomic UPDATE
-- conditional on this column being NULL, guaranteeing one shot per challenge.
ALTER TABLE challenges ADD COLUMN recipient_started_at TIMESTAMPTZ;
```

- [ ] **Step 2: Confirm unit tests still pass**

Run: `cd server && npm run test:unit`
Expected: same baseline as pre-flight, all green. (No code changed yet; this is just confirming the migration file's presence doesn't break anything that scans the migrations directory.)

- [ ] **Step 3: Commit**

```bash
git add server/migrations/012_challenge_lock_at_start.sql
git commit -m "feat(challenge): add recipient_started_at column for lock-at-start

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Atomic claim in `/api/play/start` (mode=challenge)

The core backend change. Replaces the existing SELECT-then-create-session flow with a single atomic UPDATE.

**Files:**
- Modify: `server/src/routes/play.routes.js` (mode=challenge branch, currently around lines 16-45)
- Modify: `server/test/integration/challenges.test.js` (append new tests)

- [ ] **Step 1: Write failing integration tests**

Append to `server/test/integration/challenges.test.js`. There are several tests; add them all in one go since they share setup patterns.

First, add a helper near the top of the file (after the existing helpers like `playAndFinishStandardRun` around line 39):

```js
async function acceptChallenge(app, cookie, challengeId) {
  return app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie }
  });
}

async function startChallenge(app, cookie, challengeId) {
  return app.inject({
    method: 'POST',
    url: '/api/play/start',
    payload: { mode: 'challenge', challenge_id: challengeId },
    headers: { cookie }
  });
}
```

Then append these tests at the bottom of the file:

```js
test('challenge lock: first /start sets recipient_started_at', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);

  const before = await pool.query(
    'SELECT recipient_started_at FROM challenges WHERE id=$1', [challengeId]
  );
  assert.equal(before.rows[0].recipient_started_at, null);

  const r = await startChallenge(app, bob.cookie, challengeId);
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().session_id);

  const after = await pool.query(
    'SELECT recipient_started_at FROM challenges WHERE id=$1', [challengeId]
  );
  assert.ok(after.rows[0].recipient_started_at, 'recipient_started_at should be set after first /start');
});

test('challenge lock: second /start while lock held returns already_started', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);

  const first = await startChallenge(app, bob.cookie, challengeId);
  assert.equal(first.statusCode, 200);
  assert.ok(first.json().session_id);

  const second = await startChallenge(app, bob.cookie, challengeId);
  assert.equal(second.statusCode, 200);
  const body = second.json();
  assert.equal(body.already_started, true);
  assert.equal(body.session_id, undefined, 'no session should be created on the second call');
});

test('challenge lock: race-recovery — pre-set recipient_started_at returns already_started', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);

  // Simulate "another tab won the race" by directly setting recipient_started_at.
  await pool.query(
    'UPDATE challenges SET recipient_started_at = now() WHERE id = $1',
    [challengeId]
  );

  const r = await startChallenge(app, bob.cookie, challengeId);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().already_started, true);
});

test('challenge lock: /start as non-recipient returns 403', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const carol = await registerAndCookie(app, 'carol');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);

  const r = await startChallenge(app, carol.cookie, challengeId);
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error, 'not_recipient');
});

test('challenge lock: /start when status is not accepted returns 409', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);
  // Manually move status away from 'accepted' to simulate a forfeited or completed challenge.
  await pool.query("UPDATE challenges SET status='declined' WHERE id=$1", [challengeId]);

  const r = await startChallenge(app, bob.cookie, challengeId);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'challenge_not_accepted');
});

test('challenge lock: /start for unknown challenge returns 404', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const bob = await registerAndCookie(app, 'bob');
  const r = await startChallenge(app, bob.cookie, 999999);
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error, 'not_found');
});
```

- [ ] **Step 2: Run the new tests — they should fail (or skip)**

Run: `cd server && npm run test:unit` (still no DB locally). Should be green; the integration tests skip without DB. If the test file has a syntax error, this run will surface it.

If a real DB is available, run integration tests; expect failures on the lock-related tests because the implementation hasn't landed yet. Otherwise skip this step.

- [ ] **Step 3: Implement the atomic-claim logic**

Open `server/src/routes/play.routes.js`. The existing mode=challenge branch is at lines 16-45. Replace it with:

```js
if (mode === 'challenge') {
  if (!req.user) return reply.code(401).send({ error: 'register-to-play' });
  const challengeId = Number(req.body?.challenge_id);
  if (!Number.isInteger(challengeId)) {
    return reply.code(400).send({ error: 'invalid_challenge_id' });
  }

  // Atomic claim: set recipient_started_at iff the caller is the recipient,
  // status='accepted', and nobody has started yet. Returns the challenger's run id
  // if we won the lock; rowCount=0 if we didn't.
  const claim = await pool.query(
    `UPDATE challenges
     SET recipient_started_at = now()
     WHERE id = $1
       AND recipient_id = $2
       AND status = 'accepted'
       AND recipient_started_at IS NULL
     RETURNING challenger_run_id`,
    [challengeId, req.user.id]
  );

  if (claim.rowCount === 0) {
    // Diagnose why: load the row to distinguish not_found vs not_recipient
    // vs not_accepted vs already_started.
    const c = await pool.query(
      `SELECT recipient_id, status, recipient_started_at
       FROM challenges WHERE id = $1`,
      [challengeId]
    );
    if (c.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    const row = c.rows[0];
    if (Number(row.recipient_id) !== req.user.id) {
      return reply.code(403).send({ error: 'not_recipient' });
    }
    if (row.status !== 'accepted') {
      return reply.code(409).send({ error: 'challenge_not_accepted' });
    }
    // status=accepted, recipient_id matches, but recipient_started_at is set → already started.
    return { already_started: true };
  }

  const challengerRunId = Number(claim.rows[0].challenger_run_id);
  const seedRes = await pool.query('SELECT seed FROM runs WHERE id=$1', [challengerRunId]);
  const seed = Number(seedRes.rows[0].seed);
  const r = sessionStore.start({
    userId: req.user.id,
    config: DEFAULT_CONFIG,
    explicitSeed: seed
  });
  return {
    session_id: r.sessionId,
    question: { prompt: r.question.prompt, op: r.question.op, answer: r.question.answer },
    peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
    time_limit_ms: r.timeLimitMs,
    challenge_id: challengeId
  };
}
```

Two semantic changes from the original:
1. The original SELECT-then-create-session pattern is replaced by an atomic UPDATE-and-create-session. No TOCTOU window.
2. New 200 response shape `{ already_started: true }` when the lock is held.

The original behavior — 401 for guests, 400 for invalid ID, 409 for non-accepted, 403 for non-recipient — is preserved. The 404 for unknown-challenge ID is *new* (the original returned 409 because the SELECT WHERE status='accepted' didn't match anything). Tests reflect this.

- [ ] **Step 4: Run unit tests to confirm no regressions**

Run: `cd server && npm run test:unit`
Expected: same baseline, all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/play.routes.js server/test/integration/challenges.test.js
git commit -m "feat(challenge): atomic lock claim in /api/play/start

Replace SELECT-then-create-session with single UPDATE … WHERE
recipient_started_at IS NULL. Adds already_started 200 response
shape; 404/403/409 discrimination for lock-claim failures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Forfeit sweep uses `COALESCE(recipient_started_at, responded_at)`

A recipient who actually clicked START gets a fresh 30-minute clock from start time, not from accept time.

**Files:**
- Modify: `server/src/jobs/forfeit-sweep.js`
- Modify: `server/test/integration/challenges.test.js` (add tests; the existing sweep tests are not affected)

- [ ] **Step 1: Write failing tests**

Append to `server/test/integration/challenges.test.js`:

```js
test('forfeit sweep: uses recipient_started_at when set (start at t-31min → forfeited)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);
  await startChallenge(app, bob.cookie, challengeId);

  // Backdate recipient_started_at to 31 minutes ago. responded_at stays recent.
  await pool.query(
    `UPDATE challenges SET recipient_started_at = now() - interval '31 minutes' WHERE id=$1`,
    [challengeId]
  );

  const flipped = await runForfeitSweep(pool);
  assert.equal(flipped, 1);
  const row = await pool.query('SELECT status FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].status, 'forfeited');
});

test('forfeit sweep: uses recipient_started_at when set (start at t-25min → not forfeited)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);
  await startChallenge(app, bob.cookie, challengeId);

  // Backdate responded_at to 31 minutes ago, but recipient_started_at is recent (just now).
  // The COALESCE should pick recipient_started_at and decline to forfeit.
  await pool.query(
    `UPDATE challenges SET responded_at = now() - interval '31 minutes' WHERE id=$1`,
    [challengeId]
  );

  const flipped = await runForfeitSweep(pool);
  assert.equal(flipped, 0);
  const row = await pool.query('SELECT status FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].status, 'accepted');
});

test('forfeit sweep: uses responded_at when never started (responded_at at t-31min → forfeited)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await acceptChallenge(app, bob.cookie, challengeId);
  // Don't call /start. recipient_started_at stays NULL.

  await pool.query(
    `UPDATE challenges SET responded_at = now() - interval '31 minutes' WHERE id=$1`,
    [challengeId]
  );

  const flipped = await runForfeitSweep(pool);
  assert.equal(flipped, 1);
  const row = await pool.query('SELECT status FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].status, 'forfeited');
});
```

- [ ] **Step 2: Update the sweep**

Open `server/src/jobs/forfeit-sweep.js`. The current full file is:

```js
const FORFEIT_AGE = "interval '30 minutes'";

export async function runForfeitSweep(pool) {
  const r = await pool.query(
    `UPDATE challenges
     SET status='forfeited'
     WHERE status='accepted'
       AND recipient_run_id IS NULL
       AND responded_at < now() - ${FORFEIT_AGE}`
  );
  return r.rowCount;
}

export function startForfeitSweep(pool, { intervalMs = 5 * 60 * 1000, log = console } = {}) {
  const handle = setInterval(() => {
    runForfeitSweep(pool).catch(err => log.error?.({ err }, 'forfeit-sweep failed'));
  }, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
```

Replace the WHERE clause's last predicate. Final form:

```js
const FORFEIT_AGE = "interval '30 minutes'";

export async function runForfeitSweep(pool) {
  const r = await pool.query(
    `UPDATE challenges
     SET status='forfeited'
     WHERE status='accepted'
       AND recipient_run_id IS NULL
       AND COALESCE(recipient_started_at, responded_at) < now() - ${FORFEIT_AGE}`
  );
  return r.rowCount;
}

export function startForfeitSweep(pool, { intervalMs = 5 * 60 * 1000, log = console } = {}) {
  const handle = setInterval(() => {
    runForfeitSweep(pool).catch(err => log.error?.({ err }, 'forfeit-sweep failed'));
  }, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
```

- [ ] **Step 3: Run unit tests to confirm no regressions**

Run: `cd server && npm run test:unit`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add server/src/jobs/forfeit-sweep.js server/test/integration/challenges.test.js
git commit -m "feat(challenge): forfeit sweep uses recipient_started_at when set

Once the recipient clicks START, give them the full 30-minute clock
from start time, not from accept time. COALESCE falls back to
responded_at for accepted-but-never-started challenges.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Forfeit-sweep unit test (regression guard)

A small unit test that doesn't need a DB — guards against accidentally reverting the COALESCE.

**Files:**
- Create: `server/test/unit/forfeit-sweep.test.js`

- [ ] **Step 1: Write the test**

Create `server/test/unit/forfeit-sweep.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runForfeitSweep } from '../../src/jobs/forfeit-sweep.js';

test('runForfeitSweep: WHERE clause uses COALESCE(recipient_started_at, responded_at)', async () => {
  let capturedSql = null;
  const fakePool = {
    async query(sql) {
      capturedSql = sql;
      return { rowCount: 0 };
    }
  };

  await runForfeitSweep(fakePool);

  assert.ok(capturedSql, 'should have invoked pool.query');
  assert.match(capturedSql, /COALESCE\(recipient_started_at,\s*responded_at\)/);
  assert.match(capturedSql, /status='accepted'/);
  assert.match(capturedSql, /recipient_run_id IS NULL/);
});
```

- [ ] **Step 2: Run the test**

Run: `cd server && npm run test:unit`
Expected: tests pass, with one new test added (count goes from 117 → 118 or whatever the current baseline is + 1).

- [ ] **Step 3: Commit**

```bash
git add server/test/unit/forfeit-sweep.test.js
git commit -m "test(challenge): unit guard for forfeit-sweep COALESCE

Lightweight regression guard against accidentally reverting the
sweep's WHERE clause back to plain responded_at.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — `play.js` handles `already_started` for challenges

The daily-gauntlet PR shipped the `?forfeit=1` toast and the `already_started` redirect for daily-gauntlet. Reuse the same redirect in challenge mode.

**Files:**
- Modify: `client/js/play.js` (the `startChallenge` function, around line 165)

- [ ] **Step 1: Locate the function**

Open `client/js/play.js`. Find `startChallenge` (around line 165). The relevant section is where `api.startChallenge(id)` is called and the response is used.

The current shape (around lines 193-200) is:

```js
let startRes;
try { startRes = await api.startChallenge(id); }
catch (e) {
  alert('Could not start challenge: ' + e.message);
  location.href = 'index.html';
  return;
}
```

After the catch block but before the existing logic that uses `startRes`, add an `already_started` branch:

```js
let startRes;
try { startRes = await api.startChallenge(id); }
catch (e) {
  alert('Could not start challenge: ' + e.message);
  location.href = 'index.html';
  return;
}

if (startRes.already_started) {
  location.href = 'index.html?forfeit=1';
  return;
}
```

**Note for the implementer:** read the file before editing — line numbers may have drifted after the daily-gauntlet PR. Search for the literal string `api.startChallenge(id)` to find the right place.

- [ ] **Step 2: Manual smoke check (cannot run automated tests for this)**

The user will manually verify after deploy. No local test possible.

- [ ] **Step 3: Hold the commit**

This change makes sense atomically with Task 6's toast text generalization. Combine into one commit at end of Task 6.

---

## Task 6: Frontend — generalize toast text

The toast currently says "Run already started — locked until tomorrow." The "until tomorrow" is daily-gauntlet-specific. Generalize.

**Files:**
- Modify: `client/js/landing.js` (the `showForfeitToast` helper)

- [ ] **Step 1: Edit the toast text**

Open `client/js/landing.js`. Find `showForfeitToast` (added in the daily-gauntlet PR — search for `forfeit-toast` to locate). The text content line currently reads:

```js
toast.textContent = 'Run already started — locked until tomorrow.';
```

Change to:

```js
toast.textContent = 'Run already started — locked.';
```

That's the only change in this file.

- [ ] **Step 2: Commit (combined with Task 5's `play.js` change)**

```bash
git add client/js/play.js client/js/landing.js
git commit -m "feat(challenge): redirect to forfeit toast on already_started

Adds the already_started branch in play.js startChallenge (mirrors the
daily-gauntlet redirect) and generalizes the toast text so it reads
correctly for both daily-gauntlet and challenge contexts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification

End-to-end check that nothing else regressed.

- [ ] **Step 1: Run the full unit test suite**

Run: `cd server && npm run test:unit`
Expected: all tests pass, total count up by 1 from pre-flight (the new forfeit-sweep unit test).

- [ ] **Step 2: Read the diff**

Run: `git diff main..HEAD --stat`
Expected: roughly these files, no surprises:

```
client/js/landing.js                            |  2 +-
client/js/play.js                               |  4 +
docs/superpowers/plans/...                      |  + (this plan)
docs/superpowers/specs/...                      |  + (the spec)
server/migrations/012_challenge_lock_at_start.sql | + (one ALTER TABLE)
server/src/jobs/forfeit-sweep.js                |  2 +-
server/src/routes/play.routes.js                | ~50 lines changed
server/test/integration/challenges.test.js      | ~150 lines added (9 new tests)
server/test/unit/forfeit-sweep.test.js          | + (new file)
```

If anything else shows up — particularly in `client/js/landing.js`, `server/src/routes/play.routes.js`, or any file outside this list — investigate before pushing.

- [ ] **Step 3: Confirm new test names**

Run: `grep -n "^test(" server/test/integration/challenges.test.js | tail -10`
Expected: the last several tests should be the ones added in this plan. Test names start with `'challenge lock:'` or `'forfeit sweep:'`.

- [ ] **Step 4: No leftover debug artifacts**

Run: `git diff main..HEAD | grep -E "console\.log|debugger|TODO|FIXME"`
Expected: empty output (no debug logs or TODO markers introduced).

- [ ] **Step 5: Manual frontend verification (after deploy, not now)**

Document for the user — these are post-deploy smoke tests, not local. Add to PR description:

- Accept a challenge as user B → click START → answer some questions → close tab.
- Reopen `play.html?challenge_id=X` → redirected to `index.html?forfeit=1` with toast.
- Wait for the sweep (5-min interval, 30-min threshold) → result page shows `forfeited`.
- Same flow but solve all 60 → submit-run succeeds, result page shows `completed`.

---

## Self-review against the spec

### Spec coverage

- ✅ "Add `recipient_started_at` column" → Task 1.
- ✅ "Atomic claim in `/api/play/start` mode=challenge" → Task 2.
- ✅ "Diagnostic 403/404/409 from claim failure" → Task 2 (with explicit test for each).
- ✅ "`{ already_started: true }` response shape" → Task 2 (tested in 'second /start while lock held').
- ✅ "Forfeit sweep uses `COALESCE(recipient_started_at, responded_at)`" → Task 3 (with three tests covering set-and-recent, set-and-stale, never-set).
- ✅ "Frontend `play.js` handles `already_started`" → Task 5.
- ✅ "Generalize toast text" → Task 6.
- ✅ "Forfeit-sweep unit test (optional)" → Task 4 (kept it because the regression guard is cheap).
- ✅ "submit-run unchanged" → confirmed by NOT modifying it; existing submit-run tests in challenges.test.js still pass.

### Out-of-scope items intentionally not in plan

- Anti-cheat against pre-computed answers via dev tools — explicitly out of scope per spec.
- Anti-collusion (two recipients sharing answers) — out of scope per spec.
- Reducing the 30-minute forfeit window — out of scope per spec.

### Placeholder scan

- ✅ No "TBD" / "TODO" / "implement later".
- ✅ Every code step has the actual code.
- ✅ Every test step has the actual test code.
- ✅ Expected outputs stated for every command.

### Type/identifier consistency

- `recipient_started_at` (column name) consistent across migration, route, sweep, all tests.
- `acceptChallenge` and `startChallenge` (test helpers) defined once at top of test file, reused across tests.
- `already_started` (response field) consistent between server route and client `play.js` check.
- `?forfeit=1` query param consistent between `play.js` redirect and `landing.js` toast trigger (the latter unchanged from daily-gauntlet PR).
- 404 for unknown challenge ID is a *new* error response shape vs the previous 409. Documented in Task 2 step 3 and exercised by the 'unknown challenge → 404' test.

Plan looks clean.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-challenge-lock-at-start.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
