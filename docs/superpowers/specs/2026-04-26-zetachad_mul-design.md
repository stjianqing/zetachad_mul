# zetachad_mul — Design

**Status:** approved (pending written-spec review)
**Date:** 2026-04-26
**Upstream:** [stjianqing/ZetaChad](https://github.com/stjianqing/ZetaChad)
**Repo:** new private repo `zetachad_mul`

## Summary

A multi-user, leaderboard-driven fork of ZetaChad (an arithmetic drill app). The original is a single-user static site with local IndexedDB storage and a personal history/analytics page. The fork removes history/analytics, adds username/password accounts, runs the game logic on a server (server-authoritative for cheat resistance), and ranks logged-in players on a public leaderboard. Mobile usability is a first-class requirement.

## Goals

1. Friends can register, log in, and stay logged in across visits.
2. Logged-in players can submit a qualifying run to a shared leaderboard.
3. Guests can play but cannot submit.
4. The leaderboard ranks players by best score under a fixed default config.
5. Score submission is meaningfully cheat-resistant (server-authoritative game).
6. The landing page is a one-glance "Start as User / Start as Guest" choice; custom settings are hidden by default.
7. The whole app works on mobile browsers (iOS Safari + Android Chrome).

## Non-Goals

- Password reset / account recovery (admin resets in DB if needed)
- Per-user history, past-runs lists, or personal stats (history feature is removed)
- Friend lists, social features, OAuth/SSO
- Native mobile apps (PWA installability is a possible follow-up, not v1)
- Admin UI (use psql for rare admin tasks)
- Any analytics, charts, or weakness identification

## Architecture

### High level

A monorepo with two halves:

```
zetachad_mul/
├── client/         # static HTML/CSS/JS, served by nginx
└── server/         # Node + Fastify + Postgres
```

Hosted on the user's existing Ubuntu 24.04 VPS (`87.99.158.208`):

- nginx serves `client/` as static files and reverse-proxies `/api/*` to the Fastify server on `127.0.0.1:3000`.
- Fastify runs as a systemd service.
- Postgres runs locally on the VPS, bound to localhost only.
- TLS via Let's Encrypt against a free DuckDNS subdomain.

### Server-authoritative game

The server owns the game state. The client is a thin display + input layer.

1. Client requests `/api/play/start` with a chosen config.
2. Server creates an in-memory game session, generates the first question, returns `{session_id, question, time_limit_ms}`.
3. Client renders the question. User types an answer.
4. Client POSTs `/api/play/answer` with `{session_id, answer}`.
5. Server validates, updates the score, returns either `{correct, next_question, score, time_remaining_ms}` or `{time_up: true, final_score}`.
6. Loop until time_up.
7. If logged in and config is the default, the score-screen modal offers leaderboard submission. Submission posts only `{session_id}` — the server already has score and config and decides eligibility.

The client never knows upcoming questions, never decides correctness, never owns the timer. The only attack surface is "answer faster," which is the actual game.

### Three play modes

| Mode | Auth | Config | Eligible for leaderboard | Persisted |
|------|------|--------|--------------------------|-----------|
| Leaderboard run | logged in | default (locked) | yes | only on submit |
| Custom run | logged in | user-chosen | no | no |
| Guest run | none | default or custom | no | no |

Only opted-in submissions ever land in the database. Custom runs and "no thanks" runs leave no trace.

## Components

### Server (`server/`)

```
server/
├── src/
│   ├── index.js              # Fastify bootstrap, plugin registration
│   ├── db.js                 # pg pool + migration runner
│   ├── auth.js               # register/login/logout, cookie sessions, requireAuth middleware
│   ├── game/
│   │   ├── generator.js      # pure: config → next question
│   │   ├── grader.js         # pure: question + answer → correct?
│   │   └── session.js        # in-memory active-session store + lifecycle
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── play.routes.js
│   │   └── board.routes.js
│   └── config.js             # locked leaderboard-qualifying config
├── migrations/               # plain SQL files, applied in order
└── package.json
```

**Boundaries:**

- `generator.js` and `grader.js` are pure. No DB, no I/O. Easy to unit-test.
- `session.js` holds active games in a `Map` keyed by `session_id`. Sessions are ephemeral; only finalized scores get persisted (and only when the user opts in). Server restart kills in-flight games; this is acceptable for friends-scale.
- Only `routes/*` know about HTTP. They orchestrate `auth`, `session`, `db`.
- `auth.js` owns bcrypt hashing, cookie issuance, and the `requireAuth` middleware. Routes use the middleware, not the cookie internals.

### Client (`client/`)

```
client/
├── index.html          # NEW landing — Start as User / Start as Guest + login/register links
├── login.html          # NEW
├── register.html       # NEW
├── play.html           # adapted from upstream index.html — drill UI, server-driven
├── leaderboard.html    # NEW
├── css/styles.css      # carried over from upstream + mobile-first breakpoints
└── js/
    ├── api.js          # NEW thin fetch wrapper (cookies, /api base, error handling)
    ├── auth.js         # NEW login/register handlers, "who am I" check
    ├── play.js         # REWRITE of upstream drill.js — server round-trips per answer
    ├── landing.js      # NEW landing page logic (Start buttons, advanced disclosure)
    └── leaderboard.js  # NEW
```

**Removed from upstream:** `history.html`, `js/history.js`, `js/charts.js`, `js/stats.js`, `js/classify.js`, `js/storage.js`.

The visual design (fonts, color palette, drill view layout) carries over. About 30% of upstream code (CSS + HTML structure) is reused; the rest is rewritten or new.

## Data Model

```sql
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  token         TEXT PRIMARY KEY,           -- random 32 bytes, base64url
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON auth_sessions(expires_at);

CREATE TABLE runs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score         INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  played_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON runs(user_id, score DESC);
```

Only opt-in submissions of leaderboard-eligible runs are inserted, so every `runs` row already has the default config — there's no need to store the config or an "is default" flag. Custom runs and guest runs are never persisted.

In-flight game sessions live in server memory only (a `Map`), never the DB. They expire after a 5-minute idle TTL.

## API Contract

All routes are prefixed `/api`. JSON in/out. Auth via cookie.

| Method | Path                       | Auth | Body                          | Returns                                    |
|--------|----------------------------|------|-------------------------------|--------------------------------------------|
| POST   | /api/register              | -    | `{username, password}`        | `{user: {id, username}}`, sets cookie      |
| POST   | /api/login                 | -    | `{username, password}`        | `{user: {id, username}}`, sets cookie      |
| POST   | /api/logout                | opt  | -                             | `{ok: true}`, clears cookie                |
| GET    | /api/me                    | opt  | -                             | `{user}` or `{user: null}`                 |
| POST   | /api/play/start            | opt  | `{config}`                    | `{session_id, question, time_limit_ms}`    |
| POST   | /api/play/answer           | opt  | `{session_id, answer}`        | `{correct, next_question, score, time_remaining_ms}` or `{time_up, final_score}` |
| POST   | /api/leaderboard/submit    | yes  | `{session_id}`                | `{ok: true, rank}` or 4xx                  |
| GET    | /api/leaderboard           | -    | -                             | `{entries: [{rank, username, score, played_at}]}` |

### Auth-session cookies

- 30-day rolling sessions: every authenticated request bumps `expires_at` forward.
- `HttpOnly`, `Secure`, `SameSite=Lax`.
- Random 32-byte token stored server-side in `auth_sessions`. Not a JWT — easier to revoke.

### Rate limits

- 5/min per IP on `/api/register` and `/api/login`.
- 120/min per `session_id` on `/api/play/answer` (defense against accidental loops; still well above any human pace).
- No other rate limits — friends-scale.

### Idempotency

Submitting the same `session_id` twice returns the existing run on the second attempt rather than inserting a duplicate.

## Locked Leaderboard Config

The default config (carried over verbatim from the upstream `js/config.js`):

- All four ops enabled
- add: `min: 2, max: 100`
- sub: `min: 2, max: 100` (subtraction enforces `a ≥ b` so answers are non-negative)
- mul: `lhs 2-12, rhs 2-100`
- div: `lhs 2-12, rhs 2-100` (generates `quotient × divisor = dividend`, presents as `dividend ÷ divisor`, integer answers only)
- Duration: 120 seconds

The server is the authoritative source of `is_default_config(config)` — the client cannot lie about whether a run qualifies.

## User Flows

### Landing page (`/`)

A simple, narrow column:

- Title.
- Default-run summary (the locked config, in plain text).
- Two big buttons: **Start as User** (requires log in) and **Start as Guest**.
- A collapsed "Show advanced" disclosure that reveals the existing operation/duration cards. When opened, an eligibility badge dims to "custom run — not eligible for leaderboard." The Start buttons still work with custom settings; just not leaderboard-eligible.
- A leaderboard link, always visible.
- Top-right: `username · log out` if logged in, else `Log in · Register`.

### Register & login

Plain forms:

- Register: username (3–20 chars, `[a-zA-Z0-9_-]`), password (≥8 chars). On success → cookie set → redirect to `next` query param or `/`.
- Login: same shape. Bad-credentials returns vague "username or password incorrect" — does not leak username existence.
- Logout: clears cookie, redirects to `/`.

Validation errors render inline.

### Play page (`/play`)

Visually near-identical to the upstream drill view, but every interaction is a server round-trip:

1. On load: `POST /api/play/start` with the chosen config.
2. Each answer: `POST /api/play/answer`. Render `correct/wrong` indicator, swap to next question.
3. Countdown is rendered from `time_remaining_ms` returned by the server (display only — server is authoritative).
4. On `time_up`: show score screen.

### Score screen modal

Three branches based on (auth state) × (config):

1. **Logged in, default config** → modal: *"Submit score to leaderboard? Your username and score will appear publicly."* `[Submit]` `[No thanks]`. Either choice closes the modal and reveals "Play again" / "Leaderboard" / "Home" buttons.
2. **Logged in, custom config** → no modal. Score + buttons + small note: "Custom runs aren't eligible for the leaderboard."
3. **Guest** → no modal. Score + buttons + small note: "Log in to submit scores to the leaderboard."

Submission sends only `{session_id}`. Server fetches the score and config from the in-memory session and decides eligibility.

### Leaderboard (`/leaderboard`)

Public. One row per player (best score wins). Sorted by score descending.

Columns: rank · player · score · played-at (timestamp of the best run).

If the viewer is logged in, their own row gets a highlight.

A header line restates the locked default config so visitors understand what the board ranks.

## Mobile Usability

First-class requirement. Concrete plan:

- Numeric input field uses `inputmode="numeric"` and `pattern="[0-9]*"` so phone keyboards show the number pad.
- The phone keyboard's "Go"/"Done" key submits the answer (real `<form>` + `requestSubmit()`).
- Layout uses `dvh` units and `<meta name="viewport" content="..., interactive-widget=resizes-content">` so the soft keyboard does not shove the question off-screen.
- All tap targets ≥44×44 px (Start buttons, Submit/No thanks, Log in, etc.).
- Single mobile-first stylesheet. Landing page stacks vertically on narrow screens. Leaderboard table becomes a card list below ~480px.
- Score popup is a centered modal, not a fixed-bottom sheet — works in landscape and small screens.
- Manual test matrix: iOS Safari + Android Chrome, portrait and landscape, before each release.
- No PWA installability in v1; possible follow-up.

## Game Logic Details

### Generator (`generator.js`, pure)

- Input: `config` + a seeded RNG (so test runs are reproducible).
- Output: `{op, a, b, prompt}`, e.g. `{op: 'mul', a: 7, b: 13, prompt: '7 × 13'}`.
- Picks an enabled op uniformly at random, samples operands within the op's range.
- Subtraction: ensures `a ≥ b`.
- Division: generates `quotient × divisor = dividend`, presents as `dividend ÷ divisor`, integer answers only.

### Grader (`grader.js`, pure)

- Input: `question`, `userAnswer` (string).
- Output: `{correct: boolean}`.
- Trims whitespace, parses to integer, compares. Non-integer or empty input is wrong.

### Session lifecycle (`session.js`, in-memory)

- `start(userId|null, config) → {id, question, startedAt}` — also sets a `setTimeout` that flips the session into `time_up` state at `startedAt + duration`.
- `answer(id, userAnswer) → {correct, nextQuestion, score, timeRemainingMs}` or `{timeUp: true, finalScore}`.
- `finish(id) → {finalScore, durationMs, qualifies}`. `qualifies = is_default_config(config) && userId != null`.
- 5-minute idle TTL evicts abandoned sessions.
- Server's monotonic clock is the only source of truth.

## Error Handling & Edge Cases

- **Auth session expired mid-game**: rare (auth is 30 days). Game still finishes (game-session is keyed by its own ID); submission fails with 401. Client shows "you got logged out — log back in to submit" and stashes the run for one retry.
- **Server restart mid-game**: in-memory state lost. Client gets 404 on the next `/answer`. Show "the server hiccuped, please start a new run."
- **Double-submit**: server returns the existing run on the second call (idempotent).
- **Duplicate username on register**: 409 with a clear message.
- **Invalid answer (non-numeric, empty)**: graded as wrong, drill continues.
- **Submission of an unknown / expired `session_id`**: 404.
- **Submission of a non-default-config session**: 422 with `qualifies: false`.

## Testing

- **Unit (server):** `generator.js`, `grader.js`, `is_default_config()`. Pure functions — fast, ~20 cases each. Runner: `node:test` (built-in).
- **Integration (server):** real Fastify against a test Postgres (template DB). Cover register → login → start → answer×N → submit → leaderboard, plus auth/qualification edges. ~10 tests.
- **Client:** no automated tests. Manual verification, especially for mobile. If client logic grows non-trivial, revisit.

## Deployment

### One-time VPS setup

Software:

- Node.js 22 LTS (NodeSource)
- Postgres 16 (`apt install postgresql`)
- nginx (`apt install nginx`)
- certbot (`apt install certbot python3-certbot-nginx`)

Steps:

1. Create a non-root deploy user (`zetachad`).
2. Create the Postgres database and role; apply migrations.
3. Sign up for DuckDNS, point a chosen subdomain at `87.99.158.208`.
4. nginx site config: serve `client/` static, reverse-proxy `/api/*` → `127.0.0.1:3000`, redirect HTTP → HTTPS.
5. `certbot --nginx -d <subdomain>.duckdns.org` for the cert.
6. systemd unit for the Node server (auto-restart, runs as `zetachad`, env vars from `/etc/zetachad/env` mode 600).

### Deploy loop

A `deploy.sh` (~30 lines of bash) on the developer's laptop: rsync source to the VPS, SSH in, `npm ci --production`, run pending migrations, `systemctl restart zetachad`. No CI/CD pipeline in v1.

### Backups

Nightly `pg_dump` to a local file, kept for 7 days, via cron. Off-box copy is not in scope but recommended later.

### Secrets

`/etc/zetachad/env` (mode 600, owned by deploy user) holds the DB password, cookie-signing secret, etc. Loaded by systemd via `EnvironmentFile=`. Nothing secret committed to the repo.

## Open Items

None at design-approval time.

## Decisions Log

- **Cheat resistance:** server-authoritative (chosen over honor system / light validation).
- **Backend host:** user's Ubuntu 24.04 VPS at `87.99.158.208`.
- **Backend stack:** Node.js + Fastify + Postgres.
- **Auth:** username + password, no email. Cookie-based 30-day rolling sessions, server-side stored.
- **Default config:** carried over verbatim from upstream `js/config.js`.
- **Ranking:** by score (correct answers in 120s); best score per user shown on the leaderboard.
- **Submission:** opt-in popup after eligible runs only. Only submitted runs are persisted.
- **Domain:** free DuckDNS subdomain + Let's Encrypt cert.
- **Mobile:** first-class requirement; mobile-first responsive stylesheet, manual test matrix on iOS Safari + Android Chrome.
- **History/analytics:** removed entirely, including for logged-in users' custom runs.
