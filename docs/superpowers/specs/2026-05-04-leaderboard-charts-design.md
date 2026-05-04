# Leaderboard Charts — Design Spec

**Date:** 2026-05-04
**Status:** Draft, pending implementation plan

## Goal

Add two visualisations below the all-time leaderboard table on `client/leaderboard.html`:

1. A **bar chart** showing the distribution of submitted runs across difficulty buckets.
2. A **scatter plot** of every submitted run, with difficulty (y) vs questions completed (x). The current user's runs are highlighted.

The intent is to give players a relative sense of where their difficulty score sits in the broader population of runs, and a feel for how difficulty correlates (or doesn't) with the number of questions a player completed.

## Scope

- **All-time tab only.** The Daily tab is unchanged.
- Both charts are read-only visualisations. No selection, no drill-down, no navigation from the charts.
- Existing leaderboard table, captions, and the "Show the math" disclosure are unchanged.

## Out of scope (deferred)

- Recalibrating the run-difficulty formula (currently produces values squashed in the 1–3 range; charts will surface this and motivate a future redesign).
- A trend line on the scatter plot.
- Charts on the Daily tab.
- Interactivity beyond tooltips (no clicking, filtering, zooming).

## Architecture

### Backend

A single new endpoint:

```
GET /api/leaderboard/runs
```

- **Auth:** none (matches existing `GET /api/leaderboard`).
- **Returns:** `{ runs: [{ username, score, difficulty, played_at }, ...] }`.
- **Source:** `runs` table joined to `users`, filtered to `submitted_to_leaderboard = true`. Includes every eligible run (not deduped to best-per-user).
- **Bound:** `LIMIT 1000`, ordered by `played_at DESC`. Defensive cap; current scale is far below this.
- **Location:** `server/src/routes/board.routes.js`, alongside the existing board endpoints.

Query (illustrative):

```sql
SELECT u.username, r.score, r.difficulty, r.played_at
FROM runs r
JOIN users u ON u.id = r.user_id
WHERE r.submitted_to_leaderboard = true
ORDER BY r.played_at DESC
LIMIT 1000;
```

### Frontend

Two SVG containers added to `client/leaderboard.html` inside the existing `#all-time-board` section, after the `.diff-math` `<details>` element. Each container holds a title, an `<svg>` element, and an italic dim caption beneath.

A new module `client/js/leaderboard-charts.js` exports two pure render functions:

```js
export function renderDifficultyBars(svgEl, runs)
export function renderRunsScatter(svgEl, runs, currentUsername)
```

A new method on `client/js/api.js`:

```js
boardRuns()  // GET /api/leaderboard/runs
```

`client/js/leaderboard.js` orchestrates: after the table renders, it fires `api.boardRuns()`, filters out runs with `difficulty == null`, then calls the two render functions.

### Styling

CSS additions in `client/css/styles.css`. No new files, no chart libraries. Hand-rolled SVG.

## Data flow

1. Page load. Existing flow: fetch user via `api.me()`, render user-area; fetch table via `api.board()`, render rows.
2. Independent of the table fetch, fire `api.boardRuns()`. Both charts render placeholder text ("Loading…") until this resolves.
3. On success: filter `runs` to those with non-null `difficulty`. Pass to both render functions along with `me?.username`.
4. On failure: replace placeholder text with "Could not load."
5. Empty dataset (zero qualifying runs): render "No runs yet." centred inside each SVG.

The two charts share the same fetched dataset — only one network request.

## Components

### `renderDifficultyBars(svgEl, runs)`

**Inputs:** an `<svg>` element, an array of run objects with at least a `difficulty` field.

**Behaviour:**

1. Compute data extent over `difficulty`. Round min down to nearest 0.5, max up to nearest 0.5.
2. Clamp the visible x-range to a minimum span of 0 to 4. If real data extends beyond, the axis grows. This prevents a single outlier squashing the chart and gives a stable visual baseline.
3. Partition runs into 0.5-wide bins across the visible range.
4. Render:
   - Y-axis with ~5 nice ticks based on max bin count.
   - X-axis with one tick per bin boundary.
   - One `<rect>` per bin, height proportional to bin count, fill `--accent` at 0.7 opacity. Empty bins render as a thin faded rect (opacity 0.15) so the axis doesn't look broken.
   - Count label above each non-empty bar.
   - Axis labels: "DIFFICULTY" (x), "RUNS" (y).
5. Caption beneath in italic dim text. Suggested copy (acerbic, matching existing style): "Bins are 0.5 wide. If everyone's clustered down low, blame the scale, not yourself."

### `renderRunsScatter(svgEl, runs, currentUsername)`

**Inputs:** an `<svg>` element, an array of runs, the current user's username (or `null` if not logged in).

**Behaviour:**

1. X-axis: `score` (= questions completed for the all-time drill). Range 0 to `max_score` rounded up to nearest 5.
2. Y-axis: `difficulty`. Same auto-fit logic as the bar chart — minimum 0 to 4, grows to fit.
3. Render one `<circle>` per run.
   - Default: fill `--accent`, opacity 0.5, radius 4.
   - If `run.username === currentUsername`: fill `--you` (pink, matching the existing `.you` row highlight), opacity 1.0, white stroke 1px, radius 5.
4. Sort runs so the user's runs render last (drawn on top).
5. Tooltip:
   - A single absolutely-positioned `<div>` lives outside the SVG, shared across all dots.
   - On `mouseenter` of a circle: set tooltip text to `${username} · ${score} pts · diff ${difficulty.toFixed(1)}`, position near cursor, show.
   - On `mouseleave`: hide.
6. Axis labels: "QUESTIONS COMPLETED" (x), "DIFFICULTY" (y).
7. Caption: "Each dot is one submitted run. Pink dots are yours. Hover for details."

### Shared properties of both render functions

- Use `viewBox="0 0 W H"` and `preserveAspectRatio="xMidYMid meet"` so the SVG scales with container width.
- All colours, fonts, and dimensions are read from CSS variables / use existing CSS classes. No hardcoded styling inside SVG attributes.
- Pure: same input → same output. No side effects beyond writing to the passed SVG element.
- Both clear the SVG (`svgEl.innerHTML = ''`) at the start so they're idempotent.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| Endpoint 5xx | Both SVGs show "Could not load." Table unaffected. |
| Endpoint 200, zero runs | Both SVGs show "No runs yet." |
| Endpoint 200, all runs have `difficulty == null` | Both SVGs show "No difficulty data yet." |
| Single run | Bar chart: one bar inside a 0–4 axis. Scatter: one dot. Both render. |
| Outlier difficulty (e.g. one run at 9.0 amid a cluster at 1–3) | Axis grows to fit. Truthful, even if visually sparse. |
| Outlier score | Axis grows. Acceptable for v1; may revisit if it becomes a real problem. |
| User not logged in | Scatter has no pink dots. Otherwise unchanged. |
| User logged in but never played | Same as above. |
| Mobile / narrow viewport | `viewBox` scales the SVG. Axis tick labels may need to skip every other label if cramped — handled if observed during manual testing. |

## Testing

- **Server:** integration test in `server/test/integration/` covering `GET /api/leaderboard/runs`:
  - Returns expected schema.
  - Excludes runs where `submitted_to_leaderboard = false`.
  - Returns runs whose `difficulty` is null without filtering them out (the endpoint stays simple — the client filters them when rendering charts).
  - Respects the 1000-row limit (smoke test).
- **Client:** no formal tests (codebase has no frontend test infra). Manual verification:
  - Load `/leaderboard.html` while logged in. Confirm both charts render below the existing all-time table.
  - Confirm pink dots appear at the user's submitted runs.
  - Hover scatter dots, confirm tooltip shows correct username/score/diff.
  - Log out, reload. Confirm no pink dots, charts otherwise unchanged.
  - Resize viewport down to a phone width. Confirm both charts still render legibly.

## Files touched

**New:**
- `client/js/leaderboard-charts.js` — two render functions.

**Modified:**
- `server/src/routes/board.routes.js` — new `GET /api/leaderboard/runs` handler.
- `server/test/integration/` — new test file or addition to existing leaderboard test.
- `client/leaderboard.html` — two new SVG containers below the all-time section.
- `client/js/api.js` — new `boardRuns()` method.
- `client/js/leaderboard.js` — orchestration: fetch runs, call render functions.
- `client/css/styles.css` — chart container, SVG class, dot, bar, tooltip, axis-tick, axis-label styles.

## Design decisions and rationale

- **Vanilla SVG, no chart library.** The codebase has zero frontend dependencies. The custom acerbic visual style (JetBrains Mono, custom tier colours, the pink `.you` highlight) would fight any library's defaults. Both charts are simple shapes — bars and dots — and SVG is the right primitive. Estimated cost: ~150 lines for both render functions plus tooltip wiring. Worth the one-time cost to avoid a forever dependency.
- **All submitted runs, not best-per-user.** The existing `/api/leaderboard` deduplicates to one row per user. For the bar chart's "relative sense of difficulty" framing to be informative, we need the full run population. New endpoint returns un-deduped runs.
- **Axis auto-fit with a 0–4 minimum.** Because the current difficulty formula is mis-calibrated (every value sits in 1–3), a strict 0–10 axis would render mostly empty. Auto-fit makes the chart legible. The 0–4 minimum prevents a single outlier from squashing the cluster, and provides a stable baseline so the chart doesn't visually thrash as data shifts. The chart will still be a clear *visual indicator* that the 0–10 scale is under-used — which is intentional, since recalibration is a known follow-up.
- **Scatter x-axis is `score` (questions completed), not `time taken`.** All all-time runs use the fixed 120s drill, so time is constant; questions completed is the only meaningful x-axis variance.
- **Highlighting current user's dots.** Mirrors the existing pink `.you` row in the table. Gives the chart personal stakes and visual continuity.
- **No trend line in v1.** Adds visual clutter; easy to layer on later if it proves valuable.
- **Stacked layout, not side-by-side.** The `.narrow` main is ~720px max. Side-by-side at that width crushes both. Stacked gives each chart room to breathe and works without changes on mobile.

## Known follow-ups

- **Difficulty formula recalibration.** The existing `runs.difficulty` values cluster in 1–3 of a 0–10 scale because `CEIL_MS = 7000` is too aggressive — almost no real cluster has a 7-second median. A separate piece of work should either (a) tune `FLOOR_MS` / `CEIL_MS` and the linear mapping, or (b) replace the final 0–10 mapping with a percentile rescale (median run = 5.0 by construction). Out of scope here; these charts will help motivate that work.
