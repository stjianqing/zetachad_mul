# Analytics Implementation — Resume State

**Last updated:** 2026-04-27
**Current branch:** `main`
**Last commit:** `16ad931` (plan update for Task 6 bug fix)

## How to resume

In a fresh Claude Code session, run:

```
/superpowers:subagent-driven-development
```

with arguments:

> Plan: `C:\Users\stjia\zetachad_mul\docs\superpowers\plans\2026-04-27-analytics.md`. Spec: `C:\Users\stjia\zetachad_mul\docs\superpowers\specs\2026-04-27-analytics-design.md`. Repo: `C:\Users\stjia\zetachad_mul`. Resume from Task 7 — Tasks 1–6 are already done and committed on main. See `docs/superpowers/plans/2026-04-27-analytics-status.md` for what's done and the conventions to follow.

Tell the controller to read this file before dispatching anything. It contains conventions and gotchas the original implementer agents needed.

---

## Tasks completed (do not redo)

| # | Task | Commit |
|---|---|---|
| 1 | `attempts` migration | `f997732` |
| 2 | `submitted_to_leaderboard` flag migration + backfill | `1fecaa4` |
| 3 | helper.js truncates `attempts` | `c53d8b6` |
| 4 | Stage per-question attempts in session store (logged-in default-config only) | `87d9e4a` |
| 5 | `takeRunRecord` on session store | `847c359` |
| 6 | Time-up flush in `play.routes.js` (with bug fix) | `ff03d52` + `c69c855` (fix) + `16ad931` (plan update) |

## Tasks remaining

| # | Task | Approx. complexity |
|---|---|---|
| 7 | Submit becomes flag flip; leaderboard filters by flag | Medium |
| 8 | `requireAdmin` preHandler | Trivial |
| 9 | `GET /admin/api/players` | Small (route + 2 tests) |
| 10 | `GET /admin/api/runs` | Small |
| 11 | `GET /admin/api/runs/:id/attempts` | Small |
| 12 | `GET /admin/api/per-op` | Small |
| 13 | `GET /admin/api/heatmap` | Small |
| 14 | `GET /admin/api/weak-spots` | Small |
| 15 | `GET /admin/api/score-timeseries` | Small |
| 16 | Admin client shell + CSS + API wrapper | Small (3 files, no logic) |
| 17 | Heatmap + chart renderers | Medium |
| 18 | Admin dashboard controller | Medium (wires everything) |
| 19 | Nginx admin location blocks | Trivial |
| 20 | `deploy.sh` rsync admin client | Trivial |
| 21 | htpasswd bootstrap docs | Trivial |
| 22 | Full test suite + smoke checklist | Trivial (just runs) |

## Conventions and gotchas (carry forward)

These were discovered during Tasks 1–6. New implementer subagents should be told these in their prompt:

- **Repo path:** `C:\Users\stjia\zetachad_mul`. Server commands run from `server/` subdir.
- **Migrations are non-idempotent** by design — the runner tracks applied migrations via `schema_migrations` table. Don't add `IF NOT EXISTS`.
- **Generator uses `a`/`b`; DB uses `lhs`/`rhs`.** Mapping `lhs = q.a, rhs = q.b` is intentional. Don't swap.
- **No local DB.** `TEST_DATABASE_URL` and `DATABASE_URL` are unset in this environment. Integration tests skip cleanly via `skipIfNoDb(t)`. Unit tests run regardless. The TDD "fail" verification step is not observable when tests skip — that's expected.
- **Untracked files exist in working tree** (a few `.txt` and `.html` files unrelated to this work). Leave them alone; don't `git add` them. `git status` will always show them.
- **CRLF warnings on commit are pre-existing** repo line-ending config and don't affect anything.
- **Commit subjects must match the plan exactly.** `feat(server): ...`, `feat(admin): ...`, `feat(db): ...`, `test: ...`, `docs: ...` — the plan specifies them per task.
- **Test count: plan numbers may be off by ~1.** The plan said "21 passing" after Task 5 but actually 20. Pre-existing test counts were miscounted in plan. Treat actual final-count as N+M where N is what you find and M is what the task adds. All passing is what matters.

## Test status as of last commit

- Unit tests: **39 pass / 0 fail** (`node --test test/unit/` from `server/`)
- Integration tests: **12 skip / 0 fail** (no `TEST_DATABASE_URL`; this is correct behavior — they will run on the VPS or when a test DB is configured)

## Bug found in plan during Task 6

The plan's Task 6 Step 3 originally had `pool.connect()` outside the try block in `flushRunIfRecording`. If `pool.connect()` threw (DB unreachable / pool exhausted), the error escaped to Fastify and the player would see HTTP 500 instead of `time_up: true`. **Fixed in commit `c69c855`** (code) and `16ad931` (plan).

If you read tasks out of order, the **fixed** version of `flushRunIfRecording` is the one that's currently in the plan and in `play.routes.js`. Don't reintroduce the bug.

## Subagent-driven development controller notes

The original controller used:
- **haiku** for trivial 1-file mechanical tasks (migrations, tiny edits, single-route handlers).
- **sonnet** for multi-file logic (Task 4 staging logic, Task 6 transactions).
- For each task: implementer → spec reviewer → code quality reviewer (the 3rd via `superpowers:code-reviewer` agent). Combined spec+quality review for trivially simple tasks (e.g., Task 3) when both reviews would say the same thing.

Code reviewer caught a real critical bug in Task 6 — keep using `superpowers:code-reviewer` agent for non-trivial tasks even though it costs more.
