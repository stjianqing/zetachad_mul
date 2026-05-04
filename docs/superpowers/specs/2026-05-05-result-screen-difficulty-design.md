# Result-screen difficulty display — design

## Goal

After a 2-minute default-config run ends, show the run's computed difficulty on the result screen — without requiring the player to submit to the leaderboard first.

## Background — what already exists

Significant infrastructure is already in place:

- `client/play.html:35` already has `<div id="run-difficulty" class="run-difficulty hidden"></div>` on the result screen, right under `#final-score`.
- `client/js/play.js` already has a `showDifficulty(d)` function (line 580) that renders `Run difficulty: 6.3 / 10` with a colour tier (`easy` / `mid` / `hard` / `extreme`) and matching CSS in `client/css/styles.css:1003`.
- `server/src/routes/play.routes.js` already computes difficulty inside `flushRunIfRecording` and stamps it onto the live session as `liveAfter.difficulty = difficulty` (line 287).
- The leaderboard `submit` endpoint (`server/src/routes/board.routes.js:19,27,59`) already returns `difficulty` in its response, and the client calls `showDifficulty(r?.difficulty ?? null)` after a successful submit.

## What is missing

The difficulty is currently visible **only after the player submits to the leaderboard.** In `finish(payload)` at `client/js/play.js:401`, the time-up handler explicitly calls `showDifficulty(null)`, then waits for the submit response to overwrite it. This means:

- A logged-in player who clicks "Yes, submit" sees difficulty.
- A logged-in player who declines the submit modal never sees difficulty.
- A guest never sees difficulty.
- A non-default-config run never sees difficulty (correct — there is none).

This spec wires the time-up payload to carry difficulty so the result screen shows it immediately.

## Scope

**In scope:**
- Add `difficulty` to the `/api/play/answer` `time_up` response payload (non-daily-gauntlet branch).
- In `finish(payload)`, replace the unconditional `showDifficulty(null)` with `showDifficulty(payload.difficulty ?? null)`.

**Out of scope:**
- Any change to `showDifficulty()`, the DOM element, or the CSS tiers — they stay exactly as they are.
- Any change to `computeRunDifficulty` or median-cache plumbing.
- Any change to the daily-gauntlet finish UI.
- Any change to the post-submit `showDifficulty(r.difficulty)` call sites — they remain (idempotent re-render with the same value).

## Backend change

File: `server/src/routes/play.routes.js`

In the non-daily-gauntlet branch of the `time_up` handler (currently at line 201–202):

```js
const live = sessionStore.get(session_id);
return { time_up: true, final_score: r.finalScore, run_id: live?.runId ?? null };
```

becomes:

```js
const live = sessionStore.get(session_id);
return {
  time_up: true,
  final_score: r.finalScore,
  run_id: live?.runId ?? null,
  difficulty: live?.difficulty ?? null
};
```

`flushRunIfRecording(req, session_id)` is awaited just above this `return`, so by the time we read `live.difficulty` it has been stamped (or the function early-returned without stamping, in which case we get `undefined` → coerced to `null` by the `??`).

The early-return cases inside `flushRunIfRecording` (`!rec || rec.userId == null || rec.attempts.length === 0`) naturally produce `difficulty: null`. No special-casing needed.

The daily-gauntlet branch (which has its own response shape) is left unchanged.

## Frontend change

File: `client/js/play.js`

At line 401 inside `finish(payload)`:

```js
// Difficulty for practice runs comes from the implicit submit below; for normal
// runs it comes from the user's manual submit. In both cases we wait for the
// submit response. Until then, hide the row.
showDifficulty(null);
```

becomes:

```js
showDifficulty(payload.difficulty ?? null);
```

Drop the stale comment block — the rationale no longer applies.

The post-submit `showDifficulty(r?.difficulty ?? null)` calls (lines 418 and 565) stay. They re-render with the same value the player has already been seeing; no flicker, no mismatch.

## Display rules (unchanged)

`showDifficulty(d)` already handles every case correctly:

| Condition | UI |
|---|---|
| `d` is a finite number | `Run difficulty: 6.3 / 10` with tier colour |
| `d` is `null` | element gets the `hidden` class — row disappears |

Tier thresholds (`easy ≤4 < mid ≤6 < hard ≤8 < extreme`) and CSS colours stay as-is.

## Edge cases

| Case | Behaviour |
|---|---|
| Default-config run, ≥1 attempt, medianCache available | `difficulty` rendered immediately on time-up |
| Anonymous user (guest) | `flushRunIfRecording` early-returns; payload `difficulty: null`; row hidden |
| Zero-attempts run (timer expired before any answer submitted) | Same as guest — `null` → row hidden |
| `medianCache` unavailable / cluster lookups all fail | `computeRunDifficulty` returns `null`; row hidden |
| Non-default config | `recordsAttempts` returns false; no attempts collected; difficulty stays `null`; row hidden |
| Practice run | `flushRunIfRecording` runs and stamps difficulty; payload includes it; difficulty shown immediately. The implicit `api.submit()` that follows will re-render with the same value (no-op visually). |
| Logged-in default-config run, user declines submit modal | Difficulty already shown — modal decline no longer hides it |

## Testing

### Server

Add to `server/test/integration/play.test.js`:

1. Time-up response on a logged-in default-config run with attempts → payload includes a finite `difficulty`.
2. Time-up response on a guest (anonymous) run → payload includes `difficulty: null`.
3. Time-up response on a logged-in run with zero answered questions → payload includes `difficulty: null`.

### Client

`client/js/play.js` is vanilla DOM JS with no existing unit-test harness. Manual verification only.

### Manual verification

- Log in, finish a 2-min default-config run with several correct answers, decline the submit modal → difficulty row visible immediately, stays visible after declining.
- Log in, finish a 2-min default-config run, accept the submit modal → difficulty row visible before and after submit (no flicker).
- Play a guest 2-min run → time-up screen shows no difficulty row (hidden).
- Start a 2-min run, answer nothing, let timer expire → no difficulty row.
- Run a custom-config 2-min session → no difficulty row.
- Finish a practice run → difficulty row visible immediately.

## Risks

- **None expected.** The backend change is a read-only field addition to a response payload. The frontend change replaces a hard-coded `null` with the payload value. All existing UI behaviour for non-default and guest runs is preserved (still `null` → hidden).
- The post-submit `showDifficulty` calls remain and overwrite with the same value — verified harmless because `showDifficulty` is idempotent for a given `d`.
