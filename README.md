# zetachad_mul

Multi-user arithmetic-drill leaderboard. Fork of [ZetaChad](https://github.com/stjianqing/ZetaChad).

- Spec: `docs/superpowers/specs/2026-04-26-zetachad_mul-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-26-zetachad_mul.md`

## Layout

- `client/` — static site (HTML/CSS/JS), served by nginx
- `server/` — Node + Fastify + Postgres backend
- `deploy/` — nginx config, systemd unit, deploy/backup scripts

## Run locally (dev)

See `server/README.md` and `deploy/README.md` once they exist.
