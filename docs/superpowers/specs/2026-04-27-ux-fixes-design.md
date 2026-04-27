---
name: UX fixes — auto-advance, timer expiry, logout
date: 2026-04-27
status: draft
---

# UX fixes: auto-advance, timer expiry, logout

Three small fixes to bring the multiplayer drill in line with the
single-player reference (`stjianqing/zetachad`) and to make logout work.

## Problems

1. **Answer entry requires Enter.** The drill input only advances when the
   user submits the form. The single-player reference advances as soon as
   the typed value matches the answer.
2. **Timer expiry leaves the user stuck.** When the countdown reaches 0,
   nothing on the client closes the run. The score screen only renders if
   the user submits another answer (which they typically don't).
3. **Logout appears to do nothing.** Clicking "log out" does not visibly
   change the UI; the user remains logged in.

## Constraints

- The multiplayer server grades answers (the client does not know the
  correct answer). Auto-advance must be designed around this.
- Latency must stay close to a single round-trip per question. The user
  rejected per-keystroke and debounce approaches because they add either
  extra requests or extra delay.
- Site is served over HTTPS (`https://zetachad.duckdns.org/`), so
  `cookieSecure: true` is correct and not the cause of the logout bug.

## Design

### 1. Auto-advance on answer (digit-count strategy)

**Server change** (`server/src/game/generator.js`,
`server/src/routes/play.routes.js`):

- Each question carries an `expected_digits` field equal to
  `String(answer).length`.
- Returned in the `question` payload of `POST /api/play/start` and the
  `next_question` payload of `POST /api/play/answer`.
- All answers are non-negative integers (subtraction guarantees `a >= b`,
  division generates `a = b * q`), so `expected_digits` is unambiguous.

**Client change** (`client/js/play.js`):

- Track `currentExpectedDigits` in `state`.
- Replace the form `submit` listener with an `input` listener on `#answer`.
- On every input event, early-return if `state.finished` or
  `state.timerExpired` is set.
- Otherwise, if the value matches `/^\d+$/` and
  `value.length === state.currentExpectedDigits`, call the existing submit
  path.
- After a successful submit, store the next question's `expected_digits`
  before clearing the input.
- The `<form>` element stays for layout but Enter no longer triggers
  submission. `enterkeyhint="go"` becomes cosmetic.

**Tradeoffs accepted:** A typo of equal length (e.g. typing 48 when the
answer is 47) submits immediately and is graded wrong. The user accepted
this in exchange for zero added latency.

### 2. Timer expiry triggers finish

**Client change only** (`client/js/play.js`):

- In `tickClock`, when `remaining <= 0` and `state.timerExpired` is not
  yet set:
  - Set `state.timerExpired = true` (suppresses further input handling).
  - Call `api.answer(state.sessionId, '')`. Verify in the
    implementation plan that the `/api/play/answer` route accepts an
    empty-string `answer` and returns `time_up: true` for a session
    past its deadline. If the route validates non-empty, add a
    dedicated time-up signal value (e.g. `'__timeup__'`) the route
    treats as "no answer, just close the run".
  - On the response, call the existing `finish(r.final_score)`.
- The input handler from #1 also early-returns when
  `state.timerExpired` is set, so no extra submit can race the
  expiry-triggered call.

**No server change.** The existing time-up path is reused.

### 3. Logout works visibly (`client/js/landing.js`)

The current handler:

```js
await api.logout();
location.reload();
```

is silent on failure (any thrown error skips `reload`) and uses
`reload()`, which can serve from cache. Replace with:

- On click: disable the link, set its text to "logging out…" so the user
  gets immediate feedback that the click registered.
- Wrap `api.logout()` in `try/catch`. On failure, log to console but
  still navigate.
- Use `location.href = location.pathname` (a hard navigation to the same
  page) instead of `location.reload()` to avoid any cached document
  state.

This produces correct UX regardless of which underlying cause is at
play (network failure, expired cookie causing 401, or stale page cache).

## Out of scope

- No refactor of `play.js` structure beyond the changes above.
- No change to `/api/me`, `setSessionCookie`, or `clearSessionCookie`.
- No change to the score-screen or leaderboard-submit flow after
  `finish()` runs.

## Testing

**Issue 1 (manual):**

- Start a default drill. For an answer of 47, type "47" and verify the
  next question appears without pressing Enter.
- For a 2-digit answer, type "4" and verify nothing submits.
- For a 2-digit answer, type a wrong 2-digit number and verify it
  submits and is graded wrong (input clears, score does not increment).

**Issue 2 (manual + integration):**

- Start a 10-second drill, do not answer. When timer hits 0, the score
  screen appears within ~one round-trip.
- Server integration test: send `POST /api/play/answer` with empty
  `answer` after the session deadline; assert the response contains
  `time_up: true` and `final_score`.

**Issue 3 (manual):**

- Log in, click "log out". Verify the link text briefly shows "logging
  out…" and the page navigates with the top-right showing "Log in /
  Register".
- Throttle Network in devtools to "Slow 3G" and click logout. Verify
  the intermediate "logging out…" state is visible.
- Force a logout failure (block `/api/logout` in devtools) and verify
  the page still navigates and clears the logged-in UI.
