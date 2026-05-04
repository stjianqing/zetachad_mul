# Result-screen difficulty display — design

## Goal

After a 2-minute default-config run ends, show the run's computed difficulty below the final score on the result screen.

## Scope

**In scope:**
- The 2-minute (default-config) run flow only.
- Surfacing the existing per-run `difficulty` value (already computed by `server/src/run-difficulty/compute.js` and persisted on the run row) on the post-run result UI.

**Out of scope:**
- Changing how difficulty is computed.
- Adding difficulty to non-default-config runs (they don't record attempts, so no difficulty is computed for them).
- Adding difficulty to the daily-gauntlet finish UI.
- Backfilling or surfacing difficulty in any other UI surface (leaderboard already has its own treatment).

## Data flow

1. Player answers the last question or the 2-min timer expires → `/api/play/answer` returns `{ time_up: true, ... }`.
2. Inside that branch, the route calls `flushRunIfRecording`. That function:
   - Computes `difficulty` via `computeRunDifficulty(attempts, medianCache)`.
   - Persists it on the `runs` row.
   - Stamps it onto the live session object: `liveAfter.difficulty = difficulty` (`server/src/routes/play.routes.js:287`).
3. After `flushRunIfRecording` returns, the route reads the difficulty back off the session and includes it in the response payload as `difficulty` (number or `null`).
4. The client (`client/js/play.js`) receives the payload, reads `payload.difficulty`, and renders it into a new DOM element below the final score.

## Backend changes

File: `server/src/routes/play.routes.js`

In the non-daily-gauntlet branch of the `time_up` handler (around line 201–202), include `difficulty` in the response:

```js
const live = sessionStore.get(session_id);
return {
  time_up: true,
  final_score: r.finalScore,
  run_id: live?.runId ?? null,
  difficulty: live?.difficulty ?? null
};
```

Notes:
- `flushRunIfRecording` is awaited before this `return`, so by the time we read `live.difficulty` it has been stamped (or the function early-returned without stamping, in which case the read yields `undefined` → `null`).
- The early-return cases inside `flushRunIfRecording` (`!rec || rec.userId == null || rec.attempts.length === 0`) naturally produce `difficulty: null` in the response. No additional special-casing is required.
- The daily-gauntlet branch is left unchanged.

## Frontend changes

### HTML — `client/play.html`

Add a sibling element to the existing final-score element. Exact markup must match the conventions already used on this page:

```html
<div id="final-score">...</div>
<div class="final-difficulty">Difficulty: <span id="final-difficulty">—</span></div>
```

The em-dash is the default placeholder so the layout doesn't shift between "no difficulty yet" and "difficulty rendered."

### JS — `client/js/play.js`

1. Add a selector to the `els` map (alongside `finalScore` at line 48):
   ```js
   finalDifficulty: () => document.getElementById('final-difficulty'),
   ```
2. In `finish(payload)` (around line 395, where `final_score` is rendered):
   - Read `payload.difficulty`.
   - If it's a finite number, write `value.toFixed(1)` to `els.finalDifficulty().textContent`.
   - Otherwise, leave the existing `—` placeholder in place.

### CSS

Add a `.final-difficulty` rule that styles the line as secondary text (smaller font / dimmer colour than the score). Reuse existing typography and colour tokens already present in the result-screen styles. Do not introduce new design tokens.

## Display rules

| Condition | Rendered text |
|---|---|
| `difficulty` is a finite number | `Difficulty: <one-decimal>` (e.g. `Difficulty: 6.3`) |
| `difficulty` is `null` / `undefined` / not finite | `Difficulty: —` |

The stored value carries two decimals; the UI shows one decimal. Players don't need centisecond precision, and one decimal reads cleaner.

## Edge cases

| Case | Behaviour |
|---|---|
| Default-config run, ≥1 attempt, medianCache available | Number rendered |
| Anonymous user (no `userId`) | `flushRunIfRecording` early-returns; payload `difficulty: null`; UI shows `—` |
| Zero attempts (timer expired before any answer submitted) | Same as anonymous — `null` → `—` |
| `medianCache` unavailable or cluster lookups all fail | `computeRunDifficulty` returns `null`; payload `null`; UI shows `—` |
| Non-default config | `recordsAttempts` already returns false; no attempts; no difficulty; UI shows `—` |
| Old runs already in DB | Not relevant — the result screen reads from the in-memory session at finish time, never from the DB |

## Testing

### Server

Add to `server/test/integration/play.test.js`:

1. Time-up response for a default-config run with attempts and a working medianCache → payload includes `difficulty` as a finite number.
2. Time-up response for an anonymous user → payload includes `difficulty: null`.
3. Time-up response for a zero-attempts run → payload includes `difficulty: null`.

### Client

`client/js/play.js` is vanilla DOM JS. If no existing client unit-test harness covers this file, rely on manual verification rather than scaffolding a new harness for this single change.

### Manual verification

- Finish a 2-min default-config run with answers → difficulty appears below the score, one decimal.
- Start a 2-min run; do not answer any question; let the timer expire → result shows `—`.
- Run a custom-config session and finish → result shows `—`.

## Risks

- **None expected.** The backend change is a read-only addition to a response payload. The frontend change is additive (new DOM node, new selector). No existing code paths change behaviour.
- The only correctness concern is that we read `live.difficulty` *after* `await flushRunIfRecording(...)`, which is already the case in the proposed change.
