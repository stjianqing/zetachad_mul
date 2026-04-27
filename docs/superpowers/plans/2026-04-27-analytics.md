# Analytics Database & Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-question attempt data for logged-in default-config runs and expose an admin-only dashboard at `/admin/` mirroring the zetachad single-player history page.

**Architecture:** Per-question attempts are staged in the in-memory session record during gameplay. On the time-up branch of `/api/play/answer`, a single transaction inserts one `runs` row + N `attempts` rows. `/api/leaderboard/submit` becomes a flag flip on the existing run. A new `/admin/api/*` surface returns aggregated SQL for the dashboard, gated by nginx Basic Auth (with a Fastify defense-in-depth check).

**Tech Stack:** Fastify 5 + Postgres + Node 22 (server), vanilla browser ESM (client/admin), `node:test` + `assert/strict` (tests), nginx (TLS + Basic Auth).

**Spec:** `docs/superpowers/specs/2026-04-27-analytics-design.md` (commit `689a6aa` on main).

---

## File Structure

**Server — new files:**
- `server/migrations/004_attempts.sql` — attempts table + indexes
- `server/migrations/005_runs_leaderboard_flag.sql` — flag column + backfill + index
- `server/src/routes/admin.routes.js` — admin API endpoints
- `server/src/admin-auth.js` — `requireAdmin` preHandler
- `server/test/unit/attempts-staging.test.js` — staging-logic unit tests
- `server/test/integration/admin.test.js` — admin endpoint integration tests

**Server — modified files:**
- `server/src/game/session.js` — stage attempts; expose `takeRunRecord`
- `server/src/routes/play.routes.js` — flush attempts on time-up; accept `pool`
- `server/src/routes/board.routes.js` — submit becomes flag flip
- `server/src/index.js` — pass `pool` to play routes; register admin routes
- `server/test/integration/helper.js` — truncate new tables
- `server/test/unit/session.test.js` — add staging tests
- `server/test/integration/play.test.js` — add time-up flush tests

**Client/admin — all new:**
- `client/admin/index.html`
- `client/admin/css/admin.css`
- `client/admin/js/admin-api.js`
- `client/admin/js/admin.js`
- `client/admin/js/heatmap.js`
- `client/admin/js/chart.js`

**Deploy — modified:**
- `deploy/nginx-zetachad.conf` (add admin location blocks)
- `deploy/deploy.sh` (rsync admin client)
- `docs/deploy-runbook.md` (admin htpasswd bootstrap section)

---

## Important conventions (read before starting)

- **Generator output uses `a`/`b`, schema uses `lhs`/`rhs`.** When staging an attempt from a question object, the mapping is `lhs = question.a, rhs = question.b`. (See `server/src/game/generator.js`: every op returns `{ op, a, b, answer, prompt }`.)
- **Tests use `node:test` and `assert/strict`.** No frameworks. Pattern in `server/test/unit/session.test.js` and `server/test/integration/play.test.js` is the source of truth — match it exactly.
- **Integration tests skip when `TEST_DATABASE_URL` is unset** via `skipIfNoDb(t)`. Always include this guard at the top of each integration test.
- **Wire protocol is snake_case; server internals are camelCase.** Admin endpoints follow the wire convention (snake_case in JSON output).
- **No client test framework.** All admin client behavior is verified by smoke checklist + by being driven by deterministic admin endpoints.
- **Run tests from `server/` directory:** `cd server && node --test test/unit/` or `node --test test/integration/`.

---

## Task 1: Add `attempts` migration

**Files:**
- Create: `server/migrations/004_attempts.sql`

- [ ] **Step 1: Write the migration**

Create `server/migrations/004_attempts.sql`:

```sql
CREATE TABLE attempts (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  q_index       INTEGER NOT NULL,
  op            TEXT NOT NULL,
  lhs           INTEGER NOT NULL,
  rhs           INTEGER NOT NULL,
  answer        INTEGER NOT NULL,
  user_answer   TEXT,
  response_ms   INTEGER NOT NULL,
  correct       BOOLEAN NOT NULL,
  asked_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX attempts_run_id_idx ON attempts(run_id);
CREATE INDEX attempts_op_idx     ON attempts(op);
```

- [ ] **Step 2: Apply migration locally to verify SQL parses**

Run (from `server/`): `npm run migrate`

Expected output line: `migrated: 004_attempts.sql`

- [ ] **Step 3: Verify the table exists**

Run: `psql $DATABASE_URL -c "\d attempts"`

Expected: table prints with all 11 columns and both indexes listed.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/004_attempts.sql
git commit -m "feat(db): add attempts table for per-question analytics"
```

---

## Task 2: Add `submitted_to_leaderboard` flag migration

**Files:**
- Create: `server/migrations/005_runs_leaderboard_flag.sql`

- [ ] **Step 1: Write the migration**

Create `server/migrations/005_runs_leaderboard_flag.sql`:

```sql
ALTER TABLE runs ADD COLUMN submitted_to_leaderboard BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every existing row in runs was inserted at submit time
-- (pre-migration code only created runs rows on /api/leaderboard/submit),
-- so they are all submitted-eligible.
UPDATE runs SET submitted_to_leaderboard = true;

CREATE INDEX runs_played_at_idx ON runs(played_at DESC);
```

- [ ] **Step 2: Apply migration**

Run (from `server/`): `npm run migrate`

Expected output line: `migrated: 005_runs_leaderboard_flag.sql`

- [ ] **Step 3: Verify backfill**

Run: `psql $DATABASE_URL -c "SELECT count(*) AS total, count(*) FILTER (WHERE submitted_to_leaderboard) AS submitted FROM runs"`

Expected: `total = submitted` (i.e., every existing row got the flag set true).

- [ ] **Step 4: Commit**

```bash
git add server/migrations/005_runs_leaderboard_flag.sql
git commit -m "feat(db): add submitted_to_leaderboard flag, backfill existing runs"
```

---

## Task 3: Update test helper to truncate new tables

**Files:**
- Modify: `server/test/integration/helper.js:22`

- [ ] **Step 1: Edit `helper.js`**

Change the TRUNCATE statement on line 22 from:
```js
await pool.query('TRUNCATE runs, auth_sessions, users RESTART IDENTITY CASCADE');
```
to:
```js
await pool.query('TRUNCATE attempts, runs, auth_sessions, users RESTART IDENTITY CASCADE');
```

(`attempts` is listed first because, although `CASCADE` would handle the FK, listing it explicitly makes the intent clear and the order forward-compatible if CASCADE is ever removed.)

- [ ] **Step 2: Run existing integration tests to confirm nothing breaks**

Run (from `server/`): `node --test test/integration/play.test.js`

Expected: all existing tests still pass (they don't yet exercise `attempts`, but the truncate now sees the new table).

- [ ] **Step 3: Commit**

```bash
git add server/test/integration/helper.js
git commit -m "test: truncate attempts in fresh-db setup"
```

---

## Task 4: Stage attempts in session store (logged-in default-config only)

**Files:**
- Modify: `server/src/game/session.js`
- Modify: `server/test/unit/session.test.js`

- [ ] **Step 1: Add three failing unit tests**

Append to `server/test/unit/session.test.js`:

```js
test('attempts not staged for guest sessions', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: null, config: DEFAULT_CONFIG });
  store.answer(sessionId, '0');
  const s = store.get(sessionId);
  assert.equal(s.attempts.length, 0);
});

test('attempts not staged for custom-config sessions', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 60_000;
  const { sessionId } = store.start({ userId: 7, config: cfg });
  store.answer(sessionId, '0');
  const s = store.get(sessionId);
  assert.equal(s.attempts.length, 0);
});

test('attempts staged for logged-in default-config sessions with correct fields', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const q1 = store.get(sessionId).currentQuestion;
  clock.advance(1500);
  store.answer(sessionId, String(q1.answer));
  const s = store.get(sessionId);
  assert.equal(s.attempts.length, 1);
  const a = s.attempts[0];
  assert.equal(a.qIndex, 0);
  assert.equal(a.op, q1.op);
  assert.equal(a.lhs, q1.a);
  assert.equal(a.rhs, q1.b);
  assert.equal(a.answer, q1.answer);
  assert.equal(a.userAnswer, String(q1.answer));
  assert.equal(a.responseMs, 1500);
  assert.equal(a.correct, true);
  assert.ok(a.askedAt instanceof Date);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `node --test test/unit/session.test.js`

Expected: 3 failures with messages like `Expected values to be strictly equal: 0 !== undefined` (because `s.attempts` is `undefined`).

- [ ] **Step 3: Modify `session.js` to stage attempts**

Edit `server/src/game/session.js`. At the top, add an import for `isDefaultConfig` (already imported). Then make these changes:

**3a.** Inside the `start({ userId, config })` method, in the `session` object literal that gets returned, add three fields. Replace this block:

```js
const session = {
  id: sessionId,
  userId: userId ?? null,
  config,
  startedAt,
  lastTouchedAt: startedAt,
  durationMs: config.durationMs,
  score: 0,
  currentQuestion: null,
  peekQuestion: null,
  rng,
  finalized: false
};
```

with:

```js
const session = {
  id: sessionId,
  userId: userId ?? null,
  config,
  startedAt,
  lastTouchedAt: startedAt,
  durationMs: config.durationMs,
  score: 0,
  currentQuestion: null,
  peekQuestion: null,
  rng,
  finalized: false,
  attempts: [],
  lastQuestionAskedAt: startedAt,
  runId: null
};
```

**3b.** Below the existing `publicQuestion` helper (around line 26), add this helper:

```js
function recordsAttempts(session) {
  return session.userId != null && isDefaultConfig(session.config);
}
```

**3c.** Inside the `answer(sessionId, userAnswer)` method, locate this block:

```js
const { correct } = grade(session.currentQuestion, userAnswer);
if (correct) session.score += 1;
// Advance: the previous peek becomes the new current; generate a fresh peek.
session.currentQuestion = session.peekQuestion;
session.peekQuestion = newQuestion(session);
```

Replace with:

```js
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
// Advance: the previous peek becomes the new current; generate a fresh peek.
session.currentQuestion = session.peekQuestion;
session.peekQuestion = newQuestion(session);
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `server/`): `node --test test/unit/session.test.js`

Expected: all tests in the file pass (existing 16 + new 3 = 19 passing).

- [ ] **Step 5: Commit**

```bash
git add server/src/game/session.js server/test/unit/session.test.js
git commit -m "feat(server): stage per-question attempts for logged-in default runs"
```

---

## Task 5: Add `takeRunRecord` to session store

**Files:**
- Modify: `server/src/game/session.js`
- Modify: `server/test/unit/session.test.js`

- [ ] **Step 1: Add a failing unit test**

Append to `server/test/unit/session.test.js`:

```js
test('takeRunRecord returns staged data and clears attempts', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  clock.advance(1500);
  store.answer(sessionId, String(store.get(sessionId).currentQuestion.answer));

  const rec = store.takeRunRecord(sessionId);
  assert.equal(rec.userId, 7);
  assert.equal(rec.score, 1);
  assert.equal(rec.attempts.length, 1);
  assert.equal(typeof rec.durationMs, 'number');

  // Subsequent call returns empty attempts
  assert.equal(store.takeRunRecord(sessionId).attempts.length, 0);
});

test('takeRunRecord returns null for unknown session', () => {
  const store = createSessionStore({ rngSeed: 1 });
  assert.equal(store.takeRunRecord('nope'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `node --test test/unit/session.test.js`

Expected: 2 failures with `TypeError: store.takeRunRecord is not a function`.

- [ ] **Step 3: Add `takeRunRecord` method to the returned object**

In `server/src/game/session.js`, locate the `return { ... }` block at the bottom of `createSessionStore`. Add this method (place it between `finish` and `get`):

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
    attempts
  };
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `server/`): `node --test test/unit/session.test.js`

Expected: 21 tests passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/game/session.js server/test/unit/session.test.js
git commit -m "feat(server): add takeRunRecord to session store"
```

---

## Task 6: Persist run + attempts on time-up in play routes

**Files:**
- Modify: `server/src/routes/play.routes.js`
- Modify: `server/src/index.js`
- Modify: `server/test/integration/play.test.js`

- [ ] **Step 1: Add failing integration tests**

Append to `server/test/integration/play.test.js`:

```js
test('time-up on logged-in default-config run inserts runs + attempts in one transaction', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg }, headers: { cookie } });
  const { session_id } = start.json();

  // Answer a few questions quickly so we have attempts to flush.
  for (let i = 0; i < 3; i++) {
    const cur = sessionStore.get(session_id).currentQuestion;
    await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  }

  await new Promise(r => setTimeout(r, 80));

  const tu = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });
  assert.equal(tu.statusCode, 200);
  assert.equal(tu.json().time_up, true);

  const runs = await pool.query('SELECT id, user_id, score FROM runs');
  assert.equal(runs.rows.length, 1);
  const attempts = await pool.query('SELECT run_id, q_index, op FROM attempts ORDER BY q_index');
  assert.equal(attempts.rows.length, 3);
  assert.equal(Number(attempts.rows[0].run_id), Number(runs.rows[0].id));
});

test('time-up on guest run writes nothing', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg } });
  const { session_id } = start.json();
  await new Promise(r => setTimeout(r, 80));
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' } });

  const runs = await pool.query('SELECT count(*)::int AS n FROM runs');
  const attempts = await pool.query('SELECT count(*)::int AS n FROM attempts');
  assert.equal(runs.rows[0].n, 0);
  assert.equal(attempts.rows[0].n, 0);
});

test('time-up on custom-config logged-in run writes nothing', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  cfg.ops.add.max = 50;  // makes the config non-default
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg }, headers: { cookie } });
  const { session_id } = start.json();
  await new Promise(r => setTimeout(r, 80));
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

  const runs = await pool.query('SELECT count(*)::int AS n FROM runs');
  const attempts = await pool.query('SELECT count(*)::int AS n FROM attempts');
  assert.equal(runs.rows[0].n, 0);
  assert.equal(attempts.rows[0].n, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `node --test test/integration/play.test.js`

Expected: 3 new failures (the existing tests still pass). Failures will say "expected 1 row, got 0" or similar — `runs` and `attempts` aren't being written yet.

- [ ] **Step 3: Update `play.routes.js` to flush at time-up**

Replace the entire contents of `server/src/routes/play.routes.js` with:

```js
export default async function playRoutes(fastify, { sessionStore, pool }) {
  const answerLimit = {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => `play-answer:${req.body?.session_id ?? req.ip}`
  };

  fastify.post('/api/play/start', async (req, reply) => {
    const config = req.body?.config;
    if (!config || typeof config !== 'object') {
      return reply.code(400).send({ error: 'invalid_config' });
    }
    const r = sessionStore.start({ userId: req.user?.id ?? null, config });
    return {
      session_id: r.sessionId,
      question: {
        prompt: r.question.prompt,
        op: r.question.op,
        answer: r.question.answer
      },
      peek_question: {
        prompt: r.peekQuestion.prompt,
        op: r.peekQuestion.op,
        answer: r.peekQuestion.answer
      },
      time_limit_ms: r.timeLimitMs
    };
  });

  fastify.post('/api/play/answer', { config: { rateLimit: answerLimit } }, async (req, reply) => {
    const { session_id, answer } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });
    const r = sessionStore.answer(session_id, typeof answer === 'string' ? answer : '');
    if (r === null) return reply.code(404).send({ error: 'unknown_session' });
    if (r.timeUp) {
      await flushRunIfRecording(req, session_id);
      return { time_up: true, final_score: r.finalScore };
    }
    return {
      correct: r.correct,
      next_question: {
        prompt: r.nextQuestion.prompt,
        op: r.nextQuestion.op,
        answer: r.nextQuestion.answer
      },
      peek_question: {
        prompt: r.peekQuestion.prompt,
        op: r.peekQuestion.op,
        answer: r.peekQuestion.answer
      },
      score: r.score,
      time_remaining_ms: r.timeRemainingMs
    };
  });

  async function flushRunIfRecording(req, sessionId) {
    const rec = sessionStore.takeRunRecord(sessionId);
    if (!rec || rec.userId == null || rec.attempts.length === 0) return;

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const insRun = await client.query(
        'INSERT INTO runs (user_id, score, duration_ms) VALUES ($1, $2, $3) RETURNING id',
        [rec.userId, rec.score, rec.durationMs]
      );
      const runId = Number(insRun.rows[0].id);
      // Bulk insert attempts. Build the VALUES clause with placeholders.
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

      // Stamp runId on the live in-memory session so submit can find it.
      const live = sessionStore.get(sessionId);
      if (live) live.runId = runId;
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      req.log.error({ err }, 'analytics: failed to persist run + attempts');
    } finally {
      if (client) client.release();
    }
  }
}
```

- [ ] **Step 4: Update `index.js` to pass `pool` to play routes**

Edit `server/src/index.js`. Find the line:

```js
await app.register(playRoutes, { sessionStore });
```

Change to:

```js
await app.register(playRoutes, { sessionStore, pool });
```

- [ ] **Step 5: Run integration tests to verify they pass**

Run (from `server/`): `node --test test/integration/play.test.js`

Expected: all play tests pass (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/play.routes.js server/src/index.js server/test/integration/play.test.js
git commit -m "feat(server): persist run + attempts on time-up for logged-in default runs"
```

---

## Task 7: Submit becomes flag flip; leaderboard filters by flag

**Files:**
- Modify: `server/src/routes/board.routes.js`
- Modify: `server/test/integration/play.test.js`

- [ ] **Step 1: Add a failing integration test**

Append to `server/test/integration/play.test.js`:

```js
test('submit flips submitted_to_leaderboard; unsubmitted runs do not appear on leaderboard', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();

  const cur = sessionStore.get(session_id).currentQuestion;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  // Force time-up by rewinding startedAt so the next answer triggers the flush.
  const sess = sessionStore.get(session_id);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

  // Before submit: run exists with flag=false, leaderboard is empty.
  const before = await pool.query('SELECT submitted_to_leaderboard FROM runs');
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].submitted_to_leaderboard, false);
  const lbBefore = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  assert.equal(lbBefore.json().entries.length, 0);

  // Submit flips the flag.
  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id }, headers: { cookie } });
  assert.equal(sub.statusCode, 200);
  assert.equal(sub.json().rank, 1);
  const after = await pool.query('SELECT submitted_to_leaderboard FROM runs');
  assert.equal(after.rows[0].submitted_to_leaderboard, true);
  const lbAfter = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  assert.equal(lbAfter.json().entries.length, 1);
  assert.equal(lbAfter.json().entries[0].username, 'alice');
});
```

**Note:** The original plan used `cfg.durationMs = 50` + `setTimeout(80)` to trigger time-up. This was found to be incorrect during implementation: setting `durationMs = 50` makes `isDefaultConfig(cfg)` return false, so `recordsAttempts` returns false, no attempts are staged, no time-up flush runs, `session.runId` stays null, and submit returns 409 instead of 200. The committed test uses a `DEFAULT_CONFIG` session and rewinds `session.startedAt` to force time-up without altering the config.

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `node --test test/integration/play.test.js`

Expected: the test fails because `board.routes.js` still does an INSERT (not an UPDATE of `submitted_to_leaderboard`), so `before.rows[0].submitted_to_leaderboard` will be false but `sub.statusCode` will not be 200 — submit will return 409 since `session.runId` is null (the old submit path tries to insert a new run, not flip the flag on the one written by the time-up flush). The point is: the new submit flow doesn't exist yet.

- [ ] **Step 3: Replace `board.routes.js` contents**

Replace the entire contents of `server/src/routes/board.routes.js` with:

```js
import { requireAuth } from '../auth.js';

export default async function boardRoutes(fastify, { pool, sessionStore }) {
  fastify.post('/api/leaderboard/submit', { preHandler: requireAuth }, async (req, reply) => {
    const { session_id } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });

    const session = sessionStore.get(session_id);
    if (!session) return reply.code(404).send({ error: 'unknown_session' });

    if (session.userId !== req.user.id) {
      return reply.code(403).send({ error: 'session_owner_mismatch' });
    }

    const finished = sessionStore.finish(session_id);
    if (!finished.qualifies) {
      return reply.code(422).send({ error: 'not_eligible', qualifies: false });
    }

    // Idempotency: a session can be submitted only once.
    if (session.submitted) {
      return { ok: true, rank: session.lastRank, idempotent: true };
    }

    if (session.runId == null) {
      // Time-up flush failed (DB error logged at that point) — caller should retry.
      return reply.code(409).send({ error: 'not_finalized' });
    }

    await pool.query(
      'UPDATE runs SET submitted_to_leaderboard = true WHERE id = $1',
      [session.runId]
    );

    // Compute rank: number of users whose best submitted score is strictly greater, plus 1.
    const { rows } = await pool.query(
      `WITH best AS (
         SELECT user_id, MAX(score) AS s
         FROM runs
         WHERE submitted_to_leaderboard = true
         GROUP BY user_id
       )
       SELECT COUNT(*) + 1 AS rank
       FROM best
       WHERE s > (
         SELECT MAX(score) FROM runs
         WHERE user_id = $1 AND submitted_to_leaderboard = true
       )`,
      [req.user.id]
    );
    const rank = Number(rows[0].rank);

    session.submitted = true;
    session.lastRank = rank;

    return { ok: true, rank, run_id: session.runId };
  });

  fastify.get('/api/leaderboard', async () => {
    const { rows } = await pool.query(
      `SELECT u.username, b.score, b.played_at
       FROM (
         SELECT DISTINCT ON (user_id) user_id, score, played_at
         FROM runs
         WHERE submitted_to_leaderboard = true
         ORDER BY user_id, score DESC, played_at ASC
       ) b
       JOIN users u ON u.id = b.user_id
       ORDER BY b.score DESC, b.played_at ASC`
    );
    return {
      entries: rows.map((r, i) => ({
        rank: i + 1,
        username: r.username,
        score: r.score,
        played_at: r.played_at.toISOString()
      }))
    };
  });
}
```

- [ ] **Step 4: Run integration tests**

Run (from `server/`): `node --test test/integration/play.test.js`

Expected: all tests pass, including the new submit-flag test.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/board.routes.js server/test/integration/play.test.js
git commit -m "feat(server): submit flips leaderboard flag instead of inserting runs"
```

---

## Task 8: Add `requireAdmin` preHandler

**Files:**
- Create: `server/src/admin-auth.js`

- [ ] **Step 1: Write `admin-auth.js`**

Create `server/src/admin-auth.js`:

```js
// Defense-in-depth check for /admin/api/* routes.
// Primary auth is nginx Basic Auth at the edge. This handler refuses requests
// that lack any Authorization: Basic header — meaning the request bypassed
// nginx (e.g., direct hit to the Node port from inside the VPS).
// We do NOT validate the password here; nginx already did.
// Must be async: Fastify v5's hook runner only advances on a returned Promise
// or invoked done callback. A sync no-done preHandler hangs every authenticated
// request — see commit edee926 for the same bug class fixed in requireAuth.
export async function requireAdmin(req, reply) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string' || !h.toLowerCase().startsWith('basic ')) {
    reply.code(401).send({ error: 'admin_auth_required' });
    return reply;
  }
}
```

**Note:** The original plan defined `requireAdmin` as a sync function. This was found to be incorrect during implementation: under Fastify v5, a sync preHandler that returns `undefined` on the success path causes the request to hang forever (the hook runner waits for a Promise or `done` callback that never arrives). The 401 path "works" only because `reply.send()` sets `reply.sent = true`, short-circuiting subsequent hook iterations. The same bug class was previously fixed for `requireAuth` in commit `edee926`. The committed `requireAdmin` is `async`.

- [ ] **Step 2: Commit**

(No test yet — this is exercised in Task 9.)

```bash
git add server/src/admin-auth.js
git commit -m "feat(server): add requireAdmin preHandler for /admin/api routes"
```

---

## Task 9: Admin route — `GET /admin/api/players`

**Files:**
- Create: `server/src/routes/admin.routes.js`
- Modify: `server/src/index.js`
- Create: `server/test/integration/admin.test.js`

- [ ] **Step 1: Write the failing integration test**

Create `server/test/integration/admin.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const BASIC_HEADER = 'Basic ' + Buffer.from('stjianqing:irrelevant').toString('base64');

async function registerAndCookie(app, username) {
  const r = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password: 'password123' } });
  return cookieFromResponse(r);
}

async function playOneShortRun(app, sessionStore, cookie) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg }, headers: { cookie } });
  const { session_id } = start.json();
  const cur = sessionStore.get(session_id).currentQuestion;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  await new Promise(r => setTimeout(r, 80));
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });
  return session_id;
}

test('GET /admin/api/players returns 401 without Basic header', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const r = await app.inject({ method: 'GET', url: '/admin/api/players' });
  assert.equal(r.statusCode, 401);
});

test('GET /admin/api/players returns aggregated player stats', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/players', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.players.length, 1);
  const p = body.players[0];
  assert.equal(p.username, 'alice');
  assert.equal(p.run_count, 1);
  assert.equal(typeof p.best_score, 'number');
  assert.equal(typeof p.last_played_at, 'string');
  assert.equal(typeof p.total_attempts, 'number');
  assert.ok(p.total_attempts >= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: failure with `404` (route not registered yet).

- [ ] **Step 3: Create `admin.routes.js` with the players endpoint**

Create `server/src/routes/admin.routes.js`:

```js
import { requireAdmin } from '../admin-auth.js';

export default async function adminRoutes(fastify, { pool }) {
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/admin/api/players', async () => {
    const { rows } = await pool.query(
      `SELECT
         u.id::int                             AS user_id,
         u.username                            AS username,
         COUNT(r.id)::int                      AS run_count,
         COALESCE(MAX(r.score), 0)::int        AS best_score,
         MAX(r.played_at)                      AS last_played_at,
         COALESCE(SUM(a.cnt), 0)::int          AS total_attempts
       FROM users u
       JOIN runs r ON r.user_id = u.id
       LEFT JOIN (
         SELECT run_id, COUNT(*)::int AS cnt FROM attempts GROUP BY run_id
       ) a ON a.run_id = r.id
       GROUP BY u.id, u.username
       ORDER BY run_count DESC, u.username ASC`
    );
    return {
      players: rows.map(r => ({
        user_id: r.user_id,
        username: r.username,
        run_count: r.run_count,
        best_score: r.best_score,
        last_played_at: r.last_played_at ? r.last_played_at.toISOString() : null,
        total_attempts: r.total_attempts
      }))
    };
  });
}
```

- [ ] **Step 4: Register admin routes in `index.js`**

Edit `server/src/index.js`:

**4a.** Add the import near the other route imports:

```js
import adminRoutes from './routes/admin.routes.js';
```

**4b.** Add the registration call inside `buildApp`, after the existing route registrations:

```js
await app.register(adminRoutes, { pool });
```

- [ ] **Step 5: Run admin tests to verify they pass**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/admin.routes.js server/src/index.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/players"
```

---

## Task 10: Admin route — `GET /admin/api/runs`

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Modify: `server/test/integration/admin.test.js`

- [ ] **Step 1: Add failing tests**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/runs without user_id returns all runs with aggregates', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/runs', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.total, 1);
  const run = body.runs[0];
  assert.equal(run.username, 'alice');
  assert.equal(typeof run.run_id, 'number');
  assert.equal(typeof run.score, 'number');
  assert.equal(typeof run.duration_ms, 'number');
  assert.equal(typeof run.played_at, 'string');
  assert.equal(typeof run.submitted_to_leaderboard, 'boolean');
  assert.equal(typeof run.attempts_count, 'number');
  assert.equal(typeof run.accuracy_pct, 'number');
  assert.equal(typeof run.mean_response_ms, 'number');
});

test('GET /admin/api/runs?user_id filters to a single user', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const aliceCookie = await registerAndCookie(app, 'alice');
  const bobCookie = await registerAndCookie(app, 'bob');
  await playOneShortRun(app, sessionStore, aliceCookie);
  await playOneShortRun(app, sessionStore, bobCookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/runs?user_id=1', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].username, 'alice');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 2 new failures with 404.

- [ ] **Step 3: Add the runs endpoint**

In `server/src/routes/admin.routes.js`, add inside `adminRoutes` (after the `/admin/api/players` handler):

```js
fastify.get('/admin/api/runs', async (req) => {
  const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const limit  = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));

  const params = [];
  let where = '';
  if (userId != null && Number.isFinite(userId)) {
    params.push(userId);
    where = 'WHERE r.user_id = $1';
  }
  const limitOffsetIdx = params.length;
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT
       r.id::int                                                  AS run_id,
       r.user_id::int                                             AS user_id,
       u.username                                                 AS username,
       r.score                                                    AS score,
       r.duration_ms                                              AS duration_ms,
       r.played_at                                                AS played_at,
       r.submitted_to_leaderboard                                 AS submitted_to_leaderboard,
       COALESCE(s.attempts_count, 0)::int                         AS attempts_count,
       COALESCE(s.accuracy_pct, 0)::float                         AS accuracy_pct,
       COALESCE(s.mean_response_ms, 0)::float                     AS mean_response_ms
     FROM runs r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN (
       SELECT
         run_id,
         COUNT(*)::int                                            AS attempts_count,
         100.0 * SUM(CASE WHEN correct THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS accuracy_pct,
         AVG(response_ms)                                         AS mean_response_ms
       FROM attempts
       GROUP BY run_id
     ) s ON s.run_id = r.id
     ${where}
     ORDER BY r.played_at DESC
     LIMIT $${limitOffsetIdx + 1} OFFSET $${limitOffsetIdx + 2}`,
    params
  );

  const totalParams = userId != null && Number.isFinite(userId) ? [userId] : [];
  const totalSql = userId != null && Number.isFinite(userId)
    ? 'SELECT COUNT(*)::int AS n FROM runs WHERE user_id = $1'
    : 'SELECT COUNT(*)::int AS n FROM runs';
  const { rows: tot } = await pool.query(totalSql, totalParams);

  return {
    runs: rows.map(r => ({
      run_id: r.run_id,
      user_id: r.user_id,
      username: r.username,
      score: r.score,
      duration_ms: r.duration_ms,
      played_at: r.played_at.toISOString(),
      submitted_to_leaderboard: r.submitted_to_leaderboard,
      attempts_count: r.attempts_count,
      accuracy_pct: Math.round(r.accuracy_pct * 10) / 10,
      mean_response_ms: Math.round(r.mean_response_ms)
    })),
    total: tot[0].n
  };
});
```

- [ ] **Step 4: Run tests**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/runs"
```

---

## Task 11: Admin route — `GET /admin/api/runs/:run_id/attempts`

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Modify: `server/test/integration/admin.test.js`

- [ ] **Step 1: Add failing tests**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/runs/:id/attempts returns full question log', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const list = await app.inject({ method: 'GET', url: '/admin/api/runs', headers: { authorization: BASIC_HEADER } });
  const runId = list.json().runs[0].run_id;

  const r = await app.inject({ method: 'GET', url: `/admin/api/runs/${runId}/attempts`, headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.run.run_id, runId);
  assert.ok(body.attempts.length >= 1);
  const a = body.attempts[0];
  assert.equal(a.q_index, 0);
  assert.ok(['add', 'sub', 'mul', 'div'].includes(a.op));
  assert.equal(typeof a.lhs, 'number');
  assert.equal(typeof a.rhs, 'number');
  assert.equal(typeof a.answer, 'number');
  assert.equal(typeof a.response_ms, 'number');
  assert.equal(typeof a.correct, 'boolean');
  assert.equal(typeof a.asked_at, 'string');
});

test('GET /admin/api/runs/:id/attempts returns 404 for unknown run', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const r = await app.inject({ method: 'GET', url: '/admin/api/runs/99999/attempts', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 2 new failures.

- [ ] **Step 3: Add the endpoint**

In `server/src/routes/admin.routes.js`, append inside `adminRoutes`:

```js
fastify.get('/admin/api/runs/:run_id/attempts', async (req, reply) => {
  const runId = Number(req.params.run_id);
  if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'bad_request' });

  const { rows: runRows } = await pool.query(
    `SELECT
       r.id::int                                                AS run_id,
       r.user_id::int                                           AS user_id,
       u.username                                               AS username,
       r.score                                                  AS score,
       r.duration_ms                                            AS duration_ms,
       r.played_at                                              AS played_at,
       r.submitted_to_leaderboard                               AS submitted_to_leaderboard,
       COUNT(a.id)::int                                         AS attempts_count,
       COALESCE(100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 0)::float AS accuracy_pct,
       COALESCE(AVG(a.response_ms), 0)::float                   AS mean_response_ms
     FROM runs r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN attempts a ON a.run_id = r.id
     WHERE r.id = $1
     GROUP BY r.id, u.username`,
    [runId]
  );
  if (runRows.length === 0) return reply.code(404).send({ error: 'unknown_run' });
  const r0 = runRows[0];

  const { rows: aRows } = await pool.query(
    `SELECT q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at
     FROM attempts
     WHERE run_id = $1
     ORDER BY q_index ASC`,
    [runId]
  );

  return {
    run: {
      run_id: r0.run_id,
      user_id: r0.user_id,
      username: r0.username,
      score: r0.score,
      duration_ms: r0.duration_ms,
      played_at: r0.played_at.toISOString(),
      submitted_to_leaderboard: r0.submitted_to_leaderboard,
      attempts_count: r0.attempts_count,
      accuracy_pct: Math.round(r0.accuracy_pct * 10) / 10,
      mean_response_ms: Math.round(r0.mean_response_ms)
    },
    attempts: aRows.map(a => ({
      q_index: a.q_index,
      op: a.op,
      lhs: a.lhs,
      rhs: a.rhs,
      answer: a.answer,
      user_answer: a.user_answer,
      response_ms: a.response_ms,
      correct: a.correct,
      asked_at: a.asked_at.toISOString()
    }))
  };
});
```

- [ ] **Step 4: Run tests**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/runs/:id/attempts"
```

---

## Task 12: Admin route — `GET /admin/api/per-op`

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Modify: `server/test/integration/admin.test.js`

- [ ] **Step 1: Add a failing test**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/per-op returns one row per op present in attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/per-op', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(Array.isArray(body.per_op));
  assert.ok(body.per_op.length >= 1);
  const row = body.per_op[0];
  assert.ok(['add', 'sub', 'mul', 'div'].includes(row.op));
  assert.equal(typeof row.attempts, 'number');
  assert.equal(typeof row.correct, 'number');
  assert.equal(typeof row.accuracy_pct, 'number');
  assert.equal(typeof row.mean_response_ms, 'number');
  assert.equal(typeof row.median_response_ms, 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 1 new failure with 404.

- [ ] **Step 3: Add the endpoint**

In `server/src/routes/admin.routes.js`, append inside `adminRoutes`:

```js
fastify.get('/admin/api/per-op', async (req) => {
  const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const params = [];
  let where = '';
  if (userId != null && Number.isFinite(userId)) {
    params.push(userId);
    where = 'WHERE r.user_id = $1';
  }
  const { rows } = await pool.query(
    `SELECT
       a.op                                                            AS op,
       COUNT(*)::int                                                   AS attempts,
       SUM(CASE WHEN a.correct THEN 1 ELSE 0 END)::int                 AS correct,
       (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct,
       AVG(a.response_ms)::float                                       AS mean_response_ms,
       (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.response_ms))::float AS median_response_ms
     FROM attempts a
     JOIN runs r ON r.id = a.run_id
     ${where}
     GROUP BY a.op
     ORDER BY a.op`,
    params
  );
  return {
    per_op: rows.map(r => ({
      op: r.op,
      attempts: r.attempts,
      correct: r.correct,
      accuracy_pct: Math.round(r.accuracy_pct * 10) / 10,
      mean_response_ms: Math.round(r.mean_response_ms),
      median_response_ms: Math.round(r.median_response_ms)
    }))
  };
});
```

- [ ] **Step 4: Run tests**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/per-op"
```

---

## Task 13: Admin route — `GET /admin/api/heatmap`

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Modify: `server/test/integration/admin.test.js`

- [ ] **Step 1: Add failing tests**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/heatmap?op=mul returns cells', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  // Play several short runs so we accumulate enough attempts that mul is likely to appear.
  for (let i = 0; i < 5; i++) await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/heatmap?op=mul', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.op, 'mul');
  assert.ok(Array.isArray(body.cells));
  // We don't assert non-empty (rng might not pick mul), just shape:
  if (body.cells.length > 0) {
    const c = body.cells[0];
    assert.equal(typeof c.lhs, 'number');
    assert.equal(typeof c.rhs, 'number');
    assert.equal(typeof c.attempts, 'number');
    assert.equal(typeof c.correct, 'number');
    assert.equal(typeof c.mean_response_ms, 'number');
    assert.equal(typeof c.accuracy_pct, 'number');
  }
});

test('GET /admin/api/heatmap rejects op outside add/sub/mul/div', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const r = await app.inject({ method: 'GET', url: '/admin/api/heatmap?op=junk', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 2 new failures (404, then 200 instead of 400 once route exists in next step would not matter — both fail at this point).

- [ ] **Step 3: Add the endpoint**

In `server/src/routes/admin.routes.js`, append inside `adminRoutes`:

```js
fastify.get('/admin/api/heatmap', async (req, reply) => {
  const op = req.query.op;
  if (!['add', 'sub', 'mul', 'div'].includes(op)) {
    return reply.code(400).send({ error: 'bad_op' });
  }
  const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const params = [op];
  let where = 'WHERE a.op = $1';
  if (userId != null && Number.isFinite(userId)) {
    params.push(userId);
    where += ' AND r.user_id = $2';
  }
  const { rows } = await pool.query(
    `SELECT
       a.lhs                                                          AS lhs,
       a.rhs                                                          AS rhs,
       COUNT(*)::int                                                  AS attempts,
       SUM(CASE WHEN a.correct THEN 1 ELSE 0 END)::int                AS correct,
       AVG(a.response_ms)::float                                      AS mean_response_ms,
       (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct
     FROM attempts a
     JOIN runs r ON r.id = a.run_id
     ${where}
     GROUP BY a.lhs, a.rhs
     ORDER BY a.lhs, a.rhs`,
    params
  );
  return {
    op,
    cells: rows.map(c => ({
      lhs: c.lhs,
      rhs: c.rhs,
      attempts: c.attempts,
      correct: c.correct,
      mean_response_ms: Math.round(c.mean_response_ms),
      accuracy_pct: Math.round(c.accuracy_pct * 10) / 10
    }))
  };
});
```

- [ ] **Step 4: Run tests**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/heatmap"
```

---

## Task 14: Admin route — `GET /admin/api/weak-spots`

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Modify: `server/test/integration/admin.test.js`

- [ ] **Step 1: Add a failing test**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/weak-spots returns slowest and least_accurate arrays', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/weak-spots', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(Array.isArray(body.slowest));
  assert.ok(Array.isArray(body.least_accurate));
  // Filter requires attempts >= 10 per bucket; with one short run both are likely empty — that's fine.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 1 new failure with 404.

- [ ] **Step 3: Add the endpoint**

In `server/src/routes/admin.routes.js`, append inside `adminRoutes`:

```js
fastify.get('/admin/api/weak-spots', async (req) => {
  const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const params = [];
  let where = '';
  if (userId != null && Number.isFinite(userId)) {
    params.push(userId);
    where = 'WHERE r.user_id = $1';
  }
  const { rows } = await pool.query(
    `SELECT
       a.op                                                          AS op,
       a.lhs                                                          AS lhs,
       a.rhs                                                          AS rhs,
       COUNT(*)::int                                                  AS attempts,
       AVG(a.response_ms)::float                                      AS mean_response_ms,
       (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct
     FROM attempts a
     JOIN runs r ON r.id = a.run_id
     ${where}
     GROUP BY a.op, a.lhs, a.rhs
     HAVING COUNT(*) >= 10`,
    params
  );

  const slowest = [...rows]
    .sort((a, b) => b.mean_response_ms - a.mean_response_ms)
    .slice(0, 10)
    .map(r => ({
      op: r.op,
      lhs: r.lhs,
      rhs: r.rhs,
      attempts: r.attempts,
      mean_response_ms: Math.round(r.mean_response_ms)
    }));
  const least_accurate = [...rows]
    .sort((a, b) => a.accuracy_pct - b.accuracy_pct)
    .slice(0, 10)
    .map(r => ({
      op: r.op,
      lhs: r.lhs,
      rhs: r.rhs,
      attempts: r.attempts,
      accuracy_pct: Math.round(r.accuracy_pct * 10) / 10
    }));

  return { slowest, least_accurate };
});
```

- [ ] **Step 4: Run tests**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/weak-spots"
```

---

## Task 15: Admin route — `GET /admin/api/score-timeseries`

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Modify: `server/test/integration/admin.test.js`

- [ ] **Step 1: Add a failing test**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/score-timeseries returns one point per run, ascending', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/score-timeseries?window=all', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.points.length, 2);
  const p = body.points[0];
  assert.equal(typeof p.played_at, 'string');
  assert.equal(typeof p.score, 'number');
  assert.equal(typeof p.run_id, 'number');
  assert.equal(p.username, 'alice');
  // Ascending order
  assert.ok(new Date(body.points[0].played_at) <= new Date(body.points[1].played_at));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 1 new failure with 404.

- [ ] **Step 3: Add the endpoint**

In `server/src/routes/admin.routes.js`, append inside `adminRoutes`:

```js
fastify.get('/admin/api/score-timeseries', async (req, reply) => {
  const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const window = req.query.window ?? 'all';
  if (!['7', '30', 'all'].includes(window)) {
    return reply.code(400).send({ error: 'bad_window' });
  }
  const params = [];
  const wheres = [];
  if (userId != null && Number.isFinite(userId)) {
    params.push(userId);
    wheres.push(`r.user_id = $${params.length}`);
  }
  if (window === '7') wheres.push(`r.played_at >= now() - interval '7 days'`);
  if (window === '30') wheres.push(`r.played_at >= now() - interval '30 days'`);
  const whereSql = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT
       r.played_at                          AS played_at,
       r.score                              AS score,
       r.id::int                            AS run_id,
       u.username                           AS username
     FROM runs r
     JOIN users u ON u.id = r.user_id
     ${whereSql}
     ORDER BY r.played_at ASC`,
    params
  );
  return {
    points: rows.map(p => ({
      played_at: p.played_at.toISOString(),
      score: p.score,
      run_id: p.run_id,
      username: p.username
    }))
  };
});
```

- [ ] **Step 4: Run tests**

Run (from `server/`): `node --test test/integration/admin.test.js`

Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/score-timeseries"
```

---

## Task 16: Build admin client — HTML shell + CSS + API wrapper

**Files:**
- Create: `client/admin/index.html`
- Create: `client/admin/css/admin.css`
- Create: `client/admin/js/admin-api.js`

- [ ] **Step 1: Write `client/admin/index.html`**

Create `client/admin/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ZetaChad Admin</title>
  <link rel="stylesheet" href="css/admin.css">
</head>
<body>
  <header class="admin-bar">
    <h1>ZetaChad Admin</h1>
    <label>Player:
      <select id="player-picker"></select>
    </label>
    <label>Window:
      <select id="window-picker">
        <option value="all">All time</option>
        <option value="30">Last 30 days</option>
        <option value="7">Last 7 days</option>
      </select>
    </label>
  </header>

  <main>
    <section id="activity-section" class="hidden">
      <h2>Activity (all players)</h2>
      <table id="activity-table"></table>
    </section>

    <section>
      <h2>Score over time</h2>
      <div id="score-chart"></div>
    </section>

    <section>
      <h2>Per-op summary</h2>
      <div id="per-op-cards"></div>
    </section>

    <section>
      <h2>Weak spots</h2>
      <div class="weak-cols">
        <div>
          <h3>Slowest</h3>
          <table id="slowest-table"></table>
        </div>
        <div>
          <h3>Lowest accuracy</h3>
          <table id="least-accurate-table"></table>
        </div>
      </div>
    </section>

    <section>
      <h2>Multiplication heatmap</h2>
      <canvas id="heatmap-mul" width="990" height="110"></canvas>
      <div id="heatmap-mul-tip" class="tip"></div>
    </section>

    <section>
      <h2>Division heatmap</h2>
      <canvas id="heatmap-div" width="990" height="110"></canvas>
      <div id="heatmap-div-tip" class="tip"></div>
    </section>

    <section>
      <h2>Sessions</h2>
      <table id="sessions-table"></table>
      <div id="session-detail"></div>
    </section>
  </main>

  <script type="module" src="js/admin.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `client/admin/css/admin.css`**

Create `client/admin/css/admin.css`:

```css
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 0; background: #0e1117; color: #e6edf3; }
.admin-bar { display: flex; align-items: center; gap: 16px; padding: 12px 24px; background: #161b22; border-bottom: 1px solid #30363d; }
.admin-bar h1 { font-size: 18px; margin: 0; }
.admin-bar label { font-size: 13px; }
.admin-bar select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; padding: 4px 8px; border-radius: 4px; }
main { padding: 24px; max-width: 1100px; margin: 0 auto; }
section { margin-bottom: 32px; }
section h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; margin: 0 0 12px; }
.hidden { display: none; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #21262d; font-size: 13px; }
th { color: #8b949e; font-weight: 500; }
tr.expandable { cursor: pointer; }
tr.expandable:hover { background: #161b22; }
#per-op-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.op-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
.op-card h4 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; }
.op-card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; }
.op-card dt { color: #8b949e; }
.weak-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
canvas { background: #161b22; border: 1px solid #30363d; border-radius: 4px; display: block; }
.tip { font-size: 12px; color: #8b949e; min-height: 18px; padding: 4px 0; }
#session-detail { margin-top: 16px; padding: 12px; background: #161b22; border-radius: 6px; }
#session-detail:empty { display: none; }
#score-chart { background: #161b22; border: 1px solid #30363d; border-radius: 4px; padding: 12px; height: 220px; }
```

- [ ] **Step 3: Write `client/admin/js/admin-api.js`**

Create `client/admin/js/admin-api.js`:

```js
const BASE = '/admin/api';

async function get(path) {
  const res = await fetch(BASE + path, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = new Error(`http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const adminApi = {
  players:        ()                       => get('/players'),
  runs:           (q = {})                 => get('/runs' + qs(q)),
  attempts:       (runId)                  => get(`/runs/${runId}/attempts`),
  perOp:          (q = {})                 => get('/per-op' + qs(q)),
  heatmap:        (op, q = {})             => get('/heatmap' + qs({ op, ...q })),
  weakSpots:      (q = {})                 => get('/weak-spots' + qs(q)),
  scoreTimeSeries:(q = {})                 => get('/score-timeseries' + qs(q))
};

function qs(obj) {
  const parts = Object.entries(obj).filter(([, v]) => v != null && v !== '');
  return parts.length ? '?' + parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
}

const fmtSGT = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});

export function sgtDate(iso) {
  return fmtSGT.format(new Date(iso));
}
```

- [ ] **Step 4: Commit**

(No test yet — these files are exercised by the dashboard wiring in Task 18.)

```bash
git add client/admin/index.html client/admin/css/admin.css client/admin/js/admin-api.js
git commit -m "feat(admin-client): HTML shell, CSS, API wrapper with SGT formatting"
```

---

## Task 17: Heatmap and chart renderers

**Files:**
- Create: `client/admin/js/heatmap.js`
- Create: `client/admin/js/chart.js`

- [ ] **Step 1: Write `heatmap.js`**

Create `client/admin/js/heatmap.js`:

```js
// Renders a (lhs × rhs) grid of mean response times on a canvas.
// lhs range 2..12 (11 rows), rhs range 2..100 (99 cols). Cell = 10×10 px.
const LHS_MIN = 2, LHS_MAX = 12, RHS_MIN = 2, RHS_MAX = 100;
const CELL = 10;
const ROWS = LHS_MAX - LHS_MIN + 1;
const COLS = RHS_MAX - RHS_MIN + 1;

export function renderHeatmap(canvas, tipEl, cells) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (cells.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px system-ui';
    ctx.fillText('No data', 8, 20);
    return;
  }

  const sorted = cells.map(c => c.mean_response_ms).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? sorted[0];
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
  const span = Math.max(1, p90 - p10);

  // Build a map for hover lookup
  const cellMap = new Map();
  for (const c of cells) cellMap.set(`${c.lhs},${c.rhs}`, c);

  for (const c of cells) {
    const x = (c.rhs - RHS_MIN) * CELL;
    const y = (c.lhs - LHS_MIN) * CELL;
    const t = Math.max(0, Math.min(1, (c.mean_response_ms - p10) / span));
    // Green (fast) → red (slow)
    const r = Math.round(60 + 195 * t);
    const g = Math.round(180 - 130 * t);
    const b = 60;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y, CELL, CELL);
  }

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const rhs = Math.floor(px / CELL) + RHS_MIN;
    const lhs = Math.floor(py / CELL) + LHS_MIN;
    if (lhs < LHS_MIN || lhs > LHS_MAX || rhs < RHS_MIN || rhs > RHS_MAX) {
      tipEl.textContent = '';
      return;
    }
    const c = cellMap.get(`${lhs},${rhs}`);
    if (!c) {
      tipEl.textContent = `${lhs} × ${rhs}: no data`;
    } else {
      tipEl.textContent = `${lhs} × ${rhs}: ${c.mean_response_ms}ms · ${c.attempts} attempts · ${c.accuracy_pct}%`;
    }
  };
  canvas.onmouseleave = () => { tipEl.textContent = ''; };
}
```

- [ ] **Step 2: Write `chart.js`**

Create `client/admin/js/chart.js`:

```js
// Tiny SVG line chart for score-over-time. One <path> per series.
// Input: { points: [{ played_at, score, username }] } already sorted ascending.
// Multi-player: groups by username.
export function renderChart(container, points) {
  container.innerHTML = '';
  if (points.length === 0) {
    container.textContent = 'No runs yet.';
    return;
  }

  const W = container.clientWidth || 800;
  const H = 200;
  const PAD_L = 32, PAD_R = 8, PAD_T = 8, PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const ts = points.map(p => +new Date(p.played_at));
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const tSpan = Math.max(1, tMax - tMin);
  const sMax = Math.max(1, ...points.map(p => p.score));

  const x = (t) => PAD_L + ((t - tMin) / tSpan) * innerW;
  const y = (s) => PAD_T + innerH - (s / sMax) * innerH;

  // Group by username
  const series = new Map();
  for (const p of points) {
    if (!series.has(p.username)) series.set(p.username, []);
    series.get(p.username).push(p);
  }

  const colors = ['#58a6ff', '#56d364', '#f1e05a', '#ff7b72', '#bc8cff', '#79c0ff'];

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
  // Y axis ticks (0 and sMax)
  svg += `<text x="4" y="${y(0) + 4}" fill="#8b949e" font-size="11">0</text>`;
  svg += `<text x="4" y="${y(sMax) + 4}" fill="#8b949e" font-size="11">${sMax}</text>`;
  // Lines
  let cIdx = 0;
  for (const [name, pts] of series) {
    const color = colors[cIdx++ % colors.length];
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(+new Date(p.played_at)).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
    svg += `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" />`;
    for (const p of pts) {
      svg += `<circle cx="${x(+new Date(p.played_at)).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="3" fill="${color}" />`;
    }
    if (series.size > 1) {
      svg += `<text x="${PAD_L + 4}" y="${PAD_T + 12 + (cIdx - 1) * 14}" fill="${color}" font-size="11">${name}</text>`;
    }
  }
  svg += '</svg>';
  container.innerHTML = svg;
}
```

- [ ] **Step 3: Commit**

```bash
git add client/admin/js/heatmap.js client/admin/js/chart.js
git commit -m "feat(admin-client): heatmap + line chart renderers"
```

---

## Task 18: Wire admin dashboard controller

**Files:**
- Create: `client/admin/js/admin.js`

- [ ] **Step 1: Write `admin.js`**

Create `client/admin/js/admin.js`:

```js
import { adminApi, sgtDate } from './admin-api.js';
import { renderHeatmap } from './heatmap.js';
import { renderChart } from './chart.js';

const els = {
  playerPicker: document.getElementById('player-picker'),
  windowPicker: document.getElementById('window-picker'),
  activitySection: document.getElementById('activity-section'),
  activityTable: document.getElementById('activity-table'),
  scoreChart: document.getElementById('score-chart'),
  perOpCards: document.getElementById('per-op-cards'),
  slowest: document.getElementById('slowest-table'),
  leastAccurate: document.getElementById('least-accurate-table'),
  heatmapMul: document.getElementById('heatmap-mul'),
  heatmapMulTip: document.getElementById('heatmap-mul-tip'),
  heatmapDiv: document.getElementById('heatmap-div'),
  heatmapDivTip: document.getElementById('heatmap-div-tip'),
  sessionsTable: document.getElementById('sessions-table'),
  sessionDetail: document.getElementById('session-detail')
};

const state = { userId: null, window: 'all' };

async function loadPlayers() {
  const { players } = await adminApi.players();
  els.playerPicker.innerHTML = '<option value="">All players</option>' +
    players.map(p => `<option value="${p.user_id}">${escape(p.username)} (${p.run_count})</option>`).join('');
  // Activity table for "All players"
  els.activityTable.innerHTML =
    '<thead><tr><th>Player</th><th>Runs</th><th>Best</th><th>Last played (SGT)</th><th>Attempts</th></tr></thead>' +
    '<tbody>' + players.map(p =>
      `<tr><td>${escape(p.username)}</td><td>${p.run_count}</td><td>${p.best_score}</td><td>${p.last_played_at ? sgtDate(p.last_played_at) : ''}</td><td>${p.total_attempts}</td></tr>`
    ).join('') + '</tbody>';
}

async function refresh() {
  const userId = state.userId;
  els.activitySection.classList.toggle('hidden', userId != null);

  const [chart, perOp, weak, mul, div, runs] = await Promise.all([
    adminApi.scoreTimeSeries({ user_id: userId, window: state.window }),
    adminApi.perOp({ user_id: userId }),
    adminApi.weakSpots({ user_id: userId }),
    adminApi.heatmap('mul', { user_id: userId }),
    adminApi.heatmap('div', { user_id: userId }),
    adminApi.runs({ user_id: userId, limit: 100 })
  ]);

  renderChart(els.scoreChart, chart.points);
  renderPerOp(perOp.per_op);
  renderWeakSpots(weak);
  renderHeatmap(els.heatmapMul, els.heatmapMulTip, mul.cells);
  renderHeatmap(els.heatmapDiv, els.heatmapDivTip, div.cells);
  renderSessions(runs.runs);

  els.sessionDetail.innerHTML = '';
}

function renderPerOp(rows) {
  const byOp = new Map(rows.map(r => [r.op, r]));
  const ops = ['add', 'sub', 'mul', 'div'];
  els.perOpCards.innerHTML = ops.map(op => {
    const r = byOp.get(op);
    if (!r) return `<div class="op-card"><h4>${op}</h4><dl><dt>—</dt><dd>no data</dd></dl></div>`;
    return `<div class="op-card">
      <h4>${op}</h4>
      <dl>
        <dt>Attempts</dt><dd>${r.attempts}</dd>
        <dt>Accuracy</dt><dd>${r.accuracy_pct}%</dd>
        <dt>Mean</dt><dd>${r.mean_response_ms}ms</dd>
        <dt>Median</dt><dd>${r.median_response_ms}ms</dd>
      </dl>
    </div>`;
  }).join('');
}

function renderWeakSpots({ slowest, least_accurate }) {
  els.slowest.innerHTML =
    '<thead><tr><th>Op</th><th>L</th><th>R</th><th>n</th><th>Mean ms</th></tr></thead>' +
    '<tbody>' + (slowest.length ? slowest.map(r =>
      `<tr><td>${r.op}</td><td>${r.lhs}</td><td>${r.rhs}</td><td>${r.attempts}</td><td>${r.mean_response_ms}</td></tr>`
    ).join('') : '<tr><td colspan="5">No buckets with ≥10 attempts yet.</td></tr>') + '</tbody>';
  els.leastAccurate.innerHTML =
    '<thead><tr><th>Op</th><th>L</th><th>R</th><th>n</th><th>Acc %</th></tr></thead>' +
    '<tbody>' + (least_accurate.length ? least_accurate.map(r =>
      `<tr><td>${r.op}</td><td>${r.lhs}</td><td>${r.rhs}</td><td>${r.attempts}</td><td>${r.accuracy_pct}</td></tr>`
    ).join('') : '<tr><td colspan="5">No buckets with ≥10 attempts yet.</td></tr>') + '</tbody>';
}

function renderSessions(runs) {
  els.sessionsTable.innerHTML =
    '<thead><tr><th>Played (SGT)</th><th>Player</th><th>Score</th><th>Acc %</th><th>Mean ms</th><th>On board</th></tr></thead>' +
    '<tbody>' + runs.map(r =>
      `<tr class="expandable" data-run-id="${r.run_id}">
        <td>${sgtDate(r.played_at)}</td>
        <td>${escape(r.username)}</td>
        <td>${r.score}</td>
        <td>${r.accuracy_pct}</td>
        <td>${r.mean_response_ms}</td>
        <td>${r.submitted_to_leaderboard ? '✓' : ''}</td>
      </tr>`
    ).join('') + '</tbody>';
  els.sessionsTable.querySelectorAll('tr.expandable').forEach(row => {
    row.addEventListener('click', () => loadDetail(Number(row.dataset.runId)));
  });
}

async function loadDetail(runId) {
  const { run, attempts } = await adminApi.attempts(runId);
  els.sessionDetail.innerHTML =
    `<h3>Run ${run.run_id} — ${escape(run.username)} — ${sgtDate(run.played_at)}</h3>
     <table>
       <thead><tr><th>#</th><th>Prompt</th><th>Answer</th><th>You typed</th><th>ms</th><th>OK</th></tr></thead>
       <tbody>` +
       attempts.map(a =>
         `<tr><td>${a.q_index + 1}</td><td>${escape(promptFor(a))}</td><td>${a.answer}</td><td>${escape(a.user_answer ?? '')}</td><td>${a.response_ms}</td><td>${a.correct ? '✓' : '✗'}</td></tr>`
       ).join('') +
     '</tbody></table>';
}

function promptFor(a) {
  const sym = { add: '+', sub: '−', mul: '×', div: '÷' }[a.op] || '?';
  return `${a.lhs} ${sym} ${a.rhs}`;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

els.playerPicker.addEventListener('change', () => {
  const v = els.playerPicker.value;
  state.userId = v === '' ? null : Number(v);
  refresh();
});
els.windowPicker.addEventListener('change', () => {
  state.window = els.windowPicker.value;
  refresh();
});

(async () => {
  await loadPlayers();
  await refresh();
})();
```

- [ ] **Step 2: Commit**

```bash
git add client/admin/js/admin.js
git commit -m "feat(admin-client): dashboard controller wiring all sections"
```

---

## Task 19: Update nginx config for admin

**Files:**
- Modify: `deploy/nginx-zetachad.conf`

- [ ] **Step 1: Read current nginx config**

Run: `cat deploy/nginx-zetachad.conf`

Note where the `location /` and `location /api/` blocks live; the new admin blocks go alongside them in the same `server { ... }` block.

- [ ] **Step 2: Add the two admin location blocks**

Inside the `server { ... }` block (after the existing `location /api/` block), add:

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
  proxy_set_header     Host             $host;
  proxy_set_header     X-Real-IP        $remote_addr;
  proxy_set_header     X-Forwarded-For  $proxy_add_x_forwarded_for;
  proxy_set_header     X-Forwarded-Proto $scheme;
}
```

- [ ] **Step 3: Commit**

```bash
git add deploy/nginx-zetachad.conf
git commit -m "deploy: add /admin and /admin/api nginx location blocks (Basic Auth)"
```

---

## Task 20: Update deploy script to rsync admin client

**Files:**
- Modify: `deploy/deploy.sh`

- [ ] **Step 1: Read current `deploy.sh`**

Run: `cat deploy/deploy.sh`

Identify the existing line that rsyncs `client/` to `/var/www/zetachad-mul/client/`.

- [ ] **Step 2: Add a parallel rsync for `client/admin/`**

After the existing client rsync line, add:

```bash
rsync -az --delete \
  /srv/zetachad/repo/client/admin/ /var/www/zetachad-mul/admin/
```

(Adjust the source path if your `deploy.sh` uses a different repo root variable. Match the style of the existing rsync command exactly.)

- [ ] **Step 3: Commit**

```bash
git add deploy/deploy.sh
git commit -m "deploy: rsync admin client alongside main client"
```

---

## Task 21: Document admin htpasswd bootstrap

**Files:**
- Modify: `docs/deploy-runbook.md`

- [ ] **Step 1: Append a new section to `docs/deploy-runbook.md`**

Append:

```markdown
## Admin dashboard setup (one-time per VPS)

Install the htpasswd tool, create the credential file, lock it down, then reload nginx.

```bash
sudo apt-get install -y apache2-utils

sudo htpasswd -cB /etc/nginx/zetachad-admin.htpasswd stjianqing
# Enter the admin password when prompted: tns6e123

sudo chown root:www-data /etc/nginx/zetachad-admin.htpasswd
sudo chmod 640 /etc/nginx/zetachad-admin.htpasswd

sudo nginx -t && sudo systemctl reload nginx
```

After this, `https://zetachad.duckdns.org/admin/` will prompt for HTTP Basic Auth. Enter `stjianqing` / `tns6e123`.

To rotate the password later:

```bash
sudo htpasswd -B /etc/nginx/zetachad-admin.htpasswd stjianqing
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy-runbook.md
git commit -m "docs: admin dashboard htpasswd bootstrap section in runbook"
```

---

## Task 22: Run the full test suite to verify everything still passes

- [ ] **Step 1: Unit tests**

Run (from `server/`): `node --test test/unit/`

Expected: all tests pass (existing + new staging tests).

- [ ] **Step 2: Integration tests**

Run (from `server/`): `node --test test/integration/`

Expected: all tests pass (`play.test.js` + `admin.test.js`).

- [ ] **Step 3: Smoke checklist (manual, post-deploy)**

After deploying, verify:

1. Log in as a real user, finish a drill, click Submit. `GET /admin/api/runs?user_id=X` shows the run.
2. Log in, finish a drill, click "No thanks" on the submit modal. The run appears in `/admin/api/runs` but **not** on `/api/leaderboard`.
3. Play a guest run: nothing in `/admin/api/runs`.
4. Visit `/admin/` without credentials: nginx Basic Auth prompt appears. Wrong password → reject. Right password → page loads.
5. On the dashboard: switch player picker, switch window selector, click a sessions row to expand, hover a heatmap cell. Everything renders without console errors.

---
