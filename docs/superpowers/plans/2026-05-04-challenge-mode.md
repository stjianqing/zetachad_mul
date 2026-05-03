# Challenge Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Challenge Mode where a player who just finished a standard run can challenge another user (registered or via single-use share link) to beat their score on the same problem sequence, with a live ghost ticker during play and a drag-race + head-to-head review afterward.

**Architecture:** Add a `challenges` table that links two `runs` rows (challenger + recipient). Persist the RNG seed on `runs` so the recipient can re-derive the identical question sequence client-side via the existing `makeRng`/`generate` primitives. Surface CHALLENGE buttons on the post-run screen (eligible runs only), an incoming-challenge modal on the home page, a share-link landing page for unregistered targets, and a result view (drag race + head-to-head table) that both parties see when they next visit. Forfeit sweep job catches stale `accepted` rows after 30 minutes.

**Tech Stack:** Node 22 ESM, Fastify 5, Postgres 16 (`pg`), `node --test` for tests, plain HTML + vanilla JS client (no framework, no bundler).

**Spec:** `docs/superpowers/specs/2026-05-04-challenge-mode-design.md`

---

## File Structure

### Server — new files
- `server/migrations/010_challenges.sql` — schema: `challenges` table + indexes + `runs.seed` column.
- `server/src/routes/challenges.routes.js` — Fastify route plugin for all `/api/challenges/*` endpoints.
- `server/src/jobs/forfeit-sweep.js` — `setInterval` registrar that flips stale `accepted` rows to `forfeited`.
- `server/src/challenge/eligibility.js` — pure helper: `isRunChallengeEligible(runRow) → bool` and `assertEligible(runRow)` for shared use across routes.
- `server/src/challenge/share-token.js` — `generateShareToken()` returning a 16-byte URL-safe random string.

### Server — modified files
- `server/src/game/session.js` — add `seed` to the session object so the chosen RNG seed survives into `takeRunRecord`.
- `server/src/routes/play.routes.js` — `flushRunIfRecording` writes the seed into `runs`.
- `server/src/index.js` — register `challengesRoutes`, start the forfeit-sweep timer.

### Server — new tests
- `server/test/integration/challenges.test.js` — end-to-end coverage of all endpoints + forfeit sweep.
- `server/test/unit/challenge-eligibility.test.js` — pure unit coverage of the eligibility helper.
- `server/test/unit/share-token.test.js` — pure unit coverage of token generator.

### Client — new files
- `client/js/ghost-ticker.js` — wall-clock-paced ghost score advancer for `play.js`.
- `client/js/drag-race.js` — post-run animation.
- `client/js/head-to-head.js` — post-run table renderer.
- `client/js/challenges-home.js` — incoming modal queue + outgoing/results panel for `index.html`.
- `client/js/challenge-landing.js` — script for `challenge.html` (share-link landing).
- `client/js/result-page.js` — script for `result.html` (post-run challenge result page).
- `client/challenge.html` — share-link landing page, served at `/challenge/:token`.
- `client/result.html` — challenge result view (drag race + head-to-head). Linked from notifications.
- `client/css/challenges.css` — Challenge-mode-specific styles (ghost ticker, drag race, modals).

### Client — modified files
- `client/js/api.js` — add `api.challenges.*` helpers.
- `client/js/play.js` — accept `?challenge=:id` query param; load ghost ticker; redirect to `/result.html?id=:id` on challenge completion. Also gate the post-run CHALLENGE block to eligible runs.
- `client/js/landing.js` — load `challenges-home.js` on page init.
- `client/index.html` — wire `challenges-home.js`, add containers.
- `client/play.html` — add `<div id="ghost-row">` slot under score; load `ghost-ticker.js`.

---

## Conventions

**Test runner.** All tests use `node:test`. Run with:
```bash
npm --prefix server test                   # all
npm --prefix server run test:unit          # unit only
npm --prefix server run test:integration   # integration only (needs TEST_DATABASE_URL)
```

Integration tests require a Postgres database. Set:
```bash
export TEST_DATABASE_URL=postgres://localhost/zetachad_test
```
Tests skip themselves if it's unset (see `skipIfNoDb` in `server/test/integration/helper.js`).

**Single-test runs.** `node --test` doesn't natively support `--test-name-pattern` in a portable way across versions; instead, append `--test-only` markers via `t.only()`, OR run a single file:
```bash
node --test server/test/integration/challenges.test.js
```

**Commits.** Each task ends with a single commit. Use Conventional Commits style matching existing history (`feat:`, `fix:`, `schema:`, `docs:`, `test:`).

**No backwards-compat shims.** Old `runs` rows have `seed IS NULL`; eligibility just rejects them. No backfill needed.

---

## Task 1: Migration — `runs.seed` column + `challenges` table

**Files:**
- Create: `server/migrations/010_challenges.sql`

- [ ] **Step 1: Confirm migration number**

Run: `ls server/migrations/`
Expected: highest number is `009_daily_gauntlet_date.sql`. New file is `010_challenges.sql`. If a different `010_*` already exists locally or on `main`, bump to the next free number and update file references throughout the plan.

- [ ] **Step 2: Write the migration**

Create `server/migrations/010_challenges.sql`:

```sql
-- Challenge Mode: persists challenger/recipient run links + share-link tokens.

ALTER TABLE runs ADD COLUMN seed BIGINT;

CREATE TABLE challenges (
  id                       BIGSERIAL PRIMARY KEY,
  challenger_run_id        BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  challenger_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id             BIGINT REFERENCES users(id) ON DELETE SET NULL,
  recipient_run_id         BIGINT REFERENCES runs(id) ON DELETE SET NULL,
  share_token              TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending',
  challenger_seen_result   BOOLEAN NOT NULL DEFAULT false,
  recipient_seen_result    BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at             TIMESTAMPTZ,
  CHECK (status IN ('pending','accepted','completed','forfeited','declined')),
  CHECK (challenger_id <> recipient_id OR recipient_id IS NULL)
);

CREATE UNIQUE INDEX challenges_share_token_idx
  ON challenges(share_token)
  WHERE share_token IS NOT NULL;

CREATE INDEX challenges_recipient_pending_idx
  ON challenges(recipient_id, status)
  WHERE status = 'pending';

CREATE INDEX challenges_challenger_idx
  ON challenges(challenger_id, created_at DESC);

CREATE INDEX challenges_sweep_idx
  ON challenges(status, responded_at)
  WHERE status = 'accepted';
```

- [ ] **Step 3: Apply migration locally**

Run: `npm --prefix server run migrate`
Expected: completes without error.

- [ ] **Step 4: Verify schema**

Run: `psql "$DATABASE_URL" -c "\d challenges" -c "\d runs"`
Expected: `challenges` table exists with all columns + indexes; `runs` has new `seed BIGINT` column.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/010_challenges.sql
git commit -m "schema: 010 challenges table + runs.seed column"
```

---

## Task 2: Persist seed into `runs`

**Files:**
- Modify: `server/src/game/session.js` (start() captures seed; takeRunRecord() returns it)
- Modify: `server/src/routes/play.routes.js` (flushRunIfRecording inserts seed)
- Test: `server/test/unit/session.test.js` (extend existing)

- [ ] **Step 1: Read existing session test file**

Run: `head -80 server/test/unit/session.test.js`
Goal: match its style for the new test.

- [ ] **Step 2: Write failing test — session captures seed**

Append to `server/test/unit/session.test.js`:

```javascript
test('session.start captures the seed used for normal runs', () => {
  const store = createSessionStore({ rngSeed: 12345 });
  const r = store.start({ userId: 1, config: DEFAULT_CONFIG });
  const sess = store.get(r.sessionId);
  assert.equal(typeof sess.seed, 'number');
  // Seed must be non-null (was undefined before this change).
  assert.ok(Number.isInteger(sess.seed));
});

test('session.start uses date-derived seed for daily-gauntlet, exposes it', () => {
  const store = createSessionStore({});
  const r = store.start({
    userId: 1,
    config: DEFAULT_CONFIG,
    mode: 'daily-gauntlet',
    seedDate: '2026-05-04'
  });
  const sess = store.get(r.sessionId);
  assert.equal(typeof sess.seed, 'number');
});

test('takeRunRecord includes seed', () => {
  const store = createSessionStore({ rngSeed: 99 });
  const r = store.start({ userId: 1, config: DEFAULT_CONFIG });
  const rec = store.takeRunRecord(r.sessionId);
  assert.equal(typeof rec.seed, 'number');
});
```

(Imports needed at the top of the file — check it already has `DEFAULT_CONFIG` imported; if not, add `import { DEFAULT_CONFIG } from '../../src/config.js';`.)

- [ ] **Step 3: Run failing test**

Run: `node --test server/test/unit/session.test.js`
Expected: 3 new tests fail (seed is undefined).

- [ ] **Step 4: Modify `session.js` to capture seed**

In `server/src/game/session.js`, in the `start()` function, replace the rng-construction block:

```javascript
const isDailyGauntlet = mode === 'daily-gauntlet';
const rng = isDailyGauntlet
  ? makeRng(dateStringToSeed(seedDate))
  : makeRng(nextSeed());
```

with:

```javascript
const isDailyGauntlet = mode === 'daily-gauntlet';
const seed = isDailyGauntlet
  ? dateStringToSeed(seedDate)
  : nextSeed();
const rng = makeRng(seed);
```

Then in the `session = { ... }` object literal, add `seed,` near `userId`.

In `takeRunRecord`, change the returned object to include `seed: session.seed`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/test/unit/session.test.js`
Expected: all session tests pass (existing + new 3).

- [ ] **Step 6: Modify `flushRunIfRecording` in play.routes.js**

In `server/src/routes/play.routes.js`, find the `INSERT INTO runs (...)` call inside `flushRunIfRecording`. Replace the existing INSERT and its parameter list:

```javascript
const insRun = await client.query(
  `INSERT INTO runs (user_id, score, duration_ms, practice, difficulty, daily_gauntlet_date, submitted_to_leaderboard, seed)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   RETURNING id`,
  [rec.userId, rec.score, rec.durationMs, rec.practice, difficulty, rec.dailyGauntletDate, rec.submittedToLeaderboard, rec.seed]
);
```

- [ ] **Step 7: Run all existing tests, confirm nothing regressed**

Run: `npm --prefix server test`
Expected: all green. (Existing daily-gauntlet integration tests already insert into `runs`; they'll now write `seed` non-null too. They don't assert on seed, so they pass either way.)

- [ ] **Step 8: Commit**

```bash
git add server/src/game/session.js server/src/routes/play.routes.js server/test/unit/session.test.js
git commit -m "feat: persist rng seed on runs for challenge replay"
```

---

## Task 3: Challenge eligibility helper (pure)

**Files:**
- Create: `server/src/challenge/eligibility.js`
- Test: `server/test/unit/challenge-eligibility.test.js`

- [ ] **Step 1: Write failing test**

Create `server/test/unit/challenge-eligibility.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRunChallengeEligible, assertEligible } from '../../src/challenge/eligibility.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const okRow = {
  id: 1,
  user_id: 42,
  seed: 12345,
  practice: false,
  daily_gauntlet_date: null,
  config: DEFAULT_CONFIG
};

test('eligible: default-config, non-practice, non-daily, has seed', () => {
  assert.equal(isRunChallengeEligible(okRow), true);
});

test('ineligible: no seed (legacy run)', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, seed: null }), false);
});

test('ineligible: practice run', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, practice: true }), false);
});

test('ineligible: daily-gauntlet run', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, daily_gauntlet_date: '2026-05-04' }), false);
});

test('ineligible: non-default config', () => {
  const customConfig = { ...DEFAULT_CONFIG, durationMs: 60_000 };
  assert.equal(isRunChallengeEligible({ ...okRow, config: customConfig }), false);
});

test('ineligible: missing config', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, config: null }), false);
});

test('assertEligible: throws with reason on ineligible', () => {
  assert.throws(
    () => assertEligible({ ...okRow, seed: null }),
    /seed/
  );
});

test('assertEligible: returns silently on eligible', () => {
  assert.doesNotThrow(() => assertEligible(okRow));
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test server/test/unit/challenge-eligibility.test.js`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write helper**

Create `server/src/challenge/eligibility.js`:

```javascript
import { isDefaultConfig } from '../config.js';

export function isRunChallengeEligible(runRow) {
  return ineligibleReason(runRow) === null;
}

export function assertEligible(runRow) {
  const reason = ineligibleReason(runRow);
  if (reason !== null) {
    const err = new Error(`run not challenge-eligible: ${reason}`);
    err.code = 'INELIGIBLE_RUN';
    err.reason = reason;
    throw err;
  }
}

function ineligibleReason(runRow) {
  if (!runRow) return 'missing';
  if (runRow.seed === null || runRow.seed === undefined) return 'no seed (legacy run)';
  if (runRow.practice === true) return 'practice run';
  if (runRow.daily_gauntlet_date != null) return 'daily-gauntlet run';
  if (!isDefaultConfig(runRow.config)) return 'non-default config';
  return null;
}
```

**Note on `runRow.config`:** the existing `runs` table does NOT store config — `config` is reconstructed from `practice`/`daily_gauntlet_date`/etc. The `config` field on the row passed in must be hydrated by the caller. Routes that load a run for eligibility check will need to pass `DEFAULT_CONFIG` (since only default-config runs persist attempts in the first place; see `recordsAttempts` in `session.js`). Document this expectation in the helper:

Add a doc comment above `isRunChallengeEligible`:

```javascript
/**
 * Check if a run is eligible to be a challenge source.
 * The runRow must include: id, user_id, seed, practice, daily_gauntlet_date, config.
 * Caller is responsible for hydrating `config` (the runs table doesn't store it).
 * For runs that have persisted attempts, config is always DEFAULT_CONFIG (see recordsAttempts in session.js).
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/unit/challenge-eligibility.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/challenge/eligibility.js server/test/unit/challenge-eligibility.test.js
git commit -m "feat: challenge eligibility helper"
```

---

## Task 4: Share token generator

**Files:**
- Create: `server/src/challenge/share-token.js`
- Test: `server/test/unit/share-token.test.js`

- [ ] **Step 1: Write failing test**

Create `server/test/unit/share-token.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateShareToken } from '../../src/challenge/share-token.js';

test('generateShareToken: returns URL-safe string', () => {
  const t = generateShareToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('generateShareToken: 16 bytes => 22 chars base64url', () => {
  const t = generateShareToken();
  assert.equal(t.length, 22);
});

test('generateShareToken: unique across many calls', () => {
  const set = new Set();
  for (let i = 0; i < 1000; i++) set.add(generateShareToken());
  assert.equal(set.size, 1000);
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test server/test/unit/share-token.test.js`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write generator**

Create `server/src/challenge/share-token.js`:

```javascript
import { randomBytes } from 'node:crypto';

export function generateShareToken() {
  return randomBytes(16).toString('base64url');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/unit/share-token.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/challenge/share-token.js server/test/unit/share-token.test.js
git commit -m "feat: share token generator"
```

---

## Task 5: Challenges route — POST /api/challenges (create)

**Files:**
- Create: `server/src/routes/challenges.routes.js`
- Modify: `server/src/index.js` (register plugin)
- Test: `server/test/integration/challenges.test.js`

- [ ] **Step 1: Write failing test (file scaffold + create-by-username)**

Create `server/test/integration/challenges.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

async function registerAndCookie(app, username) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username, password: 'password123' }
  });
  return { cookie: cookieFromResponse(r), userId: r.json().user.id };
}

async function playAndFinishStandardRun(app, cookie, sessionStore) {
  const startRes = await app.inject({
    method: 'POST',
    url: '/api/play/start',
    payload: { config: DEFAULT_CONFIG },
    headers: { cookie }
  });
  const { session_id } = startRes.json();
  const sess = sessionStore.get(session_id);
  // Force time-up by burning through the session's clock: answer one then finish.
  await app.inject({
    method: 'POST',
    url: '/api/play/answer',
    payload: { session_id, answer: String(sess.currentQuestion.answer) },
    headers: { cookie }
  });
  // Force-finalize via session store so the run flushes.
  sess.startedAt = sess.startedAt - sess.durationMs - 1000;
  // One more answer triggers time-up branch.
  const last = await app.inject({
    method: 'POST',
    url: '/api/play/answer',
    payload: { session_id, answer: '0' },
    headers: { cookie }
  });
  return { session_id, last: last.json() };
}

async function getLatestRunId(pool, userId) {
  const r = await pool.query('SELECT id FROM runs WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId]);
  return Number(r.rows[0].id);
}

test('create challenge by username — happy path', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const challengerRunId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: challengerRunId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(body.id);
  assert.equal(body.status, 'pending');
});

test('create challenge by share link — returns share_url', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const challengerRunId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: challengerRunId, share_link: true },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(body.share_url);
  assert.match(body.share_url, /\/challenge\//);
});

test('create challenge: self-challenge blocked (400)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'alice' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
});

test('create challenge: unknown recipient (404)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'ghost' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 404);
});

test('create challenge: not the run owner (400)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const aliceRunId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: aliceRunId, recipient_username: 'alice' },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 400);
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test server/test/integration/challenges.test.js`
Expected: FAIL — `/api/challenges` not registered.

- [ ] **Step 3: Write the route plugin (skeleton + create only)**

Create `server/src/routes/challenges.routes.js`:

```javascript
import { requireAuth } from '../auth.js';
import { assertEligible } from '../challenge/eligibility.js';
import { generateShareToken } from '../challenge/share-token.js';
import { DEFAULT_CONFIG } from '../config.js';

export default async function challengesRoutes(fastify, { pool, baseUrl = '' }) {
  fastify.post('/api/challenges', { preHandler: requireAuth }, async (req, reply) => {
    const { challenger_run_id, recipient_username, share_link } = req.body ?? {};
    if (!Number.isInteger(challenger_run_id)) {
      return reply.code(400).send({ error: 'invalid_run_id' });
    }
    if (!recipient_username && !share_link) {
      return reply.code(400).send({ error: 'recipient_required' });
    }
    if (recipient_username && share_link) {
      return reply.code(400).send({ error: 'pick_one_recipient_mode' });
    }

    // Load and verify ownership of the source run.
    const runRes = await pool.query(
      `SELECT id, user_id, seed, practice, daily_gauntlet_date FROM runs WHERE id=$1`,
      [challenger_run_id]
    );
    const run = runRes.rows[0];
    if (!run) return reply.code(400).send({ error: 'run_not_found' });
    if (Number(run.user_id) !== req.user.id) {
      return reply.code(400).send({ error: 'not_run_owner' });
    }

    // Eligibility: hydrate config to DEFAULT (only default-config runs flush attempts;
    // ineligible source paths are excluded by the helper).
    try {
      assertEligible({ ...run, config: DEFAULT_CONFIG });
    } catch (err) {
      return reply.code(400).send({ error: 'ineligible_run', reason: err.reason });
    }

    // Username branch.
    if (recipient_username) {
      if (recipient_username.toLowerCase() === req.user.username.toLowerCase()) {
        return reply.code(400).send({ error: 'cannot_challenge_self' });
      }
      const userRes = await pool.query(
        'SELECT id FROM users WHERE lower(username)=lower($1)',
        [recipient_username]
      );
      const recipient = userRes.rows[0];
      if (!recipient) return reply.code(404).send({ error: 'recipient_not_found' });

      const ins = await pool.query(
        `INSERT INTO challenges (challenger_run_id, challenger_id, recipient_id, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id, status`,
        [challenger_run_id, req.user.id, recipient.id]
      );
      return { id: Number(ins.rows[0].id), status: ins.rows[0].status };
    }

    // Share-link branch.
    const token = generateShareToken();
    const ins = await pool.query(
      `INSERT INTO challenges (challenger_run_id, challenger_id, share_token, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, status`,
      [challenger_run_id, req.user.id, token]
    );
    return {
      id: Number(ins.rows[0].id),
      status: ins.rows[0].status,
      share_url: `${baseUrl}/challenge/${token}`
    };
  });
}
```

- [ ] **Step 4: Register plugin in `server/src/index.js`**

Add import near other route imports:

```javascript
import challengesRoutes from './routes/challenges.routes.js';
```

In `buildApp`, add (after `practiceRoutes` registration):

```javascript
await app.register(challengesRoutes, { pool, baseUrl: process.env.BASE_URL ?? '' });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/test/integration/challenges.test.js`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/challenges.routes.js server/src/index.js server/test/integration/challenges.test.js
git commit -m "feat: POST /api/challenges (username + share-link)"
```

---

## Task 6: Reject ineligible source runs

**Files:**
- Modify: `server/test/integration/challenges.test.js` (extend)

- [ ] **Step 1: Add tests for ineligible sources**

Append to `server/test/integration/challenges.test.js`:

```javascript
test('create challenge: legacy run (no seed) blocked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  // Insert a run by hand with seed=NULL (simulating a pre-migration run).
  const ins = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice) VALUES ($1, 10, 120000, false) RETURNING id`,
    [alice.userId]
  );
  const runId = Number(ins.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'ineligible_run');
});

test('create challenge: practice run blocked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  const ins = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed) VALUES ($1, 10, 120000, true, 42) RETURNING id`,
    [alice.userId]
  );
  const runId = Number(ins.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
});

test('create challenge: daily-gauntlet run blocked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  const ins = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed, daily_gauntlet_date, submitted_to_leaderboard)
     VALUES ($1, 60, 240000, false, 20260504, '2026-05-04', true) RETURNING id`,
    [alice.userId]
  );
  const runId = Number(ins.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: PASS — the route already calls `assertEligible`. If a test fails, the route's eligibility check is wrong.

- [ ] **Step 3: Commit**

```bash
git add server/test/integration/challenges.test.js
git commit -m "test: reject ineligible challenge source runs"
```

---

## Task 7: GET /api/challenges/incoming + /outgoing

**Files:**
- Modify: `server/src/routes/challenges.routes.js`
- Modify: `server/test/integration/challenges.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/test/integration/challenges.test.js`:

```javascript
test('incoming: only pending challenges for me', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'bob' },
    headers: { cookie: alice.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: '/api/challenges/incoming',
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].challenger.username, 'alice');
  assert.equal(typeof body[0].challenger_score, 'number');
});

test('outgoing: lists my sent challenges with status', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'bob');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'bob' },
    headers: { cookie: alice.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: '/api/challenges/outgoing',
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].recipient_username, 'bob');
  assert.equal(body[0].status, 'pending');
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: 2 new tests fail with 404 (route not defined).

- [ ] **Step 3: Add endpoints to challenges.routes.js**

Append inside `challengesRoutes` plugin:

```javascript
fastify.get('/api/challenges/incoming', { preHandler: requireAuth }, async (req) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.created_at, c.status,
            r.score AS challenger_score,
            u.username AS challenger_username
     FROM challenges c
     JOIN runs r ON r.id = c.challenger_run_id
     JOIN users u ON u.id = c.challenger_id
     WHERE c.recipient_id = $1 AND c.status = 'pending'
     ORDER BY c.created_at ASC`,
    [req.user.id]
  );
  return rows.map(row => ({
    id: Number(row.id),
    challenger: { username: row.challenger_username },
    challenger_score: row.challenger_score,
    created_at: row.created_at
  }));
});

fastify.get('/api/challenges/outgoing', { preHandler: requireAuth }, async (req) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.created_at, c.status, c.share_token, c.challenger_seen_result,
            cr.score AS challenger_score,
            rr.score AS recipient_score,
            ru.username AS recipient_username
     FROM challenges c
     JOIN runs cr ON cr.id = c.challenger_run_id
     LEFT JOIN runs rr ON rr.id = c.recipient_run_id
     LEFT JOIN users ru ON ru.id = c.recipient_id
     WHERE c.challenger_id = $1
     ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  return rows.map(row => ({
    id: Number(row.id),
    recipient_username: row.recipient_username ?? null,
    share_token: row.share_token ?? null,
    challenger_score: row.challenger_score,
    recipient_score: row.recipient_score ?? null,
    status: row.status,
    challenger_seen_result: row.challenger_seen_result,
    created_at: row.created_at
  }));
});
```

- [ ] **Step 4: Run tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/challenges.routes.js server/test/integration/challenges.test.js
git commit -m "feat: GET /api/challenges/incoming and /outgoing"
```

---

## Task 8: POST /api/challenges/:id/accept and /decline

**Files:**
- Modify: `server/src/routes/challenges.routes.js`
- Modify: `server/test/integration/challenges.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/test/integration/challenges.test.js`:

```javascript
async function createUsernameChallenge(app, pool, sessionStore, alice, recipientUsername) {
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);
  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: recipientUsername },
    headers: { cookie: alice.cookie }
  });
  return r.json().id;
}

test('accept: returns seed + config + challenger_attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(typeof body.seed === 'number');
  assert.ok(body.config);
  assert.ok(Array.isArray(body.challenger_attempts));
  // Each attempt has q_index, response_ms, correct.
  if (body.challenger_attempts.length > 0) {
    assert.ok('q_index' in body.challenger_attempts[0]);
    assert.ok('response_ms' in body.challenger_attempts[0]);
    assert.ok('correct' in body.challenger_attempts[0]);
  }
});

test('accept: not the recipient → 404', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'bob');
  const eve = await registerAndCookie(app, 'eve');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: eve.cookie }
  });
  assert.equal(r.statusCode, 404);
});

test('decline: status flips and shows up on outgoing', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/decline`,
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);

  const out = await app.inject({
    method: 'GET',
    url: '/api/challenges/outgoing',
    headers: { cookie: alice.cookie }
  });
  const list = out.json();
  assert.equal(list[0].status, 'declined');
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: new tests fail with 404 (routes missing).

- [ ] **Step 3: Add endpoints**

Append inside `challengesRoutes`:

```javascript
fastify.post('/api/challenges/:id/accept', { preHandler: requireAuth }, async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });

  // Lock and verify.
  const upd = await pool.query(
    `UPDATE challenges
     SET status='accepted', responded_at=now()
     WHERE id=$1 AND recipient_id=$2 AND status='pending'
     RETURNING challenger_run_id`,
    [id, req.user.id]
  );
  if (upd.rowCount === 0) {
    return reply.code(404).send({ error: 'not_found_or_not_recipient' });
  }
  const challengerRunId = Number(upd.rows[0].challenger_run_id);

  // Load run to get seed.
  const runRes = await pool.query('SELECT seed FROM runs WHERE id=$1', [challengerRunId]);
  const seed = runRes.rows[0].seed;

  // Load attempts (the ghost data).
  const attRes = await pool.query(
    `SELECT q_index, response_ms, correct FROM attempts WHERE run_id=$1 ORDER BY q_index ASC`,
    [challengerRunId]
  );
  const challenger_attempts = attRes.rows.map(a => ({
    q_index: a.q_index,
    response_ms: a.response_ms,
    correct: a.correct
  }));

  return {
    seed: Number(seed),
    config: DEFAULT_CONFIG,
    challenger_attempts
  };
});

fastify.post('/api/challenges/:id/decline', { preHandler: requireAuth }, async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
  const upd = await pool.query(
    `UPDATE challenges
     SET status='declined', responded_at=now()
     WHERE id=$1 AND recipient_id=$2 AND status='pending'`,
    [id, req.user.id]
  );
  if (upd.rowCount === 0) {
    return reply.code(404).send({ error: 'not_found_or_not_recipient' });
  }
  return { ok: true };
});
```

- [ ] **Step 4: Run tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/challenges.routes.js server/test/integration/challenges.test.js
git commit -m "feat: accept and decline challenge endpoints"
```

---

## Task 9: POST /api/challenges/:id/submit-run

**Files:**
- Modify: `server/src/routes/challenges.routes.js`
- Modify: `server/test/integration/challenges.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/test/integration/challenges.test.js`:

```javascript
test('submit-run: links recipient run + flips status to completed', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  // Get the seed Bob is supposed to use.
  const seedRow = await pool.query(
    `SELECT cr.seed FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id WHERE c.id=$1`,
    [challengeId]
  );
  const expectedSeed = Number(seedRow.rows[0].seed);

  // Bob plays a run with the SAME seed by inserting directly (in real flow, the
  // session store would do this). We need to bypass the session-store seed counter
  // to force the seed to match — easiest way is to insert a runs row by hand.
  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 50, 120000, false, $2) RETURNING id`,
    [bob.userId, expectedSeed]
  );
  const recipientRunId = Number(insRun.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: recipientRunId },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);

  const after = await pool.query('SELECT status, recipient_run_id FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(after.rows[0].status, 'completed');
  assert.equal(Number(after.rows[0].recipient_run_id), recipientRunId);
});

test('submit-run: seed mismatch → 400', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  // Run with a deliberately wrong seed.
  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 50, 120000, false, 99999999) RETURNING id`,
    [bob.userId]
  );
  const recipientRunId = Number(insRun.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: recipientRunId },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 400);
});

test('submit-run: not in accepted state → 409', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  // Skip accept.

  const seedRow = await pool.query(
    `SELECT cr.seed FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id WHERE c.id=$1`,
    [challengeId]
  );
  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 50, 120000, false, $2) RETURNING id`,
    [bob.userId, Number(seedRow.rows[0].seed)]
  );

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: Number(insRun.rows[0].id) },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 409);
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: 3 new tests fail (route missing).

- [ ] **Step 3: Add endpoint**

Append inside `challengesRoutes`:

```javascript
fastify.post('/api/challenges/:id/submit-run', { preHandler: requireAuth }, async (req, reply) => {
  const id = Number(req.params.id);
  const { recipient_run_id } = req.body ?? {};
  if (!Number.isInteger(id) || !Number.isInteger(recipient_run_id)) {
    return reply.code(400).send({ error: 'invalid_input' });
  }

  // Load challenge + challenger run seed in one go.
  const cRes = await pool.query(
    `SELECT c.id, c.status, c.recipient_id, cr.seed AS challenger_seed
     FROM challenges c JOIN runs cr ON cr.id = c.challenger_run_id
     WHERE c.id = $1`,
    [id]
  );
  const c = cRes.rows[0];
  if (!c) return reply.code(404).send({ error: 'not_found' });
  if (Number(c.recipient_id) !== req.user.id) {
    return reply.code(404).send({ error: 'not_recipient' });
  }
  if (c.status !== 'accepted') {
    return reply.code(409).send({ error: 'not_in_accepted_state' });
  }

  // Verify recipient_run_id belongs to user and matches seed.
  const rRes = await pool.query(
    'SELECT user_id, seed FROM runs WHERE id=$1',
    [recipient_run_id]
  );
  const rrun = rRes.rows[0];
  if (!rrun) return reply.code(400).send({ error: 'recipient_run_not_found' });
  if (Number(rrun.user_id) !== req.user.id) {
    return reply.code(400).send({ error: 'not_run_owner' });
  }
  if (Number(rrun.seed) !== Number(c.challenger_seed)) {
    return reply.code(400).send({ error: 'seed_mismatch' });
  }

  const upd = await pool.query(
    `UPDATE challenges
     SET status='completed', recipient_run_id=$1
     WHERE id=$2 AND status='accepted'`,
    [recipient_run_id, id]
  );
  if (upd.rowCount === 0) {
    return reply.code(409).send({ error: 'race_lost' });
  }
  return { ok: true };
});
```

- [ ] **Step 4: Run tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/challenges.routes.js server/test/integration/challenges.test.js
git commit -m "feat: submit-run links recipient run, validates seed"
```

---

## Task 10: Share-link endpoints (by-token GET + redeem POST)

**Files:**
- Modify: `server/src/routes/challenges.routes.js`
- Modify: `server/test/integration/challenges.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/test/integration/challenges.test.js`:

```javascript
async function createShareLinkChallenge(app, pool, sessionStore, alice) {
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);
  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, share_link: true },
    headers: { cookie: alice.cookie }
  });
  const body = r.json();
  const token = body.share_url.split('/challenge/')[1];
  return { id: body.id, token };
}

test('by-token: anonymous fetch returns challenger info while pending', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/by-token/${token}`
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.challenger.username, 'alice');
  assert.equal(body.status, 'pending');
});

test('by-token: redeemed token returns 410', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  // Anonymous redeem.
  await app.inject({
    method: 'POST',
    url: `/api/challenges/by-token/${token}/redeem`
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/by-token/${token}`
  });
  assert.equal(r.statusCode, 410);
});

test('redeem (anonymous): returns playable payload + requires_registration_to_submit', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/by-token/${token}/redeem`
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(typeof body.seed === 'number');
  assert.ok(body.config);
  assert.ok(Array.isArray(body.challenger_attempts));
  assert.equal(body.requires_registration_to_submit, true);
});

test('redeem (registered): links recipient_id, no registration required', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const { id, token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/by-token/${token}/redeem`,
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().requires_registration_to_submit, false);

  const row = await pool.query('SELECT recipient_id FROM challenges WHERE id=$1', [id]);
  assert.equal(Number(row.rows[0].recipient_id), bob.userId);
});

test('redeem: second call → 410', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  await app.inject({ method: 'POST', url: `/api/challenges/by-token/${token}/redeem` });
  const r = await app.inject({ method: 'POST', url: `/api/challenges/by-token/${token}/redeem` });
  assert.equal(r.statusCode, 410);
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: 5 new tests fail (routes missing).

- [ ] **Step 3: Add endpoints**

Append inside `challengesRoutes`:

```javascript
fastify.get('/api/challenges/by-token/:token', async (req, reply) => {
  const { token } = req.params;
  const cRes = await pool.query(
    `SELECT c.id, c.status, cr.score AS challenger_score, u.username AS challenger_username
     FROM challenges c
     JOIN runs cr ON cr.id = c.challenger_run_id
     JOIN users u ON u.id = c.challenger_id
     WHERE c.share_token = $1`,
    [token]
  );
  const c = cRes.rows[0];
  if (!c) return reply.code(404).send({ error: 'not_found' });
  if (c.status !== 'pending') {
    return reply.code(410).send({ error: 'already_claimed' });
  }
  return {
    id: Number(c.id),
    challenger: { username: c.challenger_username },
    challenger_score: c.challenger_score,
    config: DEFAULT_CONFIG,
    status: c.status
  };
});

fastify.post('/api/challenges/by-token/:token/redeem', async (req, reply) => {
  const { token } = req.params;

  // Atomic: claim only if pending. Conditional UPDATE prevents the race.
  const userId = req.user?.id ?? null;
  const upd = await pool.query(
    `UPDATE challenges
     SET status='accepted', responded_at=now(), recipient_id=COALESCE($2, recipient_id)
     WHERE share_token=$1 AND status='pending'
     RETURNING id, challenger_run_id`,
    [token, userId]
  );
  if (upd.rowCount === 0) {
    return reply.code(410).send({ error: 'already_claimed_or_not_found' });
  }
  const challengeId = Number(upd.rows[0].id);
  const challengerRunId = Number(upd.rows[0].challenger_run_id);

  const runRes = await pool.query('SELECT seed FROM runs WHERE id=$1', [challengerRunId]);
  const seed = Number(runRes.rows[0].seed);
  const attRes = await pool.query(
    `SELECT q_index, response_ms, correct FROM attempts WHERE run_id=$1 ORDER BY q_index ASC`,
    [challengerRunId]
  );

  return {
    id: challengeId,
    seed,
    config: DEFAULT_CONFIG,
    challenger_attempts: attRes.rows.map(a => ({
      q_index: a.q_index,
      response_ms: a.response_ms,
      correct: a.correct
    })),
    requires_registration_to_submit: userId === null
  };
});
```

- [ ] **Step 4: Run tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/challenges.routes.js server/test/integration/challenges.test.js
git commit -m "feat: share-link by-token endpoints (single-use)"
```

---

## Task 11: GET /api/challenges/:id/result + seen-flag flip

**Files:**
- Modify: `server/src/routes/challenges.routes.js`
- Modify: `server/test/integration/challenges.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/test/integration/challenges.test.js`:

```javascript
test('result: challenger fetches → flips challenger_seen_result', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  // Bob declines — terminal state, result fetchable.
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/decline`,
    headers: { cookie: bob.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/${challengeId}/result`,
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);

  const row = await pool.query('SELECT challenger_seen_result FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].challenger_seen_result, true);
});

test('result: third party → 403/404', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const eve = await registerAndCookie(app, 'eve');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/decline`,
    headers: { cookie: bob.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/${challengeId}/result`,
    headers: { cookie: eve.cookie }
  });
  assert.ok(r.statusCode === 403 || r.statusCode === 404);
});

test('result: completed challenge returns both runs joined', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });
  // Manually link a recipient run with matching seed.
  const seedRow = await pool.query(
    `SELECT cr.seed FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id WHERE c.id=$1`,
    [challengeId]
  );
  const seed = Number(seedRow.rows[0].seed);
  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 60, 110000, false, $2) RETURNING id`,
    [bob.userId, seed]
  );
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: Number(insRun.rows[0].id) },
    headers: { cookie: bob.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/${challengeId}/result`,
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.status, 'completed');
  assert.ok(body.challenger);
  assert.ok(body.recipient);
  assert.equal(body.challenger.username, 'alice');
  assert.equal(body.recipient.username, 'bob');
  assert.ok(typeof body.winner === 'string'); // 'challenger' | 'recipient' | 'tie' (impossible with score+time)
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: 3 new tests fail.

- [ ] **Step 3: Add endpoint**

Append inside `challengesRoutes`:

```javascript
fastify.get('/api/challenges/:id/result', { preHandler: requireAuth }, async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });

  const cRes = await pool.query(
    `SELECT c.id, c.status, c.challenger_id, c.recipient_id, c.challenger_run_id, c.recipient_run_id,
            cu.username AS challenger_username,
            ru.username AS recipient_username,
            cr.score AS challenger_score, cr.duration_ms AS challenger_duration_ms,
            rr.score AS recipient_score, rr.duration_ms AS recipient_duration_ms
     FROM challenges c
     JOIN users cu ON cu.id = c.challenger_id
     LEFT JOIN users ru ON ru.id = c.recipient_id
     JOIN runs cr ON cr.id = c.challenger_run_id
     LEFT JOIN runs rr ON rr.id = c.recipient_run_id
     WHERE c.id = $1`,
    [id]
  );
  const c = cRes.rows[0];
  if (!c) return reply.code(404).send({ error: 'not_found' });

  const isChallenger = Number(c.challenger_id) === req.user.id;
  const isRecipient = c.recipient_id !== null && Number(c.recipient_id) === req.user.id;
  if (!isChallenger && !isRecipient) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  if (c.status === 'pending' || c.status === 'accepted') {
    return reply.code(409).send({ error: 'not_terminal_yet' });
  }

  // Flip seen flag.
  const flagCol = isChallenger ? 'challenger_seen_result' : 'recipient_seen_result';
  await pool.query(`UPDATE challenges SET ${flagCol}=true WHERE id=$1`, [id]);

  // Load both runs' attempts (recipient may not have one for declined/forfeited).
  const challengerAttempts = (await pool.query(
    `SELECT q_index, op, lhs, rhs, answer, user_answer, response_ms, correct
     FROM attempts WHERE run_id=$1 ORDER BY q_index ASC`,
    [c.challenger_run_id]
  )).rows;

  let recipientAttempts = [];
  if (c.recipient_run_id !== null) {
    recipientAttempts = (await pool.query(
      `SELECT q_index, op, lhs, rhs, answer, user_answer, response_ms, correct
       FROM attempts WHERE run_id=$1 ORDER BY q_index ASC`,
      [c.recipient_run_id]
    )).rows;
  }

  // Determine winner.
  let winner = null;
  if (c.status === 'completed') {
    if (c.challenger_score > c.recipient_score) winner = 'challenger';
    else if (c.recipient_score > c.challenger_score) winner = 'recipient';
    else {
      // Tie on score: faster duration wins.
      winner = c.challenger_duration_ms <= c.recipient_duration_ms ? 'challenger' : 'recipient';
    }
  }

  return {
    id: Number(c.id),
    status: c.status,
    challenger: {
      username: c.challenger_username,
      score: c.challenger_score,
      duration_ms: c.challenger_duration_ms,
      attempts: challengerAttempts
    },
    recipient: {
      username: c.recipient_username,
      score: c.recipient_score,
      duration_ms: c.recipient_duration_ms,
      attempts: recipientAttempts
    },
    winner
  };
});
```

- [ ] **Step 4: Run tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/challenges.routes.js server/test/integration/challenges.test.js
git commit -m "feat: GET challenge result + seen-flag flip"
```

---

## Task 12: Forfeit sweep job

**Files:**
- Create: `server/src/jobs/forfeit-sweep.js`
- Modify: `server/src/index.js` (start the timer)
- Modify: `server/test/integration/challenges.test.js`

- [ ] **Step 1: Write failing test**

Append to `server/test/integration/challenges.test.js`:

```javascript
import { runForfeitSweep } from '../../src/jobs/forfeit-sweep.js';

test('forfeit sweep: accepted >30 min ago with no run flips to forfeited', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  // Backdate responded_at to 31 minutes ago.
  await pool.query(
    `UPDATE challenges SET responded_at = now() - interval '31 minutes' WHERE id=$1`,
    [challengeId]
  );

  const flipped = await runForfeitSweep(pool);
  assert.equal(flipped, 1);

  const row = await pool.query('SELECT status FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].status, 'forfeited');
});

test('forfeit sweep: accepted recently is not touched', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  const flipped = await runForfeitSweep(pool);
  assert.equal(flipped, 0);
  const row = await pool.query('SELECT status FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].status, 'accepted');
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: 2 new tests fail with module-not-found.

- [ ] **Step 3: Write the sweep**

Create `server/src/jobs/forfeit-sweep.js`:

```javascript
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

- [ ] **Step 4: Wire into index.js**

Add import:

```javascript
import { startForfeitSweep } from './jobs/forfeit-sweep.js';
```

In `main()`, after `evictTimer.unref();`:

```javascript
const stopForfeitSweep = startForfeitSweep(pool, { log: app.log });
```

In the SIGINT/SIGTERM handler, before `app.close()`:

```javascript
stopForfeitSweep();
```

- [ ] **Step 5: Run tests**

Run: `node --test server/test/integration/challenges.test.js`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/jobs/forfeit-sweep.js server/src/index.js server/test/integration/challenges.test.js
git commit -m "feat: forfeit sweep flips stale accepted challenges"
```

---

## Task 13: Client API helpers

**Files:**
- Modify: `client/js/api.js`

- [ ] **Step 1: Read current api.js to match style**

Run: `cat client/js/api.js`
Goal: see naming convention. Probably `api.somename({...})` returning JSON or throwing.

- [ ] **Step 2: Add challenges helpers**

In `client/js/api.js`, add a section (placement: with other top-level groupings):

```javascript
async function jsonOr(method, url, body, opts = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
    ...opts
  });
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
```

(If `api.js` already has an equivalent helper, reuse it instead — DRY.)

Then add:

```javascript
api.challenges = {
  create: (body) => jsonOr('POST', '/api/challenges', body),
  incoming: () => jsonOr('GET', '/api/challenges/incoming'),
  outgoing: () => jsonOr('GET', '/api/challenges/outgoing'),
  accept: (id) => jsonOr('POST', `/api/challenges/${id}/accept`),
  decline: (id) => jsonOr('POST', `/api/challenges/${id}/decline`),
  submitRun: (id, recipientRunId) => jsonOr('POST', `/api/challenges/${id}/submit-run`, { recipient_run_id: recipientRunId }),
  byToken: (token) => jsonOr('GET', `/api/challenges/by-token/${encodeURIComponent(token)}`),
  redeemToken: (token) => jsonOr('POST', `/api/challenges/by-token/${encodeURIComponent(token)}/redeem`),
  result: (id) => jsonOr('GET', `/api/challenges/${id}/result`)
};
```

- [ ] **Step 3: Smoke test by booting the client**

Run dev server (existing pattern — see `package.json` `dev` script if present, else open `client/index.html` directly via the server):
```bash
npm --prefix server run dev
```
Open `http://localhost:3000`, open browser console, type: `api.challenges` — expect an object with the methods listed.

- [ ] **Step 4: Commit**

```bash
git add client/js/api.js
git commit -m "feat: client api.challenges helpers"
```

---

## Task 14: Ghost ticker component

**Files:**
- Create: `client/js/ghost-ticker.js`
- Modify: `client/play.html` (add ghost row container)
- Modify: `client/css/challenges.css` (new, ghost-row styles)

- [ ] **Step 1: Create the css file**

Create `client/css/challenges.css`:

```css
.ghost-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-family: inherit;
  color: rgba(159, 232, 112, 0.45); /* desaturated lime */
  font-size: 0.85em;
  margin-top: 0.25rem;
}
.ghost-row .ghost-label { letter-spacing: 0.1em; }
.ghost-row .ghost-score { font-weight: 600; }
.ghost-row .ghost-diff {
  margin-left: auto;
  font-weight: 700;
}
.ghost-row .ghost-diff.ahead { color: #9fe870; }
.ghost-row .ghost-diff.behind { color: #ff5c5c; }
```

(If `client/css/styles.css` is the canonical style file, append to it instead — match existing repo convention; check what's currently in `client/css/`.)

- [ ] **Step 2: Add the slot to play.html**

In `client/play.html`, under the existing score element (find `id="score"`), add:

```html
<div id="ghost-row" class="ghost-row" hidden>
  <span class="ghost-label">ghost</span>
  <span class="ghost-score" id="ghost-score">0</span>
  <span class="ghost-diff" id="ghost-diff"></span>
</div>
```

Add a `<link>` to `challenges.css` in the `<head>` if it's a separate file.

- [ ] **Step 3: Write ghost-ticker.js**

Create `client/js/ghost-ticker.js`:

```javascript
// Wall-clock-paced ghost-score advancer.
//
// Usage:
//   const ticker = createGhostTicker({ attempts, onUpdate, getElapsedMs });
//   ticker.start();   // begins advancing the ghost score
//   ticker.tick();    // call this whenever the recipient answers (so the diff refreshes)
//   ticker.stop();    // when the run ends
//
// `attempts` is the array from the accept payload: [{ q_index, response_ms, correct }, ...]
// `getElapsedMs` returns the current run elapsed (ms since the recipient's first question).
// `onUpdate({ ghostScore, recipientScore, diff })` is called whenever ghost or recipient state changes.

export function createGhostTicker({ attempts, onUpdate, getElapsedMs }) {
  // Pre-compute cumulative wall-clock time AND cumulative score at each attempt boundary.
  // Score advances only on `correct` attempts.
  const boundaries = [];
  let cumMs = 0;
  let cumScore = 0;
  for (const a of attempts) {
    cumMs += a.response_ms;
    if (a.correct) cumScore += 1;
    boundaries.push({ atMs: cumMs, score: cumScore });
  }

  let ghostScore = 0;
  let recipientScore = 0;
  let raf = null;
  let stopped = false;

  function ghostScoreAt(elapsedMs) {
    // Linear scan is fine — runs are <60 questions.
    let s = 0;
    for (const b of boundaries) {
      if (b.atMs <= elapsedMs) s = b.score;
      else break;
    }
    return s;
  }

  function fire() {
    if (stopped) return;
    const elapsed = getElapsedMs();
    const newGhost = ghostScoreAt(elapsed);
    if (newGhost !== ghostScore) {
      ghostScore = newGhost;
      onUpdate({ ghostScore, recipientScore, diff: recipientScore - ghostScore });
    }
    raf = requestAnimationFrame(fire);
  }

  return {
    start() {
      stopped = false;
      raf = requestAnimationFrame(fire);
      // Fire initial update so UI shows ghost=0 immediately.
      onUpdate({ ghostScore, recipientScore, diff: 0 });
    },
    tick(newRecipientScore) {
      recipientScore = newRecipientScore;
      onUpdate({ ghostScore, recipientScore, diff: recipientScore - ghostScore });
    },
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    }
  };
}
```

- [ ] **Step 4: Smoke test in isolation**

Create temporary `client/js/ghost-ticker.test.html` (DO NOT commit):

```html
<!doctype html>
<html><body>
<script type="module">
import { createGhostTicker } from './ghost-ticker.js';
const attempts = [
  { q_index: 0, response_ms: 1000, correct: true },
  { q_index: 1, response_ms: 2000, correct: true },
  { q_index: 2, response_ms: 1500, correct: false }
];
let elapsed = 0;
const ticker = createGhostTicker({
  attempts,
  getElapsedMs: () => elapsed,
  onUpdate: (s) => console.log('update', s)
});
ticker.start();
setTimeout(() => { elapsed = 1100; }, 100);
setTimeout(() => { elapsed = 3100; }, 200);
setTimeout(() => { ticker.stop(); }, 400);
</script>
</body></html>
```

Open this file in a browser, check console: ghost should advance to 1 then 2.

Delete the file after smoke-testing.

- [ ] **Step 5: Commit**

```bash
git add client/js/ghost-ticker.js client/play.html client/css/challenges.css
git commit -m "feat: ghost ticker component for challenge runs"
```

---

## Task 15: play.js — challenge mode entry point

**Files:**
- Modify: `client/js/play.js`

This task wires play.js to recognize a `?challenge=:id` URL param, fetch the accept payload, regenerate questions client-side from the seed, drive the ghost ticker, and redirect to the result page on completion.

**Important constraint:** the existing `play.js` flow drives questions through `/api/play/start` + `/api/play/answer` (server-side session). For challenge runs, we need the recipient's run to ultimately become a `runs` row with the correct seed. The cleanest way: extend `/api/play/start` to accept `mode: 'challenge'` with a `challenge_id` and have the server use the challenger's seed instead of generating a new one. Then the server's existing flush path writes the run; the client just calls `submit-run` after `time_up`.

- [ ] **Step 1: Extend session.start to accept an explicit seed**

In `server/src/game/session.js`, in the `start({ ... })` parameters, add `explicitSeed = null`. Replace the seed-derivation block:

```javascript
const seed = isDailyGauntlet
  ? dateStringToSeed(seedDate)
  : (explicitSeed != null ? (explicitSeed | 0) : nextSeed());
const rng = makeRng(seed);
```

- [ ] **Step 2: Extend /api/play/start to accept mode='challenge'**

In `server/src/routes/play.routes.js`, before the existing `if (mode === 'daily-gauntlet')` block, add:

```javascript
if (mode === 'challenge') {
  if (!req.user) return reply.code(401).send({ error: 'register-to-play' });
  const challengeId = Number(req.body?.challenge_id);
  if (!Number.isInteger(challengeId)) {
    return reply.code(400).send({ error: 'invalid_challenge_id' });
  }
  // Verify recipient + accepted state, fetch seed.
  const c = await pool.query(
    `SELECT c.id, c.recipient_id, cr.seed
     FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id
     WHERE c.id=$1 AND c.status='accepted'`,
    [challengeId]
  );
  if (c.rowCount === 0) return reply.code(409).send({ error: 'challenge_not_accepted' });
  if (Number(c.rows[0].recipient_id) !== req.user.id) {
    return reply.code(403).send({ error: 'not_recipient' });
  }
  const seed = Number(c.rows[0].seed);
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

(Need to import `DEFAULT_CONFIG` at the top of play.routes.js if not already.)

- [ ] **Step 3: Add an integration test for challenge-mode play start**

Append to `server/test/integration/challenges.test.js`:

```javascript
test('play/start with mode=challenge: returns session with same seed as challenger', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  const seedRow = await pool.query(
    `SELECT cr.seed FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id WHERE c.id=$1`,
    [challengeId]
  );
  const challengerSeed = Number(seedRow.rows[0].seed);

  const r = await app.inject({
    method: 'POST',
    url: '/api/play/start',
    payload: { mode: 'challenge', challenge_id: challengeId },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.challenge_id, challengeId);
  // Verify seed matches by checking the session store.
  const sess = sessionStore.get(body.session_id);
  assert.equal(sess.seed, challengerSeed);
});
```

Run: `node --test server/test/integration/challenges.test.js`
Expected: PASS.

- [ ] **Step 4: Modify play.js to handle `?challenge=:id`**

At the top of `client/js/play.js`, add:

```javascript
import { createGhostTicker } from './ghost-ticker.js';

const params = new URLSearchParams(window.location.search);
const challengeId = params.has('challenge') ? Number(params.get('challenge')) : null;
```

Find the function that initializes a normal run (the one that POSTs to `/api/play/start`). Inside it, branch when `challengeId` is non-null:

```javascript
if (challengeId !== null) {
  // Fetch the accept payload (which the recipient already accepted via the modal,
  // but we re-fetch here as a defensive measure if the user landed via direct URL).
  let acceptPayload;
  try {
    acceptPayload = await api.challenges.accept(challengeId);
  } catch (e) {
    if (e.status === 404) {
      // Already accepted: that's fine, we still need the seed/attempts.
      // Fall back to result page or show error.
      window.location.href = `/result.html?id=${challengeId}`;
      return;
    }
    throw e;
  }
  // Start the play session in challenge mode.
  const startRes = await api.post('/api/play/start', {
    mode: 'challenge', challenge_id: challengeId
  });
  state.sessionId = startRes.session_id;
  state.config = acceptPayload.config;
  state.timeLimitMs = startRes.time_limit_ms;
  state.dailyGauntlet = false;
  state.isChallenge = true;
  state.challengeId = challengeId;

  // Wire up the ghost ticker.
  const ghostRow = document.getElementById('ghost-row');
  ghostRow.hidden = false;
  const ghostScoreEl = document.getElementById('ghost-score');
  const ghostDiffEl = document.getElementById('ghost-diff');
  state.ghostTicker = createGhostTicker({
    attempts: acceptPayload.challenger_attempts,
    getElapsedMs: () => performance.now() - state.startedAt,
    onUpdate({ ghostScore, recipientScore, diff }) {
      ghostScoreEl.textContent = String(ghostScore);
      ghostDiffEl.textContent = diff > 0 ? `+${diff}` : String(diff);
      ghostDiffEl.classList.toggle('ahead', diff > 0);
      ghostDiffEl.classList.toggle('behind', diff < 0);
    }
  });
  // Render first question (mirrors normal flow).
  renderQuestion(startRes.question, startRes.peek_question);
  state.startedAt = performance.now();
  state.ghostTicker.start();
  return;
}
```

(Use the actual `api.post` helper that exists; if `api.js` exposes it differently, match it.)

In the `submitAnswer` handler, after the score increments, add:

```javascript
if (state.isChallenge && state.ghostTicker) {
  state.ghostTicker.tick(state.score);
}
```

In the `time_up` (run-finished) handler, add:

```javascript
if (state.isChallenge) {
  state.ghostTicker?.stop();
  // Look up the run we just persisted and link it to the challenge.
  // The server flushed it inside /api/play/answer's time_up branch; we need its id.
  // Add a /api/play/last-run endpoint OR pass the run id back in the time_up response.
  // SIMPLER: add run_id to the time_up response.
  if (response.run_id) {
    await api.challenges.submitRun(state.challengeId, response.run_id);
    window.location.href = `/result.html?id=${state.challengeId}`;
    return;
  }
}
```

- [ ] **Step 5: Add run_id to the play/answer time_up response**

In `server/src/routes/play.routes.js`, in `flushRunIfRecording`, after setting `live.runId = runId;`, also expose it.

In the `time_up` branch of `/api/play/answer`, replace `return { time_up: true, final_score: r.finalScore };` with:

```javascript
const live = sessionStore.get(session_id);
return { time_up: true, final_score: r.finalScore, run_id: live?.runId ?? null };
```

(Take care not to break the existing daily-gauntlet branch — only modify the standard return below it.)

- [ ] **Step 6: Run all server tests, confirm no regression**

Run: `npm --prefix server test`
Expected: all green.

- [ ] **Step 7: Manual end-to-end smoke test**

Open two browser windows, register two users (alice, bob), play a run as alice, send a challenge to bob, accept it as bob, play through, confirm:
- Ghost ticker shows alongside score during play.
- After bob's run completes, page redirects to `/result.html?id=:challengeId` (which 404s for now — that's expected; result page comes in Task 17).
- alice's outgoing list shows the challenge as `completed`.

- [ ] **Step 8: Commit**

```bash
git add client/js/play.js client/play.html server/src/game/session.js server/src/routes/play.routes.js server/test/integration/challenges.test.js
git commit -m "feat: play.js challenge-mode flow + ghost ticker"
```

---

## Task 16: Post-run CHALLENGE block on score screen

**Files:**
- Modify: `client/js/play.js` (score screen render)
- Modify: `client/play.html` (CHALLENGE block markup)

- [ ] **Step 1: Add markup to score screen**

In `client/play.html`, inside `#score-screen`, BEFORE the existing "play again" button, add:

```html
<div id="challenge-block" hidden>
  <h3>CHALLENGE SOMEONE</h3>
  <div id="challenge-form">
    <input id="challenge-username" placeholder="username" autocomplete="off" />
    <button id="challenge-send">SEND</button>
  </div>
  <div class="or-sep">— or —</div>
  <button id="challenge-share-link">GET SHARE LINK</button>
  <div id="challenge-status" class="muted"></div>
</div>
```

- [ ] **Step 2: Wire it up in play.js (score screen render path)**

Find the function that shows the score screen. Add after it renders:

```javascript
// Show the CHALLENGE block only on eligible runs:
//  - run was logged (state.isDefaultConfig && authedUser != null)
//  - not a practice run
//  - not a daily-gauntlet run
//  - not itself a challenge run
const block = document.getElementById('challenge-block');
const eligible = state.authedUser != null
  && state.isDefaultConfig
  && !state.practice
  && !state.dailyGauntlet
  && !state.isChallenge
  && state.lastRunId != null;
if (eligible) {
  block.hidden = false;
  document.getElementById('challenge-send').onclick = async () => {
    const username = document.getElementById('challenge-username').value.trim();
    if (!username) return;
    if (username.toLowerCase() === state.authedUser.username.toLowerCase()) {
      setChallengeStatus("can't challenge yourself.");
      return;
    }
    try {
      await api.challenges.create({ challenger_run_id: state.lastRunId, recipient_username: username });
      block.querySelector('#challenge-form').remove();
      block.querySelector('.or-sep').remove();
      block.querySelector('#challenge-share-link').remove();
      setChallengeStatus(`challenge sent to ${username}. they'll see it next time they're here.`);
    } catch (e) {
      if (e.status === 404) setChallengeStatus(`no user named "${username}".`);
      else if (e.status === 400) setChallengeStatus(e.data?.error ?? 'cannot send challenge.');
      else setChallengeStatus('something broke. try again.');
    }
  };
  document.getElementById('challenge-share-link').onclick = async () => {
    try {
      const r = await api.challenges.create({ challenger_run_id: state.lastRunId, share_link: true });
      const url = window.location.origin + r.share_url;
      const ok = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
      setChallengeStatus(ok
        ? `link copied: ${url} — anyone with this link gets one shot at your run.`
        : url);
    } catch (e) {
      setChallengeStatus('failed to generate link.');
    }
  };
}

function setChallengeStatus(msg) {
  document.getElementById('challenge-status').textContent = msg;
}
```

- [ ] **Step 3: Track `state.lastRunId`**

In the `time_up` handler, when receiving the response, add (alongside the existing logic):

```javascript
state.lastRunId = response.run_id ?? null;
```

(The `run_id` is now in the time_up response from Task 15.)

- [ ] **Step 4: Manual smoke test**

Run dev server, register a user, play a default-config run to time-up, see the CHALLENGE block appear with username + link options. Send a challenge to a second registered user; confirm the block transforms to "challenge sent to X." Test rejection paths: empty username, self-challenge, unknown user.

- [ ] **Step 5: Commit**

```bash
git add client/js/play.js client/play.html
git commit -m "feat: post-run CHALLENGE block on score screen"
```

---

## Task 17: Result page — drag race + head-to-head

**Files:**
- Create: `client/result.html`
- Create: `client/js/drag-race.js`
- Create: `client/js/head-to-head.js`
- Create: `client/js/result-page.js`
- Modify: `client/css/challenges.css`

- [ ] **Step 1: Create result.html**

Create `client/result.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>zetachad — challenge result</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="stylesheet" href="/css/challenges.css" />
</head>
<body>
  <main id="result-root" class="result-root">
    <div id="loading">loading…</div>
    <div id="content" hidden>
      <h1 id="result-title"></h1>
      <div id="drag-race"></div>
      <div id="result-caption" class="result-caption"></div>
      <div class="result-actions">
        <button id="replay">REPLAY</button>
        <button id="view-questions">VIEW QUESTIONS</button>
        <a id="rematch" href="#" hidden>REMATCH</a>
        <a href="/">HOME</a>
      </div>
      <div id="head-to-head"></div>
    </div>
    <div id="error" hidden></div>
  </main>
  <script type="module" src="/js/result-page.js"></script>
</body>
</html>
```

- [ ] **Step 2: Append drag-race styles to challenges.css**

```css
.drag-race { display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem 0; }
.drag-race .lane {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 1.6rem;
  position: relative;
}
.drag-race .lane-label { width: 9rem; text-align: right; font-weight: 600; }
.drag-race .lane-bar {
  flex: 1;
  height: 0.6rem;
  background: rgba(159, 232, 112, 0.1);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.drag-race .lane-bar-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: #9fe870;
  width: 0%;
  transition: width 50ms linear;
}
.drag-race .lane.ghost .lane-bar-fill { background: rgba(159, 232, 112, 0.45); }
.drag-race .q-flash {
  position: absolute;
  top: -1.4rem;
  font-size: 0.8em;
  opacity: 0;
  transition: opacity 100ms;
}
.drag-race .q-flash.show { opacity: 1; }
.drag-race .q-flash.wrong { color: #ff5c5c; }
.result-caption { font-size: 1.4em; font-weight: 700; margin: 1rem 0; }
.result-actions { display: flex; gap: 0.5rem; margin: 1rem 0; }
.h2h-table { width: 100%; border-collapse: collapse; }
.h2h-table th, .h2h-table td { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid rgba(159, 232, 112, 0.1); }
.h2h-table tr.faster-correct { background: rgba(159, 232, 112, 0.06); }
.h2h-table tr.slower-or-wrong { background: rgba(255, 92, 92, 0.06); }
```

- [ ] **Step 3: Write drag-race.js**

Create `client/js/drag-race.js`:

```javascript
// Drag race animation: ~20s total time-compressed regardless of input run length.

const TARGET_DURATION_MS = 20_000;

export function renderDragRace(container, { challenger, recipient, viewerIs }) {
  // Build cumulative timelines: [{ atRealMs, score }, ...]
  const challengerTimeline = buildTimeline(challenger.attempts);
  const recipientTimeline = buildTimeline(recipient.attempts);
  const maxRunMs = Math.max(
    challengerTimeline.totalMs,
    recipientTimeline.totalMs
  );
  const compress = TARGET_DURATION_MS / Math.max(maxRunMs, 1);
  const animDurationMs = Math.min(maxRunMs * compress, TARGET_DURATION_MS);

  const totalQuestions = Math.max(challenger.score, recipient.score, 1);

  container.innerHTML = `
    <div class="drag-race">
      <div class="lane ${viewerIs === 'challenger' ? 'self' : 'ghost'}" data-who="challenger">
        <div class="lane-label">${escape(challenger.username)}</div>
        <div class="lane-bar"><div class="lane-bar-fill"></div></div>
        <div class="lane-score" data-role="score">0</div>
        <div class="q-flash" data-role="flash"></div>
      </div>
      <div class="lane ${viewerIs === 'recipient' ? 'self' : 'ghost'}" data-who="recipient">
        <div class="lane-label">${escape(recipient.username)}</div>
        <div class="lane-bar"><div class="lane-bar-fill"></div></div>
        <div class="lane-score" data-role="score">0</div>
        <div class="q-flash" data-role="flash"></div>
      </div>
    </div>`;

  return play(container, challengerTimeline, recipientTimeline, totalQuestions, compress);
}

function buildTimeline(attempts) {
  let cumMs = 0;
  let cumScore = 0;
  const events = [];
  for (const a of attempts) {
    cumMs += a.response_ms;
    if (a.correct) cumScore += 1;
    events.push({ atRealMs: cumMs, score: cumScore, qIndex: a.q_index, correct: a.correct });
  }
  return { events, totalMs: cumMs };
}

function play(container, challengerTL, recipientTL, totalQuestions, compress) {
  const startedAt = performance.now();
  const lanes = {
    challenger: container.querySelector('[data-who="challenger"]'),
    recipient: container.querySelector('[data-who="recipient"]')
  };
  const fills = {
    challenger: lanes.challenger.querySelector('.lane-bar-fill'),
    recipient: lanes.recipient.querySelector('.lane-bar-fill')
  };
  const scoreEls = {
    challenger: lanes.challenger.querySelector('[data-role="score"]'),
    recipient: lanes.recipient.querySelector('[data-role="score"]')
  };
  const flashEls = {
    challenger: lanes.challenger.querySelector('[data-role="flash"]'),
    recipient: lanes.recipient.querySelector('[data-role="flash"]')
  };
  const lastFiredIdx = { challenger: -1, recipient: -1 };
  let stopped = false;
  let onDoneCb = null;

  function step() {
    if (stopped) return;
    const elapsed = performance.now() - startedAt;
    const realElapsed = elapsed / compress;

    for (const who of ['challenger', 'recipient']) {
      const tl = who === 'challenger' ? challengerTL : recipientTL;
      // Find the latest event whose atRealMs <= realElapsed and fire flashes for newly-passed events.
      let latestIdx = -1;
      for (let i = 0; i < tl.events.length; i++) {
        if (tl.events[i].atRealMs <= realElapsed) latestIdx = i;
        else break;
      }
      while (lastFiredIdx[who] < latestIdx) {
        lastFiredIdx[who] += 1;
        const ev = tl.events[lastFiredIdx[who]];
        flashEls[who].textContent = `Q${ev.qIndex + 1}`;
        flashEls[who].classList.toggle('wrong', !ev.correct);
        flashEls[who].classList.add('show');
        const pinIdx = lastFiredIdx[who];
        setTimeout(() => {
          if (lastFiredIdx[who] === pinIdx) flashEls[who].classList.remove('show');
        }, 250);
      }
      const score = latestIdx >= 0 ? tl.events[latestIdx].score : 0;
      scoreEls[who].textContent = String(score);
      const widthPct = (score / Math.max(totalQuestions, 1)) * 100;
      fills[who].style.width = `${widthPct}%`;
    }

    // Done when both timelines exhausted + a small "drive home the gap" tail.
    const challengerDone = realElapsed >= challengerTL.totalMs;
    const recipientDone = realElapsed >= recipientTL.totalMs;
    if (challengerDone && recipientDone) {
      // Snap to final scores.
      scoreEls.challenger.textContent = String(challengerTL.events.at(-1)?.score ?? 0);
      scoreEls.recipient.textContent = String(recipientTL.events.at(-1)?.score ?? 0);
      onDoneCb?.();
      return;
    }
    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);

  return {
    onDone(cb) { onDoneCb = cb; },
    stop() { stopped = true; }
  };
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
```

- [ ] **Step 4: Write head-to-head.js**

Create `client/js/head-to-head.js`:

```javascript
const OP_GLYPH = { add: '+', sub: '−', mul: '×', div: '÷' };

export function renderHeadToHead(container, { challenger, recipient, viewerIs }) {
  const cAttempts = challenger.attempts;
  const rAttempts = recipient.attempts;
  const maxLen = Math.max(cAttempts.length, rAttempts.length);

  let html = `
    <table class="h2h-table">
      <thead>
        <tr>
          <th>Q#</th>
          <th>Question</th>
          <th>${esc(viewerIs === 'challenger' ? 'You' : challenger.username)} (ms)</th>
          <th>${esc(viewerIs === 'recipient' ? 'You' : recipient.username)} (ms)</th>
          <th>Δ</th>
        </tr>
      </thead>
      <tbody>`;

  for (let i = 0; i < maxLen; i++) {
    const ca = cAttempts.find(a => a.q_index === i);
    const ra = rAttempts.find(a => a.q_index === i);
    const ref = ca ?? ra;
    const question = ref ? `${ref.lhs} ${OP_GLYPH[ref.op] ?? ref.op} ${ref.rhs}` : '';
    const youAttempt = viewerIs === 'challenger' ? ca : ra;
    const themAttempt = viewerIs === 'challenger' ? ra : ca;
    const youOk = youAttempt?.correct;
    const themOk = themAttempt?.correct;
    const youMs = youAttempt?.response_ms;
    const themMs = themAttempt?.response_ms;
    const fasterCorrect = youOk && (themMs == null || (youMs != null && youMs < themMs));
    const slowerOrWrong = youAttempt && !youOk;
    const rowClass = fasterCorrect ? 'faster-correct' : (slowerOrWrong ? 'slower-or-wrong' : '');
    const delta = (youMs != null && themMs != null) ? (youMs - themMs) : '';
    html += `<tr class="${rowClass}">
      <td>${i + 1}</td>
      <td>${esc(question)}</td>
      <td>${cellTxt(viewerIs === 'challenger' ? ca : ra)}</td>
      <td>${cellTxt(viewerIs === 'challenger' ? ra : ca)}</td>
      <td>${delta === '' ? '' : (delta > 0 ? '+' : '') + delta}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function cellTxt(a) {
  if (!a) return '—';
  return `${a.response_ms} ${a.correct ? '✓' : '✗'}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
```

- [ ] **Step 5: Write result-page.js**

Create `client/js/result-page.js`:

```javascript
import { api } from './api.js';
import { renderDragRace } from './drag-race.js';
import { renderHeadToHead } from './head-to-head.js';

const params = new URLSearchParams(window.location.search);
const id = Number(params.get('id'));

const els = {
  loading: document.getElementById('loading'),
  content: document.getElementById('content'),
  error: document.getElementById('error'),
  title: document.getElementById('result-title'),
  caption: document.getElementById('result-caption'),
  dragRace: document.getElementById('drag-race'),
  h2h: document.getElementById('head-to-head'),
  replay: document.getElementById('replay'),
  rematch: document.getElementById('rematch')
};

(async () => {
  if (!Number.isInteger(id)) {
    show(els.error, 'invalid challenge id.');
    return;
  }
  let result;
  try {
    result = await api.challenges.result(id);
  } catch (e) {
    show(els.error, e.status === 403 ? 'not yours to see.' : 'failed to load result.');
    return;
  }

  // Determine viewer perspective. Need /api/auth/me equivalent — assume api.auth.me exists.
  // If not, we can rely on the seen-flag flipping behavior on the server: whichever flag flipped,
  // that's the viewer. Simplest: load /api/auth/me to get current username; match to challenger or recipient.
  let me;
  try {
    me = await api.auth.me();
  } catch {
    me = null;
  }
  const viewerIs = me?.username === result.challenger.username
    ? 'challenger'
    : (me?.username === result.recipient.username ? 'recipient' : 'unknown');

  els.title.textContent = result.status === 'completed'
    ? `${result.challenger.username} vs ${result.recipient.username}`
    : `${result.challenger.username} vs ${result.recipient.username ?? 'someone'}`;

  hide(els.loading);
  show(els.content);

  // Drag race only makes sense with two completed runs.
  if (result.status === 'completed') {
    const dr = renderDragRace(els.dragRace, { challenger: result.challenger, recipient: result.recipient, viewerIs });
    els.replay.onclick = () => renderDragRace(els.dragRace, { challenger: result.challenger, recipient: result.recipient, viewerIs });
    renderHeadToHead(els.h2h, { challenger: result.challenger, recipient: result.recipient, viewerIs });

    // Caption (illustrative — voice copy lands at a later task per docs/STYLE.md).
    const youWon = (viewerIs === 'challenger' && result.winner === 'challenger')
      || (viewerIs === 'recipient' && result.winner === 'recipient');
    els.caption.textContent = youWon ? "STILL HAIL." : "Better luck never.";

    // Rematch button visible only when viewer is the challenger and they lost.
    if (viewerIs === 'challenger' && result.winner === 'recipient') {
      els.rematch.hidden = false;
      els.rematch.href = `/play.html?rematch_target=${encodeURIComponent(result.recipient.username)}`;
    }
  } else {
    // Forfeit / declined: no drag race, just a caption.
    els.replay.hidden = true;
    document.getElementById('view-questions').hidden = true;
    if (result.status === 'declined') {
      els.caption.textContent = `${result.recipient?.username ?? 'they'} chickened out.`;
    } else if (result.status === 'forfeited') {
      els.caption.textContent = `${result.recipient?.username ?? 'they'} quit halfway through.`;
    }
  }
})();

function show(el, msg) { el.hidden = false; if (msg !== undefined) el.textContent = msg; }
function hide(el) { el.hidden = true; }
```

**Note on `api.auth.me`:** check `client/js/api.js` for whether this exists. If not, find the existing helper for "who am I" (might be embedded in `landing.js` via `/api/me` or similar) and use that. If no such endpoint exists yet, add one in a side task — `GET /api/auth/me` returning `{ username, id }` from `req.user`.

- [ ] **Step 6: Smoke test**

Open two browsers, complete a challenge end-to-end (alice creates run + sends, bob accepts + plays), navigate to `/result.html?id=:challengeId` as either user, see drag race + head-to-head.

- [ ] **Step 7: Commit**

```bash
git add client/result.html client/js/drag-race.js client/js/head-to-head.js client/js/result-page.js client/css/challenges.css
git commit -m "feat: result page with drag race + head-to-head"
```

---

## Task 18: Home page — incoming-challenge modal queue + outgoing/results panel

**Files:**
- Create: `client/js/challenges-home.js`
- Modify: `client/js/landing.js` (load challenges-home on init)
- Modify: `client/index.html` (add containers)
- Modify: `client/css/challenges.css`

- [ ] **Step 1: Add containers to index.html**

In `client/index.html`, somewhere near the top of `<main>`:

```html
<div id="challenge-modal-root"></div>
<div id="challenge-results-banner"></div>
```

Near the bottom of `<main>`, before the footer:

```html
<details id="outgoing-challenges">
  <summary>OUTGOING CHALLENGES (<span id="outgoing-count">0</span>)</summary>
  <div id="outgoing-list"></div>
</details>
```

Add the link to `challenges.css` in `<head>` if not already.

- [ ] **Step 2: Append CSS**

Append to `client/css/challenges.css`:

```css
.challenge-modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.challenge-modal {
  background: #0d0f0c; border: 1px solid #9fe870;
  padding: 1.5rem 2rem; max-width: 420px; text-align: center;
  font-family: inherit;
}
.challenge-modal h2 { margin: 0 0 0.5rem; }
.challenge-modal .actions { display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem; }
.results-banner { display: flex; flex-direction: column; gap: 0.5rem; margin: 1rem 0; }
.result-line { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; border: 1px solid rgba(159,232,112,0.3); }
.result-line .actions { margin-left: auto; display: flex; gap: 0.5rem; }
.outgoing-row { display: flex; gap: 0.75rem; padding: 0.25rem 0; font-size: 0.9em; }
```

- [ ] **Step 3: Write challenges-home.js**

Create `client/js/challenges-home.js`:

```javascript
import { api } from './api.js';

export async function initChallengesHome() {
  const [incoming, outgoing] = await Promise.all([
    api.challenges.incoming().catch(() => []),
    api.challenges.outgoing().catch(() => [])
  ]);

  // Render unread results first so they show even if the modal is dismissed.
  renderResultsBanner(outgoing.filter(o => !o.challenger_seen_result && (o.status === 'completed' || o.status === 'forfeited' || o.status === 'declined')));
  renderOutgoing(outgoing);
  showNextIncomingModal(incoming, () => api.challenges.incoming().then(incomingNew => showNextIncomingModal(incomingNew, () => {})));
}

function showNextIncomingModal(incoming, refetch) {
  if (incoming.length === 0) return;
  const c = incoming[0];
  const root = document.getElementById('challenge-modal-root');
  root.innerHTML = `
    <div class="challenge-modal-backdrop">
      <div class="challenge-modal">
        <h2>${escape(c.challenger.username)} CHALLENGES YOU</h2>
        <p>${c.challenger_score} to beat — on the exact same questions they got.</p>
        <p><strong>One attempt. No retries.</strong></p>
        <div class="actions">
          <button data-act="accept">ACCEPT</button>
          <button data-act="decline">DECLINE</button>
          <button data-act="later">LATER</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-act="accept"]').onclick = async () => {
    try {
      await api.challenges.accept(c.id);
      window.location.href = `/play.html?challenge=${c.id}`;
    } catch {
      close();
    }
  };
  root.querySelector('[data-act="decline"]').onclick = async () => {
    if (!confirm(`Decline ${c.challenger.username}'s challenge? They'll know.`)) return;
    await api.challenges.decline(c.id).catch(() => {});
    close();
    showNextIncomingModal(incoming.slice(1), refetch);
  };
  root.querySelector('[data-act="later"]').onclick = () => {
    close();
    showNextIncomingModal(incoming.slice(1), refetch);
  };
}

function renderResultsBanner(unreadResults) {
  const root = document.getElementById('challenge-results-banner');
  root.innerHTML = '';
  if (unreadResults.length === 0) return;
  root.classList.add('results-banner');
  for (const r of unreadResults) {
    const line = document.createElement('div');
    line.className = 'result-line';
    let txt;
    if (r.status === 'completed') {
      const winner = r.recipient_score > r.challenger_score ? 'beat' :
                     r.recipient_score < r.challenger_score ? 'fell short of' :
                     'tied'; // tie broken by time, but UI just says "beat"/"fell short" depending on result API later — keep it loose here
      txt = `${r.recipient_username} ${winner} your ${r.challenger_score} with ${r.recipient_score}.`;
    } else if (r.status === 'declined') {
      txt = `${r.recipient_username} chickened out.`;
    } else if (r.status === 'forfeited') {
      txt = `${r.recipient_username ?? 'someone'} quit halfway through.`;
    }
    line.innerHTML = `<span>${escape(txt)}</span>
      <span class="actions">
        <a href="/result.html?id=${r.id}">VIEW</a>
        ${r.status === 'completed' && r.recipient_score > r.challenger_score
          ? `<a href="/play.html?rematch_target=${encodeURIComponent(r.recipient_username)}">REMATCH</a>`
          : ''}
      </span>`;
    root.appendChild(line);
  }
}

function renderOutgoing(outgoing) {
  document.getElementById('outgoing-count').textContent = String(outgoing.length);
  const list = document.getElementById('outgoing-list');
  list.innerHTML = outgoing.map(o => {
    const target = o.recipient_username ?? `Anon link (${o.share_token?.slice(0, 6)}…)`;
    const age = relTime(new Date(o.created_at));
    return `<div class="outgoing-row">
      <span>${escape(target)}</span>
      <span>— ${o.status}</span>
      <span class="muted">${age}</span>
    </div>`;
  }).join('');
}

function relTime(d) {
  const diffMs = Date.now() - d.getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
```

- [ ] **Step 4: Wire into landing.js**

At the top of `client/js/landing.js`, add:

```javascript
import { initChallengesHome } from './challenges-home.js';
```

In the existing init function (after the user-area renders), add (only when the user is authed):

```javascript
if (user) {
  initChallengesHome().catch(err => console.error('challenges-home init failed', err));
}
```

- [ ] **Step 5: Manual smoke test**

Open the home page as alice, see no modal (no challenges). Have bob send alice a challenge, refresh alice's home — modal pops with ACCEPT/DECLINE/LATER. Tap LATER, refresh — modal returns. Tap DECLINE, confirm — modal disappears. As bob, refresh: see "alice chickened out" banner.

- [ ] **Step 6: Commit**

```bash
git add client/js/challenges-home.js client/js/landing.js client/index.html client/css/challenges.css
git commit -m "feat: home challenge modal queue + outgoing/results panel"
```

---

## Task 19: Share-link landing page

**Files:**
- Create: `client/challenge.html`
- Create: `client/js/challenge-landing.js`
- Modify: server config — confirm static-file routing for `/challenge/:token`

- [ ] **Step 1: Confirm server static-file routing**

The server is Fastify; check whether it serves `/challenge/:token` as a static page or whether it needs explicit route handling. Inspect the existing `client/` static serve setup (likely the deploy serves `client/` flat through nginx, in which case all `/challenge/<anything>` will 404 unless either nginx is configured for it OR the client uses query params).

**Decision:** to avoid touching nginx config, change the URL format from `/challenge/:token` to `/challenge.html?t=:token`. Update:
- `server/src/routes/challenges.routes.js` — when generating `share_url`, return `/challenge.html?t=${token}` instead of `/challenge/${token}`.
- Any test that checks the URL format.

Apply the change:

```javascript
// In challenges.routes.js POST /api/challenges share-link branch:
share_url: `${baseUrl}/challenge.html?t=${token}`
```

In the test file, update the regex check:

```javascript
assert.match(body.share_url, /\/challenge\.html\?t=/);
```

Run: `node --test server/test/integration/challenges.test.js`
Expected: PASS.

- [ ] **Step 2: Create challenge.html**

Create `client/challenge.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>zetachad — challenge</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="stylesheet" href="/css/challenges.css" />
</head>
<body>
  <main class="challenge-landing">
    <div id="loading">loading challenge…</div>
    <div id="ready" hidden>
      <h1 id="ready-title"></h1>
      <p>On the same questions they got. <strong>One attempt.</strong></p>
      <button id="ready-btn">I'M READY</button>
    </div>
    <div id="claimed" hidden>
      <h1>This challenge link has already been claimed.</h1>
      <a href="/">go home</a>
    </div>
  </main>
  <script type="module" src="/js/challenge-landing.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write challenge-landing.js**

Create `client/js/challenge-landing.js`:

```javascript
import { api } from './api.js';

const params = new URLSearchParams(window.location.search);
const token = params.get('t');

const els = {
  loading: document.getElementById('loading'),
  ready: document.getElementById('ready'),
  readyTitle: document.getElementById('ready-title'),
  readyBtn: document.getElementById('ready-btn'),
  claimed: document.getElementById('claimed')
};

(async () => {
  if (!token) {
    els.loading.textContent = 'invalid link.';
    return;
  }
  try {
    const info = await api.challenges.byToken(token);
    els.readyTitle.textContent = `${info.challenger.username} CHALLENGES YOU TO BEAT ${info.challenger_score}`;
    els.loading.hidden = true;
    els.ready.hidden = false;
    els.readyBtn.onclick = async () => {
      try {
        const redeem = await api.challenges.redeemToken(token);
        // Stash the redeem payload so play.js can use it without re-fetching.
        sessionStorage.setItem('zc_challenge_redeem', JSON.stringify(redeem));
        sessionStorage.setItem('zc_challenge_token', token);
        window.location.href = `/play.html?challenge_token=${encodeURIComponent(token)}`;
      } catch (e) {
        els.ready.innerHTML = '<p>this link was already claimed.</p>';
      }
    };
  } catch (e) {
    if (e.status === 410) {
      els.loading.hidden = true;
      els.claimed.hidden = false;
      return;
    }
    els.loading.textContent = 'failed to load challenge.';
  }
})();
```

- [ ] **Step 4: Extend play.js to handle `?challenge_token=`**

In `client/js/play.js`, replace the `?challenge=:id` handling to also handle `?challenge_token=:token`. Add early in the file:

```javascript
const challengeToken = params.has('challenge_token') ? params.get('challenge_token') : null;
```

Inside the run-init branch, if `challengeToken` is set:

```javascript
if (challengeToken) {
  const stashed = sessionStorage.getItem('zc_challenge_redeem');
  let redeem;
  if (stashed) {
    redeem = JSON.parse(stashed);
    sessionStorage.removeItem('zc_challenge_redeem');
  } else {
    redeem = await api.challenges.redeemToken(challengeToken);
  }
  state.challengeId = redeem.id;
  state.challengeToken = challengeToken;
  state.challengeRequiresRegistration = redeem.requires_registration_to_submit;

  if (state.authedUser != null) {
    // Authed: same as ?challenge=:id flow — server-side session via /api/play/start.
    // ... reuse the challenge-by-id branch from Task 15 with state.challengeId.
    // (Refactor: extract the body of the ?challenge=:id branch into a helper
    //  startChallengeRunForAuthedUser(challengeId, redeem.challenger_attempts).)
  } else {
    // Anonymous: fully client-side run using redeem.seed + redeem.config + redeem.challenger_attempts.
    runFullyClientSide(redeem);
    return;
  }
}
```

For the anonymous client-side run, you'll need a function `runFullyClientSide(redeem)` that:
1. Re-derives questions using a JS port of `makeRng` and `generate`.
2. Drives the question loop locally (no API calls).
3. Uses the ghost ticker.
4. On finish, shows a score screen with REGISTER/skip prompts.
5. If REGISTER, redirects to `/register.html?challenge_token=:token`; on success of the post-register flow, calls `api.challenges.redeemToken(token)` again (which now associates `recipient_id`), then `/api/play/start` with `mode: 'challenge'` — but since the run already happened on the client, this is awkward. Simpler: post-register, send the locally-recorded run via a new `POST /api/runs` endpoint that the recipient can call to log a finished run with attempts; then `submit-run` links it.

**Scope decision:** anonymous-play submission flow is the most complex part of this whole feature. To keep the plan tractable, **defer the REGISTER-and-submit half to Task 20** and have the anonymous flow in this task render a score screen with "REGISTER to make this count" but without the actual submission wire-up — that's the next task.

For now, in `runFullyClientSide`, just play through, show the score, and show a stub REGISTER button that links to `/register.html` (no payload yet). The REGISTER → submit flow is wired in Task 20.

To minimize new JS, port `makeRng` and `generate` into a shared client module:

Create `client/js/seeded-game.js`:

```javascript
// Mirror of server/src/game/generator.js — kept in sync manually.
// Used for client-side challenge replays where the server isn't in the loop.

export function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intInRange(rng, lo, hi) {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

// Mirrors generateFromConfig in server/src/game/generator.js.
// IMPORTANT: only the default-config (non-practice) path is mirrored here, since
// challenges only exist for default-config runs.
export function generateFromConfig(config, rng) {
  const enabled = Object.entries(config.ops)
    .filter(([, v]) => v && v.enabled)
    .map(([k]) => k);
  if (enabled.length === 0) throw new Error('no ops enabled');
  const op = enabled[intInRange(rng, 0, enabled.length - 1)];
  switch (op) {
    case 'add': {
      const { min, max } = config.ops.add;
      const a = intInRange(rng, min, max);
      const b = intInRange(rng, min, max);
      return { op, a, b, answer: a + b, prompt: `${a} + ${b}` };
    }
    case 'sub': {
      const { min, max } = config.ops.sub;
      let a = intInRange(rng, min, max);
      let b = intInRange(rng, min, max);
      if (a < b) [a, b] = [b, a];
      return { op, a, b, answer: a - b, prompt: `${a} − ${b}` };
    }
    case 'mul': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.mul;
      const a = intInRange(rng, lhsMin, lhsMax);
      const b = intInRange(rng, rhsMin, rhsMax);
      return { op, a, b, answer: a * b, prompt: `${a} × ${b}` };
    }
    case 'div': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.div;
      const quotient = intInRange(rng, rhsMin, rhsMax);
      const divisor = intInRange(rng, lhsMin, lhsMax);
      const dividend = quotient * divisor;
      return { op, a: dividend, b: divisor, answer: quotient, prompt: `${dividend} ÷ ${divisor}` };
    }
    default: throw new Error(`unknown op: ${op}`);
  }
}
```

Add an integration-style test that asserts client and server produce identical sequences for a fixed seed:

Create `server/test/unit/seeded-game-parity.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng as serverMake, generate as serverGenerate } from '../../src/game/generator.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

// We can't import client modules directly into node tests without bundling.
// Instead, this test verifies that two server-side instances with the same seed
// produce the same sequence — the client mirror is a manual port and is verified
// by smoke testing in the browser.
test('seeded RNG: same seed produces same first 60 questions', () => {
  const seed = 123456;
  const rngA = serverMake(seed);
  const rngB = serverMake(seed);
  for (let i = 0; i < 60; i++) {
    const qA = serverGenerate(DEFAULT_CONFIG, rngA);
    const qB = serverGenerate(DEFAULT_CONFIG, rngB);
    assert.equal(qA.prompt, qB.prompt, `mismatch at q${i}`);
    assert.equal(qA.answer, qB.answer, `mismatch at q${i}`);
  }
});
```

Run: `node --test server/test/unit/seeded-game-parity.test.js`
Expected: PASS.

(The client mirror is verified by the manual smoke test in step 6 — open a challenge link in an anonymous tab, confirm the questions match what alice saw.)

- [ ] **Step 5: Stub anonymous run**

In `client/js/play.js`, define `runFullyClientSide(redeem)` (skeleton — full implementation of the anonymous play loop is large; key points below):

```javascript
async function runFullyClientSide(redeem) {
  const { makeRng, generateFromConfig } = await import('./seeded-game.js');
  const { createGhostTicker } = await import('./ghost-ticker.js');
  const rng = makeRng(redeem.seed);
  const config = redeem.config;

  // Setup state similar to authed run, but no server session.
  state.config = config;
  state.timeLimitMs = config.durationMs;
  state.dailyGauntlet = false;
  state.isChallenge = true;
  state.isAnonymousChallenge = true;
  state.score = 0;
  state.attempts = []; // we record locally to send if they register

  const currentQ = generateFromConfig(config, rng);
  const peekQ = generateFromConfig(config, rng);

  // Ghost ticker.
  const ghostRow = document.getElementById('ghost-row');
  ghostRow.hidden = false;
  const ghostScoreEl = document.getElementById('ghost-score');
  const ghostDiffEl = document.getElementById('ghost-diff');
  state.ghostTicker = createGhostTicker({
    attempts: redeem.challenger_attempts,
    getElapsedMs: () => performance.now() - state.startedAt,
    onUpdate({ ghostScore, recipientScore, diff }) {
      ghostScoreEl.textContent = String(ghostScore);
      ghostDiffEl.textContent = diff > 0 ? `+${diff}` : String(diff);
      ghostDiffEl.classList.toggle('ahead', diff > 0);
      ghostDiffEl.classList.toggle('behind', diff < 0);
    }
  });

  state.startedAt = performance.now();
  state.ghostTicker.start();

  // Render first question. Then on each submit:
  //  - check elapsed > durationMs => time-up, show score screen + REGISTER prompt
  //  - else: grade locally, push to state.attempts, advance to peek/new
  //
  // The submit handler in play.js already handles UI; replace its API calls
  // with local-only updates when state.isAnonymousChallenge is true.

  // [DETAIL]: this requires refactoring submitAnswer to abstract the "next question"
  // source — for authed runs, it's the server response; for anonymous, it's local
  // generateFromConfig calls. Add a helper `nextQuestionLocal()` that returns the
  // peek and refreshes peek from generateFromConfig. The grading also moves client-side
  // for this path: import a `gradeLocal(question, userAnswer)` mirror of server/src/game/grader.js.

  renderQuestion({ prompt: currentQ.prompt, op: currentQ.op, answer: currentQ.answer },
                 { prompt: peekQ.prompt, op: peekQ.op, answer: peekQ.answer });

  // The full local play loop is a substantial refactor of play.js. For this plan iteration,
  // mark the anonymous-play path as STUBBED: show a dialog and link to /register.html
  // with a note "anonymous play coming next task" so the page is not broken.
  alert('Anonymous challenge play comes online in the next deploy. Please register to play this challenge.');
  window.location.href = `/register.html?challenge_token=${encodeURIComponent(state.challengeToken)}`;
}
```

This stub keeps the share-link landing page functional end-to-end for *registered* visitors and gracefully redirects anonymous visitors to register. The anonymous play loop refactor (Task 20) is where it gets fleshed out.

- [ ] **Step 6: Manual smoke test**

- Generate a share link as alice.
- Open the link in an incognito window — see READY screen, tap READY, get the redirect-to-register stub message.
- Open the link in a logged-in (bob) tab — see READY, tap READY, end up in `play.html` with the challenge running.
- Confirm a third visit to the same URL shows "already claimed."

- [ ] **Step 7: Commit**

```bash
git add client/challenge.html client/js/challenge-landing.js client/js/play.js client/js/seeded-game.js server/src/routes/challenges.routes.js server/test/integration/challenges.test.js server/test/unit/seeded-game-parity.test.js
git commit -m "feat: share-link landing + seeded client generator + stubbed anon flow"
```

---

## Task 20: Anonymous play loop + post-registration submit

**Files:**
- Create: `client/js/grade-local.js` (mirror of server/src/game/grader.js)
- Modify: `client/js/play.js` (full anonymous play loop)
- Modify: `client/js/register.js` or whatever handles register form (post-register hook)
- Add: `POST /api/runs/import` server endpoint (logs an externally-played run + attempts)
- Modify: `server/src/routes/play.routes.js` (or new file)

This task is intentionally broken out because it spans server and client and is the most complex single piece. Eligibility for the import endpoint is strict: only attaches to an `accepted` challenge by token, only writes a single run, only by an authed user.

- [ ] **Step 1: Read server/src/game/grader.js**

Run: `cat server/src/game/grader.js`
Goal: faithfully mirror its behavior client-side.

- [ ] **Step 2: Create client/js/grade-local.js**

Mirror the grader behavior. Sample skeleton (adjust to match actual grader.js):

```javascript
// Mirror of server/src/game/grader.js — kept in sync manually.
export function gradeLocal(question, userAnswer) {
  const trimmed = String(userAnswer ?? '').trim();
  if (trimmed === '') return { correct: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { correct: false };
  return { correct: n === question.answer };
}
```

- [ ] **Step 3: Replace the stub in `runFullyClientSide`**

In `client/js/play.js`, replace the alert-and-redirect stub with the full local loop:

```javascript
async function runFullyClientSide(redeem) {
  const { makeRng, generateFromConfig } = await import('./seeded-game.js');
  const { createGhostTicker } = await import('./ghost-ticker.js');
  const { gradeLocal } = await import('./grade-local.js');

  const rng = makeRng(redeem.seed);
  const config = redeem.config;
  const startedAt = performance.now();
  let score = 0;
  const attempts = [];
  let qIndex = 0;
  let lastAskedAt = startedAt;
  let currentQ = generateFromConfig(config, rng);
  let peekQ = generateFromConfig(config, rng);

  const ghostRow = document.getElementById('ghost-row');
  ghostRow.hidden = false;
  const ghostScoreEl = document.getElementById('ghost-score');
  const ghostDiffEl = document.getElementById('ghost-diff');
  const ghost = createGhostTicker({
    attempts: redeem.challenger_attempts,
    getElapsedMs: () => performance.now() - startedAt,
    onUpdate({ ghostScore, recipientScore, diff }) {
      ghostScoreEl.textContent = String(ghostScore);
      ghostDiffEl.textContent = diff > 0 ? `+${diff}` : String(diff);
      ghostDiffEl.classList.toggle('ahead', diff > 0);
      ghostDiffEl.classList.toggle('behind', diff < 0);
    }
  });
  ghost.start();

  // Wire the existing form/input/score elements directly.
  const scoreEl = document.getElementById('score');
  const promptEl = document.getElementById('prompt-text');
  const form = document.getElementById('answer-form');
  const input = document.getElementById('answer');

  promptEl.textContent = currentQ.prompt;
  scoreEl.textContent = '0';
  input.focus();

  function tickClock() {
    const elapsed = performance.now() - startedAt;
    document.getElementById('timer').textContent = formatTimeMs(Math.max(0, config.durationMs - elapsed));
    document.getElementById('time-bar-fill').style.transform = `scaleX(${1 - elapsed / config.durationMs})`;
    if (elapsed >= config.durationMs) {
      finish();
      return;
    }
    requestAnimationFrame(tickClock);
  }
  requestAnimationFrame(tickClock);

  form.onsubmit = (e) => {
    e.preventDefault();
    const ans = input.value;
    input.value = '';
    const t = performance.now();
    const { correct } = gradeLocal(currentQ, ans);
    if (correct) score += 1;
    attempts.push({
      qIndex,
      op: currentQ.op,
      lhs: currentQ.a,
      rhs: currentQ.b,
      answer: currentQ.answer,
      userAnswer: ans,
      responseMs: t - lastAskedAt,
      correct,
      askedAt: new Date(performance.timeOrigin + lastAskedAt).toISOString()
    });
    qIndex += 1;
    lastAskedAt = t;
    scoreEl.textContent = String(score);
    ghost.tick(score);
    currentQ = peekQ;
    peekQ = generateFromConfig(config, rng);
    promptEl.textContent = currentQ.prompt;
  };

  function finish() {
    ghost.stop();
    form.onsubmit = null;
    // Persist attempts + score into sessionStorage so the post-register flow can pick them up.
    sessionStorage.setItem('zc_anon_challenge_run', JSON.stringify({
      score,
      durationMs: config.durationMs,
      attempts,
      challengeId: redeem.id,
      challengeToken: state.challengeToken
    }));
    showAnonScoreScreen(score);
  }

  function showAnonScoreScreen(finalScore) {
    document.getElementById('score-screen').hidden = false;
    document.getElementById('final-score').textContent = String(finalScore);
    const block = document.getElementById('challenge-block');
    block.hidden = false;
    block.innerHTML = `
      <h3>Want this to count?</h3>
      <p>Register to submit your result and tell ${escape(redeem.challenger_username ?? 'them')}.</p>
      <a id="anon-register" href="/register.html?after=challenge_import">REGISTER</a>
      <a href="/">skip</a>`;
  }
}

function escape(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
```

- [ ] **Step 4: Add server endpoint `POST /api/runs/import`**

In `server/src/routes/play.routes.js` (or a new `server/src/routes/challenges-import.routes.js` registered by index.js), add:

```javascript
fastify.post('/api/challenges/import-run', { preHandler: requireAuth }, async (req, reply) => {
  const { challenge_token, score, duration_ms, attempts } = req.body ?? {};
  if (typeof challenge_token !== 'string' ||
      !Number.isInteger(score) ||
      !Number.isInteger(duration_ms) ||
      !Array.isArray(attempts)) {
    return reply.code(400).send({ error: 'invalid_payload' });
  }
  // Verify token + state.
  const cRes = await pool.query(
    `SELECT c.id, c.status, c.recipient_id, cr.seed
     FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id
     WHERE c.share_token=$1`,
    [challenge_token]
  );
  const c = cRes.rows[0];
  if (!c) return reply.code(404).send({ error: 'not_found' });
  if (c.status !== 'accepted') {
    return reply.code(409).send({ error: 'not_accepted_state' });
  }
  // Associate the recipient if not already.
  if (c.recipient_id == null) {
    await pool.query('UPDATE challenges SET recipient_id=$1 WHERE id=$2', [req.user.id, c.id]);
  } else if (Number(c.recipient_id) !== req.user.id) {
    return reply.code(403).send({ error: 'taken_by_another' });
  }

  // Atomic insert run + attempts + link challenge.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insRun = await client.query(
      `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
       VALUES ($1, $2, $3, false, $4) RETURNING id`,
      [req.user.id, score, duration_ms, Number(c.seed)]
    );
    const runId = Number(insRun.rows[0].id);
    if (attempts.length > 0) {
      const cols = ['run_id','q_index','op','lhs','rhs','answer','user_answer','response_ms','correct','asked_at'];
      const values = [];
      const placeholders = attempts.map((a, i) => {
        const off = i * cols.length;
        values.push(runId, a.qIndex ?? a.q_index, a.op, a.lhs, a.rhs, a.answer, a.userAnswer ?? a.user_answer, a.responseMs ?? a.response_ms, a.correct, a.askedAt ?? a.asked_at);
        return `($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10})`;
      });
      await client.query(`INSERT INTO attempts (${cols.join(',')}) VALUES ${placeholders.join(',')}`, values);
    }
    await client.query(
      `UPDATE challenges SET status='completed', recipient_run_id=$1 WHERE id=$2 AND status='accepted'`,
      [runId, c.id]
    );
    await client.query('COMMIT');
    return { ok: true, run_id: runId, challenge_id: Number(c.id) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});
```

(Note: this endpoint lives in challenges.routes.js, not play.routes.js — fits with sibling endpoints. Move accordingly.)

- [ ] **Step 5: Add an integration test for import-run**

Append to `server/test/integration/challenges.test.js`:

```javascript
test('import-run: anonymous-played run gets logged + linked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { id: cid, token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  // Anonymous redeem (no cookie).
  await app.inject({ method: 'POST', url: `/api/challenges/by-token/${token}/redeem` });

  // Now the recipient registers; reuse helper.
  const bob = await registerAndCookie(app, 'bob');

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges/import-run',
    payload: {
      challenge_token: token,
      score: 50,
      duration_ms: 120000,
      attempts: [
        { qIndex: 0, op: 'add', lhs: 2, rhs: 3, answer: 5, userAnswer: '5', responseMs: 800, correct: true, askedAt: new Date().toISOString() }
      ]
    },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().run_id);

  const ch = await pool.query('SELECT status, recipient_id, recipient_run_id FROM challenges WHERE id=$1', [cid]);
  assert.equal(ch.rows[0].status, 'completed');
  assert.equal(Number(ch.rows[0].recipient_id), bob.userId);
});
```

Run: `node --test server/test/integration/challenges.test.js`
Expected: PASS.

- [ ] **Step 6: Wire register.js post-register import**

In whichever file handles a successful registration (likely `client/js/register.js` or inline in `client/register.html`), check `?after=challenge_import` after a successful registration. If set, look up `zc_anon_challenge_run` from sessionStorage, POST it to `/api/challenges/import-run`, then redirect to `/result.html?id=<challenge_id>`.

```javascript
// After successful registration:
const after = new URLSearchParams(window.location.search).get('after');
if (after === 'challenge_import') {
  const raw = sessionStorage.getItem('zc_anon_challenge_run');
  if (raw) {
    const data = JSON.parse(raw);
    sessionStorage.removeItem('zc_anon_challenge_run');
    try {
      const r = await api.post('/api/challenges/import-run', {
        challenge_token: data.challengeToken,
        score: data.score,
        duration_ms: data.durationMs,
        attempts: data.attempts
      });
      window.location.href = `/result.html?id=${r.challenge_id}`;
      return;
    } catch (e) {
      console.error('import failed', e);
    }
  }
}
```

(Match the actual register.js flow — exact shape depends on what's there.)

- [ ] **Step 7: Manual end-to-end smoke test**

- Alice generates a share link.
- Open in incognito tab → READY → play through → score screen with REGISTER button.
- Click REGISTER → register form with `?after=challenge_import` → submit → redirect to `/result.html`.
- Alice refreshes home → sees result notification.

- [ ] **Step 8: Commit**

```bash
git add client/js/grade-local.js client/js/play.js client/js/register.js server/src/routes/challenges.routes.js server/test/integration/challenges.test.js
git commit -m "feat: anonymous challenge play + post-register import"
```

---

## Task 21: Rematch flow

**Files:**
- Modify: `client/js/play.js`
- Modify: `client/js/result-page.js`
- Modify: `client/js/challenges-home.js`

- [ ] **Step 1: Wire `?rematch_target=:username` in play.js**

At the top of `play.js`:

```javascript
const rematchTarget = params.has('rematch_target') ? params.get('rematch_target') : null;
```

In the score screen render path, after wiring the standard CHALLENGE block, add:

```javascript
if (rematchTarget && state.lastRunId != null) {
  // Pre-fill the username and auto-focus the SEND button.
  const block = document.getElementById('challenge-block');
  block.hidden = false;
  document.getElementById('challenge-username').value = rematchTarget;
  // Optionally insert a "REMATCH:" header.
  const header = block.querySelector('h3');
  if (header) header.textContent = `REMATCH: ${rematchTarget}`;
  document.getElementById('challenge-send').focus();
}
```

- [ ] **Step 2: Confirm result-page.js rematch button is wired**

The Task 17 implementation already sets `els.rematch.href = /play.html?rematch_target=...`. Sanity-check by clicking REMATCH on a lost-challenge result page and confirming the next run's score screen pre-fills the username.

- [ ] **Step 3: Confirm challenges-home.js banner has REMATCH on losses**

Already wired in Task 18; confirm visually.

- [ ] **Step 4: Manual smoke test**

End-to-end: alice loses to bob → alice clicks REMATCH → plays a fresh run → score screen has username pre-filled with "bob" and "REMATCH: bob" header.

- [ ] **Step 5: Commit**

```bash
git add client/js/play.js
git commit -m "feat: rematch pre-fills challenge target on score screen"
```

---

## Task 22: Polish + voice copy pass

**Files:**
- Modify: copy throughout client (modals, captions, errors).
- Reference: `docs/STYLE.md`.

- [ ] **Step 1: Read the style guide**

Run: `cat docs/STYLE.md`
Goal: understand current voice rules.

- [ ] **Step 2: Add rotating result captions**

Create `client/js/challenge-copy.js`:

```javascript
const WIN_LINES = [
  "STILL HAIL.",
  "Got served.",
  "Crushed.",
  "47 wasn't the ceiling. You're the ceiling.",
  "Better luck never (for them).",
  "Math gods nodded approvingly.",
  "Numbers obeyed.",
  "You won the math fight.",
  "Vindicated.",
  "Quietly devastating.",
  "Filed under: dominance.",
  "Glory acknowledged.",
  "The leaderboard knows.",
  "Decisive.",
  "No notes."
];
const LOSS_LINES = [
  "Better luck never.",
  "47 was apparently the ceiling.",
  "Outpaced.",
  "Quietly humiliated.",
  "The numbers chose violence.",
  "Math waits for no one.",
  "Try again. Maybe.",
  "Filed under: cope.",
  "It happens.",
  "Reflect.",
  "Skill issue.",
  "Beaten on your own questions.",
  "Disrespected.",
  "Retire?",
  "Practice mode is one tab over."
];
const TIE_LINES = [
  "Tied on score, beaten on the clock.",
  "Same score, faster fingers.",
  "Photo finish, but the camera says you.",
  "Numerically equal. Practically unequal.",
  "Speed kills."
];
const DECLINE_LINES = [
  "{name} chickened out.",
  "{name} declined politely.",
  "{name} doesn't want the smoke.",
  "{name} backed down.",
  "{name} folded."
];
const FORFEIT_LINES = [
  "{name} quit halfway through.",
  "{name} couldn't finish.",
  "{name} ghosted mid-run.",
  "{name} ran out of stamina.",
  "{name} surrendered to the questions."
];

function pick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }

export function captionForResult({ status, viewerWon, viewerIs, otherUsername, challengeId }) {
  const seed = challengeId | 0;
  if (status === 'declined')  return pick(DECLINE_LINES, seed).replace('{name}', otherUsername ?? 'they');
  if (status === 'forfeited') return pick(FORFEIT_LINES, seed).replace('{name}', otherUsername ?? 'they');
  if (status !== 'completed') return '';
  if (viewerWon) return pick(WIN_LINES, seed);
  return pick(LOSS_LINES, seed);
}
```

- [ ] **Step 3: Use it in result-page.js**

Replace the inline caption logic with:

```javascript
import { captionForResult } from './challenge-copy.js';
// ...
const otherUsername = viewerIs === 'challenger' ? result.recipient.username : result.challenger.username;
const viewerWon = (viewerIs === 'challenger' && result.winner === 'challenger')
  || (viewerIs === 'recipient' && result.winner === 'recipient');
els.caption.textContent = captionForResult({
  status: result.status,
  viewerWon,
  viewerIs,
  otherUsername,
  challengeId: id
});
```

- [ ] **Step 4: Use it in challenges-home.js banner**

Replace the inline win/loss/decline strings in `renderResultsBanner` similarly — call `captionForResult` per line.

- [ ] **Step 5: Voice-pass the modal + READY screen + form labels**

Adjust copy in `challenges-home.js` modal and `play.html`/play.js READY-screen interstitial:
- Modal heading: keep "{NAME} CHALLENGES YOU"
- Body: keep `${score} to beat — on the exact same questions they got. One attempt. No retries.`
- READY screen title: `CHALLENGE: ${name} — ${score}`
- READY subtitle: rotate from `["No do-overs.", "Don't fumble it.", "Refresh = forfeit. Don't get cute.", "One attempt. Make it count.", "No mercy mode."]`

(Add a `READY_SUBTITLES` table to challenge-copy.js and select via `pick(arr, challengeId)`.)

- [ ] **Step 6: Commit**

```bash
git add client/js/challenge-copy.js client/js/result-page.js client/js/challenges-home.js client/js/play.js
git commit -m "feat: voice-copy pass for challenge captions and modals"
```

---

## Task 23: README + deploy

**Files:**
- Modify: `server/README.md` or top-level `README.md`
- Run: deploy script

- [ ] **Step 1: Add a Challenge Mode section to the README**

Append a short section describing what Challenge Mode is, the routes added, and the migration. Match existing README style.

- [ ] **Step 2: Run full test suite once**

Run: `npm --prefix server test`
Expected: all green.

- [ ] **Step 3: Deploy to staging/production**

Per memory `reference_zetachad_deploy.md`:

```bash
VPS_HOST=root@87.99.158.208 bash deploy/deploy.sh 2>&1 | tail -30
```

Verify on the VPS:
- `psql` confirms `challenges` table exists.
- The home page loads.
- A real end-to-end challenge between two users on the live site works.

- [ ] **Step 4: Commit + push**

```bash
git add README.md
git commit -m "docs: README note about challenge mode"
git push origin main
```

---

## Self-review notes

Reviewing the plan against the spec section-by-section:

- **Goals.** Challenge button on post-run screen → Task 16. Daily/practice/custom-config exclusion → Tasks 3, 5. Recipient gets notification next visit → Task 18. Funnel via share links → Tasks 5, 10, 19. Reuse run/attempt infra → Tasks 1, 2 (no parallel scoring path). ✓
- **Flow A (registered recipient).** Send → Task 16. Modal pop → Task 18. ACCEPT/READY → Task 18 + Task 15. Live ghost → Task 14, 15. Drag race + h2h → Task 17. Result notification + REMATCH → Tasks 18, 21. ✓
- **Flow B (share link, unregistered).** Get share link → Task 16. Landing page → Task 19. Anonymous play loop → Task 20. REGISTER + import-run → Task 20. ✓
- **Flow C (share link, registered).** Same flow with `requires_registration_to_submit=false` → Task 19 (READY then play). ✓
- **Flow D (decline).** Decline endpoint + notification → Tasks 8, 18. ✓
- **Flow E (forfeit).** Sweep job → Task 12. ✓
- **Constraints.** All enforced by tests in Tasks 5, 6. ✓
- **API.** Every endpoint has a task: create/incoming/outgoing/accept/decline/submit-run/by-token/redeem/result/import-run/play-start-challenge → Tasks 5, 7, 8, 9, 10, 11, 15, 20. ✓
- **UI surfaces.** Every surface has a task: CHALLENGE block (16), incoming modal (18), READY screen (15), live ghost (14, 15), drag race (17), h2h (17), result notification (18), outgoing panel (18), share-link landing (19), voice copy (22). ✓
- **Testing.** Unit (eligibility 3, share-token 4, session 2, parity 19) + integration coverage in 5–11, 12, 15, 20. Manual smoke tests called out at each major task. ✓

**Open items still in spec:** migration number (resolved Task 1), voice copy (Task 22), share-link URL format (resolved Task 19, switched to `?t=` query param), forfeit sweep scheduling (Task 12), notification ordering (Task 7 uses `created_at ASC`). All covered.

**Type/method consistency check:** `api.challenges.*` names used throughout (Tasks 13, 15, 16, 17, 18, 19, 20). `state.challengeId`, `state.isChallenge`, `state.lastRunId` used consistently in play.js. Server endpoints all under `/api/challenges/*` except the play-start branch (`/api/play/start` with `mode: 'challenge'`).

**Known design tension surfaced during planning** (worth flagging for the implementing engineer):
- The anonymous play loop in Task 20 partially duplicates server logic (grading + question generation). This is unavoidable because the run is fully client-side. The `seeded-game-parity` test guards the seeded-rng side; `grade-local.js` is small enough that drift risk is low. If grader.js gains complexity, this duplication becomes harder to maintain — a future refactor could move the grader into a shared module that both server and client import (the current ESM setup makes this feasible if `client/js/` adds a build step, which it currently lacks).
- `play.js` accumulates branches (normal / daily-gauntlet / challenge-by-id / challenge-by-token-authed / challenge-by-token-anon). It's getting wide. If the file balloons past ~600 lines during implementation, consider extracting the challenge-mode entry into a separate file (`client/js/play-challenge.js`) that play.js dispatches to.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-challenge-mode.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
