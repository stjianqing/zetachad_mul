# Challenge Mode — Design

**Date:** 2026-05-04
**Project:** zetachad_mul
**Status:** Spec — pending plan

## Summary

Challenge Mode lets a player who just finished a standard run challenge another user (registered or via single-use share link) to beat their score on the same problem sequence. The recipient plays the seeded run with the challenger's run as a live time-paced ghost, sees a live score and +/- diff against the ghost during play, and after the run gets a ~20s drag-race animation comparing both runs question-by-question, plus a head-to-head review table.

The hook: every challenge is a real beatable target set by a real player on the same questions. Watching a ghost named "Derpy" pull ahead while you're stuck on 8×7 hits the same nervous-system response as a leaderboard rival, but with a name and a face.

## Goals

- Turn the post-run score screen into a launchpad for rivalry — one click to challenge.
- Drive returning sessions: the recipient gets a notification next time they're on the site.
- Funnel new users via share links: anyone can play a challenge unauthenticated, but submitting the result requires registration.
- Reuse existing run/attempt infrastructure — no parallel scoring path.

## Non-goals

- Real-time multiplayer / simultaneous play.
- Friends list, follows, or any closed social graph.
- Push notifications outside the site (no email, no browser push).
- Challenge expiry by time (recipient can take as long as they want before accepting).
- Daily Gauntlet challenges — the daily seed is already shared globally; challenging on top of that is redundant.
- Server-rendered question streams — questions are regenerated client-side from seed+config.
- Anti-cheat beyond seed/config validation on submit.

## User flows

### Flow A — Registered recipient

1. Alice plays a standard run, scores 47.
2. Post-run score screen shows a CHALLENGE block with a username input. Alice types "Derpy", taps SEND.
3. Alice's UI confirms: "Challenge sent to Derpy. They'll see it next time they're here." She can keep playing or leave.
4. Bob ("Derpy") next opens any logged-in zetachad page. A modal pops:
   > **ALICE CHALLENGES YOU**
   > 47 to beat — on the exact same questions she got.
   > One attempt. No retries.
   > [ACCEPT] [DECLINE] [LATER]
5. Bob taps ACCEPT. Pre-run READY screen appears:
   > **CHALLENGE: ALICE — 47**
   > Same 60 questions. Same order.
   > **ONE ATTEMPT.**
   > Quit, refresh, or close the tab = forfeit.
   > [READY]
6. Bob taps READY. Run starts. Live ghost ticker shows below his score: `ghost 47   +/-N`.
7. Bob finishes. Drag-race animation plays (~20s). Voice-matched caption drops in. Head-to-head table renders below.
8. Alice next opens zetachad. Result notification at top of home: "Derpy beat your 47 with 52" (or "Derpy fell short — 41 vs your 47" / "Derpy chickened out" / "Derpy quit halfway through"). Buttons: [VIEW] [REMATCH].
9. Clicking VIEW opens the same head-to-head page. Clicking REMATCH starts a fresh run for Alice; on finish, the challenge form is pre-targeted at Derpy.

### Flow B — Share link (unregistered recipient)

1. Alice scores 47. Picks GET SHARE LINK on the post-run screen instead of a username.
2. Modal shows the URL with a copy button: "anyone with this link gets one shot at your run."
3. Alice pastes the link wherever (WhatsApp, etc.).
4. Anonymous visitor clicks. Lands on `/challenge/:token`:
   > **ALICE CHALLENGES YOU TO BEAT 47**
   > On the same questions she got.
   > One attempt.
   > [I'M READY]
5. Tap → READY screen → run plays with Alice's ghost ticker.
6. Run ends. Score screen shows their result, then:
   > **Want this to count?**
   > Register to submit your result and tell Alice.
   > [REGISTER] [skip]
7. If they register: result is logged, Alice gets the notification, link is consumed, recipient now has a normal account.
8. If they skip: their score is shown locally but never logged. The link was already consumed by the redeem call when they tapped READY, so no one else can play it. Alice gets a forfeit notification 30 minutes later via the same sweep that catches abandoned mid-runs.

### Flow C — Share link (already registered)

If a logged-in user clicks a share link, the registration step is skipped. Same flow as Flow A from "READY" onward, with the result auto-submitting.

### Flow D — Decline

If Bob taps DECLINE on the modal, a confirm appears: "Decline Alice's challenge? She'll know." Confirming flips the challenge to `declined`, fires a result notification to Alice ("Derpy chickened out"). No rematch button on a declined challenge — they didn't play, there's nothing to rematch.

### Flow E — Forfeit (abandoned mid-run)

If Bob accepts and starts the run but never submits (closes tab, refreshes, network drops), a periodic server sweep catches it: any challenge in `status='accepted'` with no `recipient_run_id` after 30 minutes flips to `forfeited`. Alice gets a notification ("Derpy quit halfway through"). No rematch button.

## Constraints and edge cases

- **Standard, default-config, non-practice runs only.** The CHALLENGE block does not appear on Daily Gauntlet, practice, or custom-config score screens. The server rejects challenge creation in any of those cases. Practice mode is excluded because its cluster-weighted question generation is non-deterministic from seed alone (depends on `cluster_medians` snapshot); custom configs are excluded so the recipient never gets sandbagged with an unfamiliar setup.
- **One attempt per challenge.** No retries, no expiration on acceptance, no expiration on the challenge itself.
- **Self-challenge blocked.** UI greys out send when the username matches the user's own; server returns 400 if forced.
- **Tie-break.** Equal scores → faster `runs.duration_ms` wins. Caption acknowledges closeness ("47-47, but you finished 3.2s faster — STILL HAIL.").
- **Single-use share links.** Each token can be redeemed exactly once. Subsequent visits to the same URL show "This challenge link has already been claimed." A challenger who wants to send to multiple people generates multiple links.
- **Incoming modal is dismissible.** [LATER] closes it without deciding; the modal returns on the next page load until the user accepts or declines.
- **Forfeit window.** 30 minutes from acceptance with no submit → forfeit. Sweep runs every 5 minutes.
- **Refresh / close mid-run = forfeit.** No client-side resume; the run state is not persisted between page loads.

## Architecture

### Data model

#### New table: `challenges`

```sql
CREATE TABLE challenges (
  id                       BIGSERIAL PRIMARY KEY,
  challenger_run_id        BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  challenger_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id             BIGINT REFERENCES users(id) ON DELETE SET NULL,
  recipient_run_id         BIGINT REFERENCES runs(id) ON DELETE SET NULL,
  share_token              TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending',
  challenger_seen_result   BOOLEAN NOT NULL DEFAULT false,
  recipient_seen_result    BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at             TIMESTAMPTZ,
  CHECK (status IN ('pending','accepted','completed','forfeited','declined')),
  CHECK (challenger_id <> recipient_id OR recipient_id IS NULL)
);

CREATE UNIQUE INDEX challenges_share_token_idx
  ON challenges(share_token)
  WHERE share_token IS NOT NULL;

CREATE INDEX challenges_recipient_pending_idx
  ON challenges(recipient_id, status)
  WHERE status = 'pending';

CREATE INDEX challenges_challenger_idx
  ON challenges(challenger_id, created_at DESC);
```

A "share link" is just a challenge with `recipient_id IS NULL` and a non-null `share_token`. When someone registers and redeems via the link, `recipient_id` is set on the same row. Single state machine, no parallel paths.

#### New column on `runs`

```sql
ALTER TABLE runs ADD COLUMN seed BIGINT;
```

The seed used to generate this run's question sequence. Required so a challenge can replay the exact same problems. Old runs (pre-migration) have `seed IS NULL` and are not eligible to be challenge sources — UI only shows the CHALLENGE block when `seed IS NOT NULL` on the just-finished run.

#### Reused tables

`runs` and `attempts` are otherwise unchanged. The challenger's run and (if completed) the recipient's run are both normal logged runs. The `challenges` row links them. Ghost replay data = `attempts` rows from `challenger_run_id`. Head-to-head data = `attempts` rows from both runs joined on `q_index`.

### Components

1. **Seeded question generator** — already exists at `server/src/game/generator.js` with `makeRng(seed)` (mulberry32). Reused as-is. The challenger's run already runs through `generate(config, rng, weighting)`; we just need to *persist the seed* so the recipient can re-derive the same sequence.
2. **Challenge API** (`server/src/routes/challenges.routes.js`). All endpoints listed in the API section.
3. **Forfeit sweep** (`server/src/jobs/forfeit-sweep.js`). Runs every 5 minutes via `setInterval`, registered in `server/src/index.js` alongside the existing session-eviction timer.
4. **Ghost replay component** (`client/js/ghost-ticker.js`). Loaded by `play.js` when a challenge run starts. Receives `challenger_attempts` and advances ghost score against wall-clock.
5. **Drag race animation** (`client/js/drag-race.js`). Receives both runs' attempts, plays a ~20s time-compressed race on the post-run screen.
6. **Head-to-head view** (`client/js/head-to-head.js`). Renders the static table joining attempts by `q_index`.
7. **Notifications + outgoing panel** (`client/js/challenges-home.js`). Loaded by `landing.js`. Renders incoming-challenge modal queue and outgoing/unread-results panel.
8. **Share-link landing** — new HTML page `client/challenge.html` + `client/js/challenge-landing.js`, served on `/challenge/:token`.

**Eligibility rules for challenge sources** (all enforced server-side at `POST /api/challenges`):
- Run must have a non-null `seed` (i.e., post-migration, non-daily-gauntlet).
- Run's config must be the default config (`isDefaultConfig`).
- Run must not be a practice run (`practice = false`).
- Run must not be a daily-gauntlet run (`daily_gauntlet_date IS NULL`).
- Run must belong to the requesting user.

These constraints together guarantee deterministic replay: practice mode's cluster-bias weighting is non-deterministic (it depends on `cluster_medians` at run time) and would break replay; non-default configs would let the challenger send a custom-tuned config that the recipient hasn't opted into; daily-gauntlet runs are already shared globally.

### Data flow

**Sending a challenge (Alice):**
1. Alice's run finishes → `runs` row written with `seed`, `attempts` rows written.
2. Score screen fetches and shows CHALLENGE block (only when `seed IS NOT NULL` and run is not Daily Gauntlet).
3. Alice picks Derpy → `POST /api/challenges {challenger_run_id, recipient_username: "derpy"}`.
4. Server resolves username to `recipient_id`, validates not-self, validates source run, inserts row with `status='pending'`. Returns `{id, status}`.

**Receiving a challenge (Bob):**
1. Bob loads any logged-in page → client calls `GET /api/challenges/incoming`.
2. If pending challenges exist, oldest one renders as modal.
3. Bob taps ACCEPT → `POST /api/challenges/:id/accept` → server flips to `accepted`, returns `{seed, config, challenger_attempts}`.
4. Client navigates to play view in challenge mode, regenerates questions from seed+config, primes ghost ticker with `challenger_attempts`.
5. Bob finishes → run logs normally to `runs` + `attempts` → client calls `POST /api/challenges/:id/submit-run {recipient_run_id}`.
6. Server validates seed+config of recipient_run match challenge, links it, flips to `completed`.
7. Client navigates to result view (drag race + head-to-head).

**Result notification (Alice):**
1. Alice loads any logged-in page → client calls `GET /api/challenges/outgoing`.
2. Client filters the response to rows where status is terminal (`completed` / `forfeited` / `declined`) AND `challenger_seen_result=false`. These render at top of home as result notifications.
3. Click VIEW → result page → server flips `challenger_seen_result=true` via the result endpoint's side effect.

**Share link redemption (anonymous):**
1. Visitor lands on `/challenge/:token` → client calls `GET /api/challenges/by-token/:token` (no auth).
2. If status not pending → 410 with "already claimed" message.
3. Visitor taps READY → client calls `POST /api/challenges/by-token/:token/redeem` (no auth). Server flips `status='accepted'`. The link is now consumed; any subsequent visit gets the "already claimed" page. This is what makes the link single-use whether or not the recipient ever submits a result.
4. Server returns `{seed, config, challenger_attempts, requires_registration_to_submit: true}`.
5. Client plays the run entirely client-side. The run is NOT logged to `runs` yet — the server only learns about the recipient's run if they register and submit.
6. On finish, score screen offers REGISTER. If they register: client calls `POST /api/runs` to log the run, then `POST /api/challenges/:id/submit-run` to link it. Status flips `'accepted'` → `'completed'`.
7. If they skip registration: no further server calls happen. Status stays at `'accepted'` until the 30-minute forfeit sweep flips it to `'forfeited'`. Alice gets a "someone took your challenge but didn't submit" notification at that point. (Wording for this anonymous-forfeit case may differ from the named-recipient forfeit copy — drafted at impl time.)

### Forfeit sweep mechanics

- Job runs every 5 minutes (cron-style or `setInterval` on the server, matching whatever pattern the project uses).
- Query: `UPDATE challenges SET status='forfeited' WHERE status='accepted' AND responded_at < now() - interval '30 minutes' AND recipient_run_id IS NULL RETURNING id, challenger_id;`
- For each row affected, the challenger's `challenger_seen_result` is already `false` so the result notification surfaces normally on next page load.
- 30 minutes is well past the longest legitimate run (Daily Gauntlet's 60-question variant tops out at ~5 min) and absorbs network hiccups + brief walk-aways.

## API

All endpoints under `/api/challenges`. Auth = current zetachad_mul session cookie.

```
POST   /api/challenges
  Body: { challenger_run_id, recipient_username }
        | { challenger_run_id, share_link: true }
  Auth: required (must own challenger_run_id)
  Returns: { id, status, share_url? }
  Errors:
    400 if challenger_run_id is ineligible (daily-gauntlet / practice /
        custom config / no seed / not owned by current user)
    400 if recipient_username == current user
    404 if recipient_username not found

GET    /api/challenges/incoming
  Auth: required
  Returns: [{
    id, challenger: { username },
    challenger_score, config, created_at
  }, ...]
  Filter: status='pending' AND recipient_id=current_user

GET    /api/challenges/outgoing
  Auth: required
  Returns: [{
    id, recipient_username | null, share_token | null,
    challenger_score, status,
    recipient_score | null, created_at,
    challenger_seen_result
  }, ...]
  Filter: challenger_id=current_user
  Ordered by created_at desc

POST   /api/challenges/:id/accept
  Auth: required (must be recipient_id)
  Side effect: status='accepted', responded_at=now()
  Returns: {
    seed, config,
    challenger_attempts: [{ q_index, response_ms, correct }, ...]
  }
  Errors: 404 if not pending or not the recipient

POST   /api/challenges/:id/decline
  Auth: required (must be recipient_id)
  Side effect: status='declined', responded_at=now()
  Returns: { ok: true }

POST   /api/challenges/:id/submit-run
  Body: { recipient_run_id }
  Auth: required (must own recipient_run_id, must be challenge recipient_id)
  Validates: recipient_run's seed and config match challenge's challenger_run
  Side effect: links recipient_run_id, status='completed'
  Returns: { ok: true, result: <head-to-head payload> }
  Errors:
    400 if seed/config mismatch
    409 if challenge not in 'accepted' state

GET    /api/challenges/by-token/:token
  No auth.
  Returns: {
    id, challenger: { username },
    challenger_score, config, status
  }
  Errors: 410 if status != 'pending'

POST   /api/challenges/by-token/:token/redeem
  Auth: optional.
  Side effect:
    If authed: links recipient_id, status='accepted', responded_at=now()
    If not authed: status='accepted', responded_at=now(), recipient_id stays NULL
  Returns: {
    seed, config,
    challenger_attempts: [...],
    requires_registration_to_submit: <bool>
  }
  Errors: 410 if already redeemed

GET    /api/challenges/:id/result
  Auth: required (must be challenger or recipient)
  Side effect:
    If caller is challenger: challenger_seen_result=true
    If caller is recipient:  recipient_seen_result=true
  Returns: full head-to-head payload (both runs' attempts, winner determination)
```

### Anti-cheat (minimal)

- `submit-run` validates that the recipient's run has the same seed and config as the challenge.
- The seeded generator is deterministic, so anyone who can read the client code (or run it) can pre-compute the answers for a given seed. We accept this for v1: it's a math drill, the worst case is someone cheats their own challenge result, the head-to-head table makes egregious cheating obvious. If it becomes a real problem, we can server-render the question stream later.

## UI surfaces

### Post-run score screen — CHALLENGE block

Below the score, above "play again", on standard runs only (not Daily Gauntlet, not legacy runs without seed):

```
CHALLENGE SOMEONE
[username input]  [SEND]
       ── or ──
   [GET SHARE LINK]
```

After SEND succeeds: replaces with "Challenge sent to <name>. They'll see it next time they're here."
After GET SHARE LINK: modal pops with URL + copy button + "anyone with this link gets one shot at your run."

If the user just lost their last challenge (rematch flow): block is replaced by **REMATCH [name]** as the primary button, with normal challenge below.

### Home page — incoming challenge modal

Blocking modal on logged-in pages when there are pending incoming challenges:

```
ALICE CHALLENGES YOU
47 to beat — on the exact same questions she got.
One attempt. No retries.

[ACCEPT]  [DECLINE]  [LATER]
```

LATER closes the modal; it returns on the next page load. DECLINE confirms with "Decline Alice's challenge? She'll know." If multiple pending: dismissing one shows the next.

### Pre-run READY screen

Between accept (or share-link redeem) and the first question:

```
CHALLENGE: ALICE — 47
Same 60 questions. Same order.
ONE ATTEMPT.
Quit, refresh, or close the tab = forfeit.

[READY]
```

Recipient must tap READY. No auto-start.

### Live ghost ticker

Existing score display gets a second line in desaturated lime, with the diff floating to the right (green when ahead, red when behind):

```
YOU      52
ghost    47        +5
```

Updates on every ghost-tick (challenger answer time) and every recipient answer.

### Drag race animation (post-run)

Replaces the standard score screen on challenge runs.

- Two horizontal bars labeled with usernames.
- "You" in lime, ghost in desaturated lime.
- Total animation duration ~20s, time-compressed regardless of run length.
- Each correct answer advances its bar one tick; q-number flashes briefly above the bar.
- Wrong answer = red flash, no advance.
- Hesitation = bar visibly stalls.
- When the winner crosses the finish line, the loser's bar keeps animating one more beat to drive home the gap.
- Voice-matched caption drops in on completion. Examples (final copy drafted at impl time per `docs/STYLE.md`):
  - Win: "STILL HAIL [your name]." / "Derpy got served."
  - Loss: "Better luck never." / "47 was apparently the ceiling."
  - Tie (broken by time): "47-47, but you finished 3.2s faster — STILL HAIL."
- [REPLAY] button restarts the animation. [VIEW QUESTIONS] scrolls to head-to-head below.

### Head-to-head table

Below the animation, scrollable. Columns: `Q#`, `Question`, `You (time, ✓/✗)`, `[Challenger] (time, ✓/✗)`, `Δ`. Rows tinted faintly green when the viewer was faster + correct, faintly red when slower or wrong.

### Result notification (challenger side)

Top of home when there's an unread result:

```
Derpy beat your 47 with 52.   [VIEW]  [REMATCH]
```

VIEW opens the head-to-head + drag race from the challenger's POV. REMATCH starts a fresh run; on finish, the challenge form is pre-targeted at Derpy.

If recipient declined or forfeited: no REMATCH button — just `Derpy chickened out.   [DISMISS]` or `Derpy quit halfway through.   [DISMISS]`.

### Pending outgoing panel

On home, collapsed by default below the main play buttons:

```
▸ OUTGOING CHALLENGES (3)
```

Expanded:

```
Derpy        — pending           (sent 2h ago)
Linus        — accepted, playing (5min ago)
Anon link    — 7 clicks, no submit yet  [COPY LINK]
```

Refreshes on page load. No real-time updates.

### Share-link landing (`/challenge/:token`)

Public, no login required:

```
ALICE CHALLENGES YOU TO BEAT 47
On the same questions she got.
One attempt.

[I'M READY]
```

Tap → READY screen → run. After run, score screen says "want this to count? Register to submit." If they register: result logs and posts back to Alice. If they skip: shown but not logged.

Logged-in users hitting the same URL skip the registration prompt.

If the token has been redeemed: "This challenge link has already been claimed."

### Voice copy notes

All user-facing copy is illustrative in this spec — final strings drafted at implementation time per `docs/STYLE.md`. Result captions, decline confirmation, rematch prompts, and forfeit notifications get the rotating-variants treatment used by Daily Gauntlet (~14-21 lines each). Functional copy (form labels, errors) stays plain.

## Testing

### Server (integration tests against real Postgres, matching project conventions)

- Create challenge by username — happy path, returns id + pending status.
- Create challenge by share link — generates token, returns share_url, recipient_id NULL.
- Self-challenge blocked — 400.
- Challenge from a Daily Gauntlet run blocked — 400.
- Challenge from a practice run blocked — 400.
- Challenge from a custom-config (non-default) run blocked — 400.
- Challenge from a legacy run (no seed) blocked — 400.
- Incoming list — only `status='pending'` for the requesting user.
- Outgoing list — all statuses, only requesting user's challenges.
- Accept → status flips, returns seed+config+attempts.
- Decline → status flips, challenger sees "declined" via outgoing.
- Submit run with mismatched seed/config → 400.
- Submit run when challenge not in 'accepted' state → 409.
- Forfeit sweep — accepted >30 min ago with no run → forfeited.
- Share-link redeem (registered) → links recipient_id, identical payload to accept.
- Share-link redeem (unregistered) → returns playable payload but submit-run requires auth.
- Share-link single-use — second redeem → 410.
- Result endpoint — both challenger and recipient can fetch; third party cannot.
- `*_seen_result` flags flip correctly when the right party fetches the result.

### Client (existing project test patterns)

- Seeded generator: same seed+config produces identical question sequence (snapshot test).
- Ghost ticker: given fixed challenger_attempts and a simulated clock, score advances at correct wall-clock moments.
- Drag race animation: given two attempts arrays, total animation duration is ~20s regardless of input run length; finish ordering matches actual scores.
- Head-to-head joiner: questions align by `q_index`.
- Result notification rendering: win/loss/tie/decline/forfeit each render correct copy and buttons.
- Rematch flow: clicking REMATCH starts a fresh run; on finish, challenge form is pre-targeted at the right recipient.
- CHALLENGE block hidden on Daily Gauntlet score screens and on legacy runs without seed.

### Manual / E2E spot-checks (no formal automation in v1)

- Two browser windows, two accounts: send → notification appears → accept → ghost ticker visible → submit → result shows on both sides.
- Share-link end-to-end with an unregistered tab: play → score screen → register → result posts back to challenger.
- Accept-then-close-tab → 30 min later, forfeit notification arrives.

### Explicitly NOT tested in v1

- Real-time push (no WebSockets, polling on page load is sufficient).
- Concurrent acceptance race conditions (single-use token enforced by unique constraint; first commits win, second gets 410 — Postgres handles it).
- Performance / load.

## Open items for implementation time

- **Migration number.** Next available is `010_*` (after `009_daily_gauntlet_date.sql`). Resolve at impl time depending on Daily Gauntlet's actual migration number on `main`.
- **Voice copy.** Result captions, decline/forfeit copy, rematch prompts to be drafted per `docs/STYLE.md`. Use rotating variants matching Daily Gauntlet's 14-21-line approach.
- **Share-link URL format.** Recommend `/challenge/:token` where `token` is a URL-safe random string (e.g., 16 bytes base64url).
- **Forfeit sweep scheduling.** Use the same job mechanism as the rest of the app (whatever pattern exists; if none, use a simple `setInterval` in the server bootstrap).
- **Notification ordering.** When multiple incoming pending challenges exist, the modal shows oldest first. Confirmed in spec; pin the SQL `ORDER BY created_at ASC` at impl time.
- **Drag race timing function.** ~20s total, but the easing — linear time-compression vs. squash-and-stretch where close moments stretch and dead air compresses — is a feel question. Try linear first; tune if it feels flat.

## Dependencies on other features

- **Seeded question generator** is shared with Daily Gauntlet. If Daily Gauntlet ships first, this primitive is free. If Challenge Mode ships first, Daily Gauntlet inherits it.
- **`runs.seed` column** is required for both features. Whichever migration lands first adds it; the other reuses.
