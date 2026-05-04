# Leaderboard Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a difficulty-distribution bar chart and a difficulty-vs-questions-completed scatter plot below the all-time leaderboard table on `client/leaderboard.html`.

**Architecture:** New `GET /api/leaderboard/runs` endpoint returns every leaderboard-eligible run. A new client module `leaderboard-charts.js` exposes two pure SVG render functions called by `leaderboard.js`. Vanilla SVG, no chart library. Charts auto-fit their axes to data with sensible minimums; the current user's runs in the scatter are highlighted in magenta to mirror the existing `.you` row.

**Tech Stack:** Fastify + pg (server), vanilla ES modules (client), Node's built-in test runner (`node:test`), pg integration tests gated on `TEST_DATABASE_URL`.

**Reference spec:** `docs/superpowers/specs/2026-05-04-leaderboard-charts-design.md`.

---

## File Structure

**New:**
- `client/js/leaderboard-charts.js` — two pure render functions (`renderDifficultyBars`, `renderRunsScatter`) and one tooltip helper. Pure: same input → same DOM mutation of the passed SVG element. No fetch, no globals.

**Modified:**
- `server/src/routes/board.routes.js` — add `GET /api/leaderboard/runs` handler.
- `server/test/integration/leaderboard.test.js` — add tests for the new endpoint.
- `client/js/api.js` — add `boardRuns()` method.
- `client/leaderboard.html` — add two SVG containers with titles and captions, after the `.diff-math` block.
- `client/js/leaderboard.js` — orchestrate the runs fetch, call render functions, manage loading/error/empty states.
- `client/css/styles.css` — chart container, SVG axis/tick/label/grid/bar/dot/tooltip styles.

**Out of scope:** difficulty-formula recalibration, daily-tab charts, trend lines.

---

## Task 1: Backend endpoint — failing test for shape and basic behaviour

**Files:**
- Test: `server/test/integration/leaderboard.test.js` (modify)

- [ ] **Step 1: Add three new tests in `leaderboard.test.js` after the existing tests**

Append to the end of `server/test/integration/leaderboard.test.js`:

```js
test('GET /api/leaderboard/runs returns one entry per submitted run, not per user', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const a = await registerAndCookie(app, 'alice');
  const b = await registerAndCookie(app, 'bob');

  await playAndSubmit(app, sessionStore, a, 3);
  await playAndSubmit(app, sessionStore, a, 5);
  await playAndSubmit(app, sessionStore, b, 4);

  const res = await app.inject({ method: 'GET', url: '/api/leaderboard/runs' });
  assert.equal(res.statusCode, 200);
  const { runs } = res.json();
  assert.equal(runs.length, 3);
  for (const r of runs) {
    assert.ok(typeof r.username === 'string');
    assert.ok(typeof r.score === 'number');
    assert.ok(r.played_at);
    assert.ok('difficulty' in r);
  }
  const scoresByUser = runs.reduce((acc, r) => { (acc[r.username] ||= []).push(r.score); return acc; }, {});
  assert.deepEqual(new Set(scoresByUser.alice), new Set([3, 5]));
  assert.deepEqual(scoresByUser.bob, [4]);
});

test('GET /api/leaderboard/runs excludes runs not submitted to leaderboard', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore, pool } = await freshApp();
  t.after(() => app.close());

  const a = await registerAndCookie(app, 'alice');
  await playAndSubmit(app, sessionStore, a, 3);

  // Insert a run directly that is not submitted to leaderboard.
  await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, submitted_to_leaderboard)
     VALUES ((SELECT id FROM users WHERE username = 'alice'), 99, 120000, false)`
  );

  const res = await app.inject({ method: 'GET', url: '/api/leaderboard/runs' });
  const { runs } = res.json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].score, 3);
});

test('GET /api/leaderboard/runs returns runs ordered by played_at desc', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const a = await registerAndCookie(app, 'alice');
  await playAndSubmit(app, sessionStore, a, 3);
  await playAndSubmit(app, sessionStore, a, 4);
  await playAndSubmit(app, sessionStore, a, 5);

  const res = await app.inject({ method: 'GET', url: '/api/leaderboard/runs' });
  const { runs } = res.json();
  assert.equal(runs.length, 3);
  // Most recently played run is first.
  for (let i = 0; i < runs.length - 1; i++) {
    assert.ok(runs[i].played_at >= runs[i + 1].played_at);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `server/`:
```
TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:integration -- --test-name-pattern="leaderboard/runs"
```

(On Windows PowerShell: `$env:TEST_DATABASE_URL=$env:TEST_DATABASE_URL; npm run test:integration -- --test-name-pattern="leaderboard/runs"`)

Expected: 3 failures with status 404 or similar, since the endpoint doesn't exist yet.

- [ ] **Step 3: No commit yet** — implement in next task before committing.

---

## Task 2: Backend endpoint — implementation

**Files:**
- Modify: `server/src/routes/board.routes.js`

- [ ] **Step 1: Add the handler inside the existing `boardRoutes` function**

Add this handler in `server/src/routes/board.routes.js`, immediately after the existing `fastify.get('/api/leaderboard', ...)` handler (before `'/api/leaderboard/champion'`):

```js
fastify.get('/api/leaderboard/runs', async () => {
  const { rows } = await pool.query(
    `SELECT u.username, r.score, r.difficulty, r.played_at
     FROM runs r
     JOIN users u ON u.id = r.user_id
     WHERE r.submitted_to_leaderboard = true
     ORDER BY r.played_at DESC
     LIMIT 1000`
  );
  return {
    runs: rows.map((r) => ({
      username: r.username,
      score: r.score,
      difficulty: r.difficulty == null ? null : Number(r.difficulty),
      played_at: r.played_at.toISOString()
    }))
  };
});
```

- [ ] **Step 2: Run tests to verify they pass**

```
npm run test:integration -- --test-name-pattern="leaderboard/runs"
```

Expected: all 3 tests PASS.

- [ ] **Step 3: Run the full leaderboard test file to ensure no regressions**

```
npm run test:integration -- --test-name-pattern="leaderboard"
```

Expected: all leaderboard tests PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/board.routes.js server/test/integration/leaderboard.test.js
git commit -m "feat(api): add GET /api/leaderboard/runs

Returns every leaderboard-eligible run (not deduped per-user) with
username, score, difficulty, played_at. Capped at 1000 most recent.
Used by the upcoming distribution + scatter charts."
```

---

## Task 3: Client API method

**Files:**
- Modify: `client/js/api.js`

- [ ] **Step 1: Add the `boardRuns` method**

In `client/js/api.js`, add `boardRuns` to the exported `api` object next to the existing `board` line:

Find:
```js
  board:     () => request('GET',  '/leaderboard'),
```

Replace with:
```js
  board:     () => request('GET',  '/leaderboard'),
  boardRuns: () => request('GET',  '/leaderboard/runs'),
```

- [ ] **Step 2: Manually verify in browser console (sanity check)**

Open the running dev server, visit the leaderboard page, in DevTools console run:
```js
const { api } = await import('/js/api.js');
const data = await api.boardRuns();
console.log(data.runs.length, data.runs[0]);
```

Expected: a number and an object with `username`, `score`, `difficulty`, `played_at` keys.

- [ ] **Step 3: Commit**

```bash
git add client/js/api.js
git commit -m "feat(client): add api.boardRuns() for run-population charts"
```

---

## Task 4: Chart module — `renderDifficultyBars` (skeleton + axis math)

**Files:**
- Create: `client/js/leaderboard-charts.js`

- [ ] **Step 1: Create the file with the helper functions and the bar-chart render function**

Create `client/js/leaderboard-charts.js` with the following content. This task adds only the bar chart; the scatter is added in Task 5.

```js
// Small, focused chart module for the leaderboard page.
// Pure render functions: each clears the passed SVG element and rewrites it.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = String(text);
  return e;
}

function clear(svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }

function centeredMessage(svg, text, viewBox) {
  clear(svg);
  svg.setAttribute('viewBox', viewBox);
  const [, , w, h] = viewBox.split(' ').map(Number);
  svg.appendChild(el('text', {
    x: w / 2, y: h / 2,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    class: 'chart-empty-text'
  }, text));
}

// Round n down (floor) to the nearest step.
function floorTo(n, step) { return Math.floor(n / step) * step; }
// Round n up (ceil) to the nearest step.
function ceilTo(n, step) { return Math.ceil(n / step) * step; }

// Pick ~5 nice integer ticks for a y-axis from 0 to maxValue.
function niceYTicks(maxValue) {
  if (maxValue <= 5) return [0, 1, 2, 3, 4, 5].slice(0, maxValue + 1).concat(maxValue < 5 ? [] : []);
  const targetTicks = 5;
  const rawStep = maxValue / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceStep = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const top = Math.ceil(maxValue / niceStep) * niceStep;
  const ticks = [];
  for (let v = 0; v <= top; v += niceStep) ticks.push(v);
  return ticks;
}

const BAR_VB_W = 720;
const BAR_VB_H = 240;
const BAR_PAD_L = 50;
const BAR_PAD_R = 20;
const BAR_PAD_T = 20;
const BAR_PAD_B = 40;

export function renderDifficultyBars(svg, runs) {
  const VB = `0 0 ${BAR_VB_W} ${BAR_VB_H}`;
  if (!runs || runs.length === 0) return centeredMessage(svg, 'No runs yet.', VB);
  const diffs = runs.map((r) => r.difficulty).filter((d) => typeof d === 'number');
  if (diffs.length === 0) return centeredMessage(svg, 'No difficulty data yet.', VB);

  // Axis range: data extent rounded out to 0.5, clamped to a minimum span of 0–4.
  const dataMin = floorTo(Math.min(...diffs), 0.5);
  const dataMax = ceilTo(Math.max(...diffs), 0.5);
  const xMin = Math.min(0, dataMin);
  const xMax = Math.max(4, dataMax);

  // 0.5-wide bins.
  const binSize = 0.5;
  const binCount = Math.round((xMax - xMin) / binSize);
  const bins = new Array(binCount).fill(0);
  for (const d of diffs) {
    let idx = Math.floor((d - xMin) / binSize);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  }
  const maxBin = Math.max(...bins, 1);
  const yTicks = niceYTicks(maxBin);
  const yTop = yTicks[yTicks.length - 1];

  clear(svg);
  svg.setAttribute('viewBox', VB);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const plotW = BAR_VB_W - BAR_PAD_L - BAR_PAD_R;
  const plotH = BAR_VB_H - BAR_PAD_T - BAR_PAD_B;
  const xToPx = (v) => BAR_PAD_L + ((v - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (v) => BAR_PAD_T + plotH - (v / yTop) * plotH;

  // Y-axis grid lines + tick labels.
  for (const t of yTicks) {
    const y = yToPx(t);
    svg.appendChild(el('line', { x1: BAR_PAD_L, y1: y, x2: BAR_PAD_L + plotW, y2: y, class: 'chart-grid' }));
    svg.appendChild(el('text', { x: BAR_PAD_L - 8, y: y + 3, 'text-anchor': 'end', class: 'chart-tick' }, String(t)));
  }

  // Bars.
  const barWidth = plotW / binCount;
  for (let i = 0; i < binCount; i++) {
    const count = bins[i];
    const x = xToPx(xMin + i * binSize) + 1;
    const w = barWidth - 2;
    if (count === 0) {
      svg.appendChild(el('rect', { x, y: yToPx(0) - 2, width: w, height: 2, class: 'chart-bar empty' }));
    } else {
      const y = yToPx(count);
      svg.appendChild(el('rect', { x, y, width: w, height: yToPx(0) - y, class: 'chart-bar' }));
      svg.appendChild(el('text', { x: x + w / 2, y: y - 4, 'text-anchor': 'middle', class: 'chart-bar-count' }, String(count)));
    }
  }

  // X-axis tick labels at every bin boundary, but skip every other if we have many bins.
  const skipEvery = binCount > 12 ? 2 : 1;
  for (let i = 0; i <= binCount; i++) {
    if (i % skipEvery !== 0) continue;
    const v = xMin + i * binSize;
    const x = xToPx(v);
    svg.appendChild(el('text', { x, y: BAR_PAD_T + plotH + 16, 'text-anchor': 'middle', class: 'chart-tick' }, v.toFixed(1)));
  }

  // Axis labels.
  svg.appendChild(el('text', {
    x: BAR_PAD_L + plotW / 2, y: BAR_VB_H - 6,
    'text-anchor': 'middle', class: 'chart-axis-label'
  }, 'DIFFICULTY'));
  svg.appendChild(el('text', {
    x: 14, y: BAR_PAD_T + plotH / 2,
    'text-anchor': 'middle', class: 'chart-axis-label',
    transform: `rotate(-90 14 ${BAR_PAD_T + plotH / 2})`
  }, 'RUNS'));
}
```

- [ ] **Step 2: Verify the file parses (syntax sanity)**

From repo root:
```
node --check client/js/leaderboard-charts.js
```

Expected: no output (success).

- [ ] **Step 3: No commit yet** — wire it up and verify visually after the next task.

---

## Task 5: Chart module — `renderRunsScatter` + tooltip helper

**Files:**
- Modify: `client/js/leaderboard-charts.js`

- [ ] **Step 1: Append the scatter render function and tooltip helper**

Append to the end of `client/js/leaderboard-charts.js`:

```js
const SCAT_VB_W = 720;
const SCAT_VB_H = 280;
const SCAT_PAD_L = 50;
const SCAT_PAD_R = 20;
const SCAT_PAD_T = 20;
const SCAT_PAD_B = 50;

function ensureTooltip() {
  let tip = document.getElementById('chart-tooltip');
  if (tip) return tip;
  tip = document.createElement('div');
  tip.id = 'chart-tooltip';
  tip.className = 'chart-tooltip hidden';
  document.body.appendChild(tip);
  return tip;
}

function showTooltip(tip, text, evt) {
  tip.textContent = text;
  tip.classList.remove('hidden');
  const pad = 12;
  tip.style.left = `${evt.clientX + pad}px`;
  tip.style.top = `${evt.clientY + pad}px`;
}

function hideTooltip(tip) { tip.classList.add('hidden'); }

export function renderRunsScatter(svg, runs, currentUsername) {
  const VB = `0 0 ${SCAT_VB_W} ${SCAT_VB_H}`;
  if (!runs || runs.length === 0) return centeredMessage(svg, 'No runs yet.', VB);
  const usable = runs.filter((r) => typeof r.difficulty === 'number' && typeof r.score === 'number');
  if (usable.length === 0) return centeredMessage(svg, 'No difficulty data yet.', VB);

  // Y range: same auto-fit-with-min-0-to-4 as the bar chart.
  const diffs = usable.map((r) => r.difficulty);
  const yMin = Math.min(0, floorTo(Math.min(...diffs), 0.5));
  const yMax = Math.max(4, ceilTo(Math.max(...diffs), 0.5));

  // X range: 0 to ceil(max_score/5)*5.
  const scores = usable.map((r) => r.score);
  const xMin = 0;
  const xMax = Math.max(5, ceilTo(Math.max(...scores), 5));

  clear(svg);
  svg.setAttribute('viewBox', VB);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const plotW = SCAT_VB_W - SCAT_PAD_L - SCAT_PAD_R;
  const plotH = SCAT_VB_H - SCAT_PAD_T - SCAT_PAD_B;
  const xToPx = (v) => SCAT_PAD_L + ((v - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (v) => SCAT_PAD_T + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Y grid + ticks (every integer between yMin and yMax).
  for (let v = Math.ceil(yMin); v <= Math.floor(yMax); v++) {
    const y = yToPx(v);
    svg.appendChild(el('line', { x1: SCAT_PAD_L, y1: y, x2: SCAT_PAD_L + plotW, y2: y, class: 'chart-grid' }));
    svg.appendChild(el('text', { x: SCAT_PAD_L - 8, y: y + 3, 'text-anchor': 'end', class: 'chart-tick' }, String(v)));
  }

  // X grid + ticks at multiples of 5.
  const xStep = xMax > 60 ? 10 : 5;
  for (let v = 0; v <= xMax; v += xStep) {
    const x = xToPx(v);
    svg.appendChild(el('line', { x1: x, y1: SCAT_PAD_T, x2: x, y2: SCAT_PAD_T + plotH, class: 'chart-grid' }));
    svg.appendChild(el('text', { x, y: SCAT_PAD_T + plotH + 16, 'text-anchor': 'middle', class: 'chart-tick' }, String(v)));
  }

  // Axis labels.
  svg.appendChild(el('text', {
    x: SCAT_PAD_L + plotW / 2, y: SCAT_VB_H - 6,
    'text-anchor': 'middle', class: 'chart-axis-label'
  }, 'QUESTIONS COMPLETED'));
  svg.appendChild(el('text', {
    x: 14, y: SCAT_PAD_T + plotH / 2,
    'text-anchor': 'middle', class: 'chart-axis-label',
    transform: `rotate(-90 14 ${SCAT_PAD_T + plotH / 2})`
  }, 'DIFFICULTY'));

  // Sort: user's runs last, so they render on top.
  const sorted = usable.slice().sort((a, b) => {
    const au = a.username === currentUsername ? 1 : 0;
    const bu = b.username === currentUsername ? 1 : 0;
    return au - bu;
  });

  const tip = ensureTooltip();

  for (const run of sorted) {
    const isYou = run.username === currentUsername;
    const cx = xToPx(run.score);
    const cy = yToPx(run.difficulty);
    const c = el('circle', {
      cx, cy,
      r: isYou ? 5 : 4,
      class: isYou ? 'chart-dot you' : 'chart-dot'
    });
    const label = `${run.username} · ${run.score} pts · diff ${run.difficulty.toFixed(1)}`;
    c.addEventListener('mouseenter', (evt) => showTooltip(tip, label, evt));
    c.addEventListener('mousemove',  (evt) => showTooltip(tip, label, evt));
    c.addEventListener('mouseleave', () => hideTooltip(tip));
    svg.appendChild(c);
  }
}
```

- [ ] **Step 2: Verify the file parses**

```
node --check client/js/leaderboard-charts.js
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add client/js/leaderboard-charts.js
git commit -m "feat(client): add leaderboard-charts module (bar + scatter)

Pure SVG render functions: renderDifficultyBars and renderRunsScatter.
Both auto-fit axes to data with sensible minimums; scatter highlights
the current user's runs and shows tooltips on hover."
```

---

## Task 6: HTML — chart containers and CSS rules

**Files:**
- Modify: `client/leaderboard.html`
- Modify: `client/css/styles.css`

- [ ] **Step 1: Add the two chart containers to `leaderboard.html`**

In `client/leaderboard.html`, find:

```html
        <details class="diff-math">
          <summary>Show the math</summary>
          <div class="diff-math-body">
```

Locate the closing `</details>` of `.diff-math` (it ends just before `</section>` for `#all-time-board`). Insert these two containers immediately after `</details>` and before the closing `</section>`:

```html
        <div class="chart-block" id="diff-bars-block">
          <div class="chart-title">DIFFICULTY DISTRIBUTION — ALL SUBMITTED RUNS</div>
          <svg class="chart-svg" id="diff-bars" viewBox="0 0 720 240" preserveAspectRatio="xMidYMid meet"></svg>
          <p class="chart-caption">Each bar is a 0.5-wide difficulty bin. If everyone's clustered down low, blame the scale, not yourself.</p>
        </div>
        <div class="chart-block" id="runs-scatter-block">
          <div class="chart-title">DIFFICULTY VS QUESTIONS COMPLETED</div>
          <svg class="chart-svg" id="runs-scatter" viewBox="0 0 720 280" preserveAspectRatio="xMidYMid meet"></svg>
          <p class="chart-caption">Each dot is one submitted run. Magenta dots are yours. Hover for details.</p>
        </div>
```

- [ ] **Step 2: Append the chart styles to `styles.css`**

Append to the end of `client/css/styles.css`:

```css
/* ===== Leaderboard charts ===== */
.chart-block {
  background: var(--panel);
  border: 1px solid var(--border);
  padding: 16px 12px 8px;
  margin: 16px 0;
}
.chart-title {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--ink-dim);
  margin: 0 0 8px 4px;
}
.chart-svg {
  display: block;
  width: 100%;
  height: auto;
  font-family: var(--font-mono);
}
.chart-caption {
  color: var(--ink-dim);
  font-size: 11px;
  font-style: italic;
  margin: 6px 0 0 4px;
}
.chart-grid { stroke: var(--grid); stroke-width: 1; }
.chart-tick { fill: var(--ink-dim); font-size: 10px; }
.chart-axis-label { fill: var(--ink-dim); font-size: 10px; letter-spacing: 0.08em; }
.chart-bar { fill: var(--lime); opacity: 0.7; }
.chart-bar.empty { fill: var(--ink-faint); opacity: 0.3; }
.chart-bar-count { fill: var(--text); font-size: 10px; }
.chart-empty-text { fill: var(--ink-dim); font-size: 12px; font-style: italic; }
.chart-dot { fill: var(--lime); opacity: 0.55; cursor: default; }
.chart-dot.you {
  fill: var(--magenta);
  opacity: 1;
  stroke: var(--ink);
  stroke-width: 1;
}
.chart-tooltip {
  position: fixed;
  z-index: 10000;
  pointer-events: none;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 6px 8px;
  white-space: nowrap;
}
.chart-tooltip.hidden { display: none; }
```

- [ ] **Step 3: Commit**

```bash
git add client/leaderboard.html client/css/styles.css
git commit -m "feat(client): leaderboard chart containers + styles

Two SVG containers below the all-time table, plus the CSS for bars,
dots, grid, axis labels, ticks, captions, and the shared tooltip."
```

---

## Task 7: Wire it all up — fetch + render + states in `leaderboard.js`

**Files:**
- Modify: `client/js/leaderboard.js`

- [ ] **Step 1: Import the chart module**

At the top of `client/js/leaderboard.js`, change:

```js
import { api } from './api.js';
```

to:

```js
import { api } from './api.js';
import { renderDifficultyBars, renderRunsScatter } from './leaderboard-charts.js';
```

- [ ] **Step 2: Add a chart-loader function**

Add this function in `client/js/leaderboard.js`, right above the `document.addEventListener('DOMContentLoaded', ...)` line:

```js
function chartMessage(svgEl, viewBox, message) {
  svgEl.setAttribute('viewBox', viewBox);
  svgEl.innerHTML = `<text x="${viewBox.split(' ')[2] / 2}" y="${viewBox.split(' ')[3] / 2}" text-anchor="middle" dominant-baseline="middle" class="chart-empty-text">${escapeHtml(message)}</text>`;
}

async function loadAllTimeCharts(currentUsername) {
  const barsSvg = document.getElementById('diff-bars');
  const scatterSvg = document.getElementById('runs-scatter');
  if (!barsSvg || !scatterSvg) return;
  chartMessage(barsSvg, '0 0 720 240', 'Loading…');
  chartMessage(scatterSvg, '0 0 720 280', 'Loading…');
  let runs;
  try {
    ({ runs } = await api.boardRuns());
  } catch {
    chartMessage(barsSvg, '0 0 720 240', 'Could not load.');
    chartMessage(scatterSvg, '0 0 720 280', 'Could not load.');
    return;
  }
  const filtered = runs.filter((r) => typeof r.difficulty === 'number');
  renderDifficultyBars(barsSvg, filtered);
  renderRunsScatter(scatterSvg, filtered, currentUsername);
}
```

- [ ] **Step 3: Call the loader after the table renders**

In the existing `DOMContentLoaded` handler in `client/js/leaderboard.js`, find this block:

```js
  try {
    const { entries } = await api.board();
    document.getElementById('rows').innerHTML = rowsHtml(entries, me);
  } catch (e) {
    document.getElementById('rows').innerHTML = `<tr><td colspan="5">Could not load: ${escapeHtml(e.message)}</td></tr>`;
  }
```

Add immediately after the `try { ... } catch { ... }` block (still inside the `DOMContentLoaded` async function):

```js
  loadAllTimeCharts(me ? me.username : null);
```

(Don't `await` it — the charts load independently and shouldn't block any other init.)

- [ ] **Step 4: Manual verification — golden path**

Start the server and run the client. Visit `/leaderboard.html` (logged-out first):

Expected:
- The leaderboard table renders as before.
- Below the "Show the math" disclosure, two new chart blocks appear with titles and captions.
- Bar chart shows bins with counts; scatter shows green dots, no magenta dots.

Then log in as a user who has submitted runs and reload the page:

Expected:
- Same charts.
- One or more dots in the scatter are magenta with a white outline (corresponding to your runs).
- Hover any dot — a tooltip appears with `username · N pts · diff X.X`. Move the mouse — the tooltip follows.

- [ ] **Step 5: Manual verification — edge cases**

Open DevTools Network tab, find the `/api/leaderboard/runs` request, right-click → Block request URL, reload.

Expected: both charts show "Could not load." Table still renders.

Unblock the URL. With an empty database (or one where no runs are `submitted_to_leaderboard = true`):

Expected: both charts show "No runs yet."

- [ ] **Step 6: Manual verification — mobile width**

In DevTools, set device toolbar to a narrow viewport (e.g. 375×812).

Expected: both charts scale down with the container, axis labels remain legible, no horizontal scroll on the page.

- [ ] **Step 7: Commit**

```bash
git add client/js/leaderboard.js
git commit -m "feat(client): wire leaderboard charts to the all-time tab

Fetches runs in parallel with the table, renders both charts, handles
loading/error/empty states. Independent of table rendering."
```

---

## Task 8: Verification before completion

- [ ] **Step 1: Run the server test suite**

From `server/`:
```
npm test
```

Expected: all tests pass (assuming `TEST_DATABASE_URL` is set; otherwise integration tests skip cleanly).

- [ ] **Step 2: Lint check (if any)**

If the repo has a lint script, run `npm run lint` from both `client/` and `server/`. If no lint config, skip.

- [ ] **Step 3: Visual sanity check using the existing leaderboard data**

Visit `/leaderboard.html`. Confirm:
- Bar chart bins are 0.5 wide, axis covers at least 0–4.
- Bin counts above each bar match what the table implies (e.g. if the table shows 8 entries with diffs 1.1, 2.0, 2.3, 1.1, 2.0, 2.5, 1.8, 2.3, the 1.0–1.5 bin should be 2 (1.1, 1.1), the 1.5–2.0 bin should be 1 (1.8), the 2.0–2.5 bin should be 4 (2.0, 2.3, 2.0, 2.3), the 2.5–3.0 bin should be 1 (2.5)).
- Scatter shows one dot per *run* (not one per user). With un-deduped data, the count should match `runs` returned by `GET /api/leaderboard/runs`.
- Logged-in user's dots are magenta and on top.
- Tooltip shows correct values, follows cursor, hides on leave.

- [ ] **Step 4: Confirm no regressions on the existing leaderboard**

Visit `/leaderboard.html`:
- Table renders exactly as before (no styling shifts).
- "Show the math" still expands.
- Daily tab still loads correctly when clicked.
- "You" row still has the pink left-border highlight.

- [ ] **Step 5: Final commit (if any tweaks were made during verification)**

If you adjusted anything during verification, commit it now. Otherwise no commit.

```bash
# Only if needed
git add <files>
git commit -m "fix(charts): <whatever was tweaked>"
```

---

## Self-review

**Spec coverage:**
- ✅ New `GET /api/leaderboard/runs` endpoint → Tasks 1–2.
- ✅ Returns un-deduped runs with `username/score/difficulty/played_at` → Task 1 schema test, Task 2 implementation.
- ✅ 1000-row LIMIT → Task 2 implementation.
- ✅ Filters non-submitted runs → Task 1 test.
- ✅ Two SVG containers below the all-time section → Task 6.
- ✅ `renderDifficultyBars` with 0.5 bins, 0–4 minimum, count-above-bar → Task 4.
- ✅ `renderRunsScatter` with score (x), difficulty (y), magenta highlight, tooltips → Task 5.
- ✅ Auto-fit axes, sort user-runs-on-top → Task 5.
- ✅ Loading / error / empty states → Task 7.
- ✅ Filter null-difficulty client-side → Task 7.
- ✅ Captions in acerbic style → Task 6.
- ✅ Mobile responsiveness via `viewBox` → Tasks 4, 5; verified Task 7.
- ✅ Tooltip styling → Task 6 CSS.
- ✅ Server integration tests → Task 1.

**Placeholder scan:** No "TBD", "TODO", "implement later," or vague hand-waves. Every code block is complete.

**Type / name consistency:**
- `renderDifficultyBars(svg, runs)` and `renderRunsScatter(svg, runs, currentUsername)` — exported names match between Tasks 4, 5 and the import in Task 7.
- `api.boardRuns()` — defined Task 3, used Task 7.
- DOM IDs `diff-bars`, `runs-scatter` — defined in Task 6 HTML, queried in Task 7.
- CSS class names — `chart-block`, `chart-title`, `chart-svg`, `chart-caption`, `chart-grid`, `chart-tick`, `chart-axis-label`, `chart-bar`, `chart-bar.empty`, `chart-bar-count`, `chart-empty-text`, `chart-dot`, `chart-dot.you`, `chart-tooltip`, `chart-tooltip.hidden` — all defined in Task 6 CSS, all used in Tasks 4 / 5 / 7.
- Endpoint path `/api/leaderboard/runs` — defined Task 2, called via api method Task 3, exercised in tests Task 1.
