# zetachad_mul

Multi-user arithmetic-drill leaderboard. Fork of [ZetaChad](https://github.com/stjianqing/ZetaChad).

- Spec: `docs/superpowers/specs/2026-04-26-zetachad_mul-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-26-zetachad_mul.md`

## Layout

- `client/` — static site (HTML/CSS/JS), served by nginx
- `server/` — Node + Fastify + Postgres backend
- `deploy/` — nginx config, systemd unit, deploy/backup scripts

## Run locally (dev)

Local end-to-end testing requires nginx (or a similar proxy) to route `/api/*` → the Fastify server, plus a Postgres database. For practical purposes:

- Develop the server with its unit tests (`cd server && npm run test:unit` — runs without a DB).
- Develop the client visually (any static-file server pointed at `client/`).
- Validate the integrated flow on the VPS deploy (Phase 4 in the implementation plan).

To run the integration test suite locally, set `TEST_DATABASE_URL` to a writable Postgres URL and run `cd server && npm run test:integration`. The suite skips when that env var is unset.

See `deploy/README.md` for VPS bootstrap.

## Challenge Mode

Send a finished default-config run to another user (or to anyone via single-use share link); they replay the same problem sequence with a live ghost ticker showing your score in real time. Loser sees a drag-race animation of the head-to-head, plus a per-question table.

- Spec: `docs/superpowers/specs/2026-05-04-challenge-mode-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-04-challenge-mode.md`

Migration: `010_challenges.sql` (adds `challenges` table + `runs.seed`). Routes: `/api/challenges/*` (8 endpoints). Forfeit sweep flips stale `accepted` rows after 30 minutes.

**Known follow-up:** anonymous play loop (Task 20 of the plan) is stubbed — anonymous visitors to a share link are redirected to register. Registered-user flow is end-to-end.
