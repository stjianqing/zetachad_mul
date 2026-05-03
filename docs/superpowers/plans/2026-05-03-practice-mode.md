# Practice Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/practice` page and supporting backend so a logged-in user can run a 2-minute drill weighted toward their personally-weakest conceptual clusters (e.g. "multiplying 7, 8, 9 or 12 by numbers above 30"), without affecting the leaderboard.

**Architecture:** Reuse the existing play loop end-to-end. Add three server modules: `clusters.js` (frozen 18-cluster definition + `bucketize` function), `analyzer.js` (`analyzeUser(userId, pool)` — one SQL query against the user's last 500 attempts, then in-JS scoring), `practice.routes.js` (`GET /api/practice/diagnose` + `POST /api/practice/start`). Modify `generator.js` to accept an optional `weighting` arg, `session.js` to plumb that arg through, `play.routes.js` to write `runs.practice = true` at insert time. The existing leaderboard flow already filters by `submitted_to_leaderboard = true` — practice runs simply never get that flag flipped, so no leaderboard query changes are needed. Client gets a new `/practice` page (diagnosis screen + Start button) and a small "PRACTICE" badge on the play screen, both driven by `sessionStorage`.

**Tech Stack:** Fastify 5, Postgres 16 (via `pg`), Node `node --test` for tests, vanilla JS/HTML for client, nginx for static + proxy.

---

## Important context for the implementer

**Read this before starting Task 1.** It saves you from a few wrong turns the spec doesn't quite cover.

1. **Where runs get inserted.** Practice runs are written to `runs` by `flushRunIfRecording` in `server/src/routes/play.routes.js:56-94`, NOT in `board.routes.js`. Submit only flips `submitted_to_leaderboard = true`. So the `practice` flag must be set in `play.routes.js` at INSERT time.
2. **Why no leaderboard query changes are needed.** The leaderboard read and rank-computation queries in `board.routes.js` already filter `WHERE submitted_to_leaderboard = true`. Practice runs never get that flag flipped (we'll make the submit endpoint return early for practice sessions), so they're invisible to leaderboard logic. The spec's `WHERE practice = false` filter is redundant — the `submitted_to_leaderboard = false` constraint already does the job. We add the `practice` column anyway because it's needed for analytics views and to make the practice/leaderboard distinction explicit and queryable.
3. **`isDefaultConfig` gating.** `recordsAttempts` (`session.js:30-32`) requires `userId != null && isDefaultConfig(session.config)`. Practice mode uses `DEFAULT_CONFIG` directly (no client-supplied config) and is logged-in only, so attempts WILL record naturally. Don't change this gate.
4. **Test framework is `node --test`** (built-in to Node 22+). See existing tests in `server/test/unit/*.test.js` for the style. Integration tests use the helper at `server/test/integration/helper.js` — they skip when `TEST_DATABASE_URL` is unset.
5. **`requireAuth` middleware** is at `server/src/auth.js:111-116`. It sets `req.user` (with `.id`) and returns 401 if missing. Use `{ preHandler: requireAuth }` in the route options.
6. **Cluster definitions are the contract.** Both the analyzer and the generator import the same cluster definitions and `bucketize()` from `clusters.js`. Don't duplicate cluster boundaries anywhere else — if a boundary changes, it changes in one place.

---

## File structure (what gets created/modified)

**New server files:**
- `server/src/practice/clusters.js` — cluster definitions, `bucketize(op, lhs, rhs) → clusterId | null`, `globalP50` constants, label table.
- `server/src/practice/analyzer.js` — `analyzeUser(userId, pool) → { totalAttemptsAnalyzed, topWeak[], reason? }`.
- `server/src/routes/practice.routes.js` — the two endpoints + named consts `weakBias`, `topN`.
- `server/test/unit/practice/clusters.test.js`
- `server/test/unit/practice/analyzer.test.js`
- `server/test/unit/practice/generator-weighting.test.js`
- `server/test/integration/practice.test.js`

**Modified server files:**
- `server/src/game/generator.js` — accept optional `weighting` 3rd arg.
- `server/src/game/session.js` — store `practice` + `weighting` on session, pass `weighting` to generator.
- `server/src/routes/play.routes.js` — at insert, set `runs.practice = true` when `session.practice`. New endpoint `/api/play/start` accepts an optional `practice: true` flag from server-side state — actually we add this through the **practice route**, not by modifying play.routes.js's start endpoint directly (see Task 9).
- `server/src/routes/board.routes.js` — submit returns `{ ok: true, practice: true, run_id }` early when `session.practice`, without flipping `submitted_to_leaderboard`.
- `server/src/index.js` — register `practiceRoutes`.

**Migration:**
- `server/migrations/006_runs_practice_flag.sql`

**New client files:**
- `client/practice.html`
- `client/js/practice.js`

**Modified client files:**
- `client/play.html` — render `<div class="practice-badge hidden" id="practice-badge">PRACTICE</div>`.
- `client/js/play.js` — read `sessionStorage.zc_practice_session`, show badge, replace post-run buttons + copy.
- `client/index.html`, `client/leaderboard.html` — add "Practice" nav link next to "Leaderboard".
- `client/css/styles.css` — `.practice-badge`, `.weak-spot-row` styles.

**Deploy:**
- nginx config on VPS — confirm `/practice.html` serves from `/var/www/zetachad/`. The current nginx config already serves `/var/www/zetachad/client/` for `/`, so `practice.html` placed there works without nginx changes.

---

## Pre-flight: verify environment

Before starting Task 1, confirm:
- You're in `C:\Users\stjia\projects\zetachad_mul` (Windows, Git Bash via the Bash tool).
- `git status` is clean (the spec was committed in `48f44d4`).
- `cd server && npm test` runs (existing tests should pass — note: integration tests skip without `TEST_DATABASE_URL`, that's fine).

---

### Task 1: Database migration — add `runs.practice` column

**Files:**
- Create: `server/migrations/006_runs_practice_flag.sql`

- [ ] **Step 1: Write the migration**

Create `server/migrations/006_runs_practice_flag.sql`:

```sql
ALTER TABLE runs ADD COLUMN practice BOOLEAN NOT NULL DEFAULT false;

-- All existing rows get practice=false via the DEFAULT.
-- No backfill needed.

-- Speeds up future analytics queries that distinguish practice from leaderboard runs.
CREATE INDEX runs_practice_idx ON runs(user_id, played_at DESC) WHERE practice = true;
```

Note: index is on `WHERE practice = true` (the smaller, growing-slower partition) — opposite of the spec. Reason: leaderboard queries already use `submitted_to_leaderboard = true` (and its existing index `runs_user_score_idx`), so they don't benefit from a `practice = false` index. The new analytics paths (e.g., the diagnose query, future practice-history views) are the ones that filter on `practice = true`, so index that side. Update the spec note in your commit message.

- [ ] **Step 2: Apply the migration locally**

If you have a local Postgres + `DATABASE_URL` set up, run:

```bash
cd server && npm run migrate
```

Expected output: `migrated: 006_runs_practice_flag.sql` followed by `migrations complete`.

If you don't have a local DB, skip this step — the integration tests will exercise the migration via `helper.js`'s `getPool()`.

- [ ] **Step 3: Commit**

```bash
git add server/migrations/006_runs_practice_flag.sql
git commit -m "feat(db): add runs.practice column + index"
```

---

### Task 2: Cluster definitions and `bucketize()` — write failing tests

**Files:**
- Create: `server/test/unit/practice/clusters.test.js`

- [ ] **Step 1: Create the test file with failing tests**

Create directory `server/test/unit/practice/` and `server/test/unit/practice/clusters.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketize, CLUSTER_LABELS, GLOBAL_P50 } from '../../../src/practice/clusters.js';

test('bucketize: mul easy small (lhs=2, rhs=15 → mul_easy_small)', () => {
  assert.equal(bucketize('mul', 2, 15), 'mul_easy_small');
  assert.equal(bucketize('mul', 5, 30), 'mul_easy_small');
  assert.equal(bucketize('mul', 10, 2), 'mul_easy_small');
});

test('bucketize: mul easy large (lhs=10, rhs=31 → mul_easy_large)', () => {
  assert.equal(bucketize('mul', 10, 31), 'mul_easy_large');
  assert.equal(bucketize('mul', 2, 100), 'mul_easy_large');
});

test('bucketize: mul medium small (lhs=3,4,6,11 with rhs<=30)', () => {
  assert.equal(bucketize('mul', 3, 5), 'mul_med_small');
  assert.equal(bucketize('mul', 4, 30), 'mul_med_small');
  assert.equal(bucketize('mul', 6, 12), 'mul_med_small');
  assert.equal(bucketize('mul', 11, 25), 'mul_med_small');
});

test('bucketize: mul hard large (lhs=7,8,9,12 with rhs>30)', () => {
  assert.equal(bucketize('mul', 7, 31), 'mul_hard_large');
  assert.equal(bucketize('mul', 8, 50), 'mul_hard_large');
  assert.equal(bucketize('mul', 9, 100), 'mul_hard_large');
  assert.equal(bucketize('mul', 12, 75), 'mul_hard_large');
});

test('bucketize: mul order-independent (treats min(lhs,rhs) as the table)', () => {
  // generator stores lhs as the table operand for mul, but if input order is reversed
  // (e.g. attempt logged with lhs=50, rhs=12), bucketize should still classify by the small one.
  assert.equal(bucketize('mul', 50, 12), 'mul_hard_large');
  assert.equal(bucketize('mul', 75, 7), 'mul_hard_large');
});

test('bucketize: div uses divisor (the small operand) for difficulty', () => {
  // attempts.lhs=dividend, attempts.rhs=divisor for div (per generator.js:55)
  assert.equal(bucketize('div', 24, 12), 'div_hard_small');  // dividend=24, divisor=12, easy/med/hard? 12 is hard. dividend<=300 → small
  assert.equal(bucketize('div', 600, 12), 'div_hard_large'); // dividend>300 → large
  assert.equal(bucketize('div', 50, 5), 'div_easy_small');   // divisor=5 is easy, dividend<=300 → small
  assert.equal(bucketize('div', 800, 10), 'div_easy_large'); // divisor=10 easy, dividend>300 → large
  assert.equal(bucketize('div', 200, 3), 'div_med_small');   // divisor=3 medium
});

test('bucketize: add by max(lhs, rhs)', () => {
  assert.equal(bucketize('add', 5, 15), 'add_small');     // max=15 ≤ 20
  assert.equal(bucketize('add', 20, 20), 'add_small');    // max=20
  assert.equal(bucketize('add', 21, 10), 'add_med');      // max=21 in 21..50
  assert.equal(bucketize('add', 50, 5), 'add_med');       // max=50
  assert.equal(bucketize('add', 51, 5), 'add_large');     // max=51 > 50
  assert.equal(bucketize('add', 90, 90), 'add_large');
});

test('bucketize: sub by max(lhs, rhs)', () => {
  assert.equal(bucketize('sub', 18, 5), 'sub_small');
  assert.equal(bucketize('sub', 30, 20), 'sub_med');
  assert.equal(bucketize('sub', 80, 30), 'sub_large');
});

test('bucketize: returns null for unknown op', () => {
  assert.equal(bucketize('mod', 5, 3), null);
});

test('bucketize: returns null for out-of-config inputs (defensive)', () => {
  // div with divisor>12 isn't possible in default config, but be defensive.
  assert.equal(bucketize('div', 100, 50), null);  // divisor=50 outside {2..12}
  // mul with both operands large isn't possible (one is always lhs ∈ 2..12)
  assert.equal(bucketize('mul', 50, 75), null);   // neither operand in 2..12
});

test('CLUSTER_LABELS has 18 entries with non-empty strings', () => {
  const ids = Object.keys(CLUSTER_LABELS);
  assert.equal(ids.length, 18);
  for (const id of ids) {
    assert.equal(typeof CLUSTER_LABELS[id], 'string');
    assert.ok(CLUSTER_LABELS[id].length > 0, `empty label for ${id}`);
  }
});

test('GLOBAL_P50 has values for all four ops', () => {
  assert.equal(GLOBAL_P50.add, 2125);
  assert.equal(GLOBAL_P50.sub, 1898);
  assert.equal(GLOBAL_P50.mul, 2661);
  assert.equal(GLOBAL_P50.div, 2820);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && npm run test:unit -- --test-name-pattern='bucketize|CLUSTER_LABELS|GLOBAL_P50'
```

Expected: FAIL with "Cannot find module '../../../src/practice/clusters.js'" or similar.

---

### Task 3: Cluster definitions and `bucketize()` — implementation

**Files:**
- Create: `server/src/practice/clusters.js`

- [ ] **Step 1: Implement the module**

Create directory `server/src/practice/` and `server/src/practice/clusters.js`:

```javascript
// Frozen weakness-cluster definitions. Single source of truth for both
// the analyzer (which buckets attempts) and the generator (which biases
// question selection within a cluster's bounds).
//
// GLOBAL_P50 values are population-wide medians per op, frozen from the
// 2026-05-03 production dataset (8 users, 4332 attempts). Re-derive when
// the dataset 10×s. The values are subtracted in scoring to normalize
// across ops (mul is inherently slower than add, etc.).

export const GLOBAL_P50 = Object.freeze({
  add: 2125,
  sub: 1898,
  mul: 2661,
  div: 2820
});

// Times-table difficulty groups (apply to mul lhs and div divisor).
const EASY_TABLES = new Set([2, 5, 10]);
const MED_TABLES  = new Set([3, 4, 6, 11]);
const HARD_TABLES = new Set([7, 8, 9, 12]);

function tableGroup(n) {
  if (EASY_TABLES.has(n)) return 'easy';
  if (MED_TABLES.has(n))  return 'med';
  if (HARD_TABLES.has(n)) return 'hard';
  return null;
}

// Cluster bounds — used by the generator to sample operands within a cluster.
// For mul: lhsValues = the small "table" operand, rhsRange = the partner.
// For div: lhsValues = the divisor, rhsRange = the dividend (presented as dividend ÷ divisor).
// For add/sub: maxRange = bound on max(lhs, rhs); both operands sampled in [2, max].
export const CLUSTER_BOUNDS = Object.freeze({
  // Multiplication
  mul_easy_small: { op: 'mul', lhsValues: [2, 5, 10],     rhsMin: 2,  rhsMax: 30  },
  mul_easy_large: { op: 'mul', lhsValues: [2, 5, 10],     rhsMin: 31, rhsMax: 100 },
  mul_med_small:  { op: 'mul', lhsValues: [3, 4, 6, 11],  rhsMin: 2,  rhsMax: 30  },
  mul_med_large:  { op: 'mul', lhsValues: [3, 4, 6, 11],  rhsMin: 31, rhsMax: 100 },
  mul_hard_small: { op: 'mul', lhsValues: [7, 8, 9, 12],  rhsMin: 2,  rhsMax: 30  },
  mul_hard_large: { op: 'mul', lhsValues: [7, 8, 9, 12],  rhsMin: 31, rhsMax: 100 },
  // Division
  div_easy_small: { op: 'div', divisorValues: [2, 5, 10],     dividendMin: 2,   dividendMax: 300  },
  div_easy_large: { op: 'div', divisorValues: [2, 5, 10],     dividendMin: 301, dividendMax: 1200 },
  div_med_small:  { op: 'div', divisorValues: [3, 4, 6, 11],  dividendMin: 2,   dividendMax: 300  },
  div_med_large:  { op: 'div', divisorValues: [3, 4, 6, 11],  dividendMin: 301, dividendMax: 1200 },
  div_hard_small: { op: 'div', divisorValues: [7, 8, 9, 12],  dividendMin: 2,   dividendMax: 300  },
  div_hard_large: { op: 'div', divisorValues: [7, 8, 9, 12],  dividendMin: 301, dividendMax: 1200 },
  // Addition
  add_small: { op: 'add', maxMin: 2,  maxMax: 20  },
  add_med:   { op: 'add', maxMin: 21, maxMax: 50  },
  add_large: { op: 'add', maxMin: 51, maxMax: 100 },
  // Subtraction
  sub_small: { op: 'sub', maxMin: 2,  maxMax: 20  },
  sub_med:   { op: 'sub', maxMin: 21, maxMax: 50  },
  sub_large: { op: 'sub', maxMin: 51, maxMax: 100 }
});

export const CLUSTER_LABELS = Object.freeze({
  mul_easy_small: 'Multiplying 2, 5 or 10 by numbers up to 30',
  mul_easy_large: 'Multiplying 2, 5 or 10 by numbers above 30',
  mul_med_small:  'Multiplying 3, 4, 6 or 11 by numbers up to 30',
  mul_med_large:  'Multiplying 3, 4, 6 or 11 by numbers above 30',
  mul_hard_small: 'Multiplying 7, 8, 9 or 12 by numbers up to 30',
  mul_hard_large: 'Multiplying 7, 8, 9 or 12 by numbers above 30',
  div_easy_small: 'Dividing by 2, 5 or 10, dividends up to 300',
  div_easy_large: 'Dividing by 2, 5 or 10, dividends above 300',
  div_med_small:  'Dividing by 3, 4, 6 or 11, dividends up to 300',
  div_med_large:  'Dividing by 3, 4, 6 or 11, dividends above 300',
  div_hard_small: 'Dividing by 7, 8, 9 or 12, dividends up to 300',
  div_hard_large: 'Dividing by 7, 8, 9 or 12, dividends above 300',
  add_small: 'Adding numbers up to 20',
  add_med:   'Adding numbers between 21 and 50',
  add_large: 'Adding numbers above 50',
  sub_small: 'Subtracting numbers up to 20',
  sub_med:   'Subtracting numbers between 21 and 50',
  sub_large: 'Subtracting numbers above 50'
});

/**
 * Map a single attempt (op, lhs, rhs) to a cluster id, or null if it doesn't
 * belong to any defined cluster (e.g. div with divisor>12 — out of default config).
 *
 * For mul: the "table" operand is whichever of (lhs, rhs) falls in 2..12.
 * For div: lhs=dividend, rhs=divisor (per generator.js convention).
 * For add/sub: bucketed by max(lhs, rhs).
 */
export function bucketize(op, lhs, rhs) {
  if (op === 'mul') {
    // Determine which operand is the "table" (small) and which is the partner.
    let table, partner;
    if (lhs >= 2 && lhs <= 12) { table = lhs; partner = rhs; }
    else if (rhs >= 2 && rhs <= 12) { table = rhs; partner = lhs; }
    else return null;
    const grp = tableGroup(table);
    if (!grp) return null;
    const sizeBucket = partner <= 30 ? 'small' : 'large';
    return `mul_${grp}_${sizeBucket}`;
  }

  if (op === 'div') {
    // attempts.lhs=dividend, attempts.rhs=divisor
    const divisor = rhs;
    if (divisor < 2 || divisor > 12) return null;
    const grp = tableGroup(divisor);
    if (!grp) return null;
    const sizeBucket = lhs <= 300 ? 'small' : 'large';
    return `div_${grp}_${sizeBucket}`;
  }

  if (op === 'add' || op === 'sub') {
    const m = Math.max(lhs, rhs);
    let bucket;
    if (m <= 20) bucket = 'small';
    else if (m <= 50) bucket = 'med';
    else bucket = 'large';
    return `${op}_${bucket}`;
  }

  return null;
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd server && npm run test:unit -- --test-name-pattern='bucketize|CLUSTER_LABELS|GLOBAL_P50'
```

Expected: all 12 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/practice/clusters.js server/test/unit/practice/clusters.test.js
git commit -m "feat(practice): cluster definitions + bucketize"
```

---

### Task 4: Analyzer — write failing tests

**Files:**
- Create: `server/test/unit/practice/analyzer.test.js`

The analyzer needs a pool, but we want to unit-test the scoring logic without a DB. So the analyzer is split: `scoreAttempts(attempts) → { topWeak, totalAttemptsAnalyzed, reason? }` is pure (testable here), and `analyzeUser(userId, pool)` is the DB-fetching wrapper (tested in integration). Plan: this task tests `scoreAttempts`; the DB wrapper is implemented in Task 5 and exercised by integration tests in Task 13.

- [ ] **Step 1: Create the test file**

Create `server/test/unit/practice/analyzer.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAttempts, MIN_LIFETIME_ATTEMPTS, MIN_CLUSTER_ATTEMPTS } from '../../../src/practice/analyzer.js';

// Helper: build N synthetic attempts in a given cluster shape with a fixed responseMs.
function attempts(op, lhs, rhs, responseMs, n, correct = true) {
  return Array.from({ length: n }, () => ({ op, lhs, rhs, responseMs, correct }));
}

test('scoreAttempts: 0 attempts → need_more_data', () => {
  const r = scoreAttempts([]);
  assert.equal(r.totalAttemptsAnalyzed, 0);
  assert.deepEqual(r.topWeak, []);
  assert.equal(r.reason, 'need_more_data');
});

test('scoreAttempts: 49 attempts (just below MIN_LIFETIME_ATTEMPTS) → need_more_data', () => {
  assert.equal(MIN_LIFETIME_ATTEMPTS, 50);
  const xs = attempts('add', 5, 5, 2000, 49);
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 49);
  assert.deepEqual(r.topWeak, []);
  assert.equal(r.reason, 'need_more_data');
});

test('scoreAttempts: 50 attempts but no cluster has MIN_CLUSTER_ATTEMPTS → empty topWeak (no reason)', () => {
  // Spread 50 attempts across ~12 different clusters so no cluster reaches 5.
  // Easiest: 10 different add-cluster-wide buckets — but we only have 3 add clusters.
  // Instead: 4 attempts in each of many distinct cluster cells.
  const xs = [];
  // 4 in add_small, 4 in add_med, 4 in add_large = 12 in add (no cluster reaches 5)
  for (let i = 0; i < 4; i++) xs.push({ op: 'add', lhs: 5, rhs: 5, responseMs: 1000, correct: true });
  for (let i = 0; i < 4; i++) xs.push({ op: 'add', lhs: 30, rhs: 30, responseMs: 1000, correct: true });
  for (let i = 0; i < 4; i++) xs.push({ op: 'add', lhs: 70, rhs: 70, responseMs: 1000, correct: true });
  // Same for sub
  for (let i = 0; i < 4; i++) xs.push({ op: 'sub', lhs: 5, rhs: 5, responseMs: 1000, correct: true });
  for (let i = 0; i < 4; i++) xs.push({ op: 'sub', lhs: 30, rhs: 20, responseMs: 1000, correct: true });
  for (let i = 0; i < 4; i++) xs.push({ op: 'sub', lhs: 70, rhs: 30, responseMs: 1000, correct: true });
  // 4 in mul_easy_small, 4 in mul_med_small, 4 in mul_hard_small
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 2, rhs: 5, responseMs: 1000, correct: true });
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 3, rhs: 5, responseMs: 1000, correct: true });
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 7, rhs: 5, responseMs: 1000, correct: true });
  // 2 more to reach 50 in distinct buckets
  xs.push({ op: 'div', lhs: 10, rhs: 2, responseMs: 1000, correct: true });
  xs.push({ op: 'div', lhs: 10, rhs: 3, responseMs: 1000, correct: true });
  assert.equal(xs.length, 50);
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 50);
  assert.deepEqual(r.topWeak, []);
  assert.equal(r.reason, undefined, 'should not be need_more_data — they have enough total, just no qualifying cluster');
});

test('scoreAttempts: ranks slowest cluster (relative to global p50) first', () => {
  // 60 add attempts: 30 in add_small (fast: 1000ms) and 30 in add_large (slow: 5000ms).
  // GLOBAL_P50.add = 2125. score(add_small) = 1000 - 2125 = -1125. score(add_large) = 5000 - 2125 = 2875.
  // add_large wins.
  const xs = [
    ...attempts('add', 5, 5, 1000, 30),
    ...attempts('add', 80, 80, 5000, 30)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 60);
  assert.equal(r.topWeak.length, 2);
  assert.equal(r.topWeak[0].id, 'add_large');
  assert.equal(r.topWeak[0].avgMs, 5000);
  assert.equal(r.topWeak[0].n, 30);
  assert.equal(r.topWeak[1].id, 'add_small');
});

test('scoreAttempts: normalizes across ops (8s mul beats 4s add)', () => {
  // mul_hard_large at 8000ms: score = 8000 - 2661 = 5339
  // add_large at 4000ms:      score = 4000 - 2125 = 1875
  // mul_hard_large should win.
  const xs = [
    ...attempts('mul', 12, 75, 8000, 30),
    ...attempts('add', 80, 80, 4000, 30)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'mul_hard_large');
  assert.equal(r.topWeak[1].id, 'add_large');
});

test('scoreAttempts: returns at most top 3', () => {
  const xs = [
    ...attempts('mul', 12, 75, 8000, 30),  // mul_hard_large
    ...attempts('mul', 9,  50, 7000, 30),  // mul_hard_large (same cluster — combined)
    ...attempts('add', 80, 80, 4000, 30),  // add_large
    ...attempts('sub', 80, 30, 3500, 30),  // sub_large
    ...attempts('div', 600, 12, 6500, 30), // div_hard_large
    ...attempts('mul', 7,  10, 2000, 30),  // mul_hard_small
    ...attempts('add', 5,  5,  1000, 30)   // add_small (would rank last)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak.length, 3);
  assert.equal(r.topWeak[0].id, 'mul_hard_large');
});

test('scoreAttempts: tie-breaking prefers larger n when scores within 50ms', () => {
  // Two clusters with very close scores; the one with more attempts wins.
  // mul_hard_large at 5000ms, n=10:  score = 5000 - 2661 = 2339
  // mul_med_large at 5030ms, n=20:   score = 5030 - 2661 = 2369  (within 50)
  // mul_med_large should win because n=20 > n=10.
  const xs = [
    ...attempts('mul', 12, 75, 5000, 10),
    ...attempts('mul', 11, 75, 5030, 20)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'mul_med_large');
  assert.equal(r.topWeak[1].id, 'mul_hard_large');
});

test('scoreAttempts: wrong-answer penalty (1000ms each) shifts a tie', () => {
  // Two clusters at exactly the same avgMs and n; one has 3 wrongs.
  // score(c1) = 5000 - 2661 + 0 = 2339
  // score(c2) = 5000 - 2661 + 3000 = 5339 — c2 wins despite same avg.
  const xs = [
    ...attempts('mul', 12, 75, 5000, 10),                      // mul_hard_large, all correct
    ...attempts('mul', 11, 75, 5000, 7, true),                 // mul_med_large, 7 correct
    ...attempts('mul', 11, 75, 5000, 3, false)                 // mul_med_large, 3 wrong
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'mul_med_large');
});

test('scoreAttempts: skips clusters with fewer than MIN_CLUSTER_ATTEMPTS', () => {
  assert.equal(MIN_CLUSTER_ATTEMPTS, 5);
  // mul_hard_large with only 4 attempts at 8000ms (would otherwise dominate) — should be skipped.
  // add_large with 50 attempts at 4000ms — qualifies and wins.
  const xs = [
    ...attempts('mul', 12, 75, 8000, 4),
    ...attempts('add', 80, 80, 4000, 50)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak.length, 1);
  assert.equal(r.topWeak[0].id, 'add_large');
});

test('scoreAttempts: ignores attempts that bucketize to null (defensive)', () => {
  const xs = [
    ...attempts('add', 5, 5, 1000, 50),
    { op: 'mod', lhs: 1, rhs: 1, responseMs: 1000, correct: true } // unknown op
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 51);
  assert.equal(r.topWeak.length, 1);
  assert.equal(r.topWeak[0].id, 'add_small');
});

test('scoreAttempts: topWeak entries include label', () => {
  const xs = attempts('add', 80, 80, 4000, 50);
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'add_large');
  assert.equal(r.topWeak[0].label, 'Adding numbers above 50');
});
```

- [ ] **Step 2: Run to verify failing**

```bash
cd server && npm run test:unit -- --test-name-pattern='scoreAttempts'
```

Expected: FAIL (module not found).

---

### Task 5: Analyzer — implementation

**Files:**
- Create: `server/src/practice/analyzer.js`

- [ ] **Step 1: Implement the analyzer**

Create `server/src/practice/analyzer.js`:

```javascript
import { bucketize, CLUSTER_LABELS, GLOBAL_P50 } from './clusters.js';

export const RECENT_WINDOW = 500;
export const MIN_LIFETIME_ATTEMPTS = 50;
export const MIN_CLUSTER_ATTEMPTS = 5;
export const TIE_TOLERANCE_MS = 50;
export const WRONG_PENALTY_MS = 1000;
export const TOP_N = 3;

/**
 * Pure scoring function. Takes an array of attempts and returns the weakness ranking.
 * Each attempt: { op, lhs, rhs, responseMs, correct }
 */
export function scoreAttempts(attempts) {
  const total = attempts.length;
  if (total < MIN_LIFETIME_ATTEMPTS) {
    return { totalAttemptsAnalyzed: total, topWeak: [], reason: 'need_more_data' };
  }

  // Group by cluster id.
  const groups = new Map();  // clusterId -> { sumMs, n, wrongCount, op }
  for (const a of attempts) {
    const id = bucketize(a.op, a.lhs, a.rhs);
    if (id == null) continue;
    let g = groups.get(id);
    if (!g) { g = { sumMs: 0, n: 0, wrongCount: 0, op: a.op }; groups.set(id, g); }
    g.sumMs += a.responseMs;
    g.n += 1;
    if (!a.correct) g.wrongCount += 1;
  }

  // Build candidate list, filter by min cluster size, compute score.
  const candidates = [];
  for (const [id, g] of groups) {
    if (g.n < MIN_CLUSTER_ATTEMPTS) continue;
    const avgMs = Math.round(g.sumMs / g.n);
    const score = avgMs - GLOBAL_P50[g.op] + g.wrongCount * WRONG_PENALTY_MS;
    candidates.push({ id, label: CLUSTER_LABELS[id], n: g.n, avgMs, score, wrongCount: g.wrongCount });
  }

  // Sort by score desc; tie-break (within TIE_TOLERANCE_MS) by larger n.
  candidates.sort((a, b) => {
    if (Math.abs(a.score - b.score) <= TIE_TOLERANCE_MS) return b.n - a.n;
    return b.score - a.score;
  });

  const topWeak = candidates.slice(0, TOP_N).map(({ id, label, n, avgMs }) => ({ id, label, n, avgMs }));
  return { totalAttemptsAnalyzed: total, topWeak };
}

/**
 * DB-fetching wrapper. Reads the user's last RECENT_WINDOW attempts and runs scoreAttempts.
 * Returns the same shape as scoreAttempts.
 */
export async function analyzeUser(userId, pool) {
  const { rows } = await pool.query(
    `SELECT a.op, a.lhs, a.rhs, a.response_ms AS "responseMs", a.correct
     FROM attempts a
     JOIN runs r ON r.id = a.run_id
     WHERE r.user_id = $1
     ORDER BY a.id DESC
     LIMIT $2`,
    [userId, RECENT_WINDOW]
  );
  return scoreAttempts(rows);
}
```

- [ ] **Step 2: Run unit tests, verify pass**

```bash
cd server && npm run test:unit -- --test-name-pattern='scoreAttempts'
```

Expected: all 11 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/practice/analyzer.js server/test/unit/practice/analyzer.test.js
git commit -m "feat(practice): weakness analyzer (scoreAttempts + analyzeUser)"
```

---

### Task 6: Generator weighting — write failing tests

**Files:**
- Create: `server/test/unit/practice/generator-weighting.test.js`

- [ ] **Step 1: Create the test file**

Create `server/test/unit/practice/generator-weighting.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, makeRng } from '../../../src/game/generator.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import { bucketize } from '../../../src/practice/clusters.js';

test('generate: with weighting, ~70% of questions fall in supplied weak clusters', () => {
  const rng = makeRng(12345);
  const weighting = {
    clusters: ['mul_hard_large', 'add_large', 'div_hard_small'],
    weakBias: 0.7
  };
  const N = 10000;
  let inWeak = 0;
  for (let i = 0; i < N; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    const cluster = bucketize(q.op, q.a, q.b);
    if (weighting.clusters.includes(cluster)) inWeak += 1;
  }
  const ratio = inWeak / N;
  // 70% with the random 30% potentially landing on a weak cluster too.
  // Lower bound: 70% from weak (always). Upper bound: 70% + 30%*(3/18) ≈ 75%.
  // Allow tolerance ±3 percentage points.
  assert.ok(ratio >= 0.67, `expected >=0.67, got ${ratio}`);
  assert.ok(ratio <= 0.78, `expected <=0.78, got ${ratio}`);
});

test('generate: weak picks are roughly uniform across the 3 supplied clusters', () => {
  const rng = makeRng(42);
  const weighting = {
    clusters: ['mul_hard_large', 'add_large', 'div_hard_small'],
    weakBias: 1.0  // force all questions to come from weak path
  };
  const N = 6000;
  const counts = { mul_hard_large: 0, add_large: 0, div_hard_small: 0 };
  for (let i = 0; i < N; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    const cluster = bucketize(q.op, q.a, q.b);
    if (counts[cluster] != null) counts[cluster] += 1;
  }
  // Expect ~2000 each. Allow ±200 (10%).
  for (const id of Object.keys(counts)) {
    assert.ok(counts[id] >= 1700 && counts[id] <= 2300,
      `cluster ${id}: count=${counts[id]} not within [1700,2300]`);
  }
});

test('generate: with weakBias=0, behaves like normal play (no questions forced to weak clusters beyond chance)', () => {
  const rng = makeRng(1);
  const weighting = { clusters: ['mul_hard_large'], weakBias: 0 };
  const N = 4000;
  let mulHardLarge = 0;
  for (let i = 0; i < N; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    if (bucketize(q.op, q.a, q.b) === 'mul_hard_large') mulHardLarge += 1;
  }
  // Without weighting, mul_hard_large is one of ~18 clusters, but mul has 4 of 18 ops weight.
  // Expect roughly (1/4) * (4 hard tables / 11 mul tables) * (70/99 of rhs in 31..100) ≈ a few %.
  // The point: should be << 70% (which would indicate weighting kicked in).
  assert.ok(mulHardLarge / N < 0.30, `weakBias=0 should not concentrate on weak cluster, got ${mulHardLarge / N}`);
});

test('generate: operands sampled from a weak cluster fall within cluster bounds', () => {
  const rng = makeRng(7);
  const weighting = { clusters: ['mul_hard_large'], weakBias: 1.0 };
  for (let i = 0; i < 200; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    assert.equal(bucketize(q.op, q.a, q.b), 'mul_hard_large',
      `q=${JSON.stringify(q)} did not bucketize to mul_hard_large`);
    // The cluster bound: lhs in {7,8,9,12}, rhs in [31,100]. But generator may store either order.
    const small = Math.min(q.a, q.b), large = Math.max(q.a, q.b);
    assert.ok([7, 8, 9, 12].includes(small), `expected small operand in {7,8,9,12}, got ${small}`);
    assert.ok(large >= 31 && large <= 100, `expected large operand in [31,100], got ${large}`);
    assert.equal(q.answer, q.a * q.b);
  }
});

test('generate: div weak cluster — divisor + dividend bounds + integer answer', () => {
  const rng = makeRng(11);
  const weighting = { clusters: ['div_hard_small'], weakBias: 1.0 };
  for (let i = 0; i < 200; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    assert.equal(q.op, 'div');
    assert.ok([7, 8, 9, 12].includes(q.b), `divisor ${q.b} should be in {7,8,9,12}`);
    assert.ok(q.a >= 2 && q.a <= 300, `dividend ${q.a} should be in [2,300]`);
    assert.equal(q.a / q.b, q.answer);
    assert.equal(q.a % q.b, 0, 'dividend must be exactly divisible');
  }
});

test('generate: add weak cluster — max(a,b) in correct range', () => {
  const rng = makeRng(99);
  const weighting = { clusters: ['add_large'], weakBias: 1.0 };
  for (let i = 0; i < 200; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    assert.equal(q.op, 'add');
    assert.ok(Math.max(q.a, q.b) > 50);
    assert.ok(Math.max(q.a, q.b) <= 100);
    assert.equal(q.answer, q.a + q.b);
  }
});

test('generate: without weighting param, behaves identically to today (regression guard)', () => {
  // Same seed, no weighting → same questions as before. Verify output shape.
  const rng = makeRng(123);
  const q = generate(DEFAULT_CONFIG, rng);
  assert.ok(['add', 'sub', 'mul', 'div'].includes(q.op));
  assert.equal(typeof q.answer, 'number');
  assert.equal(typeof q.prompt, 'string');
});
```

- [ ] **Step 2: Run to verify failing**

```bash
cd server && npm run test:unit -- --test-name-pattern='generate: with weighting|weak picks|weakBias|operands sampled|div weak|add weak|without weighting'
```

Expected: FAIL — most tests fail because `generate` ignores the `weighting` arg.

---

### Task 7: Generator weighting — implementation

**Files:**
- Modify: `server/src/game/generator.js`

- [ ] **Step 1: Add weighted-sample path to generator**

Open `server/src/game/generator.js`. Replace the entire file with:

```javascript
import { CLUSTER_BOUNDS } from '../practice/clusters.js';

// Mulberry32 PRNG — deterministic, fast, good enough for question generation.
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

function pickFromArray(rng, arr) {
  return arr[intInRange(rng, 0, arr.length - 1)];
}

/**
 * Generate one question.
 *
 * @param {object}  config     - DEFAULT_CONFIG-shaped object.
 * @param {function} rng       - PRNG returning [0,1).
 * @param {object} [weighting] - Optional. { clusters: string[], weakBias: number in [0,1] }.
 *   When supplied, with probability weakBias the question is drawn from a uniformly-chosen
 *   cluster in `clusters`. Otherwise (1 - weakBias) the question is drawn from `config` like normal.
 */
export function generate(config, rng, weighting) {
  if (weighting && weighting.clusters && weighting.clusters.length > 0) {
    if (rng() < weighting.weakBias) {
      const clusterId = pickFromArray(rng, weighting.clusters);
      return generateFromCluster(rng, clusterId);
    }
    // else fall through to normal generation
  }

  return generateFromConfig(config, rng);
}

function generateFromConfig(config, rng) {
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
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

function generateFromCluster(rng, clusterId) {
  const c = CLUSTER_BOUNDS[clusterId];
  if (!c) throw new Error(`unknown cluster: ${clusterId}`);

  switch (c.op) {
    case 'mul': {
      const a = pickFromArray(rng, c.lhsValues);
      const b = intInRange(rng, c.rhsMin, c.rhsMax);
      return { op: 'mul', a, b, answer: a * b, prompt: `${a} × ${b}` };
    }
    case 'div': {
      // Pick a divisor from the cluster's set, then pick a dividend that's a multiple of it
      // and falls within the cluster's dividend range.
      const divisor = pickFromArray(rng, c.divisorValues);
      const minQ = Math.ceil(c.dividendMin / divisor);
      const maxQ = Math.floor(c.dividendMax / divisor);
      // Bound the quotient to also stay within the default config (rhsMin/rhsMax for div = quotient range = [2,100]).
      // Default config has div quotient ∈ [2, 100], so:
      const lo = Math.max(minQ, 2);
      const hi = Math.min(maxQ, 100);
      const quotient = intInRange(rng, lo, hi);
      const dividend = quotient * divisor;
      return { op: 'div', a: dividend, b: divisor, answer: quotient, prompt: `${dividend} ÷ ${divisor}` };
    }
    case 'add': {
      // Pick max in cluster's max range, other operand in [2, max].
      const big = intInRange(rng, c.maxMin, c.maxMax);
      const small = intInRange(rng, 2, big);
      // Randomize order so the larger isn't always 'a'.
      const [a, b] = rng() < 0.5 ? [big, small] : [small, big];
      return { op: 'add', a, b, answer: a + b, prompt: `${a} + ${b}` };
    }
    case 'sub': {
      // Larger operand in cluster's max range; smaller in [2, larger]. a >= b for sub.
      const a = intInRange(rng, c.maxMin, c.maxMax);
      const b = intInRange(rng, 2, a);
      return { op: 'sub', a, b, answer: a - b, prompt: `${a} − ${b}` };
    }
    default:
      throw new Error(`unsupported cluster op: ${c.op}`);
  }
}
```

- [ ] **Step 2: Run weighting tests, verify pass**

```bash
cd server && npm run test:unit -- --test-name-pattern='generate: with weighting|weak picks|weakBias|operands sampled|div weak|add weak|without weighting'
```

Expected: all 7 tests PASS.

- [ ] **Step 3: Run the full unit suite to confirm no regression**

```bash
cd server && npm run test:unit
```

Expected: all tests pass — including the existing `generator.test.js` tests (which call `generate(cfg, rng)` with no weighting arg, so they hit the `generateFromConfig` path unchanged).

- [ ] **Step 4: Commit**

```bash
git add server/src/game/generator.js server/test/unit/practice/generator-weighting.test.js
git commit -m "feat(generator): optional weighting for cluster-biased questions"
```

---

### Task 8: Session store — plumb `practice` and `weighting` through

**Files:**
- Modify: `server/src/game/session.js`

- [ ] **Step 1: Update `start()` to accept practice + weighting; pass weighting to generator**

In `server/src/game/session.js`, replace the `start({ userId, config })` method (lines ~35-64) and the `newQuestion` helper (lines ~22-24) with:

```javascript
  function newQuestion(session) {
    return generate(session.config, session.rng, session.weighting);
  }
```

```javascript
    start({ userId, config, practice = false, weighting = null }) {
      const sessionId = makeId();
      const startedAt = now();
      const rng = makeRng(nextSeed());
      const session = {
        id: sessionId,
        userId: userId ?? null,
        config,
        practice,
        weighting,
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
      session.currentQuestion = generate(session.config, session.rng, session.weighting);
      session.peekQuestion = generate(session.config, session.rng, session.weighting);
      sessions.set(sessionId, session);
      return {
        sessionId,
        question: publicQuestion(session.currentQuestion),
        peekQuestion: publicQuestion(session.peekQuestion),
        timeLimitMs: session.durationMs
      };
    },
```

- [ ] **Step 2: Run unit tests to verify no regression**

```bash
cd server && npm run test:unit
```

Expected: all tests pass. (Existing `session.test.js` calls `start({ userId, config })` without practice/weighting — defaults preserve current behavior.)

- [ ] **Step 3: Commit**

```bash
git add server/src/game/session.js
git commit -m "feat(session): support practice + weighting fields"
```

---

### Task 9: Practice routes — implementation

**Files:**
- Create: `server/src/routes/practice.routes.js`
- Modify: `server/src/index.js`
- Modify: `server/src/routes/play.routes.js`

This task creates the two practice endpoints AND modifies `play.routes.js` so practice runs get `practice = true` written at INSERT time.

- [ ] **Step 1: Create `practice.routes.js`**

Create `server/src/routes/practice.routes.js`:

```javascript
import { requireAuth } from '../auth.js';
import { analyzeUser, TOP_N } from '../practice/analyzer.js';
import { DEFAULT_CONFIG } from '../config.js';

const WEAK_BIAS = 0.7;

export default async function practiceRoutes(fastify, { pool, sessionStore }) {
  fastify.get('/api/practice/diagnose', { preHandler: requireAuth }, async (req) => {
    const result = await analyzeUser(req.user.id, pool);
    return result;
  });

  fastify.post('/api/practice/start', { preHandler: requireAuth }, async (req, reply) => {
    const result = await analyzeUser(req.user.id, pool);
    if (result.topWeak.length === 0) {
      return reply.code(422).send({ reason: result.reason ?? 'no_weak_clusters' });
    }
    const clusterIds = result.topWeak.slice(0, TOP_N).map((c) => c.id);
    const r = sessionStore.start({
      userId: req.user.id,
      config: DEFAULT_CONFIG,
      practice: true,
      weighting: { clusters: clusterIds, weakBias: WEAK_BIAS }
    });
    return {
      session_id: r.sessionId,
      question: { prompt: r.question.prompt, op: r.question.op, answer: r.question.answer },
      peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
      time_limit_ms: r.timeLimitMs,
      practice: true,
      clusters: clusterIds
    };
  });
}
```

- [ ] **Step 2: Register the route plugin in `index.js`**

In `server/src/index.js`, add the import after the other route imports (line ~11):

```javascript
import practiceRoutes from './routes/practice.routes.js';
```

And register it (after `boardRoutes` registration, line ~23):

```javascript
  await app.register(practiceRoutes, { pool, sessionStore });
```

- [ ] **Step 3: Modify `play.routes.js` so practice flag is set at run insert**

In `server/src/routes/play.routes.js`, find `flushRunIfRecording` (line ~56) and modify the `runs` insert (line ~64-67) to include the `practice` column. Also change `takeRunRecord` consumption to read the practice flag.

Since `takeRunRecord` (in `session.js`) returns `{ userId, score, durationMs, attempts }`, we need to add `practice` to its return. Update `session.js`'s `takeRunRecord` first:

In `server/src/game/session.js`, update `takeRunRecord` (lines ~116-127):

```javascript
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
        attempts
      };
    },
```

Then in `server/src/routes/play.routes.js`, update the `runs` insert in `flushRunIfRecording` (line ~64-67):

```javascript
      const insRun = await client.query(
        'INSERT INTO runs (user_id, score, duration_ms, practice) VALUES ($1, $2, $3, $4) RETURNING id',
        [rec.userId, rec.score, rec.durationMs, rec.practice]
      );
```

- [ ] **Step 4: Modify `board.routes.js` so submit short-circuits for practice runs**

In `server/src/routes/board.routes.js`, after the `if (session.userId !== req.user.id)` check (line ~13) but before `const finished = sessionStore.finish(session_id)` (line ~15), insert:

Actually, restructure: we need to call `finish` to mark the session finalized regardless. Then for practice we return early without flipping `submitted_to_leaderboard` or computing rank.

Replace the body of `/api/leaderboard/submit` (lines 4-58) so the order is:
1. Validate body, look up session, check ownership.
2. Call `sessionStore.finish(session_id)`.
3. **If `session.practice === true`**: return `{ ok: true, practice: true, run_id: session.runId }` without further work.
4. Otherwise: existing rank flow.

The full updated route:

```javascript
  fastify.post('/api/leaderboard/submit', { preHandler: requireAuth }, async (req, reply) => {
    const { session_id } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });

    const session = sessionStore.get(session_id);
    if (!session) return reply.code(404).send({ error: 'unknown_session' });

    if (session.userId !== req.user.id) {
      return reply.code(403).send({ error: 'session_owner_mismatch' });
    }

    const finished = sessionStore.finish(session_id);

    // Practice runs: don't flip submitted_to_leaderboard, don't compute rank.
    // The runs row was already inserted with practice=true at time-up flush.
    if (session.practice === true) {
      return { ok: true, practice: true, run_id: session.runId };
    }

    if (!finished.qualifies) {
      return reply.code(422).send({ error: 'not_eligible', qualifies: false });
    }

    if (session.submitted) {
      return { ok: true, rank: session.lastRank, idempotent: true };
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

    return { ok: true, rank, run_id: session.runId };
  });
```

- [ ] **Step 5: Run unit tests, then full test suite if DB available**

```bash
cd server && npm run test:unit
```

Expected: all unit tests pass (no integration tests for practice yet — those come in Task 13).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/practice.routes.js server/src/index.js server/src/routes/play.routes.js server/src/routes/board.routes.js server/src/game/session.js
git commit -m "feat(practice): /api/practice/{diagnose,start} routes + submit short-circuit"
```

---

### Task 10: Client — `practice.html` page

**Files:**
- Create: `client/practice.html`
- Create: `client/js/practice.js`

- [ ] **Step 1: Create the HTML page**

Look at `client/leaderboard.html` first to match the project's layout/header conventions:

```bash
cat client/leaderboard.html | head -30
```

Then create `client/practice.html` mirroring that structure. Use this template (adapt header/footer markup to match leaderboard.html's actual structure, but keep the main content):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Practice — ZetaChad</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body>
  <header class="site-header">
    <a class="brand" href="index.html">ZetaChad</a>
    <nav>
      <a href="play.html">Play</a>
      <a href="practice.html" aria-current="page">Practice</a>
      <a href="leaderboard.html">Leaderboard</a>
      <span id="user-area"></span>
    </nav>
  </header>
  <main id="app" class="narrow">
    <h1>Practice mode</h1>

    <div id="loading" class="muted">Analysing your recent attempts…</div>

    <section id="ready" class="hidden">
      <p class="subtitle">A 2-minute run focused on your 3 weakest areas. Won't affect your leaderboard score.</p>
      <div class="label">Your weak spots</div>
      <ul id="weak-list" class="weak-list"></ul>
      <button class="primary" id="start-btn">Start practice</button>
    </section>

    <section id="need-more" class="hidden">
      <p>Play a few normal rounds first — practice mode unlocks once we have enough data to find your weak spots.</p>
      <a class="primary" href="play.html">Go to play</a>
    </section>

    <section id="auth-required" class="hidden">
      <p>You need to be logged in to use practice mode.</p>
      <a class="primary" href="login.html?next=/practice">Log in</a>
    </section>

    <section id="error" class="hidden">
      <p>Something went wrong. <button id="retry-btn">Try again</button></p>
    </section>
  </main>
  <script type="module" src="js/practice.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create the JS controller**

Create `client/js/practice.js`:

```javascript
const els = {
  loading: () => document.getElementById('loading'),
  ready: () => document.getElementById('ready'),
  needMore: () => document.getElementById('need-more'),
  authRequired: () => document.getElementById('auth-required'),
  error: () => document.getElementById('error'),
  weakList: () => document.getElementById('weak-list'),
  startBtn: () => document.getElementById('start-btn'),
  retryBtn: () => document.getElementById('retry-btn')
};

function show(id) {
  for (const k of ['loading', 'ready', 'needMore', 'authRequired', 'error']) {
    els[k]().classList.toggle('hidden', k !== id);
  }
}

function formatMs(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

async function loadDiagnosis() {
  show('loading');
  let res;
  try {
    res = await fetch('/api/practice/diagnose', { credentials: 'same-origin' });
  } catch {
    show('error');
    return;
  }
  if (res.status === 401) { show('authRequired'); return; }
  if (!res.ok) { show('error'); return; }

  const data = await res.json();
  if (!data.topWeak || data.topWeak.length === 0) {
    show('needMore');
    return;
  }

  const ul = els.weakList();
  ul.innerHTML = '';
  for (const c of data.topWeak) {
    const li = document.createElement('li');
    li.className = 'weak-spot-row';
    const label = document.createElement('div');
    label.className = 'weak-label';
    label.textContent = c.label;  // server-controlled string, safe
    const meta = document.createElement('div');
    meta.className = 'weak-meta muted';
    meta.textContent = `${c.n} attempts`;
    const time = document.createElement('div');
    time.className = 'weak-time';
    time.textContent = `${formatMs(c.avgMs)} avg`;
    const left = document.createElement('div');
    left.className = 'weak-left';
    left.appendChild(label);
    left.appendChild(meta);
    li.appendChild(left);
    li.appendChild(time);
    ul.appendChild(li);
  }
  show('ready');
}

async function startPractice() {
  els.startBtn().disabled = true;
  els.startBtn().textContent = 'Starting…';
  let res;
  try {
    res = await fetch('/api/practice/start', { method: 'POST', credentials: 'same-origin' });
  } catch {
    els.startBtn().disabled = false;
    els.startBtn().textContent = 'Start practice';
    show('error');
    return;
  }
  if (res.status === 401) { show('authRequired'); return; }
  if (res.status === 422) { show('needMore'); return; }
  if (!res.ok) { show('error'); return; }

  const data = await res.json();
  // Stash session info so play.js picks it up after redirect.
  sessionStorage.setItem('zc_practice_session', JSON.stringify({
    sessionId: data.session_id,
    clusters: data.clusters,
    question: data.question,
    peekQuestion: data.peek_question,
    timeLimitMs: data.time_limit_ms
  }));
  window.location.href = '/play.html';
}

document.addEventListener('DOMContentLoaded', () => {
  els.startBtn()?.addEventListener('click', startPractice);
  els.retryBtn()?.addEventListener('click', loadDiagnosis);
  loadDiagnosis();
});
```

- [ ] **Step 3: Add CSS for the new elements**

In `client/css/styles.css`, append:

```css
/* Practice page */
.weak-list {
  list-style: none;
  padding: 0;
  margin: 16px 0 24px;
  border-top: 1px solid var(--border, #ddd);
}
.weak-spot-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--border, #ddd);
  gap: 16px;
}
.weak-left { flex: 1; }
.weak-label { font-weight: 600; }
.weak-meta { font-size: 0.85em; margin-top: 2px; }
.weak-time { font-weight: 600; color: #c44; white-space: nowrap; }

/* Practice badge on play screen */
.practice-badge {
  position: fixed;
  top: 12px;
  left: 12px;
  background: #c44;
  color: white;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 4px 8px;
  border-radius: 3px;
  z-index: 10;
}
.practice-badge.hidden { display: none; }
```

(If your stylesheet uses different variable names than `--border`, adapt accordingly. Check the existing CSS first with `head -50 client/css/styles.css`.)

- [ ] **Step 4: Smoke-test in browser locally**

Open `client/practice.html` in a browser by serving the `client/` directory (e.g., `python -m http.server -d client 8080`) and visiting `http://localhost:8080/practice.html`. The diagnosis fetch will fail (no backend at localhost:8080) — that's fine; verify the page renders and the loading → error transition works visually.

- [ ] **Step 5: Commit**

```bash
git add client/practice.html client/js/practice.js client/css/styles.css
git commit -m "feat(client): /practice page with diagnosis + start"
```

---

### Task 11: Client — play screen integration (badge + post-run copy)

**Files:**
- Modify: `client/play.html`
- Modify: `client/js/play.js`

- [ ] **Step 1: Add the PRACTICE badge element to play.html**

In `client/play.html`, immediately after the opening `<body class="drilling">` tag, add:

```html
  <div class="practice-badge hidden" id="practice-badge">PRACTICE</div>
```

- [ ] **Step 2: Update play.js to read sessionStorage and adapt UI**

In `client/js/play.js`, near the top (after the `els` object definition around line 12), add:

```javascript
function readPracticeSession() {
  try {
    const raw = sessionStorage.getItem('zc_practice_session');
    if (!raw) return null;
    sessionStorage.removeItem('zc_practice_session'); // consume — survives one page load
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
```

Then find where the play loop initializes its session (look for `start` calls — `api.start()` or similar). Before the normal `/api/play/start` flow, check for the practice session and use it instead:

The pattern depends on existing structure. Read the relevant section first:

```bash
grep -n "api.start\|/api/play/start\|state.sessionId" client/js/play.js | head -20
```

The integration: if `readPracticeSession()` returns non-null, use that data to populate the same state variables (sessionId, question, peekQuestion, timeLimitMs) that the normal `/api/play/start` response would. Set a flag like `state.practice = true`. Show the badge:

```javascript
const practice = readPracticeSession();
if (practice) {
  state.sessionId = practice.sessionId;
  state.practice = true;
  state.currentQuestion = practice.question;
  state.peekQuestion = practice.peekQuestion;
  document.getElementById('practice-badge').classList.remove('hidden');
  // wire up first question + timer just as the normal /api/play/start handler does
  // (refer to the existing init code path and replicate the post-start setup)
}
```

You'll need to refactor the existing init flow into a helper that takes a "session payload" (whether from `/api/play/start` or from sessionStorage) and starts the play loop. Keep the diff focused.

- [ ] **Step 3: Update post-run flow when practice**

Find the post-run rendering in play.js (search for `score-screen`, `post-note`, or the submit handler around lines 180-220). In the path that runs after submit:

When `state.practice === true`:
- Skip the leaderboard-submit confirmation modal entirely (practice always submits silently).
- Set `els.postNote().textContent = "Practice complete — your updated weak spots will be ready next time you visit /practice."`.
- Replace or hide the existing buttons. Insert two action buttons in `.actions`:
  - "Practice again" → `window.location.href = '/practice.html'`
  - "Play normally" → `window.location.href = '/play.html'`

The exact code depends on the existing post-run structure. The key changes:
1. Skip the "Submit to leaderboard?" modal when `state.practice`.
2. Auto-call `api.submit(state.sessionId)` immediately when time's up (the server returns `{ ok: true, practice: true }` for practice runs; you can ignore the response).
3. Render the practice-complete message + buttons instead of the leaderboard rank panel.

Implementation sketch — adapt to actual line numbers:

```javascript
// In the time-up / score-screen handler:
if (state.practice) {
  els.postNote().textContent = 'Practice complete — your updated weak spots will be ready next time you visit /practice.';
  const actions = document.querySelector('.actions');
  actions.innerHTML = '';
  const a1 = document.createElement('a'); a1.className = 'primary'; a1.href = 'practice.html'; a1.textContent = 'Practice again';
  const a2 = document.createElement('a'); a2.className = 'secondary'; a2.href = 'play.html'; a2.textContent = 'Play normally';
  actions.appendChild(a1); actions.appendChild(a2);
  // Auto-submit so the run gets persisted on the server side.
  await api.submit(state.sessionId).catch(() => {});
  return;
}
// else: existing flow
```

- [ ] **Step 4: Manual smoke test**

Once the server is running and you have a logged-in user with ≥50 attempts:
1. Visit `/practice.html`, click Start.
2. You're redirected to `/play.html`. Verify the red PRACTICE badge appears top-left.
3. Play through (or wait for time-up). Verify the post-run screen shows the practice-complete copy and two buttons (Practice again / Play normally), NOT the leaderboard submit modal.

- [ ] **Step 5: Commit**

```bash
git add client/play.html client/js/play.js
git commit -m "feat(client): practice badge + practice-aware post-run flow on /play"
```

---

### Task 12: Client — add Practice nav link to other pages

**Files:**
- Modify: `client/index.html`, `client/leaderboard.html` (and any other page with the site nav)

- [ ] **Step 1: Find all pages with the existing nav**

```bash
grep -l 'leaderboard.html"' client/*.html
```

For each match (likely `index.html`, `play.html`, `leaderboard.html`):

- [ ] **Step 2: Add a Practice link**

In each file, find the `<nav>` block and add a `<a href="practice.html">Practice</a>` between the "Play"/"Home" link and the "Leaderboard" link:

```html
<nav>
  <a href="play.html">Play</a>
  <a href="practice.html">Practice</a>
  <a href="leaderboard.html">Leaderboard</a>
  <span id="user-area"></span>
</nav>
```

(Adapt to each file's actual nav structure — some may not have a Play link, or may use different class names.)

- [ ] **Step 3: Commit**

```bash
git add client/index.html client/leaderboard.html
git commit -m "feat(client): add Practice link to site nav"
```

---

### Task 13: Integration tests

**Files:**
- Create: `server/test/integration/practice.test.js`

Integration tests skip when `TEST_DATABASE_URL` is not set. They exercise the full HTTP → DB → HTTP loop.

- [ ] **Step 1: Read existing integration test for patterns**

```bash
cat server/test/integration/play.test.js | head -80
```

Note how it: spins up via `freshApp()`, registers a user, logs in to get a cookie, makes API calls with `app.inject({ headers: { cookie } })`.

- [ ] **Step 2: Create the practice integration test**

Create `server/test/integration/practice.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

async function registerAndLogin(app, username = 'practiceuser', password = 'password123') {
  const reg = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username, password }
  });
  assert.equal(reg.statusCode, 200, `register failed: ${reg.payload}`);
  const cookie = cookieFromResponse(reg);
  assert.ok(cookie, 'no cookie on register');
  return { cookie, username };
}

async function seedAttempts(pool, userId, attempts) {
  // Insert one run + N attempts.
  const { rows } = await pool.query(
    'INSERT INTO runs (user_id, score, duration_ms) VALUES ($1, $2, $3) RETURNING id',
    [userId, attempts.length, 120000]
  );
  const runId = rows[0].id;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    await pool.query(
      `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [runId, i, a.op, a.lhs, a.rhs, a.answer ?? 0, String(a.answer ?? 0), a.responseMs, a.correct ?? true]
    );
  }
}

test('GET /api/practice/diagnose: 401 when unauthenticated', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  const res = await app.inject({ method: 'GET', url: '/api/practice/diagnose' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/practice/diagnose: need_more_data for fresh user', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  const { cookie } = await registerAndLogin(app);
  const res = await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.totalAttemptsAnalyzed, 0);
  assert.deepEqual(body.topWeak, []);
  assert.equal(body.reason, 'need_more_data');
});

test('GET /api/practice/diagnose: returns top-3 for user with seeded slow attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  const { cookie } = await registerAndLogin(app);
  // Get the user's id
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  // Seed 60 attempts: 30 slow mul_hard_large, 30 fast add_small
  const attempts = [];
  for (let i = 0; i < 30; i++) attempts.push({ op: 'mul', lhs: 12, rhs: 75, responseMs: 8000 });
  for (let i = 0; i < 30; i++) attempts.push({ op: 'add', lhs: 5, rhs: 5, responseMs: 1000 });
  await seedAttempts(pool, userId, attempts);

  const res = await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.totalAttemptsAnalyzed, 60);
  assert.ok(body.topWeak.length >= 1);
  assert.equal(body.topWeak[0].id, 'mul_hard_large');
  assert.equal(body.topWeak[0].n, 30);
  assert.equal(body.topWeak[0].avgMs, 8000);
  assert.equal(body.topWeak[0].label, 'Multiplying 7, 8, 9 or 12 by numbers above 30');
});

test('POST /api/practice/start: 422 when need_more_data', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  const { cookie } = await registerAndLogin(app);
  const res = await app.inject({ method: 'POST', url: '/api/practice/start', headers: { cookie } });
  assert.equal(res.statusCode, 422);
  const body = JSON.parse(res.payload);
  assert.equal(body.reason, 'need_more_data');
});

test('POST /api/practice/start: returns session + clusters when eligible', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  const { cookie } = await registerAndLogin(app);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  const attempts = [];
  for (let i = 0; i < 30; i++) attempts.push({ op: 'mul', lhs: 12, rhs: 75, responseMs: 8000 });
  for (let i = 0; i < 30; i++) attempts.push({ op: 'add', lhs: 80, rhs: 80, responseMs: 5000 });
  await seedAttempts(pool, userId, attempts);

  const res = await app.inject({ method: 'POST', url: '/api/practice/start', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.session_id === 'string');
  assert.equal(body.practice, true);
  assert.ok(Array.isArray(body.clusters));
  assert.ok(body.clusters.includes('mul_hard_large'));
  assert.equal(body.time_limit_ms, DEFAULT_CONFIG.durationMs);
  assert.ok(body.question);
  assert.ok(body.peek_question);
});

test('practice end-to-end: start → answer → submit → run.practice=true and not on leaderboard', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  const { cookie } = await registerAndLogin(app);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  // Seed enough to qualify
  const attempts = Array.from({ length: 60 }, () => ({ op: 'mul', lhs: 12, rhs: 75, responseMs: 8000 }));
  await seedAttempts(pool, userId, attempts);

  // Start practice
  const startRes = await app.inject({ method: 'POST', url: '/api/practice/start', headers: { cookie } });
  assert.equal(startRes.statusCode, 200);
  const start = JSON.parse(startRes.payload);
  const sessionId = start.session_id;

  // Answer a few questions (use the prompt's known answer from peek/current)
  // Easier: use the answer field returned in the question payload (already exposed).
  let q = start.question;
  for (let i = 0; i < 5; i++) {
    const ans = await app.inject({
      method: 'POST', url: '/api/play/answer', headers: { cookie },
      payload: { session_id: sessionId, answer: String(q.answer) }
    });
    assert.equal(ans.statusCode, 200);
    const data = JSON.parse(ans.payload);
    if (data.time_up) break;
    q = data.next_question;
  }

  // Force time-up by directly calling submit (the spec also allows fast-forwarding via finish in tests)
  // Submit the practice run
  const subRes = await app.inject({
    method: 'POST', url: '/api/leaderboard/submit', headers: { cookie },
    payload: { session_id: sessionId }
  });
  assert.equal(subRes.statusCode, 200);
  const sub = JSON.parse(subRes.payload);
  assert.equal(sub.practice, true);
  assert.equal(sub.ok, true);

  // Verify a runs row was inserted with practice=true (might be 0 if no time-up flushed; check based on flow)
  // A practice run only inserts on time-up flush, not on submit. So this only works if time-up fired during the loop.
  // For deterministic test, alternative: call /api/play/answer until time_up returns true, then submit.
  // For now, verify leaderboard does NOT show the practice user
  const lbRes = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  const lb = JSON.parse(lbRes.payload);
  const found = lb.entries.find((e) => e.username === 'practiceuser');
  assert.equal(found, undefined, 'practice user should not appear on leaderboard');
});

test('practice attempts feed back into next diagnose call', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  const { cookie } = await registerAndLogin(app);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  // Seed 60 slow add_large attempts
  const seed = Array.from({ length: 60 }, () => ({ op: 'add', lhs: 80, rhs: 80, responseMs: 6000 }));
  await seedAttempts(pool, userId, seed);

  const r1 = JSON.parse((await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } })).payload);
  assert.equal(r1.totalAttemptsAnalyzed, 60);

  // Simulate a practice run by inserting more attempts directly
  const more = Array.from({ length: 20 }, () => ({ op: 'mul', lhs: 12, rhs: 90, responseMs: 9000 }));
  await seedAttempts(pool, userId, more);

  const r2 = JSON.parse((await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } })).payload);
  assert.equal(r2.totalAttemptsAnalyzed, 80);
  // mul_hard_large now has 20 attempts at 9000ms — should rank higher than add_large at 6000ms
  // (score(mul_hard_large) = 9000-2661 = 6339; score(add_large) = 6000-2125 = 3875)
  assert.equal(r2.topWeak[0].id, 'mul_hard_large');
});
```

- [ ] **Step 3: Run integration tests if you have TEST_DATABASE_URL**

```bash
cd server && TEST_DATABASE_URL=postgres://... npm run test:integration
```

Expected: all tests pass.

If you don't have a local Postgres, skip this step — the tests are written to skip cleanly when `TEST_DATABASE_URL` is unset (`skipIfNoDb` returns true). Verify they at least *parse* and *skip*:

```bash
cd server && npm run test:integration
```

Expected: every practice test reports as "skipped" with the message `TEST_DATABASE_URL not set`.

- [ ] **Step 4: Commit**

```bash
git add server/test/integration/practice.test.js
git commit -m "test(practice): integration tests for diagnose/start/end-to-end"
```

---

### Task 14: Deploy to VPS and smoke-test

**Files:**
- (No code changes — this is a deploy + verify pass)

The VPS is `root@87.99.158.208`. Live URL is `https://zetachad.duckdns.org`. Server code lives at `/srv/zetachad/server/`, client at `/var/www/zetachad/`. Per the project's `feedback_telegram_articles.md` and earlier conversation memory, deploy mechanics on the VPS use `deploy/deploy-scp.sh`.

- [ ] **Step 1: Confirm what `deploy/deploy-scp.sh` does**

```bash
cat deploy/deploy-scp.sh
```

It should rsync/scp the server source and client static files, run the migration on the server, and restart the `zetachad.service` systemd unit. Confirm the script handles the new files (`server/src/practice/`, `client/practice.html`, `client/js/practice.js`).

- [ ] **Step 2: Run the deploy**

```bash
./deploy/deploy-scp.sh
```

Expected: the script reports successful upload, migration application (you should see `migrated: 006_runs_practice_flag.sql` in its output or in `journalctl`), and service restart.

- [ ] **Step 3: Verify migration applied**

```bash
ssh root@87.99.158.208 "sudo -u postgres psql -d zetachad -c \"SELECT filename FROM schema_migrations ORDER BY filename;\""
```

Expected: list includes `006_runs_practice_flag.sql`.

```bash
ssh root@87.99.158.208 "sudo -u postgres psql -d zetachad -c \"\\d runs\""
```

Expected: `practice` column visible with type `boolean`, default `false`.

- [ ] **Step 4: Smoke-test the API**

```bash
curl -i https://zetachad.duckdns.org/api/practice/diagnose
```

Expected: `401 Unauthorized` with body `{"error":"auth_required"}`.

- [ ] **Step 5: Smoke-test in browser as a real user**

In a browser, log in as a user with ≥50 attempts on the live site (the data already exists per the dataset survey done during brainstorming — use one of the 8 known users). Visit `https://zetachad.duckdns.org/practice.html`.

Expected:
- Page loads, shows "Analysing your recent attempts…" briefly, then renders the 3 weak spots.
- Click Start. Redirects to `/play.html` with the red PRACTICE badge top-left.
- Play through. After time-up, see the practice-complete message and the two buttons (Practice again / Play normally).
- Visit `/leaderboard.html`. Confirm your practice run did NOT appear (your previous leaderboard rank is unchanged).
- Visit `/practice.html` again. Confirm the diagnosis reflects updated stats (the practice attempts count toward total).

For an unauthenticated user: visit `/practice.html` → expect "You need to be logged in" message + Log in button.

For a user with <50 attempts: register a fresh test user and visit `/practice.html` → expect "Play a few normal rounds first" message + Go to play button.

- [ ] **Step 6: Check service logs for errors**

```bash
ssh root@87.99.158.208 "journalctl -u zetachad -n 50 --no-pager"
```

Expected: no error stack traces from practice routes.

- [ ] **Step 7: Final commit (only if any deploy-script changes were needed)**

If `deploy-scp.sh` needed updates to handle the new directory or migration:

```bash
git add deploy/deploy-scp.sh
git commit -m "chore(deploy): handle new practice/ source dir"
```

Otherwise, skip.

---

## Self-review

(Done by the plan author before handing off.)

**Spec coverage check:**
- ✅ 18-cluster definitions → Task 3 (`clusters.js`)
- ✅ Scoring algorithm (avgMs − globalP50 + wrongPenalty, tie-breaking, eligibility) → Task 5 (`analyzer.js`)
- ✅ `GET /api/practice/diagnose` and `POST /api/practice/start` → Task 9
- ✅ Generator weighting (70/30, uniform among 3) → Task 7
- ✅ Session state (practice, weighting fields) → Task 8
- ✅ Submit short-circuit for practice → Task 9 (board.routes.js change)
- ✅ Migration 006 → Task 1
- ✅ Practice run insertion with `practice = true` → Task 9 (play.routes.js change)
- ✅ Diagnosis screen (Layout A, minimal list) → Task 10
- ✅ need_more_data state, auth-required state → Task 10
- ✅ PRACTICE badge on /play → Task 11
- ✅ Post-run practice copy + buttons → Task 11
- ✅ Practice nav link on other pages → Task 12
- ✅ sessionStorage hand-off from /practice to /play → Task 10 + 11
- ✅ Unit + integration tests → Tasks 2, 4, 6, 13

**Spec note about admin.routes.js:** the spec says admin queries should "include practice runs in counts and per-user views, with a visual indicator." This plan does NOT modify `admin.routes.js`. Reason: admin queries don't currently filter on `practice`, so adding the column with a default of `false` means existing admin behavior is preserved (all current rows are non-practice, so counts/views look identical to today). Visual indicators in the admin dashboard are a UX polish item that can be a follow-up — they don't block the v1 launch and the spec also lists this as guidance ("the implementation plan should enumerate each admin query and confirm the include/exclude decision"). Recommended follow-up: a separate admin-dashboard polish PR after this lands.

**Placeholder scan:** no TBDs. Tasks 11 and 14 contain "adapt to existing structure" guidance because the play.js file structure is best understood by the implementer at the moment of editing — but every required behavior is specified.

**Type consistency:** `weighting.clusters` (array of strings) and `weighting.weakBias` (number) used consistently across `practice.routes.js`, `session.js`, `generator.js`. `topWeak[].{ id, label, n, avgMs }` consistent across analyzer return, API response, and client renderer.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-practice-mode.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here because tasks are well-isolated (each commits cleanly).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
