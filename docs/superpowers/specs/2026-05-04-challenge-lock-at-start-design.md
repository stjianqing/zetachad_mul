# Challenge Lock-at-Start — Design

## Problem

Challenge mode lets a recipient grind the challenger's deterministic seed within the 30-minute forfeit window. The recipient can:

1. Accept the challenge (status flips to `accepted`, stamps `responded_at`).
2. Click START — server creates an in-memory session seeded from `challenger_run_id`. Same seed every time.
3. Play partway, close the tab — no `runs` row is committed.
4. Click START again — server happily creates another session with the same seed.
5. Repeat until they get a fast clean run, then submit only that one.

The existing anti-cheat checks (`played_at >= responded_at`, no practice/daily-gauntlet runs, seed match in `submit-run`) prevent submitting a *pre-played* run, but not grinding within the post-accept window.

This is the same abuse vector the daily-gauntlet hardening fixed. Apply the same pattern to challenges.

## Goal

A recipient gets exactly one `/api/play/start` per challenge. A second attempt — whether from another tab, after abandoning, or from a refresh — is rejected. The recipient is locked to whatever happens after their first START: finish, forfeit at the sweep, or get out-resolved by their opponent.

## Why this fits zetachad_mul

- **Reuses the lock-at-start pattern** already shipped for daily-gauntlet. The frontend's `?forfeit=1` toast and `play.js`'s `already_started` redirect handler are reusable as-is.
- **Tiny schema change** — one nullable column on `challenges`.
- **Atomic server-side claim** via single `UPDATE … WHERE recipient_started_at IS NULL` — no TOCTOU race, no `23505` catch path needed.

## Out of scope

- Anti-cheat against a recipient pre-computing answers via dev tools (the seed is shared with them on accept; this is unfixable without server-only question delivery, which is a much bigger change).
- Anti-collusion (two recipients sharing answers) — social, not technical.
- Reducing the 30-minute forfeit window (separate decision; not part of this hardening).

---

## Data model

One nullable column added to `challenges`:

```sql
ALTER TABLE challenges ADD COLUMN recipient_started_at TIMESTAMPTZ;
```

No new index. Lookups are by primary key (`/start`, `submit-run`) or by the existing `challenges_sweep_idx ON challenges(status, responded_at) WHERE status='accepted'` (sweep, see below).

State transitions for the recipient's perspective:

| status | recipient_started_at | recipient_run_id | meaning |
|---|---|---|---|
| `pending` | NULL | NULL | challenge sent, not yet accepted |
| `accepted` | NULL | NULL | accepted, recipient hasn't clicked START |
| `accepted` | set | NULL | playing OR has abandoned mid-run |
| `completed` | set | set | submitted a run |
| `forfeited` | NULL or set | NULL | sweep grabbed an idle accepted row |
| `declined` | NULL | NULL | recipient explicitly declined |

The lock at `/start` is: "row exists with `id = $1, recipient_id = $2, status = 'accepted', recipient_started_at IS NULL` — atomic UPDATE setting `recipient_started_at = now()`." Either the caller wins the claim or doesn't.

---

## Backend changes

### `POST /api/play/start` (mode=challenge)

Replace the existing SELECT-then-create-session flow with an atomic claim:

```js
if (mode === 'challenge') {
  if (!req.user) return reply.code(401).send({ error: 'register-to-play' });
  const challengeId = Number(req.body?.challenge_id);
  if (!Number.isInteger(challengeId)) {
    return reply.code(400).send({ error: 'invalid_challenge_id' });
  }

  // Atomic claim: set recipient_started_at iff we're the recipient AND status=accepted
  // AND nobody has started yet. Returns the challenger's run id if we won.
  const claim = await pool.query(
    `UPDATE challenges
     SET recipient_started_at = now()
     WHERE id = $1
       AND recipient_id = $2
       AND status = 'accepted'
       AND recipient_started_at IS NULL
     RETURNING challenger_run_id`,
    [challengeId, req.user.id]
  );

  if (claim.rowCount === 0) {
    // Diagnose why the claim failed: load the row to distinguish
    // not_found vs not_recipient vs not_accepted vs already_started.
    const c = await pool.query(
      `SELECT recipient_id, status, recipient_started_at
       FROM challenges WHERE id = $1`,
      [challengeId]
    );
    if (c.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    const row = c.rows[0];
    if (Number(row.recipient_id) !== req.user.id) {
      return reply.code(403).send({ error: 'not_recipient' });
    }
    if (row.status !== 'accepted') {
      return reply.code(409).send({ error: 'challenge_not_accepted' });
    }
    // recipient_started_at is set → already started.
    return { already_started: true };
  }

  const challengerRunId = Number(claim.rows[0].challenger_run_id);
  const seedRes = await pool.query('SELECT seed FROM runs WHERE id=$1', [challengerRunId]);
  const seed = Number(seedRes.rows[0].seed);

  const r = sessionStore.start({
    userId: req.user.id,
    config: DEFAULT_CONFIG,
    explicitSeed: seed
  });
  return {
    session_id: r.sessionId,
    question: { prompt: r.question.prompt, op: r.question.op, answer: r.question.answer },
    peek_question: { prompt: r.peekQuestion.prompt, op: r.peekQuestion.op, answer: r.peekQuestion.answer },
    time_limit_ms: r.timeLimitMs,
    challenge_id: challengeId
  };
}
```

Two semantic changes from the existing code:

1. The claim is atomic — single UPDATE with all WHERE conditions — eliminating the TOCTOU window between checking eligibility and creating the session.
2. New 200 response shape `{ already_started: true }` when the lock is held.

The 403/404/409 discrimination in the failure path is for diagnostics — only one of these conditions can fire when the UPDATE returns 0 rows, so we look up the row to report the specific reason. This matches the existing route's error vocabulary.

### `POST /api/challenges/:id/submit-run`

**No changes.** The existing checks (status='accepted', `played_at >= responded_at`, seed match, not practice/daily-gauntlet) all still apply. `recipient_started_at` doesn't gate submission — only `/start`.

A theoretical concern: could a recipient bypass the lock by submitting a run from a different mode? No. The recipient's run must have a seed matching `challenger_seed`. The only way to create a run with a server-controlled seed is via `/api/play/start`. `mode='normal'` and `mode='daily-gauntlet'` use either client-supplied configs or date-derived seeds — neither lets an external caller pin to a specific 32-bit value. `mode='challenge'` is the only path, and it now goes through the lock.

### Forfeit sweep (`server/src/jobs/forfeit-sweep.js`)

Update the staleness check to use `recipient_started_at` if set, else fall back to `responded_at`:

```js
const FORFEIT_AGE = "interval '30 minutes'";

export async function runForfeitSweep(pool) {
  const r = await pool.query(
    `UPDATE challenges
     SET status='forfeited'
     WHERE status='accepted'
       AND recipient_run_id IS NULL
       AND COALESCE(recipient_started_at, responded_at) < now() - ${FORFEIT_AGE}`
  );
  return r.rowCount;
}
```

The existing index `challenges_sweep_idx ON challenges(status, responded_at) WHERE status='accepted'` is no longer perfectly matched by the COALESCE'd predicate, but the index narrows scan to `status='accepted'` rows — the dominant filter — and the sweep table is small (handful of rows at most). Re-evaluating the index is over-engineering.

---

## Frontend changes

### `client/js/play.js`

The `startChallenge` function (around line 165) currently catches errors but doesn't handle `already_started`. Add a branch right after the existing accept-then-start flow gets a response:

```js
let startRes;
try { startRes = await api.startChallenge(id); }
catch (e) {
  alert('Could not start challenge: ' + e.message);
  location.href = 'index.html';
  return;
}

if (startRes.already_started) {
  location.href = 'index.html?forfeit=1';
  return;
}

// existing flow continues...
```

The `?forfeit=1` query param triggers the existing toast on the landing page (added in the daily-gauntlet PR). No new client-side state needed.

### `client/js/landing.js`

The existing toast text is `"Run already started — locked until tomorrow."` That copy is daily-gauntlet-specific (the "until tomorrow" part). For challenges the lock isn't time-based the same way. Generalize to:

```
Run already started — locked.
```

Both daily-gauntlet and challenge contexts read correctly. The user's last action (clicking START) is the obvious cause; further specificity would require plumbing context through the redirect, which adds wiring without proportional clarity.

### Other frontend files

`result.html` and `challenge.html` are unaffected — they don't render the in-progress accepted state. The recipient's flow on second `/start` is: `play.js` gets `already_started` → redirects to `index.html?forfeit=1` → toast → user lands on the home page.

---

## Files touched

**New:**
- `server/migrations/012_challenge_lock_at_start.sql` — adds `recipient_started_at` column.

**Modified:**
- `server/src/routes/play.routes.js` — atomic-claim logic in mode=challenge branch of `/api/play/start`.
- `server/src/jobs/forfeit-sweep.js` — COALESCE the staleness check.
- `client/js/play.js` — `already_started` branch in `startChallenge`.
- `client/js/landing.js` — generalize toast copy.
- `server/test/integration/challenges.test.js` — append new tests (see Testing).

**Optional:**
- `server/test/unit/forfeit-sweep.test.js` (new) — small regression guard for the sweep WHERE clause.

---

## Edge cases

### 1. Concurrent `/start` race (two tabs)

Both tabs hit the route nearly simultaneously. Both load the route handler, both reach the atomic UPDATE. PostgreSQL serializes UPDATEs on the same row.

- One UPDATE wins (rowCount=1) → seed loaded → in-memory session created → question envelope returned.
- The other UPDATE returns rowCount=0 → diagnostic SELECT shows `recipient_started_at` is now set → returns `{ already_started: true }`.

The atomic-claim design eliminates the TOCTOU window the daily-gauntlet had to handle via the `23505` catch-on-INSERT. Cleaner here because we're updating an existing row.

### 2. Recipient accepts at 12:00, never plays

- 12:30 — sweep runs. `recipient_started_at` is NULL, COALESCE picks `responded_at = 12:00`. 12:30 - 30min = 12:00, expired → forfeited.
- 12:31 — recipient navigates to play.html for this challenge. `/start` UPDATE fails (status is now 'forfeited'). Diagnostic SELECT → returns 409 `challenge_not_accepted`. Client falls into existing alert/redirect path.

Behavior unchanged from today.

### 3. Recipient starts at 12:25, abandons, returns at 12:40

- 12:25 — `/start` succeeds. `recipient_started_at = 12:25`. Plays one question, closes tab.
- 12:40 — sweep runs. COALESCE picks `recipient_started_at = 12:25`. 12:40 - 30min = 12:10 < 12:25, not expired. Status stays accepted.
- 12:40 — recipient returns. `/start` UPDATE fails (recipient_started_at IS NULL predicate). Diagnostic SELECT shows status='accepted', recipient_id matches, recipient_started_at is set → returns `{ already_started: true }`. Client redirects to landing with toast.

This is the core abuse-defeating path. Confirmed correct.

### 4. Recipient finishes successfully

- 12:25 — `/start`. recipient_started_at = 12:25.
- 12:27 — finishes 60 questions. submit-run UPDATEs status='completed', recipient_run_id set.
- 12:55 — sweep runs. WHERE filter excludes `status='completed'`. No-op.

### 5. Network blip mid-`/start`

- Recipient clicks START. UPDATE succeeds. Response packet lost.
- Client times out / shows error. User clicks again.
- Second request: UPDATE fails (lock held) → returns `{ already_started: true }` → client redirects to landing.

The user just lost their attempt to a network blip. Same harshness as daily-gauntlet — accepted trade-off.

### 6. Race against the sweep

`/start` arrives at the same instant the sweep marks the row forfeited.

- If sweep wins: status='forfeited'. `/start`'s UPDATE fails (status≠'accepted'). Returns 409 `challenge_not_accepted`.
- If `/start` wins: recipient_started_at = now(). Sweep runs immediately after, sees recipient_run_id IS NULL but COALESCE'd timestamp = now(), now() - 30min < now(), filter fails, sweep no-op. Recipient gets to play.

Both outcomes correct. PostgreSQL's row-level locking handles serialization; no deadlock.

### 7. submit-run after sweep marks forfeited

Recipient is mid-run when their session sits long enough for the sweep to fire (>30 min between START and submit). Sweep updates status='forfeited'. submit-run's WHERE includes status='accepted' → returns 409 `not_in_accepted_state`.

Existing behavior, unchanged.

### 8. Challenger redeems own share link

The redeem route already rejects this (`cannot_redeem_own_share` 400). Unchanged.

### 9. Share-link redeem: lock not set on redeem, only on `/start`

The `/api/challenges/by-token/:token/redeem` route flips status='pending'→'accepted' atomically (via WHERE status='pending'). The redeem itself self-locks — a second redeem of the same token returns `already_claimed_or_not_found`. The lock-at-start is a separate gate that fires only when the recipient clicks START.

This means a recipient who redeems via share link but never clicks START is in the same boat as a username-targeted recipient who accepts but never starts: they get forfeited at `responded_at + 30min`. Consistent.

### 10. Recipient is NULL on share-link challenge

`recipient_id` can be NULL for a share-link challenge before redemption. Our `/start` lock check requires `recipient_id = $2`. Calling `/start` for a non-redeemed challenge would hit 0 rows → diagnostic shows `recipient_id != req.user.id` (NULL != user_id) → 403 `not_recipient`. Impossible to hit from the UI (user must have redeemed before they reach play.html), so 403 is fine.

---

## Testing

The project uses Node test runner (`node --test`).

### New integration tests (`server/test/integration/challenges.test.js`)

Append to the existing test file:

| Test | Asserts |
|---|---|
| Lock claimed on first `/start` | After accept + first `/start`, `challenges.recipient_started_at IS NOT NULL`. |
| Re-`/start` while lock held | First `/start` succeeds (no submit), second `/start` returns 200 `{ already_started: true }`. The first session id remains valid. |
| Concurrent race recovery | Pre-set `recipient_started_at` directly via SQL (simulating "the other tab won"), then call `/start` → returns `{ already_started: true }`. (The genuine concurrent-call race is timing-flaky; testing the recovery path is more robust.) |
| Lock + complete | Accept → start → solve all 60 → submit-run. `challenges.status='completed'`, `recipient_run_id` set, `recipient_started_at` still set (not cleared). |
| Sweep uses `recipient_started_at` when set | Inject a fake `now`. Accept at t0, start at t0+25min, run sweep at t0+30min → row stays `accepted`. Run sweep at t0+56min → row becomes `forfeited`. |
| Sweep uses `responded_at` when no start | Accept at t0, never start, run sweep at t0+31min → row becomes `forfeited`. |
| Sweep ignores completed challenges | Complete a challenge, run sweep > 30min later → status stays `completed`. |
| `/start` rejects non-recipient | Different user calls `/start` on someone else's accepted challenge → 403 `not_recipient`. |
| `/start` rejects non-accepted state | Manually set status to 'declined' via SQL, `/start` → 409 `challenge_not_accepted`. |

Existing tests for accept/submit/result are unaffected; if any construct a mock `accepted` row directly without setting `recipient_started_at`, no edits are needed because submit-run doesn't read that column.

### New unit test (`server/test/unit/forfeit-sweep.test.js`)

Lightweight regression guard. The sweep function is small enough that we can mock the pool and assert the SQL string contains `COALESCE(recipient_started_at, responded_at)` and `status='accepted'`. This catches accidental reverts of the COALESCE logic.

### Manual frontend verification

- Accept a challenge as user B from user A → click START → answer some questions → close tab.
- Reopen `play.html?challenge_id=X` → redirected to `index.html?forfeit=1` with toast.
- Wait for the sweep (5-min interval, 30-min threshold) or trigger manually → result page shows `forfeited`.
- Same flow but solve all 60 → submit-run succeeds, result page shows `completed` with both runs.

---

## Spec self-review

- **Placeholders:** None. All migration content, query bodies, and test names are concrete.
- **Internal consistency:** Data model section, server section, edge cases section all agree on the four-field claim predicate (`id`, `recipient_id`, `status='accepted'`, `recipient_started_at IS NULL`). Sweep section's COALESCE matches the edge-case timing analysis.
- **Scope:** One migration, ~5 modified files, ~9 new tests. Single implementation plan.
- **Ambiguity:** Toast text deliberately generalized to "Run already started — locked." — explicit about the intended copy. No room for "wait, what should it say?"
