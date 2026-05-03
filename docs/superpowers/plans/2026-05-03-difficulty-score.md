# Run Difficulty Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute and display a 0–10 time-weighted difficulty score per run, derived from the global median response time of each question's cluster.

**Architecture:** A new `MedianCache` module loads cluster medians from a `cluster_medians` table at startup and refreshes daily. At run-finalization, a pure `computeRunDifficulty(attempts, medianCache)` function produces a single number, written to a new `runs.difficulty` column. The leaderboard API surfaces the value; the leaderboard table and post-run summary display it. The submit response also returns the difficulty so the post-run screen can show it without an extra round-trip.

**Tech Stack:** Node.js (ES modules), Fastify 5, Postgres 16, vanilla JS frontend, `node:test` for tests.

**Reference spec:** `docs/superpowers/specs/2026-05-03-difficulty-score-design.md`

**Note on git:** This project's working directory is not under git (the VPS deploys via `deploy/deploy-scp.sh`, not git pulls). The "commit" steps below are still listed for the implementing engineer's bookkeeping but can be skipped or replaced with a manual changelog note. Do NOT run `git init` — that would diverge from the existing deploy workflow. Deploy is handled in Task 14, after all code lands.

---

## File Structure

**Created:**
- `server/migrations/007_runs_difficulty.sql` — adds `runs.difficulty` column.
- `server/migrations/008_cluster_medians.sql` — creates `cluster_medians` table.
- `server/src/run-difficulty/compute.js` — pure `computeRunDifficulty(attempts, medianCache)` function.
- `server/src/run-difficulty/median-cache.js` — `MedianCache` class with `get`, `getAll`, `fallbackMedian`, `refresh` methods.
- `server/scripts/backfill-difficulty.js` — one-shot backfill for runs missing `difficulty`.
- `server/test/unit/run-difficulty.test.js` — unit tests for `computeRunDifficulty` and `MedianCache`.
- `server/test/integration/difficulty.test.js` — integration tests for end-to-end run insert + leaderboard payload.

**Modified:**
- `server/src/index.js` — instantiate `MedianCache`, refresh on boot, schedule daily, pass to routes.
- `server/src/routes/play.routes.js` — call `computeRunDifficulty` in `flushRunIfRecording`, include in INSERT.
- `server/src/routes/board.routes.js` — return `difficulty` from `/api/leaderboard` and from submit response.
- `server/src/routes/admin.routes.js` — add `POST /admin/api/refresh-medians`.
- `client/leaderboard.html` — add Diff column header.
- `client/js/leaderboard.js` — render Diff cell with color band.
- `client/css/styles.css` — `.diff-cell` color classes.
- `client/play.html` — placeholder element for difficulty in post-run summary.
- `client/js/play.js` — populate difficulty on finish.

---

## Task 1: Migration — `runs.difficulty` column

**Files:**
- Create: `server/migrations/007_runs_difficulty.sql`

- [ ] **Step 1: Write the migration file**

```sql
ALTER TABLE runs ADD COLUMN difficulty NUMERIC(4,2) NULL;

-- Speeds up leaderboard queries that may sort or filter on difficulty later.
-- Partial index because most analytics paths only care about scored runs.
CREATE INDEX runs_difficulty_idx ON runs(difficulty) WHERE difficulty IS NOT NULL;
```

- [ ] **Step 2: Run the test suite to confirm baseline passes (no schema lint yet)**

Run: `cd server && npm test`
Expected: existing tests pass (or skip if `TEST_DATABASE_URL` is unset). No new failures.

- [ ] **Step 3: Apply the migration locally if a test DB is available**

Run (if `TEST_DATABASE_URL` is set):
```bash
cd server && node --env-file=/dev/null -e "import('./src/db.js').then(async ({makePool, migrate}) => { const p = makePool(); await migrate(p); console.log('ok'); await p.end(); })"
```
Expected: prints `ok`. Then verify column exists:
```bash
psql "$TEST_DATABASE_URL" -c "\d runs" | grep difficulty
```
Expected: `difficulty | numeric(4,2)`.

If no test DB, skip this step — Task 14 will apply on production.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/007_runs_difficulty.sql 2>/dev/null || true
# (Skip if not a git repo. Note added to changelog manually if needed.)
```

---

## Task 2: Migration — `cluster_medians` table

**Files:**
- Create: `server/migrations/008_cluster_medians.sql`

- [ ] **Step 1: Write the migration file**

```sql
CREATE TABLE cluster_medians (
  cluster_id    TEXT PRIMARY KEY,
  median_ms     INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Apply locally if a test DB is available**

Run (if `TEST_DATABASE_URL` is set):
```bash
psql "$TEST_DATABASE_URL" -c "\d cluster_medians"
```
Expected: shows `cluster_id`, `median_ms`, `n`, `refreshed_at` columns.

- [ ] **Step 3: Commit**

```bash
git add server/migrations/008_cluster_medians.sql 2>/dev/null || true
```

---

## Task 3: Pure function — `computeRunDifficulty` (TDD)

**Files:**
- Create: `server/test/unit/run-difficulty.test.js`
- Create: `server/src/run-difficulty/compute.js`

- [ ] **Step 1: Write the failing tests**

Create `server/test/unit/run-difficulty.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRunDifficulty } from '../../src/run-difficulty/compute.js';

// Helper: build a fake medianCache with a fixed lookup table.
function makeCache(table, fallback = null) {
  return {
    get: (id) => (id in table ? table[id] : null),
    fallbackMedian: () => fallback
  };
}

// Helper: build an attempt row with sensible defaults.
function attempt(overrides = {}) {
  return {
    op: 'add',
    lhs: 5,
    rhs: 5,
    response_ms: 2000,
    correct: true,
    ...overrides
  };
}

test('computeRunDifficulty: empty attempts returns null', () => {
  const cache = makeCache({});
  assert.equal(computeRunDifficulty([], cache), null);
});

test('computeRunDifficulty: single cluster, uniform response_ms', () => {
  // add_small with median 2000ms: d_i = 10*(2000-1500)/5500 = 0.909...
  const cache = makeCache({ add_small: 2000 });
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }),
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 })
  ];
  // Time-weighted mean over a single distinct difficulty equals that difficulty.
  const expected = Math.round((10 * (2000 - 1500) / 5500) * 100) / 100;
  assert.equal(computeRunDifficulty(attempts, cache), expected);
});

test('computeRunDifficulty: time-weighted mean differs from naive mean', () => {
  // 40 easy (cluster median 2000ms, response 2000ms) + 5 hard (cluster median 6000ms, response 6000ms).
  // d_easy = 10*(2000-1500)/5500 ≈ 0.909
  // d_hard = 10*(6000-1500)/5500 ≈ 8.182
  // Naive mean: (40*0.909 + 5*8.182)/45 ≈ 1.717
  // Time-weighted: easy contributes 40*2000=80000ms; hard contributes 5*6000=30000ms.
  //   sum(d*t) = 0.909*80000 + 8.182*30000 = 72727 + 245454 = 318181
  //   sum(t)   = 80000 + 30000 = 110000
  //   D = 318181 / 110000 ≈ 2.89
  const cache = makeCache({ add_small: 2000, mul_hard_large: 6000 });
  const attempts = [];
  for (let i = 0; i < 40; i++) {
    attempts.push(attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }));
  }
  for (let i = 0; i < 5; i++) {
    attempts.push(attempt({ op: 'mul', lhs: 12, rhs: 75, response_ms: 6000 }));
  }
  const result = computeRunDifficulty(attempts, cache);
  // Should be substantially higher than naive mean (~1.72), confirming time-weighting.
  assert.ok(result > 2.5, `expected > 2.5, got ${result}`);
  assert.ok(result < 3.5, `expected < 3.5, got ${result}`);
});

test('computeRunDifficulty: wrong answer contributes equally to weighting', () => {
  const cache = makeCache({ add_small: 2000 });
  const both = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: false }),
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: true })
  ];
  const onlyCorrect = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: true }),
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: true })
  ];
  // Same time, same cluster, so same difficulty regardless of correctness.
  assert.equal(computeRunDifficulty(both, cache), computeRunDifficulty(onlyCorrect, cache));
});

test('computeRunDifficulty: response_ms > 15000 is capped at 15000', () => {
  const cache = makeCache({ add_small: 2000, mul_hard_large: 6000 });
  // One easy at 2000ms, one hard at 30000ms (should be capped to 15000).
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }),
    attempt({ op: 'mul', lhs: 12, rhs: 75, response_ms: 30000 })
  ];
  const result = computeRunDifficulty(attempts, cache);
  // d_easy ≈ 0.909, d_hard ≈ 8.182
  // weights: 2000 + 15000 (capped) = 17000
  // sum(d*t) = 0.909*2000 + 8.182*15000 = 1818 + 122727 ≈ 124545
  // D = 124545 / 17000 ≈ 7.33
  assert.ok(result > 7 && result < 7.5, `expected ~7.33, got ${result}`);
});

test('computeRunDifficulty: missing cluster median uses fallback', () => {
  const cache = makeCache({ add_small: 2000 }, /* fallback */ 4000);
  // mul_hard_large is missing — should fall back to 4000.
  const attempts = [
    attempt({ op: 'mul', lhs: 12, rhs: 75, response_ms: 4000 })
  ];
  // d = 10 * (4000 - 1500) / 5500 ≈ 4.545
  const result = computeRunDifficulty(attempts, cache);
  assert.ok(result > 4.4 && result < 4.7, `expected ~4.55, got ${result}`);
});

test('computeRunDifficulty: cache fully empty returns null', () => {
  const cache = makeCache({}, /* fallback */ null);
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 })
  ];
  assert.equal(computeRunDifficulty(attempts, cache), null);
});

test('computeRunDifficulty: bucketize-null attempts are skipped', () => {
  const cache = makeCache({ add_small: 2000 });
  const attempts = [
    // Valid: add_small.
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }),
    // Invalid: mul with both operands outside 2..12 range — bucketize returns null.
    attempt({ op: 'mul', lhs: 75, rhs: 80, response_ms: 5000 })
  ];
  // The invalid attempt is skipped; result equals the easy difficulty.
  const expected = Math.round((10 * (2000 - 1500) / 5500) * 100) / 100;
  assert.equal(computeRunDifficulty(attempts, cache), expected);
});

test('computeRunDifficulty: returns null when sum(t) == 0', () => {
  const cache = makeCache({ add_small: 2000 });
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 0 })
  ];
  assert.equal(computeRunDifficulty(attempts, cache), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/unit/run-difficulty.test.js`
Expected: FAIL — `Cannot find module '../../src/run-difficulty/compute.js'`.

- [ ] **Step 3: Create the implementation**

Create `server/src/run-difficulty/compute.js`:

```javascript
import { bucketize } from '../practice/clusters.js';

const FLOOR_MS = 1500;
const CEIL_MS = 7000;
const TIME_CAP_MS = 15000;

export function computeRunDifficulty(attempts, medianCache) {
  if (!attempts || attempts.length === 0) return null;
  let weightedSum = 0;
  let totalTime = 0;
  for (const a of attempts) {
    const clusterId = bucketize(a.op, a.lhs, a.rhs);
    if (clusterId == null) continue;
    let m_c = medianCache.get(clusterId);
    if (m_c == null) m_c = medianCache.fallbackMedian();
    if (m_c == null) return null;
    const t = Math.min(a.response_ms, TIME_CAP_MS);
    const d = Math.max(0, Math.min(10, 10 * (m_c - FLOOR_MS) / (CEIL_MS - FLOOR_MS)));
    weightedSum += d * t;
    totalTime += t;
  }
  if (totalTime === 0) return null;
  return Math.round((weightedSum / totalTime) * 100) / 100;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test test/unit/run-difficulty.test.js`
Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/run-difficulty/compute.js server/test/unit/run-difficulty.test.js 2>/dev/null || true
```

---

## Task 4: `MedianCache` class (TDD)

**Files:**
- Modify: `server/test/unit/run-difficulty.test.js` (append tests)
- Create: `server/src/run-difficulty/median-cache.js`

- [ ] **Step 1: Append failing tests for `MedianCache`**

Append to `server/test/unit/run-difficulty.test.js`:

```javascript
import { MedianCache } from '../../src/run-difficulty/median-cache.js';

test('MedianCache: get returns null for unknown cluster', () => {
  const cache = new MedianCache();
  cache.loadFromRows([{ cluster_id: 'add_small', median_ms: 2000, n: 100 }]);
  assert.equal(cache.get('mul_hard_large'), null);
});

test('MedianCache: get returns median_ms for known cluster', () => {
  const cache = new MedianCache();
  cache.loadFromRows([{ cluster_id: 'add_small', median_ms: 2000, n: 100 }]);
  assert.equal(cache.get('add_small'), 2000);
});

test('MedianCache: fallbackMedian is the median of all known cluster medians', () => {
  const cache = new MedianCache();
  cache.loadFromRows([
    { cluster_id: 'a', median_ms: 1000, n: 10 },
    { cluster_id: 'b', median_ms: 3000, n: 10 },
    { cluster_id: 'c', median_ms: 5000, n: 10 }
  ]);
  assert.equal(cache.fallbackMedian(), 3000);
});

test('MedianCache: fallbackMedian is null when empty', () => {
  const cache = new MedianCache();
  assert.equal(cache.fallbackMedian(), null);
});

test('MedianCache: getAll returns a snapshot map', () => {
  const cache = new MedianCache();
  cache.loadFromRows([{ cluster_id: 'add_small', median_ms: 2000, n: 100 }]);
  const all = cache.getAll();
  assert.equal(all.get('add_small'), 2000);
});

test('MedianCache: computeFromRawAttempts groups by cluster + medians, excludes practice & wrong', () => {
  // Raw rows as they would come from the SELECT in refresh().
  // Note: practice/wrong filtering happens in SQL — this test verifies the
  // pure JS aggregation given already-filtered input.
  const rows = [
    { op: 'add', lhs: 5,  rhs: 5,  response_ms: 1000 },
    { op: 'add', lhs: 10, rhs: 10, response_ms: 2000 }, // both add_small (max <= 30)
    { op: 'add', lhs: 10, rhs: 10, response_ms: 3000 }, // add_small
    { op: 'mul', lhs: 12, rhs: 75, response_ms: 6000 }, // mul_hard_large
    { op: 'mul', lhs: 12, rhs: 80, response_ms: 7000 }  // mul_hard_large
  ];
  const result = MedianCache.computeFromRawAttempts(rows);
  // add_small medians: [1000, 2000, 3000] → 2000
  // mul_hard_large medians: [6000, 7000] → 6500
  assert.equal(result.get('add_small').median_ms, 2000);
  assert.equal(result.get('add_small').n, 3);
  assert.equal(result.get('mul_hard_large').median_ms, 6500);
  assert.equal(result.get('mul_hard_large').n, 2);
});

test('MedianCache: computeFromRawAttempts with even-count picks lower-middle for stability', () => {
  // For [1000, 2000] the median is 1500; we use lower-middle (1000) for integer stability.
  // Either choice is defensible; lock in the behavior in the test.
  const rows = [
    { op: 'add', lhs: 5, rhs: 5, response_ms: 1000 },
    { op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }
  ];
  const result = MedianCache.computeFromRawAttempts(rows);
  // Document the chosen convention: average of two middle values, rounded.
  assert.equal(result.get('add_small').median_ms, 1500);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/unit/run-difficulty.test.js`
Expected: FAIL — `Cannot find module '../../src/run-difficulty/median-cache.js'`.

- [ ] **Step 3: Create the implementation**

Create `server/src/run-difficulty/median-cache.js`:

```javascript
import { bucketize } from '../practice/clusters.js';

export class MedianCache {
  constructor({ pool = null, log = null } = {}) {
    this.pool = pool;
    this.log = log;
    this._map = new Map();
    this._fallback = null;
    this._refreshTimer = null;
  }

  loadFromRows(rows) {
    this._map = new Map();
    for (const r of rows) {
      this._map.set(r.cluster_id, Number(r.median_ms));
    }
    this._recomputeFallback();
  }

  get(clusterId) {
    return this._map.has(clusterId) ? this._map.get(clusterId) : null;
  }

  getAll() {
    return new Map(this._map);
  }

  fallbackMedian() {
    return this._fallback;
  }

  _recomputeFallback() {
    const values = [...this._map.values()].sort((a, b) => a - b);
    if (values.length === 0) {
      this._fallback = null;
      return;
    }
    const mid = Math.floor(values.length / 2);
    this._fallback = values.length % 2 === 1
      ? values[mid]
      : Math.round((values[mid - 1] + values[mid]) / 2);
  }

  /**
   * Pure aggregation: given raw attempt rows, group by clusterId and compute median_ms + n.
   * SQL is responsible for filtering (correct = true, practice = false).
   */
  static computeFromRawAttempts(rows) {
    const buckets = new Map();
    for (const r of rows) {
      const id = bucketize(r.op, r.lhs, r.rhs);
      if (id == null) continue;
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(r.response_ms);
    }
    const out = new Map();
    for (const [id, times] of buckets) {
      times.sort((a, b) => a - b);
      const mid = Math.floor(times.length / 2);
      const median = times.length % 2 === 1
        ? times[mid]
        : Math.round((times[mid - 1] + times[mid]) / 2);
      out.set(id, { median_ms: median, n: times.length });
    }
    return out;
  }

  /**
   * Reads attempts from the DB, computes medians in JS, UPSERTs cluster_medians,
   * and reloads the in-memory map.
   */
  async refresh() {
    if (!this.pool) throw new Error('MedianCache.refresh requires a pool');
    const { rows } = await this.pool.query(
      `SELECT a.op, a.lhs, a.rhs, a.response_ms
       FROM attempts a
       JOIN runs r ON r.id = a.run_id
       WHERE a.correct = true
         AND COALESCE(r.practice, false) = false`
    );
    const computed = MedianCache.computeFromRawAttempts(rows);
    if (computed.size === 0) {
      // No data yet — leave existing cache as-is, but log.
      if (this.log) this.log.warn('MedianCache.refresh: no attempts to compute medians from');
      return;
    }
    // UPSERT all clusters in a single statement using VALUES.
    const params = [];
    const tuples = [];
    let i = 1;
    for (const [id, { median_ms, n }] of computed) {
      tuples.push(`($${i++}, $${i++}, $${i++})`);
      params.push(id, median_ms, n);
    }
    await this.pool.query(
      `INSERT INTO cluster_medians (cluster_id, median_ms, n) VALUES ${tuples.join(',')}
       ON CONFLICT (cluster_id) DO UPDATE SET
         median_ms = EXCLUDED.median_ms,
         n = EXCLUDED.n,
         refreshed_at = now()`,
      params
    );
    // Reload from the table so the in-memory map is exactly what is persisted.
    const { rows: reloaded } = await this.pool.query(
      `SELECT cluster_id, median_ms, n FROM cluster_medians`
    );
    this.loadFromRows(reloaded);
    if (this.log) this.log.info({ clusters: this._map.size }, 'MedianCache.refresh: complete');
  }

  scheduleDailyRefresh(intervalMs = 24 * 60 * 60 * 1000) {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        if (this.log) this.log.error({ err }, 'MedianCache.refresh failed');
      });
    }, intervalMs);
    this._refreshTimer.unref();
  }

  stop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test test/unit/run-difficulty.test.js`
Expected: PASS — all original tests + 7 new MedianCache tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/run-difficulty/median-cache.js server/test/unit/run-difficulty.test.js 2>/dev/null || true
```

---

## Task 5: Wire `MedianCache` into the app lifecycle

**Files:**
- Modify: `server/src/index.js`

- [ ] **Step 1: Add the import + instantiation in `main()` and pass into `buildApp`**

Edit `server/src/index.js`. The full updated file:

```javascript
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { pathToFileURL } from 'node:url';
import { makePool, migrate } from './db.js';
import { makeAuthHook } from './auth.js';
import { createSessionStore } from './game/session.js';
import { MedianCache } from './run-difficulty/median-cache.js';
import authRoutes from './routes/auth.routes.js';
import playRoutes from './routes/play.routes.js';
import boardRoutes from './routes/board.routes.js';
import practiceRoutes from './routes/practice.routes.js';
import adminRoutes from './routes/admin.routes.js';

export async function buildApp({ pool, cookieSecret, cookieSecure = true, sessionStore, medianCache } = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cookie, { secret: cookieSecret });
  await app.register(rateLimit, { global: false });

  app.addHook('preHandler', makeAuthHook(pool, { cookieSecure }));

  await app.register(authRoutes, { pool, cookieSecure });
  await app.register(playRoutes, { sessionStore, pool, medianCache });
  await app.register(boardRoutes, { pool, sessionStore });
  await app.register(practiceRoutes, { pool, sessionStore });
  await app.register(adminRoutes, { pool, medianCache });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}

async function main() {
  const pool = makePool();
  await migrate(pool);

  const sessionStore = createSessionStore({});
  const evictTimer = setInterval(() => sessionStore.evictExpired(), 60_000);
  evictTimer.unref();

  const medianCache = new MedianCache({ pool });
  // Initial load from cluster_medians (may be empty on first boot).
  const { rows: initialRows } = await pool.query(
    `SELECT cluster_id, median_ms, n FROM cluster_medians`
  );
  medianCache.loadFromRows(initialRows);
  // First-time bootstrap: if the table is empty, do an immediate refresh
  // so new runs starting today get a meaningful difficulty.
  if (initialRows.length === 0) {
    try {
      await medianCache.refresh();
    } catch (err) {
      console.error('initial MedianCache.refresh failed:', err);
    }
  }
  medianCache.scheduleDailyRefresh();

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret || cookieSecret.length < 32) {
    throw new Error('COOKIE_SECRET must be set and >=32 chars');
  }
  const cookieSecure = (process.env.COOKIE_SECURE ?? 'true') !== 'false';

  const app = await buildApp({ pool, cookieSecret, cookieSecure, sessionStore, medianCache });

  app.log.info({ clusters: medianCache.getAll().size }, 'MedianCache loaded');

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      app.log.info(`received ${sig}, shutting down`);
      medianCache.stop();
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

Note: `buildApp` now accepts `medianCache` so tests can pass a fake. `playRoutes` and `adminRoutes` receive it; `boardRoutes` does not (it reads `runs.difficulty` from SQL, no in-memory lookup needed at query time).

- [ ] **Step 2: Update `server/test/integration/helper.js` so `freshApp` provides a `MedianCache`**

Edit `server/test/integration/helper.js`. Add the import and update `freshApp`:

```javascript
import { makePool, migrate } from '../../src/db.js';
import { createSessionStore } from '../../src/game/session.js';
import { buildApp } from '../../src/index.js';
import { MedianCache } from '../../src/run-difficulty/median-cache.js';

const TEST_COOKIE_SECRET = 'a'.repeat(64);

let cachedPool;

export async function getPool() {
  if (cachedPool) return cachedPool;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  process.env.DATABASE_URL = url;
  cachedPool = makePool();
  await migrate(cachedPool);
  return cachedPool;
}

export async function freshApp() {
  const pool = await getPool();
  if (!pool) return null;
  await pool.query('TRUNCATE attempts, runs, auth_sessions, users, cluster_medians RESTART IDENTITY CASCADE');
  const sessionStore = createSessionStore({});
  const medianCache = new MedianCache({ pool });
  medianCache.loadFromRows([]); // empty by default; tests seed via cluster_medians directly or call refresh()
  const app = await buildApp({
    pool,
    cookieSecret: TEST_COOKIE_SECRET,
    cookieSecure: false,
    sessionStore,
    medianCache
  });
  return { app, pool, sessionStore, medianCache };
}

export function cookieFromResponse(res) {
  const header = res.headers['set-cookie'];
  if (!header) return null;
  const arr = Array.isArray(header) ? header : [header];
  for (const c of arr) {
    const m = c.match(/zc_session=([^;]+)/);
    if (m) return `zc_session=${m[1]}`;
  }
  return null;
}

export function skipIfNoDb(t) {
  if (!process.env.TEST_DATABASE_URL) {
    t.skip('TEST_DATABASE_URL not set');
    return true;
  }
  return false;
}
```

- [ ] **Step 3: Run tests to confirm nothing regresses**

Run: `cd server && npm test`
Expected: existing tests still pass (or skip if no `TEST_DATABASE_URL`).

- [ ] **Step 4: Commit**

```bash
git add server/src/index.js server/test/integration/helper.js 2>/dev/null || true
```

---

## Task 6: Use `MedianCache` in `flushRunIfRecording`

**Files:**
- Modify: `server/src/routes/play.routes.js`

- [ ] **Step 1: Update `playRoutes` signature and the INSERT**

The full updated file:

```javascript
import { computeRunDifficulty } from '../run-difficulty/compute.js';

export default async function playRoutes(fastify, { sessionStore, pool, medianCache }) {
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
      question: { prompt: r.question.prompt, op: r.question.op, answer: r.question.answer },
      peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
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
      next_question: { prompt: r.nextQuestion.prompt, op: r.nextQuestion.op, answer: r.nextQuestion.answer },
      peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
      score: r.score,
      time_remaining_ms: r.timeRemainingMs
    };
  });

  async function flushRunIfRecording(req, sessionId) {
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
      const insRun = await client.query(
        'INSERT INTO runs (user_id, score, duration_ms, practice, difficulty) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [rec.userId, rec.score, rec.durationMs, rec.practice, difficulty]
      );
      const runId = Number(insRun.rows[0].id);
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

      const live = sessionStore.get(sessionId);
      if (live) {
        live.runId = runId;
        live.difficulty = difficulty;
      }
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

- [ ] **Step 2: Run tests to confirm existing analytics tests still pass**

Run: `cd server && npm test`
Expected: existing analytics integration tests pass (or skip without DB).

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/play.routes.js 2>/dev/null || true
```

---

## Task 7: Surface `difficulty` in `/api/leaderboard` and submit response

**Files:**
- Modify: `server/src/routes/board.routes.js`

- [ ] **Step 1: Update `/api/leaderboard` SELECT and submit response**

Replace the `/api/leaderboard` handler and update the submit success branch. Full updated file:

```javascript
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

    if (session.practice === true) {
      return { ok: true, practice: true, run_id: session.runId, difficulty: session.difficulty ?? null };
    }

    if (!finished.qualifies) {
      return reply.code(422).send({ error: 'not_eligible', qualifies: false });
    }

    if (session.submitted) {
      return { ok: true, rank: session.lastRank, idempotent: true, difficulty: session.difficulty ?? null };
    }

    if (session.runId == null) {
      return reply.code(409).send({ error: 'not_finalized' });
    }

    await pool.query(
      'UPDATE runs SET submitted_to_leaderboard = true WHERE id = $1',
      [session.runId]
    );

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

    return { ok: true, rank, run_id: session.runId, difficulty: session.difficulty ?? null };
  });

  fastify.get('/api/leaderboard', async () => {
    const { rows } = await pool.query(
      `SELECT u.username, b.score, b.difficulty, b.played_at
       FROM (
         SELECT DISTINCT ON (user_id) user_id, score, difficulty, played_at
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
        difficulty: r.difficulty == null ? null : Number(r.difficulty),
        played_at: r.played_at.toISOString()
      }))
    };
  });

  fastify.get('/api/leaderboard/champion', async () => {
    const { rows } = await pool.query(
      `SELECT u.username, MAX(r.score) AS score
       FROM runs r JOIN users u ON u.id = r.user_id
       WHERE r.submitted_to_leaderboard = true
       GROUP BY u.username
       ORDER BY score DESC
       LIMIT 1`
    );
    if (rows.length === 0) return { champion: null };
    return { champion: { username: rows[0].username, score: Number(rows[0].score) } };
  });

  fastify.get('/api/leaderboard/speed', async () => {
    const MIN_ATTEMPTS = 50;
    const { rows } = await pool.query(
      `WITH per_user_op AS (
         SELECT u.username, a.op,
                AVG(a.response_ms)::int AS avg_ms,
                COUNT(*)::int AS n
         FROM attempts a
         JOIN runs r ON r.id = a.run_id
         JOIN users u ON u.id = r.user_id
         WHERE a.correct = true
           AND COALESCE(r.practice, false) = false
         GROUP BY u.username, a.op
         HAVING COUNT(*) >= $1
       ),
       ranked AS (
         SELECT username, op, avg_ms, n,
                ROW_NUMBER() OVER (PARTITION BY op ORDER BY avg_ms ASC) AS rk
         FROM per_user_op
       )
       SELECT op, username, avg_ms, n, rk
       FROM ranked
       WHERE rk <= 3
       ORDER BY op, rk`,
      [MIN_ATTEMPTS]
    );
    const ops = { add: [], sub: [], mul: [], div: [] };
    for (const r of rows) {
      if (ops[r.op]) ops[r.op].push({ username: r.username, avgMs: r.avg_ms, n: r.n });
    }
    return ops;
  });
}
```

- [ ] **Step 2: Run tests**

Run: `cd server && npm test`
Expected: existing leaderboard tests pass; new `difficulty` field is null for runs without one (existing test data).

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/board.routes.js 2>/dev/null || true
```

---

## Task 8: Admin endpoint — `POST /admin/api/refresh-medians`

**Files:**
- Modify: `server/src/routes/admin.routes.js`

- [ ] **Step 1: Update signature to receive `medianCache` and add the endpoint**

At the top of `server/src/routes/admin.routes.js`, change the signature line:

Find:
```javascript
export default async function adminRoutes(fastify, { pool }) {
```

Replace with:
```javascript
export default async function adminRoutes(fastify, { pool, medianCache }) {
```

Then, inside the function body, immediately after `fastify.addHook('preHandler', requireAdmin);`, add:

```javascript
  fastify.post('/admin/api/refresh-medians', async (req, reply) => {
    if (!medianCache) return reply.code(503).send({ error: 'median_cache_unavailable' });
    try {
      await medianCache.refresh();
      const all = medianCache.getAll();
      return {
        ok: true,
        clusters: all.size,
        medians: Object.fromEntries(all)
      };
    } catch (err) {
      req.log.error({ err }, 'refresh-medians failed');
      return reply.code(500).send({ error: 'refresh_failed' });
    }
  });
```

- [ ] **Step 2: Run tests**

Run: `cd server && npm test`
Expected: existing admin tests still pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/admin.routes.js 2>/dev/null || true
```

---

## Task 9: Integration test — end-to-end run produces difficulty

**Files:**
- Create: `server/test/integration/difficulty.test.js`

- [ ] **Step 1: Write the test**

Create `server/test/integration/difficulty.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { computeRunDifficulty } from '../../src/run-difficulty/compute.js';

async function registerAndLogin(app, username = 'difftester', password = 'password123') {
  const reg = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username, password }
  });
  assert.equal(reg.statusCode, 200, `register failed: ${reg.payload}`);
  const cookie = cookieFromResponse(reg);
  return { cookie, username };
}

test('run insert: difficulty column populated when medianCache has data', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore, medianCache } = await freshApp();
  t.after(() => app.close());

  // Seed cluster_medians directly so the cache has a known fixed value to use.
  await pool.query(
    `INSERT INTO cluster_medians (cluster_id, median_ms, n) VALUES ('add_small', 2000, 100)`
  );
  // Reload the cache from the table.
  const { rows } = await pool.query(`SELECT cluster_id, median_ms, n FROM cluster_medians`);
  medianCache.loadFromRows(rows);

  const { cookie } = await registerAndLogin(app);

  // Start a default-config run.
  const startRes = await app.inject({
    method: 'POST', url: '/api/play/start', headers: { cookie },
    payload: { config: {
      ops: {
        add: { enabled: true, min: 2, max: 100 },
        sub: { enabled: true, min: 2, max: 100 },
        mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
        div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
      },
      durationMs: 120000
    } }
  });
  assert.equal(startRes.statusCode, 200);
  const start = JSON.parse(startRes.payload);
  const sessionId = start.session_id;

  // Answer one question correctly.
  const ans1 = await app.inject({
    method: 'POST', url: '/api/play/answer', headers: { cookie },
    payload: { session_id: sessionId, answer: String(start.question.answer) }
  });
  assert.equal(ans1.statusCode, 200);

  // Force time-up and trigger the flush.
  const sess = sessionStore.get(sessionId);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  const flushRes = await app.inject({
    method: 'POST', url: '/api/play/answer', headers: { cookie },
    payload: { session_id: sessionId, answer: '' }
  });
  assert.equal(flushRes.statusCode, 200);
  assert.equal(JSON.parse(flushRes.payload).time_up, true);

  // Verify the runs row has a non-null difficulty.
  const { rows: runRows } = await pool.query(
    `SELECT difficulty FROM runs ORDER BY id DESC LIMIT 1`
  );
  assert.equal(runRows.length, 1);
  assert.notEqual(runRows[0].difficulty, null);

  // Verify it equals what computeRunDifficulty produces for the stored attempts.
  const { rows: attempts } = await pool.query(
    `SELECT op, lhs, rhs, response_ms, correct FROM attempts WHERE run_id = (SELECT MAX(id) FROM runs)`
  );
  const expected = computeRunDifficulty(attempts, medianCache);
  assert.equal(Number(runRows[0].difficulty), expected);
});

test('GET /api/leaderboard: returns difficulty per entry', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, medianCache } = await freshApp();
  t.after(() => app.close());

  await pool.query(`INSERT INTO cluster_medians (cluster_id, median_ms, n) VALUES ('add_small', 2000, 100)`);
  medianCache.loadFromRows((await pool.query(`SELECT cluster_id, median_ms, n FROM cluster_medians`)).rows);

  // Seed a user + a submitted run with a known difficulty.
  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('alice', 'x')`);
  await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, submitted_to_leaderboard, difficulty)
     VALUES ((SELECT id FROM users WHERE username='alice'), 42, 120000, true, 5.55)`
  );

  const lbRes = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  const lb = JSON.parse(lbRes.payload);
  const alice = lb.entries.find(e => e.username === 'alice');
  assert.ok(alice);
  assert.equal(alice.difficulty, 5.55);
});

test('MedianCache.refresh: roundtrip with seeded attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, medianCache } = await freshApp();
  t.after(() => app.close());

  // Seed: a non-practice user + run with 5 attempts in add_small at 2000ms each.
  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('bob', 'x')`);
  const { rows: rRow } = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice) VALUES
     ((SELECT id FROM users WHERE username='bob'), 5, 120000, false) RETURNING id`
  );
  const runId = rRow[0].id;
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
       VALUES ($1, $2, 'add', 5, 5, 10, '10', $3, true, now())`,
      [runId, i, 2000]
    );
  }
  // A practice run that should be excluded.
  const { rows: pRow } = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice) VALUES
     ((SELECT id FROM users WHERE username='bob'), 5, 120000, true) RETURNING id`
  );
  await pool.query(
    `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
     VALUES ($1, 0, 'add', 5, 5, 10, '10', 99999, true, now())`,
    [pRow[0].id]
  );
  // A wrong attempt that should be excluded.
  await pool.query(
    `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
     VALUES ($1, 5, 'add', 5, 5, 10, '11', 99999, false, now())`,
    [runId]
  );

  await medianCache.refresh();
  assert.equal(medianCache.get('add_small'), 2000);
});
```

- [ ] **Step 2: Run tests**

Run (with a test DB): `TEST_DATABASE_URL=postgres://... cd server && node --test test/integration/difficulty.test.js`
Expected: all 3 tests pass. Without `TEST_DATABASE_URL` they skip cleanly.

- [ ] **Step 3: Commit**

```bash
git add server/test/integration/difficulty.test.js 2>/dev/null || true
```

---

## Task 10: Backfill script

**Files:**
- Create: `server/scripts/backfill-difficulty.js`

- [ ] **Step 1: Write the script**

Create `server/scripts/backfill-difficulty.js`:

```javascript
#!/usr/bin/env node
/**
 * One-shot: compute and store difficulty for every runs row where it is null.
 * Idempotent — re-running only touches still-null rows.
 *
 * Usage on the VPS:
 *   sudo -u zetachad node --env-file=/etc/zetachad/env server/scripts/backfill-difficulty.js
 */
import { makePool } from '../src/db.js';
import { MedianCache } from '../src/run-difficulty/median-cache.js';
import { computeRunDifficulty } from '../src/run-difficulty/compute.js';

async function main() {
  const pool = makePool();
  try {
    const medianCache = new MedianCache({ pool });
    // Make sure the cache is fresh before backfilling.
    const { rows: existing } = await pool.query(`SELECT cluster_id, median_ms, n FROM cluster_medians`);
    medianCache.loadFromRows(existing);
    if (existing.length === 0) {
      console.log('cluster_medians empty — running initial refresh');
      await medianCache.refresh();
    }

    const { rows: runs } = await pool.query(
      `SELECT id FROM runs WHERE difficulty IS NULL ORDER BY id ASC`
    );
    console.log(`Found ${runs.length} runs needing backfill`);

    let updated = 0;
    let skipped = 0;
    for (const r of runs) {
      const { rows: attempts } = await pool.query(
        `SELECT op, lhs, rhs, response_ms, correct FROM attempts WHERE run_id = $1`,
        [r.id]
      );
      const d = computeRunDifficulty(attempts, medianCache);
      if (d == null) {
        skipped++;
        continue;
      }
      await pool.query(`UPDATE runs SET difficulty = $1 WHERE id = $2`, [d, r.id]);
      updated++;
      if (updated % 100 === 0) console.log(`  ${updated} updated...`);
    }
    console.log(`Backfill complete. Updated: ${updated}. Skipped: ${skipped}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Verify the script parses (no execution without a DB)**

Run: `cd server && node --check scripts/backfill-difficulty.js`
Expected: no output (parse OK).

- [ ] **Step 3: Commit**

```bash
git add server/scripts/backfill-difficulty.js 2>/dev/null || true
```

---

## Task 11: Frontend — leaderboard Diff column

**Files:**
- Modify: `client/leaderboard.html`
- Modify: `client/js/leaderboard.js`
- Modify: `client/css/styles.css`

- [ ] **Step 1: Add the column header in `client/leaderboard.html`**

Find:
```html
      <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Played</th></tr></thead>
      <tbody id="rows"><tr><td colspan="4">Loading…</td></tr></tbody>
```

Replace with:
```html
      <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Diff</th><th>Played</th></tr></thead>
      <tbody id="rows"><tr><td colspan="5">Loading…</td></tr></tbody>
```

- [ ] **Step 2: Render the cell in `client/js/leaderboard.js`**

Find the `rowsHtml` function and replace with:

```javascript
function rowsHtml(entries, me) {
  if (entries.length === 0) {
    return `<tr><td colspan="5">No scores yet — be the first.</td></tr>`;
  }
  return entries.map((e) => {
    const youClass = me && e.username === me.username ? ' class="you"' : '';
    const diffCell = formatDiff(e.difficulty);
    return `<tr${youClass}>
      <td data-label="#">${e.rank}</td>
      <td data-label="Player">${escapeHtml(e.username)}</td>
      <td data-label="Score">${e.score}</td>
      <td data-label="Diff">${diffCell}</td>
      <td data-label="Played">${fmtDate(e.played_at)}</td>
    </tr>`;
  }).join('');
}

function formatDiff(d) {
  if (d == null) return `<span class="diff-cell diff-na">—</span>`;
  const tier = d <= 4 ? 'easy' : d <= 6 ? 'mid' : d <= 8 ? 'hard' : 'extreme';
  return `<span class="diff-cell diff-${tier}">${d.toFixed(1)}</span>`;
}
```

Also update the error fallback rowspan: find `<tr><td colspan="4">Could not load:` and change to `colspan="5"`.

- [ ] **Step 3: Add CSS**

Append to `client/css/styles.css`:

```css
/* Leaderboard difficulty column */
.diff-cell {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  padding: 0.1rem 0.35rem;
  border-radius: 2px;
  display: inline-block;
}
.diff-cell.diff-easy    { color: var(--lime); }
.diff-cell.diff-mid     { color: var(--cyan); }
.diff-cell.diff-hard    { color: var(--magenta); }
.diff-cell.diff-extreme { color: var(--orange); }
.diff-cell.diff-na      { color: var(--ink-faint); font-weight: 400; }
```

- [ ] **Step 4: Visually verify (manual)**

If a local server is available: `cd server && npm run dev` and open `http://localhost:3000/leaderboard.html`. Check:
- Existing entries render with `—` (since their difficulty is null pre-backfill).
- After Task 14 deploy + backfill: real values render with the right colors.

- [ ] **Step 5: Commit**

```bash
git add client/leaderboard.html client/js/leaderboard.js client/css/styles.css 2>/dev/null || true
```

---

## Task 12: Frontend — post-run summary line

**Files:**
- Modify: `client/play.html`
- Modify: `client/js/play.js`

- [ ] **Step 1: Add the placeholder element in `client/play.html`**

Find:
```html
    <section id="score-screen" class="hidden narrow">
      <h1>Time!</h1>
      <div class="big-score" id="final-score">0</div>
      <div id="post-note" class="score-note"></div>
```

Replace with:
```html
    <section id="score-screen" class="hidden narrow">
      <h1>Time!</h1>
      <div class="big-score" id="final-score">0</div>
      <div id="run-difficulty" class="run-difficulty hidden"></div>
      <div id="post-note" class="score-note"></div>
```

- [ ] **Step 2: Populate the difficulty in the finish + submit paths in `client/js/play.js`**

Add a helper at the bottom of `client/js/play.js`:

```javascript
function showDifficulty(d) {
  const el = document.getElementById('run-difficulty');
  if (!el) return;
  if (d == null) {
    el.classList.add('hidden');
    return;
  }
  const tier = d <= 4 ? 'easy' : d <= 6 ? 'mid' : d <= 8 ? 'hard' : 'extreme';
  el.className = `run-difficulty diff-${tier}`;
  el.textContent = `Run difficulty: ${d.toFixed(1)} / 10`;
}
```

In the existing `finish` function, after `els.scoreScreen().classList.remove('hidden');`, add:

```javascript
  // Difficulty for practice runs comes from the implicit submit below; for normal
  // runs it comes from the user's manual submit. In both cases we wait for the
  // submit response. Until then, hide the row.
  showDifficulty(null);
```

Inside the practice branch, change:
```javascript
    api.submit(state.sessionId).catch(() => {});
```

to:
```javascript
    api.submit(state.sessionId).then((r) => {
      showDifficulty(r?.difficulty ?? null);
    }).catch(() => {});
```

Inside `showSubmitModal`, find the line:
```javascript
      els.postNote().textContent = `Submitted! You are #${r.rank}.`;
```

and add immediately after it:
```javascript
      showDifficulty(r?.difficulty ?? null);
```

- [ ] **Step 3: Add CSS for `.run-difficulty`**

Append to `client/css/styles.css`:

```css
.run-difficulty {
  font-family: var(--font-mono);
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-align: center;
  margin: 0.5rem 0 0.75rem;
}
.run-difficulty.diff-easy    { color: var(--lime); }
.run-difficulty.diff-mid     { color: var(--cyan); }
.run-difficulty.diff-hard    { color: var(--magenta); }
.run-difficulty.diff-extreme { color: var(--orange); }
```

- [ ] **Step 4: Visually verify (manual)**

If a local server is available, do a default-config run, submit, and confirm the difficulty line appears below the score with the right color.

- [ ] **Step 5: Commit**

```bash
git add client/play.html client/js/play.js client/css/styles.css 2>/dev/null || true
```

---

## Task 13: Verify deploy script ships new files

**Files:**
- Read-only review: `deploy/deploy-scp.sh`

- [ ] **Step 1: Read the deploy script**

Open `deploy/deploy-scp.sh`. The current "Sync server" block does `scp -r -q server/src` and `scp -r -q server/migrations`. This already covers:
- `server/src/run-difficulty/` (new directory, ships with `src/`)
- `server/migrations/007_*.sql` and `008_*.sql` (ship with `migrations/`)

For the script directory `server/scripts/`, check the deploy script:

Run: `grep -n "scripts" deploy/deploy-scp.sh || echo "scripts NOT in deploy"`

If `scripts NOT in deploy`, add a line. Otherwise, this step is a no-op.

- [ ] **Step 2: Add scripts/ sync if missing**

If the previous step printed `scripts NOT in deploy`, add a sync line. Find:

```bash
echo "==> Sync server"
ssh "$VPS_HOST" "rm -rf /srv/zetachad/server/src /srv/zetachad/server/migrations"
scp -q server/package.json server/package-lock.json "$VPS_HOST:/srv/zetachad/server/"
scp -r -q server/src "$VPS_HOST:/srv/zetachad/server/src"
scp -r -q server/migrations "$VPS_HOST:/srv/zetachad/server/migrations"
```

Replace with:

```bash
echo "==> Sync server"
ssh "$VPS_HOST" "rm -rf /srv/zetachad/server/src /srv/zetachad/server/migrations /srv/zetachad/server/scripts"
scp -q server/package.json server/package-lock.json "$VPS_HOST:/srv/zetachad/server/"
scp -r -q server/src "$VPS_HOST:/srv/zetachad/server/src"
scp -r -q server/migrations "$VPS_HOST:/srv/zetachad/server/migrations"
scp -r -q server/scripts "$VPS_HOST:/srv/zetachad/server/scripts"
```

- [ ] **Step 3: Commit**

```bash
git add deploy/deploy-scp.sh 2>/dev/null || true
```

---

## Task 14: Deploy + run backfill on production

**Files:** No code changes — operational only.

- [ ] **Step 1: Run the deploy script**

Run from project root in Git Bash (per memory `reference_zetachad_deploy.md`):

```bash
VPS_HOST=root@87.99.158.208 bash deploy/deploy-scp.sh
```

Expected: prints `==> Done`. The script applies migrations via `node src/db.js` and restarts the service.

If `scp: Connection closed` or `Connection reset by peer` mid-run (known flakiness — happened during the speed-kings deploy), the safest recovery is to wait 30 seconds and re-run the whole script. Re-running is safe because `mkdir -p` and migrations are idempotent.

- [ ] **Step 2: Verify endpoints**

Run:
```bash
curl -s https://zetachad.duckdns.org/api/leaderboard | head -c 400
```

Expected: JSON entries each include `"difficulty": null` (pre-backfill) or a number.

- [ ] **Step 3: Run the backfill on the VPS**

Run:
```bash
ssh root@87.99.158.208 "cd /srv/zetachad/server && sudo -u zetachad node --env-file=/etc/zetachad/env scripts/backfill-difficulty.js"
```

Expected output:
```
Found N runs needing backfill
  100 updated...
Backfill complete. Updated: N. Skipped: 0.
```

- [ ] **Step 4: Verify backfill landed**

Run:
```bash
ssh root@87.99.158.208 "sudo -u zetachad psql -d zetachad -c \"SELECT COUNT(*) FROM runs WHERE difficulty IS NULL\""
```

Expected: `0` (or close to 0 — a run with all `bucketize`-null attempts would stay null, very rare).

- [ ] **Step 5: Visually verify**

Open `https://zetachad.duckdns.org/leaderboard.html`. Diff column should show colored values per row.

- [ ] **Step 6: Commit changelog if you keep one**

```bash
git add . 2>/dev/null || true
```

---

## Definition of done

- All migrations applied on production.
- All unit tests pass (`cd server && node --test test/unit/`).
- Integration tests pass with a `TEST_DATABASE_URL` set.
- Live `/api/leaderboard` returns `difficulty` for each entry.
- Live `leaderboard.html` shows the Diff column with color-coded values.
- Live post-run summary shows "Run difficulty: X.X / 10" after submit.
- `cluster_medians` table populated with 18 rows (or however many clusters have data).
- `runs.difficulty` populated for ≥99% of historical runs.
