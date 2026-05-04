# Result-screen difficulty display — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the per-run difficulty on the 2-min result screen as soon as the timer ends, instead of only after a leaderboard submit.

**Architecture:** Two tiny changes. (1) `/api/play/answer` — when the run times up, include `difficulty` (already stamped on the live session by `flushRunIfRecording`) in the response payload. (2) `client/js/play.js` `finish(payload)` — replace the hard-coded `showDifficulty(null)` with `showDifficulty(payload.difficulty ?? null)`. Everything else (`showDifficulty`, the `#run-difficulty` DOM node, CSS tiers, the post-submit re-render) is untouched.

**Tech Stack:** Node.js / Fastify / `node:test` for the server; vanilla ES modules in the browser. Postgres for persisted runs (not touched here).

---

## File Structure

| File | Change |
|---|---|
| `server/src/routes/play.routes.js` | Modify the `time_up` (non-daily-gauntlet) response to include `difficulty` |
| `server/test/integration/play.test.js` | Add three tests covering authed/guest/zero-attempts payloads |
| `client/js/play.js` | Replace `showDifficulty(null)` with `showDifficulty(payload.difficulty ?? null)` and drop the stale comment |

No new files. No CSS or HTML changes. No DB migrations.

---

## Task 1: Add server test — authed default-config run returns difficulty

**Files:**
- Test: `server/test/integration/play.test.js`

- [ ] **Step 1: Open `server/test/integration/play.test.js` and add the new test after the existing `'time-up on logged-in default-config run inserts runs + attempts in one transaction'` test (which ends near line 192).**

Append this test:

```js
test('time-up payload on logged-in default-config run includes difficulty', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();

  // Answer a few questions so flushRunIfRecording has attempts and computes a difficulty.
  for (let i = 0; i < 3; i++) {
    const cur = sessionStore.get(session_id).currentQuestion;
    await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  }

  // Force time-up so the next answer triggers the flush + response.
  const sess = sessionStore.get(session_id);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  const tu = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

  assert.equal(tu.statusCode, 200);
  assert.equal(tu.json().time_up, true);
  // Difficulty depends on the median cache being warm. In CI it may legitimately
  // be null (no historical attempts). Either way, the field must be present and
  // either a finite number or null — never undefined.
  const body = tu.json();
  assert.ok('difficulty' in body, 'response should include `difficulty` field');
  const d = body.difficulty;
  assert.ok(d === null || (typeof d === 'number' && Number.isFinite(d)), `difficulty was ${d}`);
});
```

- [ ] **Step 2: Run the new test. Expect it to FAIL.**

Run:
```bash
cd server && node --test test/integration/play.test.js 2>&1 | tail -30
```

Expected: the new test fails with `response should include 'difficulty' field` because the route doesn't return that field yet.

(If the test is skipped due to `skipIfNoDb`, the implementation steps below are still safe to do — just verify with the manual run later. The skip will go away once Postgres is reachable.)

- [ ] **Step 3: Commit the failing test.**

```bash
cd C:/Users/stjia/projects/zetachad_mul
git add server/test/integration/play.test.js
git commit -m "test(play): time-up payload should include difficulty (failing)"
```

---

## Task 2: Make the authed test pass — wire difficulty into the time-up payload

**Files:**
- Modify: `server/src/routes/play.routes.js` (lines 200–203)

- [ ] **Step 1: Open `server/src/routes/play.routes.js` and locate the non-daily-gauntlet `time_up` return at lines 200–202.**

Existing code:

```js
      const live = sessionStore.get(session_id);
      return { time_up: true, final_score: r.finalScore, run_id: live?.runId ?? null };
```

- [ ] **Step 2: Replace it with the version that includes `difficulty`.**

```js
      const live = sessionStore.get(session_id);
      return {
        time_up: true,
        final_score: r.finalScore,
        run_id: live?.runId ?? null,
        difficulty: live?.difficulty ?? null
      };
```

`live.difficulty` is set by `flushRunIfRecording` at line 287 (`liveAfter.difficulty = difficulty`), which is awaited at line 177 (`await flushRunIfRecording(req, session_id);`) — so by the time we read it here, it is either a finite number, `null`, or `undefined` (when the early-return at line 220 fires). The `?? null` collapses the latter two.

- [ ] **Step 3: Run the test from Task 1. Expect it to PASS.**

Run:
```bash
cd server && node --test test/integration/play.test.js 2>&1 | tail -30
```

Expected: the new test passes.

- [ ] **Step 4: Run the full integration suite to confirm no regressions.**

Run:
```bash
cd server && node --test test/integration/ 2>&1 | tail -20
```

Expected: all tests pass (or skip with the existing `skipIfNoDb` pattern).

- [ ] **Step 5: Commit.**

```bash
cd C:/Users/stjia/projects/zetachad_mul
git add server/src/routes/play.routes.js
git commit -m "feat(play): include difficulty in time-up payload"
```

---

## Task 3: Add server test — guest run returns difficulty:null

**Files:**
- Test: `server/test/integration/play.test.js`

- [ ] **Step 1: Append this test to `server/test/integration/play.test.js`.**

```js
test('time-up payload on guest run includes difficulty:null', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg } });
  const { session_id } = start.json();

  await new Promise(r => setTimeout(r, 80));
  const tu = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' } });

  assert.equal(tu.statusCode, 200);
  assert.equal(tu.json().time_up, true);
  assert.equal(tu.json().difficulty, null);
});
```

Why guests get `null`: `flushRunIfRecording` early-returns at line 220 (`rec.userId == null`), so it never stamps `live.difficulty`. The `live?.difficulty ?? null` fallback yields `null`.

- [ ] **Step 2: Run the test. Expect it to PASS immediately (Task 2 already provides the field).**

Run:
```bash
cd server && node --test test/integration/play.test.js 2>&1 | tail -30
```

Expected: the new test passes.

- [ ] **Step 3: Commit.**

```bash
cd C:/Users/stjia/projects/zetachad_mul
git add server/test/integration/play.test.js
git commit -m "test(play): time-up payload null difficulty for guest"
```

---

## Task 4: Add server test — zero-attempts logged-in run returns difficulty:null

**Files:**
- Test: `server/test/integration/play.test.js`

- [ ] **Step 1: Append this test to `server/test/integration/play.test.js`.**

```js
test('time-up payload on logged-in zero-attempts run includes difficulty:null', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();

  // No answers — force time-up immediately.
  const sess = sessionStore.get(session_id);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  const tu = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

  assert.equal(tu.statusCode, 200);
  assert.equal(tu.json().time_up, true);
  // flushRunIfRecording early-returns when attempts.length === 0, so live.difficulty is never set.
  assert.equal(tu.json().difficulty, null);
});
```

- [ ] **Step 2: Run the test. Expect it to PASS.**

Run:
```bash
cd server && node --test test/integration/play.test.js 2>&1 | tail -30
```

Expected: the new test passes.

- [ ] **Step 3: Commit.**

```bash
cd C:/Users/stjia/projects/zetachad_mul
git add server/test/integration/play.test.js
git commit -m "test(play): time-up payload null difficulty for zero-attempts run"
```

---

## Task 5: Wire the client to render difficulty on time-up

**Files:**
- Modify: `client/js/play.js` (lines 398–401)

- [ ] **Step 1: Open `client/js/play.js` and locate the block in `finish(payload)` that currently looks like this (lines 398–401):**

```js
  // Difficulty for practice runs comes from the implicit submit below; for normal
  // runs it comes from the user's manual submit. In both cases we wait for the
  // submit response. Until then, hide the row.
  showDifficulty(null);
```

- [ ] **Step 2: Replace those four lines with:**

```js
  showDifficulty(payload.difficulty ?? null);
```

Why drop the comment: the rationale it described — that we wait for the submit response — no longer holds. The new behaviour is that difficulty comes back with the time-up payload, and the post-submit calls to `showDifficulty(r?.difficulty ?? null)` at lines 418 and 565 simply re-render with the same value (verified harmless because `showDifficulty` is idempotent for a given `d`).

- [ ] **Step 3: Verify no other call sites need touching.**

Run:
```bash
grep -n "showDifficulty" client/js/play.js
```

Expected output (line numbers will shift after the edit; the count is what matters):
- The function definition
- The call you just edited (in `finish`)
- The call inside the practice-mode `api.submit().then(...)` (~line 418)
- The call inside the submit-modal's "yes" handler (~line 565)

All three call sites are valid and stay.

- [ ] **Step 4: Commit.**

```bash
cd C:/Users/stjia/projects/zetachad_mul
git add client/js/play.js
git commit -m "feat(play): render difficulty on time-up, not just after submit"
```

---

## Task 6: Manual verification

No code changes in this task — only browser-driven smoke tests.

- [ ] **Step 1: Start the dev server.**

Match whatever local command this project uses to run the server + serve the client. Inspect `server/package.json` and the project README if unsure. Typical pattern for this repo:

```bash
cd server && npm start
```

(If a separate static server is needed for the client, start it too. Refer to `README.md` or `deploy/README.md`.)

- [ ] **Step 2: In a browser, log in as a test user and play a 2-min default-config run. Answer at least 5 questions correctly. Let the timer expire (or trigger time-up however the client supports it).**

Expected on the result screen:
- `Run difficulty: <one decimal> / 10` is visible **before** any submit modal interaction.
- The text is colour-tiered (green/cyan/magenta/orange depending on the value).

- [ ] **Step 3: Decline the submit modal ("No" / dismiss). Confirm the difficulty row stays visible.**

Expected: row remains rendered with the same value.

- [ ] **Step 4: Play another run, this time accept the submit modal.**

Expected: the row was already visible before submit; after submit it re-renders with the same value (no flicker, no value change).

- [ ] **Step 5: Log out (or open an incognito window). Play a guest 2-min run.**

Expected: no difficulty row on the time-up screen (the element has the `hidden` class).

- [ ] **Step 6: Log in again. Start a 2-min run. Do not answer anything. Let the timer expire.**

Expected: no difficulty row.

- [ ] **Step 7: Start a custom-config run (e.g. shorten the duration or change ranges via whatever UI surfaces this — check `client/index.html` and `client/js/`). Finish it.**

Expected: no difficulty row.

- [ ] **Step 8: Start a practice run. Finish it.**

Expected: difficulty row visible immediately on time-up.

- [ ] **Step 9: If everything checks out, no commit needed for this task — verification only.**

If any step fails, capture the symptom (browser console, network tab) and stop here for review before continuing.

---

## Task 7: Deploy

- [ ] **Step 1: Push the branch.**

```bash
cd C:/Users/stjia/projects/zetachad_mul
git push origin main
```

- [ ] **Step 2: Deploy via the canonical rsync script.**

```bash
cd C:/Users/stjia/projects/zetachad_mul
VPS_HOST=root@87.99.158.208 bash deploy/deploy.sh 2>&1 | tail -30
```

Expected: the systemctl status tail at the end shows `active (running)` for the `zetachad` service.

- [ ] **Step 3: Smoke test on production.**

Open the live site, log in, finish a 2-min run with answers. Confirm difficulty appears on the time-up screen.

- [ ] **Step 4: If smoke test passes, no further action. If anything is wrong, check `journalctl -u zetachad -f` on the VPS and roll back via `git revert` + redeploy.**

---

## Self-review notes

- **Spec coverage:** Each spec section maps to tasks — Task 2 covers the backend payload change; Task 5 covers the frontend wiring; Tasks 1/3/4 cover the three server-test scenarios called out in the spec; Task 6 covers the manual checklist; Task 7 ships it.
- **Type consistency:** The new payload field is `difficulty` (lowercase, matching `liveAfter.difficulty` in `flushRunIfRecording` and the `r?.difficulty` reads in the existing client code). No naming drift.
- **No placeholders:** Every code block above is the literal text the engineer types; every command is a literal command they run.
