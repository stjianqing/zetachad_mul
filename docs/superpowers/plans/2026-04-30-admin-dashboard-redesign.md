# Admin Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `/admin/` around three at-a-glance questions (engagement, cohort progress, mul/div weakness) by replacing the current empty-weak-spots tables and unreadable heatmap with a trouble-facts list + linked compact heatmap, adding a top-of-page engagement strip, and giving the score chart proper axes plus a cohort-median line with toggleable per-player series.

**Architecture:** Two new read-only endpoints (`/admin/api/engagement`, `/admin/api/trouble-facts`) and one removed (`/admin/api/weak-spots`). All other backend untouched. Frontend redesigned in `client/admin/*` only — three zones (engagement strip, cohort chart, weakness grid) plus the existing sessions table at the bottom. Heatmap restricted to a 2..12 × 2..12 grid; for division, axes are `divisor × quotient` (not raw `lhs × rhs`). DB schema and write paths unchanged.

**Tech Stack:** Node 22 + Fastify 5 (server, ESM), `pg` for Postgres, vanilla ES modules (no framework) on the client, `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-04-30-admin-dashboard-redesign-design.md`

---

## File structure

Server (modified):
- `server/src/routes/admin.routes.js` — add `/engagement`, add `/trouble-facts`, remove `/weak-spots`
- `server/test/integration/admin.test.js` — add tests for new endpoints, remove weak-spots tests

Client (modified):
- `client/admin/index.html` — replaced layout: engagement strip, score chart section, weakness grid, demoted add/sub cards, sessions table at bottom; remove "Activity (all players)" section and the old "Weak spots" section
- `client/admin/css/admin.css` — new styles for engagement tiles, weakness grid, trouble-facts list/badges, player chips, axes/gridlines
- `client/admin/js/admin-api.js` — add `engagement()`, `troubleFacts()`; remove `weakSpots()`
- `client/admin/js/admin.js` — remove `loadPlayers()` activity-table block, replace `renderWeakSpots()` with `renderEngagement()` + `renderWeaknessPanel()`, wire new sections in `refresh()`
- `client/admin/js/heatmap.js` — restrict to 2..12, larger cells (25px), axis labels, neutral diagonal/×10, click + outline-on-hover hooks; for div, take pre-aggregated `(divisor, quotient)` cells
- `client/admin/js/chart.js` — add gridlines, X-axis date ticks, Y-axis labels, cohort-median series, hover guideline, player chip toggles

Tests (new):
- `server/test/integration/admin.test.js` (extended) — engagement & trouble-facts endpoints
- No new client test framework — manual UI verification per spec

---

## Task ordering rationale

1. **Backend first** (Tasks 1–3): new endpoints with tests so the client can integrate against real data. The old `/weak-spots` is removed last (Task 3) so the client doesn't break before its replacement is wired up.
2. **Heatmap and chart components** (Tasks 4–5): pure render functions, easiest to verify in isolation.
3. **HTML structure + CSS** (Task 6): the new layout shell.
4. **Client wiring** (Task 7): `admin.js` and `admin-api.js` updates that bring it all together.
5. **Manual UI verification + cleanup** (Task 8): run through the spec's verification checklist.

---

## Task 1: `GET /admin/api/engagement` endpoint

**Files:**
- Modify: `server/src/routes/admin.routes.js` (add new handler)
- Test: `server/test/integration/admin.test.js` (append new tests)

- [ ] **Step 1.1: Write the failing test for shape**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/engagement returns the right shape', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/engagement',
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(typeof body.total_runs, 'number');
  assert.equal(typeof body.dau, 'number');
  assert.equal(typeof body.wau, 'number');
  assert.equal(typeof body.new_players_7d, 'number');
  // median may be null when there's <1 row in the 30d window; accept null too
  assert.ok(body.median_score_30d === null || typeof body.median_score_30d === 'number');
  assert.ok(Array.isArray(body.runs_per_day_30d));
  assert.equal(body.runs_per_day_30d.length, 30);
  for (const d of body.runs_per_day_30d) {
    assert.equal(typeof d.date, 'string');
    assert.equal(typeof d.count, 'number');
  }
  assert.ok(body.total_runs >= 1);
  assert.ok(body.wau >= 1);
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration -- --grep "engagement"`
Expected: FAIL — route does not exist (404).

- [ ] **Step 1.3: Add the handler**

In `server/src/routes/admin.routes.js`, add inside the default-export function (after the `/per-op` handler, before `/heatmap`):

```js
fastify.get('/admin/api/engagement', async (req) => {
  const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const params = [];
  let where = '';
  if (userId != null && Number.isFinite(userId)) {
    params.push(userId);
    where = 'WHERE r.user_id = $1';
  }

  // Single roll-up query: total_runs, dau (SGT today), wau (last 7d), median (last 30d)
  const { rows: aggRows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_runs,
       COUNT(DISTINCT r.user_id) FILTER (
         WHERE (r.played_at AT TIME ZONE 'Asia/Singapore')::date
             = (now() AT TIME ZONE 'Asia/Singapore')::date
       )::int AS dau,
       COUNT(DISTINCT r.user_id) FILTER (
         WHERE r.played_at >= now() - interval '7 days'
       )::int AS wau,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.score)
         FILTER (WHERE r.played_at >= now() - interval '30 days') AS median_score_30d
     FROM runs r
     ${where}`,
    params
  );

  // New players in last 7d: users whose first run is within the window
  const { rows: newRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT user_id, MIN(played_at) AS first_run
       FROM runs r
       ${where}
       GROUP BY user_id
     ) t WHERE t.first_run >= now() - interval '7 days'`,
    params
  );

  // 30-day per-day run counts in SGT, padded to exactly 30 entries.
  const { rows: dayRows } = await pool.query(
    `SELECT
       (r.played_at AT TIME ZONE 'Asia/Singapore')::date AS d,
       COUNT(*)::int AS c
     FROM runs r
     ${where ? where + ' AND' : 'WHERE'} r.played_at >= now() - interval '30 days'
     GROUP BY d
     ORDER BY d ASC`,
    params
  );

  const dayMap = new Map(dayRows.map(r => [r.d.toISOString().slice(0, 10), r.c]));
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const runs_per_day_30d = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    runs_per_day_30d.push({ date: key, count: dayMap.get(key) ?? 0 });
  }

  const a = aggRows[0];
  return {
    total_runs: a.total_runs,
    dau: a.dau,
    wau: a.wau,
    new_players_7d: newRows[0].n,
    median_score_30d: a.median_score_30d == null ? null : Math.round(Number(a.median_score_30d)),
    runs_per_day_30d
  };
});
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration -- --grep "engagement"`
Expected: PASS.

- [ ] **Step 1.5: Add filtering test**

Append:

```js
test('GET /admin/api/engagement?user_id scopes to one player', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const aliceCookie = await registerAndCookie(app, 'alice');
  const bobCookie = await registerAndCookie(app, 'bob');
  await playOneShortRun(app, sessionStore, aliceCookie);
  await playOneShortRun(app, sessionStore, bobCookie);
  await playOneShortRun(app, sessionStore, bobCookie);

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/engagement?user_id=2', // bob
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.total_runs, 2);
  assert.equal(body.wau, 1);
});
```

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration -- --grep "engagement"`
Expected: PASS for both engagement tests.

- [ ] **Step 1.6: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/engagement endpoint"
```

---

## Task 2: `GET /admin/api/trouble-facts` endpoint

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Test: `server/test/integration/admin.test.js`

- [ ] **Step 2.1: Write the failing test for mul shape and threshold**

Append to `server/test/integration/admin.test.js`:

```js
test('GET /admin/api/trouble-facts?op=mul returns shape, n>=3, restricted to 2..12', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  // Seed: one user, one run, attempts spread across mul facts incl. >12 rhs
  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('seed', 'x')`);
  await pool.query(`INSERT INTO runs (user_id, score, duration_ms, played_at) VALUES (1, 50, 120000, now())`);
  // 4 attempts on (12, 7), 3 on (11, 8), 2 on (5, 5), 5 on (4, 50)
  const insert = `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
                  VALUES (1, $1, 'mul', $2, $3, $4, $5, $6, $7, now())`;
  let q = 0;
  for (let i = 0; i < 4; i++) await pool.query(insert, [q++, 12, 7, 84, '84', 3000, true]);
  for (let i = 0; i < 3; i++) await pool.query(insert, [q++, 11, 8, 88, '88', 2500, true]);
  for (let i = 0; i < 2; i++) await pool.query(insert, [q++, 5, 5, 25, '25', 800, true]);
  for (let i = 0; i < 5; i++) await pool.query(insert, [q++, 4, 50, 200, '200', 4000, true]); // rhs=50, OUT of range

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/trouble-facts?op=mul',
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.op, 'mul');
  assert.equal(typeof body.op_median_ms, 'number');
  assert.equal(typeof body.total_attempts, 'number');
  assert.ok(Array.isArray(body.facts));
  // Should include (12,7) [n=4] and (11,8) [n=3] but NOT (5,5) [n=2 < 3] or (4,50) [rhs > 12]
  const keys = body.facts.map(f => `${f.lhs}x${f.rhs}`);
  assert.ok(keys.includes('12x7'));
  assert.ok(keys.includes('11x8'));
  assert.ok(!keys.includes('5x5'));
  assert.ok(!keys.includes('4x50'));
  for (const f of body.facts) {
    assert.ok(f.lhs >= 2 && f.lhs <= 12);
    assert.ok(f.rhs >= 2 && f.rhs <= 12);
    assert.ok(f.attempts >= 3);
    assert.equal(typeof f.score, 'number');
  }
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration -- --grep "trouble-facts"`
Expected: FAIL — route does not exist (404).

- [ ] **Step 2.3: Add the handler**

In `server/src/routes/admin.routes.js`, add (after the `/heatmap` handler):

```js
fastify.get('/admin/api/trouble-facts', async (req, reply) => {
  const op = req.query.op;
  if (!['add', 'sub', 'mul', 'div'].includes(op)) {
    return reply.code(400).send({ error: 'bad_op' });
  }
  const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
  const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 8)));

  const params = [op];
  const wheres = [`a.op = $1`];
  if (userId != null && Number.isFinite(userId)) {
    params.push(userId);
    wheres.push(`r.user_id = $${params.length}`);
  }

  // Range filter: mul/div restricted to 2..12 × 2..12 (in their natural axes).
  // For mul: lhs (multiplicand) in 2..12 AND rhs (multiplier) in 2..12.
  // For div: rhs (divisor) in 2..12 AND lhs/rhs (quotient) in 2..12 AND lhs % rhs = 0.
  // For add/sub: no range filter (they don't appear in the redesigned weakness grid,
  // but the endpoint supports them for completeness/future use).
  if (op === 'mul') {
    wheres.push(`a.lhs BETWEEN 2 AND 12`);
    wheres.push(`a.rhs BETWEEN 2 AND 12`);
  } else if (op === 'div') {
    wheres.push(`a.rhs BETWEEN 2 AND 12`);
    wheres.push(`a.lhs % a.rhs = 0`);
    wheres.push(`(a.lhs / a.rhs) BETWEEN 2 AND 12`);
  }
  const whereSql = 'WHERE ' + wheres.join(' AND ');

  // Aggregate buckets that have n >= 3, plus the op-wide median and total attempts.
  const { rows: bucketRows } = await pool.query(
    `SELECT
       a.lhs                                                          AS lhs,
       a.rhs                                                          AS rhs,
       COUNT(*)::int                                                  AS attempts,
       AVG(a.response_ms)::float                                      AS mean_response_ms,
       (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct
     FROM attempts a
     JOIN runs r ON r.id = a.run_id
     ${whereSql}
     GROUP BY a.lhs, a.rhs
     HAVING COUNT(*) >= 3`,
    params
  );

  const { rows: medianRows } = await pool.query(
    `SELECT
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.response_ms)::float AS median,
       COUNT(*)::int                                                     AS total_attempts
     FROM attempts a
     JOIN runs r ON r.id = a.run_id
     ${whereSql}`,
    params
  );

  const opMedianMs = Math.max(1, Math.round(medianRows[0].median ?? 1));

  // Score = slowness ratio + 2 * inaccuracy ratio. Higher = worse.
  const scored = bucketRows.map(b => {
    const slowness = b.mean_response_ms / opMedianMs;
    const inaccuracy = 1 - (b.accuracy_pct / 100);
    const score = slowness + 2 * inaccuracy;
    return {
      lhs: b.lhs,
      rhs: b.rhs,
      attempts: b.attempts,
      mean_response_ms: Math.round(b.mean_response_ms),
      accuracy_pct: Math.round(b.accuracy_pct * 10) / 10,
      score: Math.round(score * 1000) / 1000
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  return {
    op,
    op_median_ms: opMedianMs,
    total_attempts: medianRows[0].total_attempts,
    facts: scored
  };
});
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration -- --grep "trouble-facts"`
Expected: PASS.

- [ ] **Step 2.5: Add division-axis test**

Append:

```js
test('GET /admin/api/trouble-facts?op=div uses (divisor, quotient) axes', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('seed', 'x')`);
  await pool.query(`INSERT INTO runs (user_id, score, duration_ms, played_at) VALUES (1, 50, 120000, now())`);
  const insert = `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
                  VALUES (1, $1, 'div', $2, $3, $4, $5, $6, $7, now())`;
  let q = 0;
  // 84 ÷ 7 = 12 → divisor=7, quotient=12 → in range
  for (let i = 0; i < 4; i++) await pool.query(insert, [q++, 84, 7, 12, '12', 3000, true]);
  // 600 ÷ 6 = 100 → quotient=100 → OUT of range
  for (let i = 0; i < 4; i++) await pool.query(insert, [q++, 600, 6, 100, '100', 5000, true]);
  // 9 ÷ 4: not divisible (lhs % rhs != 0) — should never happen but guard anyway
  // skip — the generator never produces these.

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/trouble-facts?op=div',
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  const keys = body.facts.map(f => `${f.lhs}/${f.rhs}`);
  assert.ok(keys.includes('84/7'));
  assert.ok(!keys.includes('600/6'));
});
```

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration -- --grep "trouble-facts"`
Expected: PASS for both.

- [ ] **Step 2.6: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "feat(admin): GET /admin/api/trouble-facts endpoint"
```

---

## Task 3: Remove `/admin/api/weak-spots`

The new trouble-facts endpoint replaces it; no client will call it after Task 7.

**Files:**
- Modify: `server/src/routes/admin.routes.js`
- Modify: `server/test/integration/admin.test.js`

- [ ] **Step 3.1: Find the existing weak-spots tests**

Run: `grep -n "weak-spots\|weakSpots" server/test/integration/admin.test.js`
Expected: locates the existing tests that hit `/admin/api/weak-spots`.

- [ ] **Step 3.2: Delete the weak-spots tests**

Open `server/test/integration/admin.test.js` and remove every `test(...)` block whose URL is `/admin/api/weak-spots`. (Typical names: `'GET /admin/api/weak-spots returns shape'`, `'GET /admin/api/weak-spots filters by user'` — use whatever the file actually has.)

- [ ] **Step 3.3: Delete the weak-spots handler**

In `server/src/routes/admin.routes.js`, remove the entire `fastify.get('/admin/api/weak-spots', ...)` handler block.

- [ ] **Step 3.4: Verify the removal compiles and existing tests still pass**

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration`
Expected: all remaining tests PASS. No reference to weak-spots.

- [ ] **Step 3.5: Commit**

```bash
git add server/src/routes/admin.routes.js server/test/integration/admin.test.js
git commit -m "refactor(admin): remove /weak-spots endpoint (replaced by /trouble-facts)"
```

---

## Task 4: Redesign heatmap component

**Files:**
- Modify: `client/admin/js/heatmap.js`

The new component:
- Accepts pre-clipped 11×11 cells (lhs/rhs both 2..12 for mul; divisor/quotient both 2..12 for div — the client transforms div data before passing it in)
- 25px cells, axis labels, neutral overlay on diagonal and ×10 row/col
- Click and hover hooks to link with the trouble-facts list

- [ ] **Step 4.1: Replace the file with the redesigned version**

Overwrite `client/admin/js/heatmap.js` with:

```js
// Renders an 11x11 (rows × cols, both 2..12) grid of mean response times.
// For mul: rows = multiplicand (lhs), cols = multiplier (rhs).
// For div: rows = quotient, cols = divisor. Caller transforms data before passing.
//
// cells: [{ row: 2..12, col: 2..12, mean_response_ms, accuracy_pct, attempts }]
// options: { onCellClick?: (row, col) => void, highlightedCell?: {row,col}|null, label: (row,col)=>string }
//
// The label function returns the human-readable fact text shown in the tooltip.

const MIN = 2, MAX = 12;
const N = MAX - MIN + 1;        // 11
const CELL = 25;
const PAD_TOP = 18, PAD_LEFT = 22;

export function renderHeatmap(canvas, tipEl, cells, options = {}) {
  const { onCellClick, highlightedCell, label } = options;
  canvas.width = PAD_LEFT + N * CELL;
  canvas.height = PAD_TOP + N * CELL;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (cells.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px system-ui';
    ctx.fillText('No data', PAD_LEFT + 4, PAD_TOP + 16);
    return;
  }

  // Color scale anchored at P10/P90 of mean response times.
  const sorted = cells.map(c => c.mean_response_ms).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? sorted[0];
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
  const span = Math.max(1, p90 - p10);

  const cellMap = new Map();
  for (const c of cells) cellMap.set(`${c.row},${c.col}`, c);

  // Axis labels
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let col = MIN; col <= MAX; col++) {
    const x = PAD_LEFT + (col - MIN) * CELL + CELL / 2;
    ctx.fillText(String(col), x, PAD_TOP - 2);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let row = MIN; row <= MAX; row++) {
    const y = PAD_TOP + (row - MIN) * CELL + CELL / 2;
    ctx.fillText(String(row), PAD_LEFT - 4, y);
  }

  // Cells
  for (let row = MIN; row <= MAX; row++) {
    for (let col = MIN; col <= MAX; col++) {
      const x = PAD_LEFT + (col - MIN) * CELL;
      const y = PAD_TOP + (row - MIN) * CELL;
      const c = cellMap.get(`${row},${col}`);

      if (!c) {
        ctx.fillStyle = '#1c2128'; // empty
      } else {
        const t = Math.max(0, Math.min(1, (c.mean_response_ms - p10) / span));
        const r = Math.round(60 + 195 * t);
        const g = Math.round(180 - 130 * t);
        const b = 60;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      }
      ctx.fillRect(x, y, CELL - 1, CELL - 1);

      // Neutral overlay on trivial facts (diagonal where row==col, and *10 row/col)
      if (row === col || row === 10 || col === 10) {
        ctx.fillStyle = 'rgba(139, 148, 158, 0.55)';
        ctx.fillRect(x, y, CELL - 1, CELL - 1);
      }
    }
  }

  // Highlight outline (driven by list hover)
  if (highlightedCell) {
    const { row, col } = highlightedCell;
    if (row >= MIN && row <= MAX && col >= MIN && col <= MAX) {
      const x = PAD_LEFT + (col - MIN) * CELL;
      const y = PAD_TOP + (row - MIN) * CELL;
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, CELL - 3, CELL - 3);
    }
  }

  // Hover tooltip
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD_LEFT;
    const py = e.clientY - rect.top - PAD_TOP;
    if (px < 0 || py < 0) { tipEl.textContent = ''; return; }
    const col = Math.floor(px / CELL) + MIN;
    const row = Math.floor(py / CELL) + MIN;
    if (row < MIN || row > MAX || col < MIN || col > MAX) { tipEl.textContent = ''; return; }
    const c = cellMap.get(`${row},${col}`);
    const factText = label ? label(row, col) : `${row}/${col}`;
    if (!c) {
      tipEl.textContent = `${factText}: no data`;
    } else {
      tipEl.textContent = `${factText}: ${c.mean_response_ms}ms · ${c.attempts} attempts · ${c.accuracy_pct}%`;
    }
  };
  canvas.onmouseleave = () => { tipEl.textContent = ''; };

  // Click → cell coordinate
  canvas.onclick = (e) => {
    if (!onCellClick) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD_LEFT;
    const py = e.clientY - rect.top - PAD_TOP;
    if (px < 0 || py < 0) return;
    const col = Math.floor(px / CELL) + MIN;
    const row = Math.floor(py / CELL) + MIN;
    if (row < MIN || row > MAX || col < MIN || col > MAX) return;
    onCellClick(row, col);
  };
}
```

- [ ] **Step 4.2: Verify the file is syntactically valid**

Run: `node --check client/admin/js/heatmap.js`
Expected: no output (exit 0).

- [ ] **Step 4.3: Commit**

```bash
git add client/admin/js/heatmap.js
git commit -m "feat(admin-client): redesign heatmap to 11x11 with axes, click hooks, neutral diagonal"
```

---

## Task 5: Redesign score chart component

**Files:**
- Modify: `client/admin/js/chart.js`

The new chart:
- Cohort median per SGT day as a thick neutral line (default visible)
- Per-player series, off by default; toggled via the `visiblePlayers` set passed in options
- X-axis date ticks and Y-axis gridlines with score labels
- Hover guideline + multi-series tooltip

- [ ] **Step 5.1: Replace the file with the redesigned version**

Overwrite `client/admin/js/chart.js` with:

```js
// SVG line chart for score-over-time with cohort median + per-player toggleable series.
// points: [{ played_at, score, username }] — already sorted ascending
// options: { showCohort?: boolean (default true), visiblePlayers?: Set<string>, sgtDate?: (iso)=>string }

const COLORS = ['#58a6ff', '#56d364', '#f1e05a', '#ff7b72', '#bc8cff', '#79c0ff'];
const COHORT_COLOR = '#e6edf3';

export function renderChart(container, points, options = {}) {
  container.innerHTML = '';
  if (points.length === 0) {
    container.textContent = 'No runs yet.';
    return;
  }

  const showCohort = options.showCohort !== false;
  const visiblePlayers = options.visiblePlayers ?? new Set();
  const sgtDate = options.sgtDate ?? ((iso) => new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', month: 'short', day: '2-digit' }));

  const W = container.clientWidth || 800;
  const H = 240;
  const PAD_L = 44, PAD_R = 12, PAD_T = 12, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const ts = points.map(p => +new Date(p.played_at));
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const tSpan = Math.max(1, tMax - tMin);
  const sMax = Math.max(1, ...points.map(p => p.score));

  const x = (t) => PAD_L + ((t - tMin) / tSpan) * innerW;
  const y = (s) => PAD_T + innerH - (s / sMax) * innerH;

  // Group raw points by player
  const byPlayer = new Map();
  for (const p of points) {
    if (!byPlayer.has(p.username)) byPlayer.set(p.username, []);
    byPlayer.get(p.username).push(p);
  }

  // Build cohort median per SGT day
  const cohort = cohortMedianByDay(points);

  // Y gridlines: 0, 1/4, 1/2, 3/4, max
  const yTicks = [0, sMax * 0.25, sMax * 0.5, sMax * 0.75, sMax].map(v => Math.round(v));

  // X ticks: 5 evenly spaced timestamps
  const xTickCount = 5;
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) xTicks.push(tMin + (tSpan * i) / (xTickCount - 1));

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">`;

  // Y gridlines + labels
  for (const v of yTicks) {
    const yy = y(v);
    svg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="#21262d" stroke-width="1" />`;
    svg += `<text x="${PAD_L - 6}" y="${yy + 4}" fill="#8b949e" font-size="11" text-anchor="end">${v}</text>`;
  }
  // X ticks (date labels)
  for (const t of xTicks) {
    const xx = x(t);
    svg += `<text x="${xx}" y="${H - PAD_B + 16}" fill="#8b949e" font-size="11" text-anchor="middle">${sgtDate(new Date(t).toISOString())}</text>`;
  }

  const seriesIndex = []; // { name, color, points: [{x,y,score,date}] }

  // Cohort series (drawn first, drawn slightly thicker)
  if (showCohort && cohort.length > 1) {
    const pts = cohort.map(c => ({
      x: x(+new Date(c.day + 'T00:00:00+08:00')),
      y: y(c.median),
      score: c.median,
      date: c.day
    }));
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    svg += `<path d="${d}" stroke="${COHORT_COLOR}" stroke-width="2.5" fill="none" />`;
    for (const p of pts) {
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${COHORT_COLOR}" />`;
    }
    seriesIndex.push({ name: 'Cohort median', color: COHORT_COLOR, points: pts });
  }

  // Per-player series (only if visible)
  let cIdx = 0;
  for (const [name, pts] of byPlayer) {
    const color = COLORS[cIdx++ % COLORS.length];
    if (!visiblePlayers.has(name)) continue;
    const xy = pts.map(p => ({
      x: x(+new Date(p.played_at)),
      y: y(p.score),
      score: p.score,
      date: sgtDate(p.played_at)
    }));
    const d = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    svg += `<path d="${d}" stroke="${color}" stroke-width="1.5" fill="none" opacity="0.9" />`;
    for (const p of xy) {
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}" />`;
    }
    seriesIndex.push({ name, color, points: xy });
  }

  // Hover guideline + tooltip group (CSS-driven via JS later)
  svg += `<line id="chart-guideline" x1="0" y1="${PAD_T}" x2="0" y2="${H - PAD_B}" stroke="#30363d" stroke-width="1" style="display:none" />`;
  svg += `<g id="chart-tooltip" style="display:none"></g>`;
  svg += '</svg>';
  container.innerHTML = svg;

  // Wire hover behavior
  const svgEl = container.querySelector('svg');
  const guide = svgEl.querySelector('#chart-guideline');
  const tip = svgEl.querySelector('#chart-tooltip');
  svgEl.addEventListener('mousemove', (e) => {
    const rect = svgEl.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    if (px < PAD_L || px > W - PAD_R) { guide.style.display = 'none'; tip.style.display = 'none'; return; }
    guide.setAttribute('x1', px); guide.setAttribute('x2', px);
    guide.style.display = '';
    // Find nearest point in each series
    const lines = [];
    for (const s of seriesIndex) {
      let best = null, bestDist = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.x - px);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      if (best && bestDist < 30) lines.push({ name: s.name, color: s.color, score: best.score, date: best.date });
    }
    if (lines.length === 0) { tip.style.display = 'none'; return; }
    // Build tooltip
    const lineH = 14, padY = 6, padX = 8;
    const boxW = 160, boxH = padY * 2 + lines.length * lineH + (lines[0].date ? lineH : 0);
    let tx = px + 10;
    if (tx + boxW > W - PAD_R) tx = px - boxW - 10;
    const ty = PAD_T + 6;
    let inner = `<rect x="${tx}" y="${ty}" width="${boxW}" height="${boxH}" fill="#0d1117" stroke="#30363d" rx="4" />`;
    inner += `<text x="${tx + padX}" y="${ty + padY + lineH - 2}" fill="#8b949e" font-size="11">${lines[0].date}</text>`;
    lines.forEach((ln, i) => {
      const y0 = ty + padY + (i + 1) * lineH;
      inner += `<circle cx="${tx + padX + 4}" cy="${y0 - 4}" r="3" fill="${ln.color}" />`;
      inner += `<text x="${tx + padX + 14}" y="${y0}" fill="#e6edf3" font-size="11">${ln.name}: ${ln.score}</text>`;
    });
    tip.innerHTML = inner;
    tip.style.display = '';
  });
  svgEl.addEventListener('mouseleave', () => { guide.style.display = 'none'; tip.style.display = 'none'; });
}

function cohortMedianByDay(points) {
  const byDay = new Map();
  for (const p of points) {
    const day = sgtDateOnly(p.played_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p.score);
  }
  return [...byDay.entries()]
    .map(([day, scores]) => {
      scores.sort((a, b) => a - b);
      return { day, median: scores[Math.floor(scores.length / 2)], n: scores.length };
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

function sgtDateOnly(iso) {
  // YYYY-MM-DD in SGT
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date(iso));
}
```

- [ ] **Step 5.2: Verify the file is syntactically valid**

Run: `node --check client/admin/js/chart.js`
Expected: no output (exit 0).

- [ ] **Step 5.3: Commit**

```bash
git add client/admin/js/chart.js
git commit -m "feat(admin-client): score chart with axes, cohort median, player toggles"
```

---

## Task 6: New HTML structure + CSS

**Files:**
- Modify: `client/admin/index.html`
- Modify: `client/admin/css/admin.css`

- [ ] **Step 6.1: Replace `index.html` body content**

Overwrite the `<main>` block in `client/admin/index.html` so the file becomes:

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
    <section id="engagement-section">
      <div id="engagement-strip" class="engagement-strip"></div>
    </section>

    <section>
      <h2>Score over time</h2>
      <div id="score-chart"></div>
      <div id="player-chips" class="player-chips"></div>
    </section>

    <section>
      <h2>Where players struggle</h2>
      <div class="weakness-grid">
        <div class="weakness-panel" id="weakness-mul">
          <h3>Multiplication</h3>
          <div class="weakness-summary" id="weakness-mul-summary"></div>
          <div class="weakness-row">
            <div class="trouble-list" id="trouble-mul"></div>
            <div class="heatmap-wrap">
              <canvas id="heatmap-mul"></canvas>
              <div id="heatmap-mul-tip" class="tip"></div>
            </div>
          </div>
        </div>
        <div class="weakness-panel" id="weakness-div">
          <h3>Division</h3>
          <div class="weakness-summary" id="weakness-div-summary"></div>
          <div class="weakness-row">
            <div class="trouble-list" id="trouble-div"></div>
            <div class="heatmap-wrap">
              <canvas id="heatmap-div"></canvas>
              <div id="heatmap-div-tip" class="tip"></div>
            </div>
          </div>
        </div>
      </div>
      <div id="addsub-cards" class="addsub-cards"></div>
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

- [ ] **Step 6.2: Append new CSS to `client/admin/css/admin.css`**

Append (do not replace existing rules):

```css
/* Engagement strip */
.engagement-strip { display: flex; gap: 12px; align-items: stretch; flex-wrap: wrap; }
.stat-tile { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 14px; flex: 1 1 140px; min-width: 140px; }
.stat-tile .label { font-size: 11px; text-transform: uppercase; color: #8b949e; letter-spacing: 0.05em; }
.stat-tile .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
.engagement-spark { width: 140px; align-self: center; }

/* Player chips below score chart */
.player-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.player-chip { padding: 3px 10px; border-radius: 12px; background: #21262d; cursor: pointer; font-size: 12px; user-select: none; border: 1px solid transparent; }
.player-chip:hover { border-color: #30363d; }
.player-chip.active { color: #0e1117; font-weight: 600; }

/* Weakness grid */
.weakness-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.weakness-panel h3 { margin: 0 0 6px; font-size: 13px; color: #e6edf3; text-transform: uppercase; letter-spacing: 0.05em; }
.weakness-summary { color: #8b949e; font-size: 12px; margin-bottom: 8px; }
.weakness-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 16px; align-items: start; }
.heatmap-wrap canvas { background: #161b22; border: 1px solid #30363d; border-radius: 4px; display: block; }

/* Trouble-facts list */
.trouble-list { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.trouble-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 3px; cursor: pointer; font-size: 13px; }
.trouble-row:hover, .trouble-row.linked { background: #21262d; }
.trouble-row.flash { animation: trouble-flash 1.5s ease-out; }
@keyframes trouble-flash { from { background: #1f3a3a; } to { background: transparent; } }
.trouble-fact { font-family: ui-monospace, monospace; }
.trouble-stat { color: #8b949e; font-size: 12px; font-variant-numeric: tabular-nums; }
.n-badge { display: inline-block; min-width: 36px; padding: 1px 6px; font-size: 10px; border-radius: 3px; border: 1px solid #30363d; text-align: center; color: #8b949e; }
.n-badge.solid { background: #21262d; color: #e6edf3; }
.trouble-empty { color: #8b949e; font-size: 12px; padding: 8px 0; }

/* Add/Sub cards (demoted) */
.addsub-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 24px; }
.addsub-cards .op-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 14px; }
.addsub-cards .op-card h4 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; }
.addsub-cards .op-card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; }
.addsub-cards .op-card dt { color: #8b949e; }

/* Responsive: stack the weakness grid below ~900px */
@media (max-width: 960px) {
  .weakness-grid, .addsub-cards { grid-template-columns: 1fr; }
  .weakness-row { grid-template-columns: 1fr; }
}
```

- [ ] **Step 6.3: Remove obsolete CSS rules**

In `client/admin/css/admin.css`, find and DELETE these rules (they target removed elements):

```css
#per-op-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.op-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
.op-card h4 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; }
.op-card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; }
.op-card dt { color: #8b949e; }
.weak-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
```

(They've been replaced by the new `.addsub-cards .op-card …` rules above and the new `.weakness-grid` rules.)

- [ ] **Step 6.4: Commit**

```bash
git add client/admin/index.html client/admin/css/admin.css
git commit -m "feat(admin-client): new layout HTML + CSS for engagement/weakness zones"
```

---

## Task 7: Wire it together — `admin-api.js` and `admin.js`

**Files:**
- Modify: `client/admin/js/admin-api.js`
- Modify: `client/admin/js/admin.js`

- [ ] **Step 7.1: Update `admin-api.js`**

Replace the `adminApi` object in `client/admin/js/admin-api.js` so it reads:

```js
export const adminApi = {
  players:        ()                       => get('/players'),
  runs:           (q = {})                 => get('/runs' + qs(q)),
  attempts:       (runId)                  => get(`/runs/${runId}/attempts`),
  perOp:          (q = {})                 => get('/per-op' + qs(q)),
  heatmap:        (op, q = {})             => get('/heatmap' + qs({ op, ...q })),
  troubleFacts:   (op, q = {})             => get('/trouble-facts' + qs({ op, ...q })),
  engagement:     (q = {})                 => get('/engagement' + qs(q)),
  scoreTimeSeries:(q = {})                 => get('/score-timeseries' + qs(q))
};
```

(Removed: `weakSpots`. Added: `troubleFacts`, `engagement`.)

- [ ] **Step 7.2: Replace `client/admin/js/admin.js`**

Overwrite `client/admin/js/admin.js` with:

```js
import { adminApi, sgtDate } from './admin-api.js';
import { renderHeatmap } from './heatmap.js';
import { renderChart } from './chart.js';

const els = {
  playerPicker: document.getElementById('player-picker'),
  windowPicker: document.getElementById('window-picker'),
  engagementStrip: document.getElementById('engagement-strip'),
  scoreChart: document.getElementById('score-chart'),
  playerChips: document.getElementById('player-chips'),
  troubleMul: document.getElementById('trouble-mul'),
  troubleDiv: document.getElementById('trouble-div'),
  heatmapMul: document.getElementById('heatmap-mul'),
  heatmapMulTip: document.getElementById('heatmap-mul-tip'),
  heatmapDiv: document.getElementById('heatmap-div'),
  heatmapDivTip: document.getElementById('heatmap-div-tip'),
  weaknessMulSummary: document.getElementById('weakness-mul-summary'),
  weaknessDivSummary: document.getElementById('weakness-div-summary'),
  addsubCards: document.getElementById('addsub-cards'),
  sessionsTable: document.getElementById('sessions-table'),
  sessionDetail: document.getElementById('session-detail')
};

const state = {
  userId: null,
  window: 'all',
  visiblePlayers: new Set(),
  scorePoints: [],
  highlight: { mul: null, div: null }  // { row, col } for currently outlined cell
};

const PLAYER_COLORS = ['#58a6ff', '#56d364', '#f1e05a', '#ff7b72', '#bc8cff', '#79c0ff'];

async function loadPlayers() {
  const { players } = await adminApi.players();
  els.playerPicker.innerHTML = '<option value="">All players</option>' +
    players.map(p => `<option value="${p.user_id}">${escape(p.username)} (${p.run_count})</option>`).join('');
  // Build chip list (one per player)
  els.playerChips.innerHTML = players.map((p, i) => {
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    return `<span class="player-chip" data-username="${escape(p.username)}" data-color="${color}" style="--chip-color:${color}">${escape(p.username)}</span>`;
  }).join('');
  els.playerChips.querySelectorAll('.player-chip').forEach(chip => {
    chip.addEventListener('click', () => togglePlayer(chip));
  });
}

function togglePlayer(chip) {
  const name = chip.dataset.username;
  if (state.visiblePlayers.has(name)) {
    state.visiblePlayers.delete(name);
    chip.classList.remove('active');
    chip.style.background = '';
  } else {
    state.visiblePlayers.add(name);
    chip.classList.add('active');
    chip.style.background = chip.dataset.color;
  }
  renderChart(els.scoreChart, state.scorePoints, { visiblePlayers: state.visiblePlayers, sgtDate });
}

async function refresh() {
  const userId = state.userId;

  const [engagement, chart, perOp, mulFacts, divFacts, mulCells, divCells, runs] = await Promise.all([
    adminApi.engagement({ user_id: userId }),
    adminApi.scoreTimeSeries({ user_id: userId, window: state.window }),
    adminApi.perOp({ user_id: userId }),
    adminApi.troubleFacts('mul', { user_id: userId }),
    adminApi.troubleFacts('div', { user_id: userId }),
    adminApi.heatmap('mul', { user_id: userId }),
    adminApi.heatmap('div', { user_id: userId }),
    adminApi.runs({ user_id: userId, limit: 100 })
  ]);

  renderEngagement(engagement);
  state.scorePoints = chart.points;
  renderChart(els.scoreChart, chart.points, { visiblePlayers: state.visiblePlayers, sgtDate });
  renderWeaknessPanel('mul', mulFacts, mulCells, perOp.per_op);
  renderWeaknessPanel('div', divFacts, divCells, perOp.per_op);
  renderAddSubCards(perOp.per_op);
  renderSessions(runs.runs);

  els.sessionDetail.innerHTML = '';
}

function renderEngagement(d) {
  const tiles = [
    { label: 'Total runs',       value: d.total_runs.toLocaleString() },
    { label: 'DAU',              value: d.dau },
    { label: 'WAU',              value: d.wau },
    { label: 'New players (7d)', value: d.new_players_7d },
    { label: 'Median score (30d)', value: d.median_score_30d ?? '—' }
  ];
  const tilesHtml = tiles.map(t => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value">${t.value}</div></div>`).join('');
  els.engagementStrip.innerHTML = tilesHtml + sparklineSvg(d.runs_per_day_30d);
}

function sparklineSvg(daily) {
  const W = 140, H = 36;
  const max = Math.max(1, ...daily.map(d => d.count));
  const bw = W / daily.length;
  const bars = daily.map((d, i) => {
    const h = (d.count / max) * (H - 2);
    return `<rect x="${i * bw}" y="${H - h}" width="${Math.max(1, bw - 1)}" height="${h}" fill="#56d364" opacity="0.8"><title>${d.date}: ${d.count}</title></rect>`;
  }).join('');
  return `<svg class="engagement-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bars}</svg>`;
}

function renderWeaknessPanel(op, troubleResp, heatmapResp, perOpRows) {
  const summaryEl = op === 'mul' ? els.weaknessMulSummary : els.weaknessDivSummary;
  const listEl    = op === 'mul' ? els.troubleMul         : els.troubleDiv;
  const canvasEl  = op === 'mul' ? els.heatmapMul         : els.heatmapDiv;
  const tipEl     = op === 'mul' ? els.heatmapMulTip      : els.heatmapDivTip;

  // Summary line: attempts · accuracy · mean ms (from per-op aggregate, not range-clipped)
  const opStat = perOpRows.find(r => r.op === op);
  if (opStat) {
    summaryEl.textContent = `${opStat.attempts.toLocaleString()} attempts · ${opStat.accuracy_pct}% accuracy · ${opStat.mean_response_ms}ms mean`;
  } else {
    summaryEl.textContent = 'No attempts yet.';
  }

  // Trouble-facts list
  const facts = troubleResp.facts;
  if (facts.length === 0) {
    listEl.innerHTML = `<div class="trouble-empty">More data needed — currently ${troubleResp.total_attempts} attempts on ${op} buckets.</div>`;
  } else {
    listEl.innerHTML = facts.map((f, i) => {
      const factText = op === 'mul'
        ? `${f.lhs} × ${f.rhs}`
        : `${f.lhs} ÷ ${f.rhs}`;  // for div, lhs=dividend, rhs=divisor
      const badgeClass = f.attempts >= 10 ? 'n-badge solid' : 'n-badge';
      // Cell coords for linking with heatmap:
      //   mul: row=lhs, col=rhs
      //   div: row=quotient=lhs/rhs, col=divisor=rhs
      const row = op === 'mul' ? f.lhs : Math.floor(f.lhs / f.rhs);
      const col = op === 'mul' ? f.rhs : f.rhs;
      return `<div class="trouble-row" data-row="${row}" data-col="${col}" data-idx="${i}">
        <span class="trouble-fact">${factText}</span>
        <span class="trouble-stat">${f.mean_response_ms}ms</span>
        <span class="trouble-stat">${f.accuracy_pct}%</span>
        <span class="${badgeClass}">n=${f.attempts}</span>
      </div>`;
    }).join('');

    // Hover row → outline cell
    listEl.querySelectorAll('.trouble-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        state.highlight[op] = { row: Number(row.dataset.row), col: Number(row.dataset.col) };
        drawHeatmap(op, heatmapResp);
      });
      row.addEventListener('mouseleave', () => {
        state.highlight[op] = null;
        drawHeatmap(op, heatmapResp);
      });
    });
  }

  drawHeatmap(op, heatmapResp);

  function drawHeatmap(opK, heatResp) {
    if (opK !== op) return;
    const cells = transformCells(op, heatResp.cells);
    const label = op === 'mul'
      ? (row, col) => `${row} × ${col}`
      : (row, col) => `${row * col} ÷ ${col}`;  // dividend ÷ divisor
    renderHeatmap(canvasEl, tipEl, cells, {
      highlightedCell: state.highlight[op],
      label,
      onCellClick: (row, col) => {
        // Find matching list row, scroll into view, flash
        const target = listEl.querySelector(`.trouble-row[data-row="${row}"][data-col="${col}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          target.classList.remove('flash');
          // Force reflow so the animation restarts
          // eslint-disable-next-line no-unused-expressions
          target.offsetWidth;
          target.classList.add('flash');
        }
      }
    });
  }
}

// Transform raw API heatmap cells into the (row, col) shape the redesigned heatmap expects.
//   mul: row = lhs (multiplicand), col = rhs (multiplier). Clip to 2..12 × 2..12.
//   div: row = quotient = lhs/rhs, col = divisor = rhs. Aggregate cells with same (row,col)
//        if multiple raw cells map to the same divisor/quotient (shouldn't happen since
//        the generator produces unique (lhs,rhs) per quotient — but defensive).
function transformCells(op, raw) {
  if (op === 'mul') {
    return raw
      .filter(c => c.lhs >= 2 && c.lhs <= 12 && c.rhs >= 2 && c.rhs <= 12)
      .map(c => ({ row: c.lhs, col: c.rhs, mean_response_ms: c.mean_response_ms, accuracy_pct: c.accuracy_pct, attempts: c.attempts }));
  }
  // div
  const out = new Map();
  for (const c of raw) {
    if (c.rhs < 2 || c.rhs > 12) continue;
    if (c.lhs % c.rhs !== 0) continue;
    const q = c.lhs / c.rhs;
    if (q < 2 || q > 12) continue;
    const key = `${q},${c.rhs}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { row: q, col: c.rhs, mean_response_ms: c.mean_response_ms, accuracy_pct: c.accuracy_pct, attempts: c.attempts });
    } else {
      const total = prev.attempts + c.attempts;
      prev.mean_response_ms = Math.round((prev.mean_response_ms * prev.attempts + c.mean_response_ms * c.attempts) / total);
      prev.accuracy_pct = Math.round(((prev.accuracy_pct * prev.attempts + c.accuracy_pct * c.attempts) / total) * 10) / 10;
      prev.attempts = total;
    }
  }
  return [...out.values()];
}

function renderAddSubCards(rows) {
  const byOp = new Map(rows.map(r => [r.op, r]));
  const ops = ['add', 'sub'];
  els.addsubCards.innerHTML = ops.map(op => {
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

- [ ] **Step 7.3: Verify both files compile**

Run: `node --check client/admin/js/admin-api.js && node --check client/admin/js/admin.js`
Expected: no output (exit 0).

- [ ] **Step 7.4: Commit**

```bash
git add client/admin/js/admin-api.js client/admin/js/admin.js
git commit -m "feat(admin-client): wire engagement, trouble-facts, linked heatmap, player chips"
```

---

## Task 8: Manual UI verification

This is verification-before-completion: run the dashboard locally and walk through the spec's testing checklist.

**Files:** none modified (verification only).

- [ ] **Step 8.1: Run server tests**

Run: `cd server && TEST_DATABASE_URL=$TEST_DATABASE_URL npm test`
Expected: all tests PASS, including the new engagement and trouble-facts tests.

- [ ] **Step 8.2: Start the server locally**

Run: `cd server && npm run dev` (in one terminal — leave running).

- [ ] **Step 8.3: Browse to `/admin/`**

Open the admin URL configured in `deploy/nginx.conf` for local dev (typically `http://localhost:8080/admin/`) and provide the Basic Auth credentials. If running without nginx, add a static file route for `client/admin/` and hit it directly.

- [ ] **Step 8.4: Walk through the verification checklist**

Verify each of the following and check off when confirmed:

- [ ] Engagement strip renders 5 stat tiles + a 30-day sparkline; values look reasonable
- [ ] Score chart shows a thick "Cohort median" line by default; X-axis shows ~5 SGT date ticks; Y-axis shows 5 gridlines with score labels (0, ¼, ½, ¾, max)
- [ ] Hovering the chart shows a vertical guideline + tooltip with date + visible series values
- [ ] Clicking a player chip toggles its line on/off; chip fills with the line color when active
- [ ] Multiplication panel renders an 11×11 heatmap with row/col labels 2..12; diagonal and ×10 row/col have a neutral grey overlay
- [ ] Multiplication trouble-facts list shows up to 8 facts ordered by score, each with a `n=N` badge; badge is solid when n≥10, hollow otherwise
- [ ] Hovering a list row outlines the matching heatmap cell
- [ ] Clicking a heatmap cell scrolls the matching list row into view and flashes it
- [ ] Division panel does the same with `dividend ÷ divisor` labels (e.g., `56 ÷ 7` for divisor=7, quotient=8)
- [ ] When a specific player is selected via the picker, all sections filter to that player; the cohort line in the score chart represents that player's daily median
- [ ] Add and Sub cards render below the weakness grid with attempts/accuracy/mean/median
- [ ] Sessions table at the bottom is unchanged — clicking a row still opens the detail view
- [ ] Resize window down to 900px → weakness grid stacks vertically and stays readable
- [ ] On a fresh DB (zero runs) → score chart shows "No runs yet."; trouble-lists show "More data needed" footer; heatmaps show "No data"; engagement strip shows zeros

- [ ] **Step 8.5: If any issue found, fix and re-verify**

For any unchecked item: fix the underlying issue in the relevant file, run `node --check` and tests as appropriate, commit with a `fix(admin)` message, and re-verify the affected items.

- [ ] **Step 8.6: Final commit (if cleanups needed) and summary**

```bash
git log --oneline main..HEAD
```

Expected: a tidy chain of feat/refactor commits, one per task. No fixup or revert noise.

---

## Self-review summary

**Spec coverage check:**

| Spec section | Plan task |
|---|---|
| Page layout (3 zones) | Task 6 (HTML) |
| Engagement strip + sparkline | Task 1 (endpoint), Task 7 (render) |
| Cohort progress chart | Task 5 (component), Task 7 (wire-up) |
| Trouble-facts list (n≥3, 2..12, scoring) | Task 2 (endpoint), Task 7 (render + linking) |
| Heatmap (11×11, axes, neutral diagonal/×10, click hooks) | Task 4 (component), Task 7 (data transform + linking) |
| Add/Sub demoted cards | Task 7 (`renderAddSubCards`) |
| Activity-table removal | Task 6 (HTML), Task 7 (admin.js) |
| Sessions table unchanged | Task 6 (kept in HTML), Task 7 (`renderSessions`) |
| Per-op median for trouble-facts scoring | Task 2 (server-side `op_median_ms`) |
| Division axis transformation (divisor × quotient) | Task 2 (server filter) + Task 7 (`transformCells`) |
| `/weak-spots` removal | Task 3 |

All spec sections have at least one concrete task. No placeholders found in plan content. Type/identifier names are consistent across tasks (`engagement`, `trouble-facts`, `transformCells`, `state.highlight`, `state.visiblePlayers`).
