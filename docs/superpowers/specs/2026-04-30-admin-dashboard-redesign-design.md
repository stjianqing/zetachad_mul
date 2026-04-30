# Admin Dashboard Redesign — Design Spec

**Date:** 2026-04-30
**Status:** Approved, ready for plan

## Goal

Make the admin dashboard at `/admin/` answer three questions at a glance: **(1) is anyone using this thing?** (engagement), **(2) are players progressing?** (cohort + individual trajectories), **(3) what is everyone weak at?** (mul/div trouble facts). Existing dashboard buries all three behind unreadable visualizations and an empty weak-spots table; redesign rebuilds the UI surface around these three goals without changing the data pipeline.

## Scope

In scope: `client/admin/index.html`, `client/admin/css/admin.css`, `client/admin/js/admin.js`, `client/admin/js/admin-api.js`, `client/admin/js/heatmap.js`, `client/admin/js/chart.js`, plus two new read-only endpoints (`/engagement`, `/trouble-facts`) and one removal (`/weak-spots`) in `server/src/routes/admin.routes.js`. Tests in `server/test/integration/admin.test.js` updated to match.

Out of scope: DB schema, write paths, session detail view, runs table at the bottom, login/auth, the public-facing client. The existing "Activity (all players)" table at the top of the page (loaded by `loadPlayers()` in `admin.js`) is **removed** — its contents (player list with run counts, best score, last played, attempts) are entirely subsumed by the new engagement strip plus the player picker, which already shows run counts in its option labels.

## Non-goals

- No new migrations. Schema (runs, attempts) stays as-is.
- No backfill, no data movement, no changes to what gets recorded.
- No changes to player-facing pages.

## Page layout

Three full-width zones top-to-bottom, then the existing sessions table at the bottom unchanged.

```
┌─ Header (existing) ────────────────────────────────────────────────┐
│  Player picker   Window picker                                     │
└────────────────────────────────────────────────────────────────────┘
┌─ Zone 1: Engagement strip (~80px) ─────────────────────────────────┐
│  [Total runs] [DAU] [WAU] [New 7d] [Median score 30d]   ▁▂▃▅▂▄▆▃▁ │
└────────────────────────────────────────────────────────────────────┘
┌─ Zone 2: Cohort progress chart (~280px) ───────────────────────────┐
│  Y-axis 0/¼/½/¾/max gridlines · X-axis SGT date ticks              │
│  Thick "cohort median" line (default) + per-player toggles below   │
└────────────────────────────────────────────────────────────────────┘
┌─ Zone 3: Weakness analysis ────────────────────────────────────────┐
│  ┌─ Multiplication ─────────┐  ┌─ Division ─────────────────────┐  │
│  │ Trouble facts (top 8)    │  │ Trouble facts (top 8)          │  │
│  │ + small linked heatmap   │  │ + small linked heatmap         │  │
│  └──────────────────────────┘  └────────────────────────────────┘  │
│  ┌─ Add summary card ───────┐  ┌─ Sub summary card ─────────────┐  │
│  └──────────────────────────┘  └────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
┌─ Sessions table (unchanged) + session detail (unchanged) ──────────┐
└────────────────────────────────────────────────────────────────────┘
```

The window picker (`all` / `30` / `7`) and player picker keep their current behavior. When a specific player is selected, the engagement strip, cohort chart, and trouble-facts views all filter to that player. "All players" is the default.

## Components

### Engagement strip (new)

Five stat tiles + one inline 30-day sparkline, in a flex row. Each tile is a small card showing label + value; the sparkline is a tiny SVG (no axes, no labels — pure shape).

| Tile | Value | Window |
|---|---|---|
| Total runs | `count(runs)` | All time |
| DAU | distinct `user_id` with run today (SGT) | Today |
| WAU | distinct `user_id` with run in last 7d | 7d |
| New players (7d) | users whose first run is in last 7d | 7d |
| Median score | `percentile_cont(0.5)` over `runs.score` | Last 30d |

Sparkline: runs per day for the last 30 days (29 bars + today). Renders as a single SVG path of bar-shaped rects, inline and ~120×24px. Tooltip on hover shows date + count.

### Cohort progress chart (replaces existing score chart)

SVG-based, same approach as today (`client/admin/js/chart.js`), but expanded:

- **Default series:** cohort median score per day, thick neutral-colored line. Computed client-side by bucketing the existing `/admin/api/score-timeseries` points by SGT day and taking the median.
- **Toggleable series:** per-player line, off by default. Each player gets a colored chip below the chart; clicking the chip toggles that player's line on/off and the chip fills with their line color when active.
- **X-axis:** 4–6 evenly-spaced date ticks formatted in SGT (e.g., `Apr 12`, `Apr 19`). Tick count adapts to chart width.
- **Y-axis:** 5 gridlines at `0`, `¼·max`, `½·max`, `¾·max`, `max`, each labeled with its score value. Gridlines are subtle (`#21262d`).
- **Hover:** vertical guideline tracks the cursor; tooltip shows the date and the value of every visible series at that x.
- **Empty state:** "No runs yet." (existing behavior preserved.)

When a specific player is selected via the header picker, the cohort line is replaced by that player's line (no toggles needed).

### Trouble-facts list + heatmap (replaces "weak spots" tables and current heatmap)

Two side-by-side panels, one for `mul` and one for `div`. Each panel contains:

**Trouble-facts list (top 8)** — one row per (lhs, rhs) bucket, ranked by:

```
score = (mean_response_ms / op_median_ms) + (1 - accuracy_pct/100) * 2
```

Slowness normalized against the op's own median so it's comparable across ops; inaccuracy weighted 2× because wrong answers matter more than slow ones for a learning tool. Threshold: **n ≥ 3** attempts per bucket (down from current 10). Each row shows:
- The fact (e.g., `12 × 7`)
- Mean response time
- Accuracy %
- An `n=N` badge — solid border when `n ≥ 10` (high confidence), hollow border when `3 ≤ n < 10` (provisional)

If fewer than 8 buckets meet `n ≥ 3`, show what we have plus a footer: "More data needed — currently {N} attempts on {OP} buckets."

**Heatmap (small, linked)** — restricted to **lhs 2..12 × rhs 2..12** (was lhs 2..12 × rhs 2..100). Cell size 25×25px (was 10×10px); whole grid ~325×325px. Same green→red mean-response gradient (P10/P90 anchored). Adds:
- Column-number labels along the top (2..12)
- Row-number labels along the left (2..12)
- The `lhs == rhs` diagonal and `rhs == 10` column rendered with a neutral grey overlay so they don't dominate the gradient (these are trivial facts — not signal)
- Click a cell → the matching fact in the list scrolls into view and gets a 1.5s flash highlight
- Hover a list row → the matching cell gets a 2px outline
- Hover behavior on cells unchanged (existing tooltip via `#heatmap-*-tip`)

For division: cells are `dividend ÷ divisor`. Restrict divisor to 2..12 (the `rhs` column in DB) and dividend (`lhs` in DB) to the values produced by the generator for that divisor, mapped to a 11×11 grid where the row index is `dividend / divisor` (the answer) ∈ 2..12. Hover/list show the natural form `dividend ÷ divisor`.

### Add/Sub summary cards (demoted)

Compact two-card row below the weakness grid. Each card matches the existing op-card visual (label + dl with attempts/accuracy/mean/median). No heatmap, no trouble-facts list — these ops are simpler and the user explicitly called out only mul/div as problem areas.

The existing 4-card "Per-op summary" section (which had add/sub/mul/div side-by-side) is split: mul and div are absorbed into the weakness panels above (their key stats — attempts, accuracy, mean — render as a small header above each trouble-facts list), and add/sub keep their card form as the row described here.

### Sessions table + session detail (unchanged)

Existing markup, existing logic, existing styles. Stays at the bottom of the page.

## Data flow

```
GET /admin/api/engagement                    [NEW]
GET /admin/api/score-timeseries              (existing, no change)
GET /admin/api/per-op                        (existing, no change)
GET /admin/api/weak-spots                    (existing, REPLACED by trouble-facts)
GET /admin/api/trouble-facts?op=mul|div      [NEW]
GET /admin/api/heatmap?op=mul|div            (existing, params unchanged; client clips to 2..12)
GET /admin/api/runs                          (existing, no change)
GET /admin/api/runs/:id/attempts             (existing, no change)
```

The old `/admin/api/weak-spots` endpoint is **removed** (not deprecated — single client, no public consumers). Its handler is deleted from `admin.routes.js`. Replaced by the new `/admin/api/trouble-facts` endpoint described below.

### `GET /admin/api/engagement` (new)

Query params: `user_id?` (when set, scopes everything to that player; DAU/WAU/new-players become 1/0 indicators of whether they played, median score becomes their personal median).

Returns:
```json
{
  "total_runs": 1234,
  "dau": 5,
  "wau": 12,
  "new_players_7d": 3,
  "median_score_30d": 47,
  "runs_per_day_30d": [{"date": "2026-04-01", "count": 4}, ...]  // 30 entries
}
```

DAU computed in SGT: `r.played_at AT TIME ZONE 'Asia/Singapore' >= date_trunc('day', now() AT TIME ZONE 'Asia/Singapore')`. WAU similarly over a 7-day window.

### `GET /admin/api/trouble-facts` (new)

Query params: `op` (required, one of `add|sub|mul|div`), `user_id?`, `limit?` (default 8, max 20).

Returns:
```json
{
  "op": "mul",
  "op_median_ms": 1800,
  "facts": [
    {"lhs": 12, "rhs": 7, "attempts": 14, "mean_response_ms": 3200, "accuracy_pct": 71.4, "score": 2.34},
    ...
  ],
  "total_attempts": 1209
}
```

SQL: same `attempts a JOIN runs r` join used by the existing weak-spots endpoint, with:
- `HAVING COUNT(*) >= 3` (down from 10)
- For mul/div: `WHERE a.lhs BETWEEN 2 AND 12 AND a.rhs BETWEEN 2 AND 12`
- For division specifically the constraint applies as: divisor (`rhs`) in 2..12, quotient (the answer) in 2..12 — equivalent to `lhs BETWEEN rhs*2 AND rhs*12` since the existing schema stores `lhs ÷ rhs`. Verify by reading `server/src/game/generator.js` before implementing.
- `op_median_ms` computed in the same query: `percentile_cont(0.5) WITHIN GROUP (ORDER BY response_ms)` over all attempts of this op (filtered by user_id when set), used to normalize the score
- Score computed in JS after fetch (small list, simpler than SQL)
- Sort by score descending, take `limit` rows

`total_attempts` is included so the empty-state footer can show "currently N attempts" when fewer than 8 buckets meet n≥3.

### Score chart series computation (client-side)

Cohort median per day:

```js
function cohortMedianByDay(points) {
  const byDay = new Map();  // sgtDateString -> [scores]
  for (const p of points) {
    const day = sgtDate(p.played_at).slice(0, 10);  // "YYYY-MM-DD"
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p.score);
  }
  return [...byDay.entries()]
    .map(([day, scores]) => ({
      day,
      median: scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)],
      n: scores.length
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
```

Per-player series uses the existing grouping logic in `chart.js` but with players hidden by default.

## Files changed

```
client/admin/index.html             — restructure sections per layout above
client/admin/css/admin.css          — new styles: engagement strip, trouble-facts list, linked heatmap states, axes/grids, chips
client/admin/js/admin.js            — wire up new endpoints, render functions for engagement/trouble-facts, link list↔heatmap
client/admin/js/chart.js            — add axes, gridlines, cohort series, hover guideline, chip toggles
client/admin/js/heatmap.js          — restrict to 2..12, larger cells, axis labels, neutral diagonal/×10, click + outline-on-hover hooks
client/admin/js/admin-api.js        — add engagement(), troubleFacts() wrappers; remove weakSpots() (no callers after the redesign)
server/src/routes/admin.routes.js   — add /engagement, add /trouble-facts handlers; remove /weak-spots handler
server/test/integration/admin.test.js — add tests for new endpoints; remove weak-spots tests
```

## Component contracts

Each visual component is a single render function with a small input shape, mirroring the current pattern.

```js
// engagement.js (new)
renderEngagement(container, data: EngagementResponse): void

// trouble-facts.js (new) — drives both list and the linked-heatmap interactions
renderTroubleFacts({
  listEl, heatmapCanvas, heatmapTipEl,
  facts: TroubleFact[],
  heatmapCells: HeatmapCell[],   // already filtered to 2..12 × 2..12 by API consumer
  op: 'mul' | 'div'
}): void

// chart.js (modified)
renderChart(container, points: Point[], options?: { showCohort?: boolean, visiblePlayers?: Set<string> }): void

// heatmap.js (modified)
renderHeatmap(canvas, tipEl, cells: HeatmapCell[], options?: { onCellClick?: (lhs, rhs) => void, highlightedCell?: {lhs, rhs} | null }): void
```

Each function reads its inputs and writes its DOM target. No global state. Easy to test in isolation.

## CSS additions (sketch)

```css
/* Engagement strip */
.engagement-strip { display: flex; gap: 12px; margin-bottom: 24px; align-items: stretch; }
.stat-tile { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 14px; flex: 1; }
.stat-tile .label { font-size: 11px; text-transform: uppercase; color: #8b949e; letter-spacing: 0.05em; }
.stat-tile .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
.engagement-spark { width: 120px; align-self: center; }

/* Weakness grid (mul + div side-by-side) */
.weakness-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.weakness-panel h3 { margin: 0 0 8px; font-size: 13px; color: #8b949e; text-transform: uppercase; }
.weakness-panel .row { display: grid; grid-template-columns: 1fr 325px; gap: 16px; align-items: start; }

/* Trouble-facts list */
.trouble-list { display: flex; flex-direction: column; gap: 4px; }
.trouble-row { display: flex; justify-content: space-between; padding: 6px 8px; border-radius: 3px; cursor: pointer; }
.trouble-row:hover, .trouble-row.linked { background: #21262d; }
.trouble-row.flash { background: #1f3a3a; transition: background 0.4s; }
.n-badge { display: inline-block; min-width: 32px; padding: 0 4px; font-size: 10px; border-radius: 3px; border: 1px solid #30363d; }
.n-badge.solid { background: #21262d; }

/* Player chips */
.player-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.player-chip { padding: 3px 10px; border-radius: 12px; background: #21262d; cursor: pointer; font-size: 12px; }
.player-chip.active { color: #0e1117; }
```

## Testing

Two test surfaces:

1. **Server integration tests** (`server/test/integration/admin.test.js`):
   - `/admin/api/engagement` returns the right shape and computes DAU/WAU correctly given seeded runs across days
   - `/admin/api/trouble-facts?op=mul` returns at most 8 rows, each with `n >= 3`, restricted to lhs/rhs ∈ [2,12], sorted by score desc
   - `/admin/api/trouble-facts` includes `op_median_ms` and `total_attempts`
   - `user_id` param scopes correctly for both endpoints

2. **Manual UI verification** (no UI test framework in this repo):
   - Load `/admin/` with seeded data, screenshot each zone
   - Toggle a player chip → line appears/disappears
   - Click a heatmap cell → list row scrolls into view + flashes
   - Hover a list row → matching cell gets outline
   - Resize browser → layout reflows cleanly down to ~900px
   - Empty-state: `/admin/` on a fresh DB should show empty-state messages everywhere, not blank tables

## Open assumptions to verify during implementation

1. **Generator range** — confirm `server/src/game/generator.js` produces mul facts only with both operands in 2..12 (or close to it). If it can produce e.g. `7 × 50`, the heatmap restriction is lossy and the design needs a small "outside-range" indicator.
2. **Division storage convention** — confirm whether `attempts.lhs/rhs` for `op=div` stores `dividend/divisor` (so `lhs ÷ rhs = answer`) or some other ordering. The trouble-facts SQL filter depends on this.
3. **Player count** — the player chips in the chart assume reasonable counts (≤20). If the platform has many more, the chips need a "show top N most-active" cap. Spot-check before implementing; not blocking.

These checks happen in the first plan step (read the generator + a few sample rows), not deferred.
