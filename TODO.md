# zetachad_mul — Follow-ups

System is deployed and working at https://zetachad.duckdns.org. The items below are from the final holistic code review (2026-04-27). None are blocking; address them when you next iterate.

## Quick wins (~10 min total, all 1–2 line fixes)

### 1. XSS hardening: escape username in landing page

`client/js/landing.js:31` writes `user.username` directly into `innerHTML`. The server's username regex (`[a-zA-Z0-9_-]{3,20}`) makes this safe today, but it's inconsistent with `leaderboard.js` which already calls `escapeHtml()` at the same site. If the regex is ever broadened, this silently becomes stored XSS.

**Fix:** copy the `escapeHtml` helper from `leaderboard.js` into `landing.js`, wrap `${user.username}` with it.

### 2. Enable `trustProxy` in Fastify (rate limits currently useless)

The IP rate limits on `/api/register` and `/api/login` (5/min) and the per-IP fallback on `/api/play/answer` are all hitting `req.ip = 127.0.0.1` because Fastify is behind nginx and isn't told to read `X-Forwarded-For`. Effectively, every request looks like it's from the same IP, so the limiter is bypassed.

**Fix:** in `server/src/index.js:13`, change `Fastify({ logger: ... })` to `Fastify({ logger: ..., trustProxy: true })`. The nginx config already sets `X-Real-IP` and `X-Forwarded-For` correctly.

### 3. Remove dead `zc_pending_submit` localStorage stash

`client/js/play.js:139` writes `localStorage.setItem('zc_pending_submit', state.sessionId)` on a 401 during submit, with a comment claiming the user can retry after re-login. Nothing reads this key — and by the time a user logs back in, the in-memory game session has expired (5-min TTL), so the retry would fail anyway.

**Fix:** delete the `localStorage.setItem` line. Keep the user-facing message ("you got logged out — log back in to submit") since that part is honest.

## Medium-effort (~30 min)

### 4. Validate `config` shape at the play/start route

`server/src/routes/play.routes.js:9-13` only checks `typeof config !== 'object'`. Malformed configs (no enabled ops, `durationMs: 0`, negative ranges, `Infinity` bounds) reach the session store and either throw a 500 or produce nonsensical games.

**Fix:** add a `validateConfig(config)` helper in `server/src/config.js` that checks each op's numeric bounds are positive finite integers in valid order, at least one op is enabled, and `durationMs` is between 1000 and 600000. Return 400 from the route if validation fails. Add ~6 unit tests.

## v2 follow-ups (real engineering, address when scaling)

### 5. Atomic rank computation

`board.routes.js:25-41` does INSERT then SELECT separately. Between them, another submit can change ranks. Returned rank can be off by one. Cosmetic for friends-scale.

**Fix when scaling:** wrap both queries in a single CTE so the rank reflects the inserted row.

### 6. Session idle TTL is too tight

5-minute idle TTL + 60s eviction interval, but the game itself is 120s. A user who's slow to click "Submit" on the score screen could have their session evicted. Spec already flags this as known.

**Fix:** raise to 10 minutes, or make it `durationMs + 5 * 60_000` so it's always proportional.

### 7. Observability

Errors only land in `journalctl -u zetachad`. No off-box log sink. A 2am crash needs SSH to diagnose.

**Fix when it matters:** uncaught-exception hook → file, or a free Logtail/Better Stack tier.

### 8. Off-box backups

Nightly `pg_dump` writes to `/var/backups/zetachad/` on the same disk as Postgres. Disk failure = data loss. Friends-scale, leaderboard would just reset; not catastrophic.

**Fix when stakes rise:** weekly `rclone` to an S3-compatible free tier.

### 9. Deploy SSH key isolation

`deploy.sh` (and the current manual deploy via `git pull` on the VPS) uses your laptop's SSH key targeting `root@`. A compromised laptop = root on production.

**Fix:** dedicated deploy key, ssh in as a `deploy` user (or `zetachad`), use `sudo` for the systemd restart. No more root SSH from laptop.

## Architectural notes (not bugs, just FYI)

- The session store uses **lazy time-up checking** (each `answer()` call compares `Date.now()` to `startedAt`). Spec called for a `setTimeout` that flips state. The lazy version is actually better (no dangling timers, no memory pressure if a session is never answered) — kept the deviation deliberately.
- The submit endpoint returns `run_id` on first submission and `idempotent: true` on repeat. Spec didn't ask for those; both are harmless additions.
- The `landing.js` and `play.js` clients each have their own `DEFAULT_CONFIG` constant that mirrors the server's. Acceptable because it's UI-only — the server is the source of truth for whether a config qualifies. Worth a one-line comment near each duplicate noting they're for UI only and the server is canonical.

## Operational reminders

- **Repo is currently public.** Per our deploy plan, it was made public so the VPS could `git clone` without auth. Make it private again (https://github.com/stjianqing/zetachad_mul/settings → Danger Zone → Change visibility) once you've decided whether to set up a deploy key for future `git pull`s.
- **DB password (`tns6e123`) is in `/etc/zetachad/env` on the VPS.** Postgres is bound to localhost only, so this is acceptable, but if the VPS gets shared with anyone you don't fully trust, rotate it.
- **Cookie secret** is randomly generated and only stored in `/etc/zetachad/env`. Rotating it logs everyone out. Leave alone unless you suspect compromise.
- **Cert auto-renewal** runs via `certbot.timer` systemd unit. Check `systemctl list-timers | grep certbot` periodically. Cert expires 2026-07-26 if renewal fails.
- **Nightly backup** runs at 03:00 UTC via crontab, retains 7 days, logs to `/var/backups/zetachad/backup.log`. Check `tail -5 /var/backups/zetachad/backup.log` after a few days to confirm the cron is firing.
