# zetachad_mul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a multi-user, server-authoritative arithmetic-drill leaderboard (forked from [stjianqing/ZetaChad](https://github.com/stjianqing/ZetaChad)) onto the user's Ubuntu 24.04 VPS at `87.99.158.208`.

**Architecture:** A monorepo (`zetachad_mul/`) with two halves: a Node.js + Fastify + Postgres backend that owns game state and a vanilla HTML/CSS/JS client that is a thin display layer. Hosted behind nginx on the user's VPS, with a free DuckDNS subdomain and a Let's Encrypt cert.

**Tech Stack:** Node.js 22 LTS, Fastify 5, `pg` (node-postgres), `bcrypt`, Postgres 16, vanilla HTML/CSS/JS, nginx, certbot, systemd, DuckDNS. Tests use the built-in `node:test` runner. No build step on the client; one bundle of plain files.

---

## Reference: Spec

The authoritative spec lives at `docs/superpowers/specs/2026-04-26-zetachad_mul-design.md`. This plan implements that spec verbatim — if any conflict appears, the spec wins; flag and update.

## Reference: Locked Default Config

Carried over verbatim from upstream `js/config.js`:

```js
const DEFAULT_CONFIG = {
  ops: {
    add: { enabled: true, min: 2, max: 100 },
    sub: { enabled: true, min: 2, max: 100 },
    mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
    div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
  },
  durationMs: 120_000
};
```

## Reference: File map (what gets created)

```
zetachad_mul/
├── .gitignore
├── README.md
├── client/
│   ├── index.html              landing
│   ├── login.html
│   ├── register.html
│   ├── play.html               drill UI
│   ├── leaderboard.html
│   ├── css/styles.css          carried over from upstream + mobile-first additions
│   └── js/
│       ├── api.js              fetch wrapper
│       ├── auth.js             login/register/me
│       ├── landing.js          landing page
│       ├── play.js             drill loop (server-driven)
│       └── leaderboard.js
├── server/
│   ├── package.json
│   ├── package-lock.json       (committed)
│   ├── .env.example
│   ├── migrations/
│   │   ├── 001_users.sql
│   │   ├── 002_auth_sessions.sql
│   │   └── 003_runs.sql
│   ├── src/
│   │   ├── index.js            Fastify bootstrap
│   │   ├── db.js               pg pool + migration runner
│   │   ├── config.js           DEFAULT_CONFIG + is_default_config()
│   │   ├── auth.js             register/login/logout, requireAuth, optionalAuth
│   │   ├── game/
│   │   │   ├── generator.js    pure, seeded
│   │   │   ├── grader.js       pure
│   │   │   └── session.js      in-memory map + lifecycle
│   │   └── routes/
│   │       ├── auth.routes.js
│   │       ├── play.routes.js
│   │       └── board.routes.js
│   └── test/
│       ├── unit/
│       │   ├── generator.test.js
│       │   ├── grader.test.js
│       │   └── config.test.js
│       └── integration/
│           ├── helper.js
│           ├── auth.test.js
│           ├── play.test.js
│           └── leaderboard.test.js
└── deploy/
    ├── nginx.conf              site config template
    ├── zetachad.service        systemd unit
    ├── deploy.sh               rsync + restart
    ├── backup.sh               nightly pg_dump
    └── README.md               step-by-step VPS bootstrap notes
```

---

# Phase 0: Repo scaffolding

### Task 0.1: Initialize the repo

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\.gitignore`
- Create: `C:\Users\stjia\zetachad_mul\README.md`

**Note:** the `docs/superpowers/specs/` and `docs/superpowers/plans/` directories already exist in this directory (the spec and this plan live there).

- [ ] **Step 1: Verify directory exists and has the spec**

Run (from `C:\Users\stjia`):

```bash
ls zetachad_mul/docs/superpowers/specs/
```

Expected: at least `2026-04-26-zetachad_mul-design.md` is present. If the directory does not exist, stop and check with the planner — the spec must be present before scaffolding the rest.

- [ ] **Step 2: Create `.gitignore`**

Create `C:\Users\stjia\zetachad_mul\.gitignore` with:

```
node_modules/
*.log
.env
.env.local
server/.env
.DS_Store
Thumbs.db
coverage/
.idea/
.vscode/
```

- [ ] **Step 3: Create a minimal README**

Create `C:\Users\stjia\zetachad_mul\README.md` with:

```markdown
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
```

- [ ] **Step 4: `git init` and first commit**

Run from `C:\Users\stjia\zetachad_mul`:

```bash
git init -b main
git add .gitignore README.md docs/
git commit -m "chore: scaffold zetachad_mul (spec + plan)"
```

Expected: a single commit with the spec, plan, gitignore, README. No node_modules, no env files.

- [ ] **Step 5: Verify**

Run:

```bash
git log --oneline
git status
```

Expected: one commit, working tree clean, no untracked files.

---

# Phase 1: Server scaffolding

### Task 1.1: Create the server package

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\package.json`
- Create: `C:\Users\stjia\zetachad_mul\server\.env.example`

- [ ] **Step 1: Create `server/package.json`**

Path: `C:\Users\stjia\zetachad_mul\server\package.json`

```json
{
  "name": "zetachad_mul-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test test/",
    "test:unit": "node --test test/unit/",
    "test:integration": "node --test test/integration/",
    "migrate": "node src/db.js migrate"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.0",
    "@fastify/rate-limit": "^10.2.0",
    "bcrypt": "^5.1.1",
    "fastify": "^5.1.0",
    "pg": "^8.13.1"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run from `C:\Users\stjia\zetachad_mul\server`:

```bash
npm install
```

Expected: `node_modules/` and `package-lock.json` are created. No errors. If `bcrypt` fails to build on Windows, install build tools (`npm install --global windows-build-tools`) or temporarily swap `bcrypt` for `bcryptjs` and update import sites — note the swap in commit message.

- [ ] **Step 3: Create `.env.example`**

Path: `C:\Users\stjia\zetachad_mul\server\.env.example`

```
# Database
DATABASE_URL=postgres://zetachad:CHANGE_ME@127.0.0.1:5432/zetachad

# HTTP
PORT=3000
HOST=127.0.0.1

# Cookies
COOKIE_SECRET=CHANGE_ME_TO_A_RANDOM_64_CHAR_STRING
COOKIE_SECURE=true
COOKIE_DOMAIN=

# Misc
NODE_ENV=production
LOG_LEVEL=info
```

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json server/.env.example
git commit -m "feat(server): scaffold package and env example"
```

---

### Task 1.2: Database connection + migration runner

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\db.js`
- Create: `C:\Users\stjia\zetachad_mul\server\migrations\001_users.sql`
- Create: `C:\Users\stjia\zetachad_mul\server\migrations\002_auth_sessions.sql`
- Create: `C:\Users\stjia\zetachad_mul\server\migrations\003_runs.sql`

- [ ] **Step 1: Write migration `001_users.sql`**

```sql
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write migration `002_auth_sessions.sql`**

```sql
CREATE TABLE auth_sessions (
  token       TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);
```

- [ ] **Step 3: Write migration `003_runs.sql`**

```sql
CREATE TABLE runs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  played_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runs_user_score_idx ON runs(user_id, score DESC);
```

- [ ] **Step 4: Write `src/db.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\db.js`

```js
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

export function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: url, max: 10 });
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate(pool) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(__dirname, '..', 'migrations');

  await pool.query(MIGRATIONS_TABLE);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await pool.query(
    'SELECT filename FROM schema_migrations'
  );
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`migrated: ${file}`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow rollback error to preserve original */ }
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
}

// Allow running as: `npm run migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = makePool();
  try {
    await migrate(pool);
    console.log('migrations complete');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
```

- [ ] **Step 5: Verify migrations parse (no DB needed yet)**

Run from `C:\Users\stjia\zetachad_mul\server`:

```bash
node -e "import('./src/db.js').then(m => console.log(typeof m.migrate))"
```

Expected: prints `function`. No errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/db.js server/migrations/
git commit -m "feat(server): db pool + migration runner + initial migrations"
```

---

### Task 1.3: Locked default-config module

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\config.js`
- Create: `C:\Users\stjia\zetachad_mul\server\test\unit\config.test.js`

- [ ] **Step 1: Write the failing test**

Path: `C:\Users\stjia\zetachad_mul\server\test\unit\config.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isDefaultConfig } from '../../src/config.js';

test('DEFAULT_CONFIG matches the locked spec', () => {
  assert.equal(DEFAULT_CONFIG.durationMs, 120_000);
  assert.equal(DEFAULT_CONFIG.ops.add.enabled, true);
  assert.equal(DEFAULT_CONFIG.ops.add.min, 2);
  assert.equal(DEFAULT_CONFIG.ops.add.max, 100);
  assert.equal(DEFAULT_CONFIG.ops.sub.min, 2);
  assert.equal(DEFAULT_CONFIG.ops.sub.max, 100);
  assert.equal(DEFAULT_CONFIG.ops.mul.lhsMax, 12);
  assert.equal(DEFAULT_CONFIG.ops.mul.rhsMax, 100);
  assert.equal(DEFAULT_CONFIG.ops.div.lhsMax, 12);
  assert.equal(DEFAULT_CONFIG.ops.div.rhsMax, 100);
});

test('isDefaultConfig: deep-equal default returns true', () => {
  const copy = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  assert.equal(isDefaultConfig(copy), true);
});

test('isDefaultConfig: any deviation returns false', () => {
  const tweaked = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  tweaked.durationMs = 60_000;
  assert.equal(isDefaultConfig(tweaked), false);

  const tweaked2 = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  tweaked2.ops.add.max = 99;
  assert.equal(isDefaultConfig(tweaked2), false);

  const tweaked3 = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  tweaked3.ops.mul.enabled = false;
  assert.equal(isDefaultConfig(tweaked3), false);
});

test('isDefaultConfig: null/undefined/non-object returns false', () => {
  assert.equal(isDefaultConfig(null), false);
  assert.equal(isDefaultConfig(undefined), false);
  assert.equal(isDefaultConfig('hello'), false);
  assert.equal(isDefaultConfig({}), false);
});
```

- [ ] **Step 2: Run the test (expect fail)**

```bash
npm run test:unit
```

Expected: failure — `Cannot find module '../../src/config.js'` or similar.

- [ ] **Step 3: Implement `src/config.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\config.js`

```js
export const DEFAULT_CONFIG = Object.freeze({
  ops: Object.freeze({
    add: Object.freeze({ enabled: true, min: 2, max: 100 }),
    sub: Object.freeze({ enabled: true, min: 2, max: 100 }),
    mul: Object.freeze({ enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }),
    div: Object.freeze({ enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 })
  }),
  durationMs: 120_000
});

export function isDefaultConfig(config) {
  if (!config || typeof config !== 'object') return false;
  try {
    return JSON.stringify(canonicalize(config)) === JSON.stringify(canonicalize(DEFAULT_CONFIG));
  } catch {
    return false;
  }
}

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
npm run test:unit
```

Expected: all four `config.test.js` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.js server/test/unit/config.test.js
git commit -m "feat(server): locked default-config + isDefaultConfig predicate"
```

---

### Task 1.4: Question generator (pure)

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\game\generator.js`
- Create: `C:\Users\stjia\zetachad_mul\server\test\unit\generator.test.js`

- [ ] **Step 1: Write the failing tests**

Path: `C:\Users\stjia\zetachad_mul\server\test\unit\generator.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, makeRng } from '../../src/game/generator.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

test('generate(add) produces a + b within range with correct answer', () => {
  const cfg = {
    ops: { add: { enabled: true, min: 5, max: 7 }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(1);
  const q = generate(cfg, rng);
  assert.equal(q.op, 'add');
  assert.ok(q.a >= 5 && q.a <= 7, `a out of range: ${q.a}`);
  assert.ok(q.b >= 5 && q.b <= 7, `b out of range: ${q.b}`);
  assert.equal(q.answer, q.a + q.b);
  assert.match(q.prompt, /\+/);
});

test('generate(sub) ensures a >= b (non-negative answer)', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: true, min: 2, max: 100 }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(42);
  for (let i = 0; i < 50; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.op, 'sub');
    assert.ok(q.a >= q.b, `expected a>=b, got a=${q.a} b=${q.b}`);
    assert.equal(q.answer, q.a - q.b);
    assert.ok(q.answer >= 0);
  }
});

test('generate(mul) uses separate lhs/rhs ranges', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: false }, mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(7);
  for (let i = 0; i < 50; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.op, 'mul');
    assert.ok(q.a >= 2 && q.a <= 12);
    assert.ok(q.b >= 2 && q.b <= 100);
    assert.equal(q.answer, q.a * q.b);
  }
});

test('generate(div) returns integer answer; presents as dividend ÷ divisor', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 } },
    durationMs: 60_000
  };
  const rng = makeRng(7);
  for (let i = 0; i < 50; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.op, 'div');
    assert.ok(Number.isInteger(q.answer));
    assert.equal(q.a % q.b, 0, `a=${q.a}, b=${q.b} not integer-divisible`);
    assert.equal(q.a / q.b, q.answer);
  }
});

test('generate picks among enabled ops only', () => {
  const cfg = {
    ops: { add: { enabled: true, min: 1, max: 2 }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(99);
  for (let i = 0; i < 30; i++) {
    assert.equal(generate(cfg, rng).op, 'add');
  }
});

test('generate is reproducible with the same seed', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 10; i++) {
    const qa = generate(DEFAULT_CONFIG, a);
    const qb = generate(DEFAULT_CONFIG, b);
    assert.deepEqual(qa, qb);
  }
});

test('generate throws when no op is enabled', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  assert.throws(() => generate(cfg, makeRng(1)), /no ops enabled/i);
});
```

- [ ] **Step 2: Run the tests (expect fail)**

```bash
npm run test:unit
```

Expected: `generator.test.js` fails with module-not-found.

- [ ] **Step 3: Implement `src/game/generator.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\game\generator.js`

```js
// Mulberry32 PRNG — deterministic, fast, good enough for question generation.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intInRange(rng, lo, hi) {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

export function generate(config, rng) {
  const enabled = Object.entries(config.ops)
    .filter(([, v]) => v && v.enabled)
    .map(([k]) => k);
  if (enabled.length === 0) throw new Error('no ops enabled');

  const op = enabled[intInRange(rng, 0, enabled.length - 1)];

  switch (op) {
    case 'add': {
      const { min, max } = config.ops.add;
      const a = intInRange(rng, min, max);
      const b = intInRange(rng, min, max);
      return { op, a, b, answer: a + b, prompt: `${a} + ${b}` };
    }
    case 'sub': {
      const { min, max } = config.ops.sub;
      let a = intInRange(rng, min, max);
      let b = intInRange(rng, min, max);
      if (a < b) [a, b] = [b, a];
      return { op, a, b, answer: a - b, prompt: `${a} − ${b}` };
    }
    case 'mul': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.mul;
      const a = intInRange(rng, lhsMin, lhsMax);
      const b = intInRange(rng, rhsMin, rhsMax);
      return { op, a, b, answer: a * b, prompt: `${a} × ${b}` };
    }
    case 'div': {
      const { lhsMin, lhsMax, rhsMin, rhsMax } = config.ops.div;
      // Generate quotient × divisor = dividend, present as dividend ÷ divisor.
      const quotient = intInRange(rng, rhsMin, rhsMax);
      const divisor = intInRange(rng, lhsMin, lhsMax);
      const dividend = quotient * divisor;
      return { op, a: dividend, b: divisor, answer: quotient, prompt: `${dividend} ÷ ${divisor}` };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}
```

- [ ] **Step 4: Run the tests (expect pass)**

```bash
npm run test:unit
```

Expected: all generator tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/game/generator.js server/test/unit/generator.test.js
git commit -m "feat(server): pure question generator with seeded RNG"
```

---

### Task 1.5: Grader (pure)

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\game\grader.js`
- Create: `C:\Users\stjia\zetachad_mul\server\test\unit\grader.test.js`

- [ ] **Step 1: Write the failing tests**

Path: `C:\Users\stjia\zetachad_mul\server\test\unit\grader.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade } from '../../src/game/grader.js';

const Q = { op: 'add', a: 7, b: 13, answer: 20, prompt: '7 + 13' };

test('exact match is correct', () => {
  assert.deepEqual(grade(Q, '20'), { correct: true });
});

test('whitespace is trimmed', () => {
  assert.deepEqual(grade(Q, '  20  '), { correct: true });
});

test('wrong answer is incorrect', () => {
  assert.deepEqual(grade(Q, '21'), { correct: false });
});

test('non-numeric is incorrect', () => {
  assert.deepEqual(grade(Q, 'twenty'), { correct: false });
  assert.deepEqual(grade(Q, '20a'), { correct: false });
  assert.deepEqual(grade(Q, ''), { correct: false });
  assert.deepEqual(grade(Q, '   '), { correct: false });
});

test('non-string answer is incorrect (defensive)', () => {
  assert.deepEqual(grade(Q, null), { correct: false });
  assert.deepEqual(grade(Q, undefined), { correct: false });
  assert.deepEqual(grade(Q, 20), { correct: false });
});

test('decimals are incorrect (integer answers only)', () => {
  assert.deepEqual(grade(Q, '20.0'), { correct: false });
  assert.deepEqual(grade(Q, '20.5'), { correct: false });
});

test('leading zeros are accepted', () => {
  assert.deepEqual(grade(Q, '020'), { correct: true });
});

test('negative answer matches when expected', () => {
  // Defensive — current generator never produces negative answers, but the grader should be honest.
  const negQ = { op: 'sub', a: 1, b: 2, answer: -1, prompt: '1 − 2' };
  assert.deepEqual(grade(negQ, '-1'), { correct: true });
});
```

- [ ] **Step 2: Run tests (expect fail)**

```bash
npm run test:unit
```

Expected: `grader.test.js` fails with module-not-found.

- [ ] **Step 3: Implement `src/game/grader.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\game\grader.js`

```js
export function grade(question, userAnswer) {
  if (typeof userAnswer !== 'string') return { correct: false };
  const trimmed = userAnswer.trim();
  if (trimmed === '') return { correct: false };
  // Integer pattern only: optional leading sign, then digits.
  if (!/^[-+]?\d+$/.test(trimmed)) return { correct: false };
  const parsed = Number(trimmed);
  return { correct: parsed === question.answer };
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npm run test:unit
```

Expected: all grader tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/game/grader.js server/test/unit/grader.test.js
git commit -m "feat(server): pure answer grader"
```

---

### Task 1.6: In-memory game session store

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\game\session.js`
- Create: `C:\Users\stjia\zetachad_mul\server\test\unit\session.test.js`

This is one of the trickier modules because of timing. Tests use a controlled clock instead of `Date.now()`.

- [ ] **Step 1: Write the failing tests**

Path: `C:\Users\stjia\zetachad_mul\server\test\unit\session.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../../src/game/session.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

function fakeClock(initial) {
  let now = initial;
  return {
    now: () => now,
    advance: (ms) => { now += ms; }
  };
}

test('start returns a session id, first question, and time_limit_ms', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const r = store.start({ userId: null, config: DEFAULT_CONFIG });
  assert.equal(typeof r.sessionId, 'string');
  assert.ok(r.sessionId.length >= 16);
  assert.ok(r.question && typeof r.question.prompt === 'string');
  assert.equal(r.timeLimitMs, 120_000);
});

test('answer grades, increments score, returns next question and remaining time', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId, question } = store.start({ userId: 7, config: DEFAULT_CONFIG });

  clock.advance(1500);
  const correctAnswer = String(question.answer);
  const r = store.answer(sessionId, correctAnswer);
  assert.equal(r.correct, true);
  assert.equal(r.score, 1);
  assert.ok(r.nextQuestion);
  assert.equal(r.timeRemainingMs, 120_000 - 1500);
});

test('wrong answer leaves score unchanged', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const r = store.answer(sessionId, 'definitely-not-a-number');
  assert.equal(r.correct, false);
  assert.equal(r.score, 0);
});

test('answer after time_up returns time_up:true and final_score', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId, question } = store.start({ userId: 7, config: DEFAULT_CONFIG });

  // Answer one correctly inside the time window
  store.answer(sessionId, String(question.answer));

  clock.advance(120_001);
  const r = store.answer(sessionId, '0');
  assert.equal(r.timeUp, true);
  assert.equal(r.finalScore, 1);
});

test('answer with unknown sessionId returns null', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  assert.equal(store.answer('nope', '1'), null);
});

test('finish returns finalScore, durationMs, qualifies (default config + userId)', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId, question } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  store.answer(sessionId, String(question.answer));
  clock.advance(120_001);
  const r = store.finish(sessionId);
  assert.equal(r.finalScore, 1);
  assert.equal(r.durationMs, 120_000);
  assert.equal(r.qualifies, true);
});

test('finish on a non-default config returns qualifies:false', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 60_000;
  const { sessionId } = store.start({ userId: 7, config: cfg });
  clock.advance(60_001);
  const r = store.finish(sessionId);
  assert.equal(r.qualifies, false);
});

test('finish with no userId returns qualifies:false', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: null, config: DEFAULT_CONFIG });
  clock.advance(120_001);
  const r = store.finish(sessionId);
  assert.equal(r.qualifies, false);
});

test('idle TTL evicts old sessions', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1, idleTtlMs: 5 * 60 * 1000 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  clock.advance(6 * 60 * 1000);
  store.evictExpired();
  assert.equal(store.get(sessionId), null);
});

test('get returns the session record while active', () => {
  const clock = fakeClock(1_000_000);
  const store = createSessionStore({ now: clock.now, rngSeed: 1 });
  const { sessionId } = store.start({ userId: 7, config: DEFAULT_CONFIG });
  const s = store.get(sessionId);
  assert.equal(s.userId, 7);
  assert.equal(s.score, 0);
});
```

- [ ] **Step 2: Run tests (expect fail)**

```bash
npm run test:unit
```

Expected: `session.test.js` fails with module-not-found.

- [ ] **Step 3: Implement `src/game/session.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\game\session.js`

```js
import { randomBytes } from 'node:crypto';
import { generate, makeRng } from './generator.js';
import { grade } from './grader.js';
import { isDefaultConfig } from '../config.js';

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

export function createSessionStore({ now = () => Date.now(), rngSeed, idleTtlMs = DEFAULT_IDLE_TTL_MS } = {}) {
  const sessions = new Map();
  // A monotonically advanced seed source so different sessions don't share an RNG sequence.
  let seedCounter = (rngSeed != null ? rngSeed : Math.floor(Math.random() * 0xFFFFFFFF)) | 0;

  function nextSeed() {
    seedCounter = (seedCounter + 1) | 0;
    return seedCounter;
  }

  function makeId() {
    return randomBytes(16).toString('base64url');
  }

  function newQuestion(session) {
    return generate(session.config, session.rng);
  }

  return {
    start({ userId, config }) {
      const sessionId = makeId();
      const startedAt = now();
      const rng = makeRng(nextSeed());
      const session = {
        id: sessionId,
        userId: userId ?? null,
        config,
        startedAt,
        lastTouchedAt: startedAt,
        durationMs: config.durationMs,
        score: 0,
        currentQuestion: null,
        rng,
        finalized: false
      };
      session.currentQuestion = generate(session.config, session.rng);
      sessions.set(sessionId, session);
      return {
        sessionId,
        question: { prompt: session.currentQuestion.prompt, op: session.currentQuestion.op },
        timeLimitMs: session.durationMs
      };
    },

    answer(sessionId, userAnswer) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      const t = now();
      session.lastTouchedAt = t;
      const elapsed = t - session.startedAt;
      if (elapsed >= session.durationMs) {
        session.finalized = true;
        return { timeUp: true, finalScore: session.score };
      }
      const { correct } = grade(session.currentQuestion, userAnswer);
      if (correct) session.score += 1;
      session.currentQuestion = newQuestion(session);
      return {
        correct,
        nextQuestion: { prompt: session.currentQuestion.prompt, op: session.currentQuestion.op },
        score: session.score,
        timeRemainingMs: Math.max(0, session.durationMs - elapsed)
      };
    },

    finish(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      session.finalized = true;
      return {
        finalScore: session.score,
        durationMs: session.durationMs,
        qualifies: session.userId != null && isDefaultConfig(session.config)
      };
    },

    get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },

    delete(sessionId) {
      sessions.delete(sessionId);
    },

    evictExpired() {
      const t = now();
      for (const [id, s] of sessions) {
        if (t - s.lastTouchedAt > idleTtlMs) sessions.delete(id);
      }
    },

    size() { return sessions.size; }
  };
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npm run test:unit
```

Expected: all session tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/game/session.js server/test/unit/session.test.js
git commit -m "feat(server): in-memory game-session store with idle TTL"
```

---

### Task 1.7: Auth (bcrypt + cookies + middleware)

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\auth.js`

This module is exercised end-to-end in the integration tests (Task 1.10), so we don't write unit tests here — its surface is small and entirely orchestration. The integration tests cover the real behavior.

- [ ] **Step 1: Implement `src/auth.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\auth.js`

```js
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

const COOKIE_NAME = 'zc_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const PASSWORD_MIN = 8;

export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

export function validatePassword(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN;
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function makeAuthSessionToken() {
  return randomBytes(32).toString('base64url');
}

export async function createAuthSession(pool, userId) {
  const token = makeAuthSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await pool.query(
    'INSERT INTO auth_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiresAt]
  );
  return { token, expiresAt };
}

export async function lookupAuthSession(pool, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.token, s.user_id, s.expires_at, u.username
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return rows[0] ?? null;
}

export async function bumpAuthSession(pool, token) {
  const newExpiry = new Date(Date.now() + SESSION_LIFETIME_MS);
  await pool.query('UPDATE auth_sessions SET expires_at = $1 WHERE token = $2', [newExpiry, token]);
  return newExpiry;
}

export async function deleteAuthSession(pool, token) {
  if (!token) return;
  await pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
}

export function setSessionCookie(reply, token, expiresAt, { secure = true } = {}) {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    expires: expiresAt
  });
}

export function clearSessionCookie(reply, { secure = true } = {}) {
  reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, secure, sameSite: 'lax' });
}

export function readSessionCookie(req) {
  return req.cookies?.[COOKIE_NAME] ?? null;
}

// Fastify decorator-style: req.user is set if cookie is valid.
export function makeAuthHook(pool, { cookieSecure = true } = {}) {
  return async function authHook(req, reply) {
    const token = readSessionCookie(req);
    const sess = await lookupAuthSession(pool, token);
    if (sess) {
      req.user = { id: Number(sess.user_id), username: sess.username, sessionToken: token };
      // Rolling session: bump expiry on every authenticated request.
      const newExpiry = await bumpAuthSession(pool, token);
      setSessionCookie(reply, token, newExpiry, { secure: cookieSecure });
    } else {
      req.user = null;
    }
  };
}

export function requireAuth(req, reply) {
  if (!req.user) {
    reply.code(401).send({ error: 'auth_required' });
    return reply;
  }
}
```

- [ ] **Step 2: Quick smoke check**

Run:

```bash
node -e "import('./src/auth.js').then(m => console.log(Object.keys(m)))"
```

Expected: prints array containing `validateUsername`, `hashPassword`, `createAuthSession`, etc.

- [ ] **Step 3: Commit**

```bash
git add server/src/auth.js
git commit -m "feat(server): auth module (bcrypt + cookie sessions + hooks)"
```

---

### Task 1.8: Routes — auth, play, leaderboard

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\routes\auth.routes.js`
- Create: `C:\Users\stjia\zetachad_mul\server\src\routes\play.routes.js`
- Create: `C:\Users\stjia\zetachad_mul\server\src\routes\board.routes.js`

- [ ] **Step 1: Implement `auth.routes.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\routes\auth.routes.js`

```js
import {
  validateUsername, validatePassword,
  hashPassword, verifyPassword,
  createAuthSession, deleteAuthSession,
  setSessionCookie, clearSessionCookie, readSessionCookie
} from '../auth.js';

export default async function authRoutes(fastify, { pool, cookieSecure }) {
  const ipLimit = { max: 5, timeWindow: '1 minute' };

  fastify.post('/api/register', { config: { rateLimit: ipLimit } }, async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!validateUsername(username)) return reply.code(400).send({ error: 'invalid_username' });
    if (!validatePassword(password)) return reply.code(400).send({ error: 'invalid_password' });

    const hash = await hashPassword(password);
    let userId;
    try {
      const r = await pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
        [username, hash]
      );
      userId = Number(r.rows[0].id);
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'username_taken' });
      throw err;
    }
    const { token, expiresAt } = await createAuthSession(pool, userId);
    setSessionCookie(reply, token, expiresAt, { secure: cookieSecure });
    return { user: { id: userId, username } };
  });

  fastify.post('/api/login', { config: { rateLimit: ipLimit } }, async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });

    const { token, expiresAt } = await createAuthSession(pool, Number(user.id));
    setSessionCookie(reply, token, expiresAt, { secure: cookieSecure });
    return { user: { id: Number(user.id), username: user.username } };
  });

  fastify.post('/api/logout', async (req, reply) => {
    const token = readSessionCookie(req);
    await deleteAuthSession(pool, token);
    clearSessionCookie(reply, { secure: cookieSecure });
    return { ok: true };
  });

  fastify.get('/api/me', async (req) => {
    return { user: req.user };
  });
}
```

- [ ] **Step 2: Implement `play.routes.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\routes\play.routes.js`

```js
export default async function playRoutes(fastify, { sessionStore }) {
  const answerLimit = {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => `play-answer:${req.body?.session_id ?? req.ip}`
  };

  fastify.post('/api/play/start', async (req, reply) => {
    const config = req.body?.config;
    if (!config || typeof config !== 'object') {
      return reply.code(400).send({ error: 'invalid_config' });
    }
    const r = sessionStore.start({ userId: req.user?.id ?? null, config });
    return { session_id: r.sessionId, question: r.question, time_limit_ms: r.timeLimitMs };
  });

  fastify.post('/api/play/answer', { config: { rateLimit: answerLimit } }, async (req, reply) => {
    const { session_id, answer } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });
    const r = sessionStore.answer(session_id, typeof answer === 'string' ? answer : '');
    if (r === null) return reply.code(404).send({ error: 'unknown_session' });
    if (r.timeUp) return { time_up: true, final_score: r.finalScore };
    return {
      correct: r.correct,
      next_question: r.nextQuestion,
      score: r.score,
      time_remaining_ms: r.timeRemainingMs
    };
  });
}
```

- [ ] **Step 3: Implement `board.routes.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\routes\board.routes.js`

```js
import { requireAuth } from '../auth.js';

export default async function boardRoutes(fastify, { pool, sessionStore }) {
  fastify.post('/api/leaderboard/submit', { preHandler: requireAuth }, async (req, reply) => {
    const { session_id } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });

    const session = sessionStore.get(session_id);
    if (!session) return reply.code(404).send({ error: 'unknown_session' });

    if (session.userId !== req.user.id) {
      return reply.code(403).send({ error: 'session_owner_mismatch' });
    }

    const finished = sessionStore.finish(session_id);
    if (!finished.qualifies) {
      return reply.code(422).send({ error: 'not_eligible', qualifies: false });
    }

    // Idempotency: a session can be submitted only once.
    if (session.submitted) {
      return { ok: true, rank: session.lastRank, idempotent: true };
    }

    const ins = await pool.query(
      `INSERT INTO runs (user_id, score, duration_ms) VALUES ($1, $2, $3)
       RETURNING id, played_at`,
      [req.user.id, finished.finalScore, finished.durationMs]
    );

    // Compute rank: number of users whose best score is strictly greater, plus 1.
    const { rows } = await pool.query(
      `WITH best AS (
         SELECT user_id, MAX(score) AS s FROM runs GROUP BY user_id
       )
       SELECT COUNT(*) + 1 AS rank
       FROM best
       WHERE s > (SELECT MAX(score) FROM runs WHERE user_id = $1)`,
      [req.user.id]
    );
    const rank = Number(rows[0].rank);

    session.submitted = true;
    session.lastRank = rank;

    return { ok: true, rank, run_id: Number(ins.rows[0].id) };
  });

  fastify.get('/api/leaderboard', async () => {
    const { rows } = await pool.query(
      `SELECT u.username, b.score, b.played_at
       FROM (
         SELECT DISTINCT ON (user_id) user_id, score, played_at
         FROM runs
         ORDER BY user_id, score DESC, played_at ASC
       ) b
       JOIN users u ON u.id = b.user_id
       ORDER BY b.score DESC, b.played_at ASC`
    );
    return {
      entries: rows.map((r, i) => ({
        rank: i + 1,
        username: r.username,
        score: r.score,
        played_at: r.played_at.toISOString()
      }))
    };
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/
git commit -m "feat(server): routes for auth, play, leaderboard"
```

---

### Task 1.9: Fastify bootstrap

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\src\index.js`

- [ ] **Step 1: Implement `src/index.js`**

Path: `C:\Users\stjia\zetachad_mul\server\src\index.js`

```js
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { makePool, migrate } from './db.js';
import { makeAuthHook } from './auth.js';
import { createSessionStore } from './game/session.js';
import authRoutes from './routes/auth.routes.js';
import playRoutes from './routes/play.routes.js';
import boardRoutes from './routes/board.routes.js';

export async function buildApp({ pool, cookieSecret, cookieSecure = true, sessionStore } = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cookie, { secret: cookieSecret });
  await app.register(rateLimit, { global: false });

  app.addHook('preHandler', makeAuthHook(pool, { cookieSecure }));

  await app.register(authRoutes, { pool, cookieSecure });
  await app.register(playRoutes, { sessionStore });
  await app.register(boardRoutes, { pool, sessionStore });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}

async function main() {
  const pool = makePool();
  await migrate(pool);

  const sessionStore = createSessionStore({});
  // Periodically evict abandoned sessions.
  const evictTimer = setInterval(() => sessionStore.evictExpired(), 60_000);
  evictTimer.unref();

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret || cookieSecret.length < 32) {
    throw new Error('COOKIE_SECRET must be set and >=32 chars');
  }
  const cookieSecure = (process.env.COOKIE_SECURE ?? 'true') !== 'false';

  const app = await buildApp({ pool, cookieSecret, cookieSecure, sessionStore });

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      app.log.info(`received ${sig}, shutting down`);
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Smoke check**

```bash
node -e "import('./src/index.js').then(m => console.log(typeof m.buildApp))"
```

Expected: prints `function`. No errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.js
git commit -m "feat(server): Fastify bootstrap (buildApp + main)"
```

---

### Task 1.10: Integration tests

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\server\test\integration\helper.js`
- Create: `C:\Users\stjia\zetachad_mul\server\test\integration\auth.test.js`
- Create: `C:\Users\stjia\zetachad_mul\server\test\integration\play.test.js`
- Create: `C:\Users\stjia\zetachad_mul\server\test\integration\leaderboard.test.js`

These tests need a real Postgres. The helper expects `TEST_DATABASE_URL` to point at a writable test database. The CI/local runner is responsible for creating it; the helper just truncates tables before each test. Tests are skipped (with a note) if the env var is absent.

- [ ] **Step 1: Implement the helper**

Path: `C:\Users\stjia\zetachad_mul\server\test\integration\helper.js`

```js
import { makePool, migrate } from '../../src/db.js';
import { createSessionStore } from '../../src/game/session.js';
import { buildApp } from '../../src/index.js';

const TEST_COOKIE_SECRET = 'a'.repeat(64);

let cachedPool;

export async function getPool() {
  if (cachedPool) return cachedPool;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  process.env.DATABASE_URL = url;
  cachedPool = makePool();
  await migrate(cachedPool);
  return cachedPool;
}

export async function freshApp() {
  const pool = await getPool();
  if (!pool) return null;
  await pool.query('TRUNCATE runs, auth_sessions, users RESTART IDENTITY CASCADE');
  const sessionStore = createSessionStore({});
  const app = await buildApp({
    pool,
    cookieSecret: TEST_COOKIE_SECRET,
    cookieSecure: false,
    sessionStore
  });
  return { app, pool, sessionStore };
}

export function cookieFromResponse(res) {
  const header = res.headers['set-cookie'];
  if (!header) return null;
  const arr = Array.isArray(header) ? header : [header];
  for (const c of arr) {
    const m = c.match(/zc_session=([^;]+)/);
    if (m) return `zc_session=${m[1]}`;
  }
  return null;
}

export function skipIfNoDb(t) {
  if (!process.env.TEST_DATABASE_URL) {
    t.skip('TEST_DATABASE_URL not set');
    return true;
  }
  return false;
}
```

- [ ] **Step 2: Implement `auth.test.js`**

Path: `C:\Users\stjia\zetachad_mul\server\test\integration\auth.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';

test('register → me returns the user', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const reg = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username: 'alice', password: 'password123' }
  });
  assert.equal(reg.statusCode, 200);
  const cookie = cookieFromResponse(reg);
  assert.ok(cookie, 'expected session cookie');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, 'alice');
});

test('register rejects invalid username/password', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const r1 = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'a', password: 'password123' } });
  assert.equal(r1.statusCode, 400);
  const r2 = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'short' } });
  assert.equal(r2.statusCode, 400);
});

test('register rejects duplicate username with 409', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  const dup = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  assert.equal(dup.statusCode, 409);
});

test('login + bad password → 401 with vague error', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'alice', password: 'wrong-password' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, 'invalid_credentials');

  const missing = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'no-such-user', password: 'whatever12' } });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error, 'invalid_credentials');
});

test('logout clears the session', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const reg = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  const cookie = cookieFromResponse(reg);
  await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().user, null);
});
```

- [ ] **Step 3: Implement `play.test.js`**

Path: `C:\Users\stjia\zetachad_mul\server\test\integration\play.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

async function registerAndCookie(app, username) {
  const r = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password: 'password123' } });
  return cookieFromResponse(r);
}

test('guest can start and answer; submit fails (no auth)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG } });
  assert.equal(start.statusCode, 200);
  const { session_id } = start.json();

  const session = sessionStore.get(session_id);
  const correctAnswer = String(session.currentQuestion.answer);

  const ans = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: correctAnswer } });
  assert.equal(ans.statusCode, 200);
  assert.equal(ans.json().correct, true);
  assert.equal(ans.json().score, 1);

  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id } });
  assert.equal(sub.statusCode, 401);
});

test('logged-in default-config run can submit; appears on leaderboard', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');

  const start = await app.inject({
    method: 'POST', url: '/api/play/start',
    payload: { config: DEFAULT_CONFIG }, headers: { cookie }
  });
  const { session_id } = start.json();
  const session = sessionStore.get(session_id);
  const correctAnswer = String(session.currentQuestion.answer);
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: correctAnswer }, headers: { cookie } });

  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id }, headers: { cookie } });
  assert.equal(sub.statusCode, 200);
  assert.equal(sub.json().ok, true);
  assert.equal(sub.json().rank, 1);

  const board = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  const entries = board.json().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].username, 'alice');
  assert.equal(entries[0].score, 1);
});

test('non-default config submit returns 422', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 60_000;

  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg }, headers: { cookie } });
  const { session_id } = start.json();
  const session = sessionStore.get(session_id);
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(session.currentQuestion.answer) }, headers: { cookie } });

  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id }, headers: { cookie } });
  assert.equal(sub.statusCode, 422);
  assert.equal(sub.json().qualifies, false);
});

test('submitting unknown session_id returns 404', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id: 'nope' }, headers: { cookie } });
  assert.equal(sub.statusCode, 404);
});

test('answer with unknown session_id returns 404', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const ans = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id: 'nope', answer: '1' } });
  assert.equal(ans.statusCode, 404);
});

test('user A cannot submit user B\'s session', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookieA = await registerAndCookie(app, 'alice');
  const cookieB = await registerAndCookie(app, 'bob');
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie: cookieA } });
  const { session_id } = start.json();
  const session = sessionStore.get(session_id);
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(session.currentQuestion.answer) }, headers: { cookie: cookieA } });
  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id }, headers: { cookie: cookieB } });
  assert.equal(sub.statusCode, 403);
});
```

- [ ] **Step 4: Implement `leaderboard.test.js`**

Path: `C:\Users\stjia\zetachad_mul\server\test\integration\leaderboard.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

async function registerAndCookie(app, username) {
  const r = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password: 'password123' } });
  return cookieFromResponse(r);
}

async function playAndSubmit(app, sessionStore, cookie, correctCount) {
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();
  for (let i = 0; i < correctCount; i++) {
    const session = sessionStore.get(session_id);
    await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(session.currentQuestion.answer) }, headers: { cookie } });
  }
  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id }, headers: { cookie } });
  return { session_id, sub };
}

test('best-per-user wins on the leaderboard', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  await playAndSubmit(app, sessionStore, cookie, 3);
  await playAndSubmit(app, sessionStore, cookie, 5);
  await playAndSubmit(app, sessionStore, cookie, 1);

  const board = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  const entries = board.json().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].score, 5);
});

test('multiple users sorted by score desc, ties by played_at asc', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const a = await registerAndCookie(app, 'alice');
  const b = await registerAndCookie(app, 'bob');
  const c = await registerAndCookie(app, 'carol');

  await playAndSubmit(app, sessionStore, a, 4);
  await playAndSubmit(app, sessionStore, b, 6);
  await playAndSubmit(app, sessionStore, c, 4);

  const board = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  const entries = board.json().entries;
  assert.deepEqual(entries.map((e) => e.username), ['bob', 'alice', 'carol']);
  assert.deepEqual(entries.map((e) => e.rank), [1, 2, 3]);
});

test('idempotent submit: second submit returns same rank without inserting', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore, pool } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const { session_id, sub: first } = await playAndSubmit(app, sessionStore, cookie, 3);
  const second = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id }, headers: { cookie } });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().rank, first.json().rank);
  assert.equal(second.json().idempotent, true);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM runs');
  assert.equal(rows[0].n, 1);
});
```

- [ ] **Step 5: Verify integration tests run**

If you have a local Postgres handy, create a test DB:

```bash
createdb zetachad_test
export TEST_DATABASE_URL=postgres://$USER@127.0.0.1:5432/zetachad_test
npm run test:integration
```

Expected: all pass. If `TEST_DATABASE_URL` is unset, tests are skipped (not failed).

If you don't have Postgres locally and want to defer this until VPS deploy, that's acceptable — just verify the tests *parse and load*:

```bash
node --test --test-name-pattern='nope-not-running' test/integration/
```

Expected: zero tests run, no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add server/test/
git commit -m "test(server): integration tests for auth, play, leaderboard"
```

---

# Phase 2: Client

The client is plain HTML/CSS/JS. We'll build it bottom-up: api wrapper → CSS carry-over with mobile additions → page-by-page.

### Task 2.1: Carry-over CSS + mobile-first additions

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\client\css\styles.css`

The upstream CSS is what gives the app its look (cyber-arcade palette, Space Grotesk + JetBrains Mono fonts, the magenta-cyan accents). We carry it over, then add mobile-first additions for the new pages and the keyboard-resize fix.

- [ ] **Step 1: Create `client/css/styles.css` — copy upstream verbatim**

Path: `C:\Users\stjia\zetachad_mul\client\css\styles.css`

Paste the full upstream CSS file (the one in the spec discussion / upstream's `css/styles.css`). It's ~400 lines. Source of truth: `https://raw.githubusercontent.com/stjianqing/ZetaChad/main/css/styles.css`. Fetch with curl/wget and save as the new file:

```bash
curl -fsSL https://raw.githubusercontent.com/stjianqing/ZetaChad/main/css/styles.css -o C:/Users/stjia/zetachad_mul/client/css/styles.css
```

If curl is unavailable, open the URL in a browser and save the page content.

- [ ] **Step 2: Append the new-page additions**

Append to the same file:

```css
/* ===== zetachad_mul additions ===== */

/* Layout helpers for new pages */
.narrow {
  max-width: 540px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem;
}

/* Landing page */
.landing-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
  margin: 1.25rem 0;
}
@media (max-width: 480px) {
  .landing-buttons { grid-template-columns: 1fr; }
}
.landing-buttons button.primary,
.landing-buttons button.secondary {
  width: 100%;
  min-height: 56px;
  font-size: 1rem;
}
.default-summary {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--cyan);
  padding: 0.75rem 1rem;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  color: var(--ink-dim);
  margin-bottom: 1rem;
}
.default-summary strong { color: var(--ink); }
.advanced-disclosure { margin-top: 1.5rem; }
.advanced-disclosure summary {
  cursor: pointer;
  color: var(--ink-dim);
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.85rem;
  padding: 0.5rem 0;
}
.advanced-disclosure summary:hover { color: var(--magenta); }
.eligibility-badge {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--lime);
  color: var(--lime);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 0.75rem;
}
.eligibility-badge.dim {
  border-color: var(--ink-faint);
  color: var(--ink-faint);
}

/* Auth forms */
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 1rem;
}
.auth-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.06em; }
.auth-form input {
  padding: 0.6rem 0.7rem;
  font-family: var(--font-mono);
  font-size: 1rem;
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 2px;
  min-height: 44px;
}
.auth-form input:focus { outline: none; border-color: var(--magenta); box-shadow: 0 0 0 3px rgba(255,42,109,0.25); }
.auth-form .form-error {
  color: var(--red);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  min-height: 1.2em;
}
.auth-form button.primary { min-height: 48px; }

/* User chip in topbar */
.topbar .user-chip { font-family: var(--font-mono); font-size: 0.85rem; color: var(--ink); margin-left: 1rem; }
.topbar .user-chip a { color: var(--ink-dim); margin-left: 0.5rem; }

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--magenta);
  padding: 1.25rem 1.5rem;
  max-width: 420px;
  width: calc(100% - 2rem);
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.modal h2 { margin-top: 0; border: 0; font-size: 1.2rem; }
.modal p { color: var(--ink-dim); font-family: var(--font-mono); font-size: 0.9rem; }
.modal .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
.modal .actions > * { flex: 1; min-height: 44px; }

/* Score screen note (custom-config, guest) */
.score-note {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--ink-dim);
  text-align: center;
  margin: 0.5rem 0 1rem;
}

/* Leaderboard */
.leaderboard-table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); }
.leaderboard-table th, .leaderboard-table td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.leaderboard-table th {
  color: var(--ink-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.78rem;
  background: var(--panel-2);
}
.leaderboard-table tr.you { background: rgba(255, 42, 109, 0.08); }
.leaderboard-table tr.you td:first-child { border-left: 2px solid var(--magenta); }
@media (max-width: 480px) {
  .leaderboard-table, .leaderboard-table thead, .leaderboard-table tbody, .leaderboard-table tr, .leaderboard-table td { display: block; }
  .leaderboard-table thead { display: none; }
  .leaderboard-table tr {
    background: var(--panel);
    border: 1px solid var(--border);
    margin-bottom: 0.5rem;
    padding: 0.5rem 0.75rem;
  }
  .leaderboard-table td { display: flex; justify-content: space-between; padding: 0.25rem 0; border: 0; }
  .leaderboard-table td::before { content: attr(data-label); color: var(--muted); margin-right: 1rem; }
}

/* Mobile: keyboard-resize-friendly play layout. */
.play-shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}
.play-shell .prompt {
  margin-top: 2rem;  /* override upstream's 4rem so it stays on-screen with the keyboard up */
}

/* Tap-target floor for all interactive elements */
button, a.secondary, .auth-form input, .leaderboard-table a {
  min-height: 44px;
}
```

- [ ] **Step 3: Verify the file is complete**

Run:

```bash
wc -l C:/Users/stjia/zetachad_mul/client/css/styles.css
```

Expected: at least ~500 lines (upstream ~400 + additions ~150).

- [ ] **Step 4: Commit**

```bash
git add client/css/styles.css
git commit -m "feat(client): carry over upstream styles + mobile-first additions"
```

---

### Task 2.2: API wrapper

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\client\js\api.js`

- [ ] **Step 1: Implement `js/api.js`**

Path: `C:\Users\stjia\zetachad_mul\client\js\api.js`

```js
const API_BASE = '/api';

async function request(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  me:        () => request('GET',  '/me'),
  register:  ({ username, password }) => request('POST', '/register', { username, password }),
  login:     ({ username, password }) => request('POST', '/login',    { username, password }),
  logout:    () => request('POST', '/logout'),
  startPlay: (config) => request('POST', '/play/start',  { config }),
  answer:    (session_id, answer) => request('POST', '/play/answer', { session_id, answer }),
  submit:    (session_id) => request('POST', '/leaderboard/submit', { session_id }),
  board:     () => request('GET',  '/leaderboard')
};
```

- [ ] **Step 2: Commit**

```bash
git add client/js/api.js
git commit -m "feat(client): API wrapper"
```

---

### Task 2.3: Landing page

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\client\index.html`
- Create: `C:\Users\stjia\zetachad_mul\client\js\landing.js`

The landing page shows the locked default config, two big buttons, and a collapsed "advanced" disclosure that reveals the upstream operation/duration cards.

- [ ] **Step 1: Implement `index.html`**

Path: `C:\Users\stjia\zetachad_mul\client\index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>ZetaChad — multiplayer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">ZetaChad</a>
    <nav>
      <a href="leaderboard.html">Leaderboard</a>
      <span id="user-area"></span>
    </nav>
  </header>
  <main id="app" class="narrow">
    <h1>Multiplayer drill</h1>

    <span class="eligibility-badge" id="eligibility">leaderboard-eligible</span>

    <div class="default-summary">
      <strong>Default run:</strong> all four ops · 120 s ·
      add 2–100 · sub 2–100 · mul 2–12×2–100 · div 2–12×2–100.
      Only default runs qualify for the leaderboard.
    </div>

    <div class="landing-buttons">
      <button class="primary" id="start-user">Start as User</button>
      <button class="secondary" id="start-guest">Start as Guest</button>
    </div>

    <details class="advanced-disclosure" id="advanced">
      <summary>Show advanced (custom settings)</summary>
      <div class="settings-grid" id="settings-grid">
        <fieldset class="op-card" data-op="add" style="--i: 0">
          <legend><label><input type="checkbox" name="add_enabled" checked /> <span class="op-sym">+</span> Addition</label></legend>
          <div class="range">
            <label>min <input type="number" name="add_min" min="0" max="9999" value="2" /></label>
            <label>max <input type="number" name="add_max" min="0" max="9999" value="100" /></label>
          </div>
        </fieldset>
        <fieldset class="op-card" data-op="sub" style="--i: 1">
          <legend><label><input type="checkbox" name="sub_enabled" checked /> <span class="op-sym">−</span> Subtraction</label></legend>
          <div class="range">
            <label>min <input type="number" name="sub_min" min="0" max="9999" value="2" /></label>
            <label>max <input type="number" name="sub_max" min="0" max="9999" value="100" /></label>
          </div>
          <p class="hint">Generated to keep results ≥ 0.</p>
        </fieldset>
        <fieldset class="op-card" data-op="mul" style="--i: 2">
          <legend><label><input type="checkbox" name="mul_enabled" checked /> <span class="op-sym">×</span> Multiplication</label></legend>
          <div class="range">
            <label>lhs min <input type="number" name="mul_lhsMin" min="0" max="9999" value="2" /></label>
            <label>lhs max <input type="number" name="mul_lhsMax" min="0" max="9999" value="12" /></label>
          </div>
          <div class="range-pair">
            <div class="range">
              <label>rhs min <input type="number" name="mul_rhsMin" min="0" max="9999" value="2" /></label>
              <label>rhs max <input type="number" name="mul_rhsMax" min="0" max="9999" value="100" /></label>
            </div>
          </div>
        </fieldset>
        <fieldset class="op-card" data-op="div" style="--i: 3">
          <legend><label><input type="checkbox" name="div_enabled" checked /> <span class="op-sym">÷</span> Division</label></legend>
          <div class="range">
            <label>lhs min <input type="number" name="div_lhsMin" min="0" max="9999" value="2" /></label>
            <label>lhs max <input type="number" name="div_lhsMax" min="0" max="9999" value="12" /></label>
          </div>
          <div class="range-pair">
            <div class="range">
              <label>rhs min <input type="number" name="div_rhsMin" min="0" max="9999" value="2" /></label>
              <label>rhs max <input type="number" name="div_rhsMax" min="0" max="9999" value="100" /></label>
            </div>
          </div>
          <p class="hint">Integer answers only.</p>
        </fieldset>
        <fieldset class="op-card duration-card" style="--i: 4">
          <legend><span class="op-sym">⧗</span> Duration</legend>
          <div class="range">
            <label>seconds <input type="number" name="duration" min="5" max="3600" value="120" /></label>
          </div>
          <div class="quick-picks">
            <button type="button" data-secs="30">30 s</button>
            <button type="button" data-secs="60">60 s</button>
            <button type="button" data-secs="120">120 s</button>
            <button type="button" data-secs="300">5 min</button>
          </div>
        </fieldset>
      </div>
    </details>
  </main>
  <script type="module" src="js/landing.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement `js/landing.js`**

Path: `C:\Users\stjia\zetachad_mul\client\js\landing.js`

```js
import { api } from './api.js';

const DEFAULT_CONFIG = {
  ops: {
    add: { enabled: true, min: 2, max: 100 },
    sub: { enabled: true, min: 2, max: 100 },
    mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
    div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
  },
  durationMs: 120_000
};

function readCustomConfig() {
  const v = (name) => Number(document.querySelector(`[name="${name}"]`).value);
  const c = (name) => document.querySelector(`[name="${name}"]`).checked;
  const duration = v('duration');
  return {
    ops: {
      add: { enabled: c('add_enabled'), min: v('add_min'), max: v('add_max') },
      sub: { enabled: c('sub_enabled'), min: v('sub_min'), max: v('sub_max') },
      mul: { enabled: c('mul_enabled'), lhsMin: v('mul_lhsMin'), lhsMax: v('mul_lhsMax'), rhsMin: v('mul_rhsMin'), rhsMax: v('mul_rhsMax') },
      div: { enabled: c('div_enabled'), lhsMin: v('div_lhsMin'), lhsMax: v('div_lhsMax'), rhsMin: v('div_rhsMin'), rhsMax: v('div_rhsMax') }
    },
    durationMs: duration * 1000
  };
}

function renderUserArea(user) {
  const el = document.getElementById('user-area');
  if (user) {
    el.innerHTML = `<span class="user-chip">${user.username} <a href="#" id="logout">log out</a></span>`;
    document.getElementById('logout').addEventListener('click', async (e) => {
      e.preventDefault();
      await api.logout();
      location.reload();
    });
  } else {
    el.innerHTML = `<a href="login.html">Log in</a> <a href="register.html">Register</a>`;
  }
}

function setEligibility(advancedOpen) {
  const badge = document.getElementById('eligibility');
  if (advancedOpen) {
    badge.textContent = 'custom run — not eligible';
    badge.classList.add('dim');
  } else {
    badge.textContent = 'leaderboard-eligible';
    badge.classList.remove('dim');
  }
}

function startGame(mode /* 'user' | 'guest' */) {
  const advancedOpen = document.getElementById('advanced').open;
  const config = advancedOpen ? readCustomConfig() : DEFAULT_CONFIG;
  sessionStorage.setItem('zc_config', JSON.stringify(config));
  sessionStorage.setItem('zc_mode', mode);
  location.href = 'play.html';
}

document.addEventListener('DOMContentLoaded', async () => {
  // Wire quick-pick duration buttons.
  document.querySelectorAll('.duration-card .quick-picks button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector('[name="duration"]').value = b.dataset.secs;
    });
  });

  // Eligibility badge tracks the advanced disclosure state.
  const adv = document.getElementById('advanced');
  adv.addEventListener('toggle', () => setEligibility(adv.open));

  // Buttons.
  document.getElementById('start-guest').addEventListener('click', () => startGame('guest'));
  document.getElementById('start-user').addEventListener('click', async () => {
    let me = null;
    try { me = (await api.me()).user; } catch { /* network */ }
    if (!me) {
      location.href = `login.html?next=${encodeURIComponent('play')}`;
      return;
    }
    startGame('user');
  });

  // Top-right user area.
  try {
    const { user } = await api.me();
    renderUserArea(user);
  } catch {
    renderUserArea(null);
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add client/index.html client/js/landing.js
git commit -m "feat(client): landing page (Start as User / Guest, advanced disclosure)"
```

---

### Task 2.4: Login + register pages

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\client\login.html`
- Create: `C:\Users\stjia\zetachad_mul\client\register.html`
- Create: `C:\Users\stjia\zetachad_mul\client\js\auth.js`

- [ ] **Step 1: Implement `js/auth.js`**

Path: `C:\Users\stjia\zetachad_mul\client\js\auth.js`

```js
import { api } from './api.js';

function nextUrl() {
  const p = new URLSearchParams(location.search);
  const n = p.get('next');
  if (n === 'play') return 'play.html';
  return 'index.html';
}

function showError(el, code) {
  const map = {
    invalid_username: 'Username must be 3–20 characters: letters, digits, underscore, hyphen.',
    invalid_password: 'Password must be at least 8 characters.',
    invalid_credentials: 'Username or password is incorrect.',
    username_taken: 'That username is already taken.',
    bad_request: 'Please fill out both fields.'
  };
  el.textContent = map[code] || 'Something went wrong. Please try again.';
}

export function wireLoginForm() {
  const form = document.getElementById('login-form');
  const err = form.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api.login({
        username: form.elements.username.value.trim(),
        password: form.elements.password.value
      });
      location.href = nextUrl();
    } catch (ex) {
      showError(err, ex.message);
    }
  });
}

export function wireRegisterForm() {
  const form = document.getElementById('register-form');
  const err = form.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api.register({
        username: form.elements.username.value.trim(),
        password: form.elements.password.value
      });
      location.href = nextUrl();
    } catch (ex) {
      showError(err, ex.message);
    }
  });
}
```

- [ ] **Step 2: Implement `login.html`**

Path: `C:\Users\stjia\zetachad_mul\client\login.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Log in — ZetaChad</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">ZetaChad</a>
    <nav>
      <a href="leaderboard.html">Leaderboard</a>
      <a href="register.html">Register</a>
    </nav>
  </header>
  <main id="app" class="narrow">
    <h1>Log in</h1>
    <form id="login-form" class="auth-form" autocomplete="on">
      <label>Username
        <input name="username" type="text" autocomplete="username" autocapitalize="none" required />
      </label>
      <label>Password
        <input name="password" type="password" autocomplete="current-password" required />
      </label>
      <div class="form-error"></div>
      <button class="primary" type="submit">Log in</button>
    </form>
  </main>
  <script type="module">
    import { wireLoginForm } from './js/auth.js';
    document.addEventListener('DOMContentLoaded', wireLoginForm);
  </script>
</body>
</html>
```

- [ ] **Step 3: Implement `register.html`**

Path: `C:\Users\stjia\zetachad_mul\client\register.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Register — ZetaChad</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">ZetaChad</a>
    <nav>
      <a href="leaderboard.html">Leaderboard</a>
      <a href="login.html">Log in</a>
    </nav>
  </header>
  <main id="app" class="narrow">
    <h1>Register</h1>
    <form id="register-form" class="auth-form" autocomplete="on">
      <label>Username
        <input name="username" type="text" autocomplete="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_-]{3,20}" autocapitalize="none" required />
      </label>
      <label>Password
        <input name="password" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <div class="form-error"></div>
      <button class="primary" type="submit">Register</button>
    </form>
  </main>
  <script type="module">
    import { wireRegisterForm } from './js/auth.js';
    document.addEventListener('DOMContentLoaded', wireRegisterForm);
  </script>
</body>
</html>
```

- [ ] **Step 4: Commit**

```bash
git add client/login.html client/register.html client/js/auth.js
git commit -m "feat(client): login + register pages"
```

---

### Task 2.5: Play page (drill UI, server-driven)

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\client\play.html`
- Create: `C:\Users\stjia\zetachad_mul\client\js\play.js`

- [ ] **Step 1: Implement `play.html`**

Path: `C:\Users\stjia\zetachad_mul\client\play.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Drill — ZetaChad</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body class="drilling">
  <div class="time-bar"><div class="time-bar-fill" id="time-bar-fill"></div></div>
  <main id="app" class="play-shell">
    <div class="drill-bar">
      <div class="score">Score <span id="score">0</span></div>
      <div class="timer" id="timer">120</div>
    </div>

    <form id="answer-form" class="prompt" autocomplete="off">
      <span id="prompt-text">— —</span>
      <input id="answer" name="answer" type="text" inputmode="numeric" pattern="[0-9-]*" autocomplete="off" enterkeyhint="go" autofocus />
    </form>

    <section id="score-screen" class="hidden narrow">
      <h1>Time!</h1>
      <div class="big-score" id="final-score">0</div>
      <div id="post-note" class="score-note"></div>
      <div class="actions">
        <button class="primary" id="play-again">Play again</button>
        <a class="secondary" href="leaderboard.html">Leaderboard</a>
        <a class="secondary" href="index.html">Home</a>
      </div>
    </section>

    <div id="modal-root"></div>
  </main>
  <script type="module" src="js/play.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement `js/play.js`**

Path: `C:\Users\stjia\zetachad_mul\client\js\play.js`

```js
import { api } from './api.js';

const els = {
  score: () => document.getElementById('score'),
  timer: () => document.getElementById('timer'),
  bar: () => document.getElementById('time-bar-fill'),
  prompt: () => document.getElementById('prompt-text'),
  form: () => document.getElementById('answer-form'),
  input: () => document.getElementById('answer'),
  scoreScreen: () => document.getElementById('score-screen'),
  finalScore: () => document.getElementById('final-score'),
  postNote: () => document.getElementById('post-note'),
  modalRoot: () => document.getElementById('modal-root'),
  playAgain: () => document.getElementById('play-again')
};

const state = {
  sessionId: null,
  config: null,
  mode: 'guest',  // 'user' | 'guest'
  authedUser: null,
  isDefaultConfig: true,
  timeLimitMs: 0,
  startedAt: 0,
  finished: false,
  finalScore: 0
};

function isDefaultConfig(c) {
  if (!c) return false;
  const D = {
    ops: {
      add: { enabled: true, min: 2, max: 100 },
      sub: { enabled: true, min: 2, max: 100 },
      mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
      div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
    },
    durationMs: 120_000
  };
  return JSON.stringify(c) === JSON.stringify(D);
}

function tickClock() {
  if (state.finished) return;
  const elapsed = performance.now() - state.startedAt;
  const remaining = Math.max(0, state.timeLimitMs - elapsed);
  els.timer().textContent = Math.ceil(remaining / 1000);
  els.bar().style.transform = `scaleX(${remaining / state.timeLimitMs})`;
  if (remaining <= 10_000) els.timer().classList.add('low');
  if (remaining > 0) requestAnimationFrame(tickClock);
}

async function start() {
  const cfg = JSON.parse(sessionStorage.getItem('zc_config') || 'null');
  state.config = cfg;
  state.mode = sessionStorage.getItem('zc_mode') || 'guest';
  state.isDefaultConfig = isDefaultConfig(cfg);

  if (!cfg) { location.href = 'index.html'; return; }

  try { state.authedUser = (await api.me()).user; } catch { state.authedUser = null; }

  let r;
  try { r = await api.startPlay(cfg); }
  catch (e) { alert('Could not start: ' + e.message); location.href = 'index.html'; return; }

  state.sessionId = r.session_id;
  state.timeLimitMs = r.time_limit_ms;
  state.startedAt = performance.now();
  els.prompt().textContent = r.question.prompt;
  els.timer().textContent = Math.ceil(r.time_limit_ms / 1000);
  requestAnimationFrame(tickClock);
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.finished) return;
  const value = els.input().value;
  els.input().value = '';
  let r;
  try { r = await api.answer(state.sessionId, value); }
  catch (ex) {
    if (ex.status === 404) { alert('Server hiccuped — please start a new run.'); location.href = 'index.html'; return; }
    return;
  }
  if (r.time_up) return finish(r.final_score);
  els.score().textContent = r.score;
  els.prompt().textContent = r.next_question.prompt;
  if (r.correct) {
    els.input().classList.add('correct');
    setTimeout(() => els.input().classList.remove('correct'), 220);
  }
}

function finish(finalScore) {
  state.finished = true;
  state.finalScore = finalScore;
  els.finalScore().textContent = finalScore;
  // Hide drill UI, show score screen.
  document.body.classList.remove('drilling');
  els.form().classList.add('hidden');
  document.querySelector('.drill-bar').classList.add('hidden');
  document.querySelector('.time-bar').classList.add('hidden');
  els.scoreScreen().classList.remove('hidden');

  if (state.authedUser && state.isDefaultConfig) {
    showSubmitModal();
  } else if (!state.authedUser) {
    els.postNote().textContent = 'Log in to submit scores to the leaderboard.';
  } else {
    els.postNote().textContent = 'Custom runs aren\'t eligible for the leaderboard.';
  }

  els.playAgain().addEventListener('click', () => { location.href = 'index.html'; });
}

function showSubmitModal() {
  const root = els.modalRoot();
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-bd">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">Submit score?</h2>
        <p>Submit ${state.finalScore} to the leaderboard? Your username and score will appear publicly.</p>
        <div class="actions">
          <button class="secondary" id="modal-no">No thanks</button>
          <button class="primary" id="modal-yes">Submit</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  document.getElementById('modal-no').addEventListener('click', close);
  document.getElementById('modal-yes').addEventListener('click', async () => {
    try {
      const r = await api.submit(state.sessionId);
      els.postNote().textContent = `Submitted! You are #${r.rank}.`;
    } catch (ex) {
      if (ex.status === 401) {
        // Cookie expired between play and submit. Stash for one retry.
        localStorage.setItem('zc_pending_submit', state.sessionId);
        els.postNote().textContent = 'You got logged out — log back in to submit.';
      } else if (ex.status === 422) {
        els.postNote().textContent = 'This run is not eligible for the leaderboard.';
      } else {
        els.postNote().textContent = 'Submit failed: ' + ex.message;
      }
    }
    close();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  els.form().addEventListener('submit', onSubmit);
  start();
});
```

- [ ] **Step 3: Commit**

```bash
git add client/play.html client/js/play.js
git commit -m "feat(client): play page (server-driven drill + submit modal)"
```

---

### Task 2.6: Leaderboard page

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\client\leaderboard.html`
- Create: `C:\Users\stjia\zetachad_mul\client\js\leaderboard.js`

- [ ] **Step 1: Implement `leaderboard.html`**

Path: `C:\Users\stjia\zetachad_mul\client\leaderboard.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Leaderboard — ZetaChad</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">ZetaChad</a>
    <nav>
      <a href="index.html">Drill</a>
      <span id="user-area"></span>
    </nav>
  </header>
  <main id="app" class="narrow">
    <h1>Leaderboard</h1>
    <div class="default-summary">
      Default config: all four ops · 120 s · add 2–100 · sub 2–100 · mul 2–12×2–100 · div 2–12×2–100.
    </div>
    <table class="leaderboard-table">
      <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Played</th></tr></thead>
      <tbody id="rows"><tr><td colspan="4">Loading…</td></tr></tbody>
    </table>
  </main>
  <script type="module" src="js/leaderboard.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement `js/leaderboard.js`**

Path: `C:\Users\stjia\zetachad_mul\client\js\leaderboard.js`

```js
import { api } from './api.js';

function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function rowsHtml(entries, me) {
  if (entries.length === 0) {
    return `<tr><td colspan="4">No scores yet — be the first.</td></tr>`;
  }
  return entries.map((e) => {
    const youClass = me && e.username === me.username ? ' class="you"' : '';
    return `<tr${youClass}>
      <td data-label="#">${e.rank}</td>
      <td data-label="Player">${escapeHtml(e.username)}</td>
      <td data-label="Score">${e.score}</td>
      <td data-label="Played">${fmtDate(e.played_at)}</td>
    </tr>`;
  }).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderUserArea(user) {
  const el = document.getElementById('user-area');
  if (user) {
    el.innerHTML = `<span class="user-chip">${escapeHtml(user.username)} <a href="#" id="logout">log out</a></span>`;
    document.getElementById('logout').addEventListener('click', async (e) => {
      e.preventDefault();
      await api.logout();
      location.reload();
    });
  } else {
    el.innerHTML = `<a href="login.html">Log in</a> <a href="register.html">Register</a>`;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  let me = null;
  try { me = (await api.me()).user; } catch {}
  renderUserArea(me);

  try {
    const { entries } = await api.board();
    document.getElementById('rows').innerHTML = rowsHtml(entries, me);
  } catch (e) {
    document.getElementById('rows').innerHTML = `<tr><td colspan="4">Could not load: ${escapeHtml(e.message)}</td></tr>`;
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add client/leaderboard.html client/js/leaderboard.js
git commit -m "feat(client): leaderboard page"
```

---

### Task 2.7: Local smoke test of the client

- [ ] **Step 1: Start the server in dev mode**

In one terminal, from `C:\Users\stjia\zetachad_mul\server`:

```bash
# create .env from example, fill in DATABASE_URL + COOKIE_SECRET (any 64+ char string for dev)
cp .env.example .env
# edit .env so COOKIE_SECRET is a random 64-char string and COOKIE_SECURE=false for HTTP localhost
# DATABASE_URL must point at a local Postgres if you have one — otherwise skip this step

# then:
node --env-file=.env src/index.js
```

Expected: server logs "server listening on 127.0.0.1:3000". If you don't have a local Postgres, you can skip this step and validate the full flow on the VPS later — the client is plain static files and the server unit tests already cover the logic.

- [ ] **Step 2: Serve the client locally**

In a second terminal, from `C:\Users\stjia\zetachad_mul\client`:

```bash
python -m http.server 8000
```

Or use any static file server. Python's stdlib server is fine.

- [ ] **Step 3: Wire client → server for local testing**

By default the client calls `/api/...` which assumes nginx is proxying. For local dev with separate ports, the simplest fix is: add a temporary `<script>API_BASE='http://localhost:3000/api'</script>` shim, OR add a `dev` reverse proxy. The cleanest approach: skip local browser smoke and rely on the VPS for end-to-end. **Document this and move on.** Add to `README.md`:

```markdown
## Local development

Local end-to-end testing requires nginx (or a similar proxy) to route /api → server.
For practical purposes, develop the server (with unit + integration tests) and the client
(visually) separately, and validate the integrated flow on the VPS staging.
```

- [ ] **Step 4: Commit the README update**

```bash
git add README.md
git commit -m "docs: note local dev approach"
```

---

# Phase 3: Deployment

This phase produces the configs and scripts. Actually running them on the VPS is in Phase 4.

### Task 3.1: nginx site config

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\deploy\nginx.conf`

- [ ] **Step 1: Implement `deploy/nginx.conf`**

Path: `C:\Users\stjia\zetachad_mul\deploy\nginx.conf`

```nginx
# /etc/nginx/sites-available/zetachad
# After certbot --nginx -d <subdomain>.duckdns.org, this file will be edited
# in place to add the SSL bits. Keep this template as the pre-cert baseline.

server {
    listen 80;
    listen [::]:80;
    server_name _;  # replaced with the actual DuckDNS subdomain by the deploy README

    root /var/www/zetachad/client;
    index index.html;

    # Static assets: HTML/CSS/JS
    location / {
        try_files $uri $uri/ =404;
        add_header Cache-Control "no-cache";
    }

    # Long-cache for fonts (Google CDN handles this; nothing local to cache)

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # Tighten common static gzip
    gzip on;
    gzip_types text/css application/javascript text/html application/json image/svg+xml;
    gzip_min_length 1024;
}
```

- [ ] **Step 2: Commit**

```bash
git add deploy/nginx.conf
git commit -m "feat(deploy): nginx site config template"
```

---

### Task 3.2: systemd unit

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\deploy\zetachad.service`

- [ ] **Step 1: Implement `deploy/zetachad.service`**

Path: `C:\Users\stjia\zetachad_mul\deploy\zetachad.service`

```ini
[Unit]
Description=zetachad_mul Fastify server
Wants=network-online.target postgresql.service
After=network-online.target postgresql.service

[Service]
Type=simple
User=zetachad
Group=zetachad
WorkingDirectory=/srv/zetachad/server
EnvironmentFile=/etc/zetachad/env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=2s
LimitNOFILE=65536

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/srv/zetachad/server
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add deploy/zetachad.service
git commit -m "feat(deploy): systemd unit"
```

---

### Task 3.3: Deploy + backup scripts

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\deploy\deploy.sh`
- Create: `C:\Users\stjia\zetachad_mul\deploy\backup.sh`

- [ ] **Step 1: Implement `deploy/deploy.sh`**

Path: `C:\Users\stjia\zetachad_mul\deploy\deploy.sh`

```bash
#!/usr/bin/env bash
# Usage:
#   VPS_HOST=root@87.99.158.208 ./deploy/deploy.sh
#
# What it does:
#   1. rsyncs server/ and client/ to /srv/zetachad/ on the VPS
#   2. installs server prod deps
#   3. runs migrations
#   4. restarts the systemd unit
#
# Requires: ssh access, the zetachad user on the VPS, /etc/zetachad/env in place.

set -euo pipefail

: "${VPS_HOST:?Set VPS_HOST, e.g. root@87.99.158.208}"
REMOTE_DIR=${REMOTE_DIR:-/srv/zetachad}

echo "==> Syncing server/ to $VPS_HOST:$REMOTE_DIR/server/"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude test \
  ./server/ "$VPS_HOST:$REMOTE_DIR/server/"

echo "==> Syncing client/ to $VPS_HOST:/var/www/zetachad/client/"
rsync -az --delete \
  ./client/ "$VPS_HOST:/var/www/zetachad/client/"

echo "==> Installing prod deps + migrating + restarting"
ssh "$VPS_HOST" "set -euo pipefail
  cd $REMOTE_DIR/server
  sudo -u zetachad npm ci --omit=dev
  sudo -u zetachad node --env-file=/etc/zetachad/env src/db.js
  sudo systemctl restart zetachad
  sudo systemctl status zetachad --no-pager | head -n 20
"
echo "==> Done"
```

- [ ] **Step 2: Implement `deploy/backup.sh`**

Path: `C:\Users\stjia\zetachad_mul\deploy\backup.sh`

```bash
#!/usr/bin/env bash
# Run via cron on the VPS:  0 3 * * * /srv/zetachad/deploy/backup.sh
# Keeps 7 nightly dumps in /var/backups/zetachad/

set -euo pipefail

DEST=/var/backups/zetachad
mkdir -p "$DEST"

STAMP=$(date +%Y%m%d_%H%M%S)
OUT="$DEST/zetachad_$STAMP.sql.gz"

# Read DATABASE_URL from /etc/zetachad/env (the same file systemd uses)
set -a; source /etc/zetachad/env; set +a

pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$OUT"

# Retain the most recent 7 dumps; delete older ones.
ls -1t "$DEST"/zetachad_*.sql.gz | tail -n +8 | xargs -r rm -f

echo "$(date) ok $OUT" >> "$DEST/backup.log"
```

- [ ] **Step 3: Mark scripts executable in git**

```bash
git update-index --chmod=+x deploy/deploy.sh deploy/backup.sh 2>/dev/null || true
chmod +x deploy/deploy.sh deploy/backup.sh 2>/dev/null || true
git add deploy/deploy.sh deploy/backup.sh
git commit -m "feat(deploy): rsync deploy + nightly pg_dump scripts"
```

---

### Task 3.4: Deploy README (the runbook)

**Files:**
- Create: `C:\Users\stjia\zetachad_mul\deploy\README.md`

- [ ] **Step 1: Write the runbook**

Path: `C:\Users\stjia\zetachad_mul\deploy\README.md`

```markdown
# zetachad_mul — VPS bootstrap runbook

Target: Ubuntu 24.04 at `87.99.158.208`. Run each numbered section once, in order.

## 1. DuckDNS subdomain

1. Sign in / register at https://www.duckdns.org/
2. Create a subdomain (e.g. `zetachad-mul.duckdns.org`)
3. Set its IP to `87.99.158.208`
4. Note the token DuckDNS gives you (you'll set up auto-renewal of the IP later if you want)

For this runbook, replace `SUBDOMAIN.duckdns.org` with your actual subdomain.

## 2. Server packages

```bash
ssh root@87.99.158.208
apt update && apt -y upgrade
apt -y install curl ca-certificates gnupg ufw nginx postgresql postgresql-contrib certbot python3-certbot-nginx rsync

# Node 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs

# Firewall: SSH + HTTP + HTTPS
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 3. Database

```bash
sudo -u postgres psql <<SQL
CREATE ROLE zetachad WITH LOGIN PASSWORD 'CHOOSE_A_STRONG_PASSWORD';
CREATE DATABASE zetachad OWNER zetachad;
SQL
```

## 4. Service user + paths

```bash
useradd --system --create-home --home-dir /srv/zetachad --shell /bin/bash zetachad
mkdir -p /srv/zetachad/server /var/www/zetachad/client /etc/zetachad
chown -R zetachad:zetachad /srv/zetachad
chown -R www-data:www-data /var/www/zetachad
```

## 5. Environment file

Generate a long random cookie secret:

```bash
COOKIE_SECRET=$(openssl rand -base64 48)
cat > /etc/zetachad/env <<EOF
DATABASE_URL=postgres://zetachad:CHOOSE_A_STRONG_PASSWORD@127.0.0.1:5432/zetachad
PORT=3000
HOST=127.0.0.1
COOKIE_SECRET=$COOKIE_SECRET
COOKIE_SECURE=true
NODE_ENV=production
LOG_LEVEL=info
EOF
chmod 600 /etc/zetachad/env
chown root:zetachad /etc/zetachad/env
```

## 6. nginx site

Copy the template, then edit `server_name`:

```bash
cp /srv/zetachad/server/../deploy/nginx.conf /etc/nginx/sites-available/zetachad
# (you will copy this file in step 8 when first deploying — for now, skip if not yet present)
ln -sf /etc/nginx/sites-available/zetachad /etc/nginx/sites-enabled/zetachad
sed -i 's/server_name _;/server_name SUBDOMAIN.duckdns.org;/' /etc/nginx/sites-available/zetachad
nginx -t && systemctl reload nginx
```

## 7. systemd unit

After first deploy (step 8) the service file is on the VPS. Install it:

```bash
cp /srv/zetachad/deploy/zetachad.service /etc/systemd/system/zetachad.service
systemctl daemon-reload
systemctl enable zetachad
```

## 8. First deploy from your laptop

Back on your dev machine:

```bash
cd /c/Users/stjia/zetachad_mul
VPS_HOST=root@87.99.158.208 ./deploy/deploy.sh
```

After the first deploy succeeds, ssh in and start the service:

```bash
ssh root@87.99.158.208 'systemctl start zetachad && systemctl status zetachad --no-pager'
```

Hit `http://SUBDOMAIN.duckdns.org/api/health` from a browser. Expected: `{"ok":true}`.

## 9. TLS via Let's Encrypt

```bash
ssh root@87.99.158.208 'certbot --nginx -d SUBDOMAIN.duckdns.org --non-interactive --agree-tos -m you@example.com'
```

Certbot will edit the nginx site to add SSL. Verify `https://SUBDOMAIN.duckdns.org/api/health` works. The cert auto-renews via the certbot timer.

## 10. Backups

```bash
ssh root@87.99.158.208 'crontab -l 2>/dev/null | { cat; echo "0 3 * * * /srv/zetachad/deploy/backup.sh"; } | crontab -'
```

## 11. Smoke test

From the laptop:

```bash
curl -i https://SUBDOMAIN.duckdns.org/api/health
curl -i https://SUBDOMAIN.duckdns.org/    # should serve index.html
```

Then from a browser, register an account, play a default-config run, submit, see yourself on the leaderboard.

## Operational notes

- Logs: `journalctl -u zetachad -f`
- Reset a forgotten password (admin path):
  ```sql
  -- ssh in, then
  sudo -u postgres psql zetachad -c "UPDATE users SET password_hash = '...' WHERE username = '...';"
  ```
  (Generate a bcrypt hash with `node -e "import('bcrypt').then(b=>b.default.hash('newpass', 10).then(console.log))"`.)
- DB shell: `sudo -u postgres psql zetachad`
- Nightly backup status: `tail /var/backups/zetachad/backup.log`
```

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): VPS bootstrap runbook"
```

---

# Phase 4: VPS bring-up & end-to-end validation

This phase is interactive — the engineer must pause to do things by hand on the VPS. Confirm with the user before running any of these.

### Task 4.1: Bring up the VPS

- [ ] **Step 1: Confirm with the user before starting**

Ask: "Ready to bootstrap the VPS at 87.99.158.208? This will install packages, create users, and apply the runbook in `deploy/README.md`. Confirm before proceeding."

If yes, work through `deploy/README.md` sections 1–11 in order. Each section's commands are copy-paste-ready.

- [ ] **Step 2: Verify health**

```bash
curl -i https://SUBDOMAIN.duckdns.org/api/health
```

Expected: `200 {"ok":true}`. If anything fails, check `journalctl -u zetachad -f` and `tail -f /var/log/nginx/error.log`.

### Task 4.2: End-to-end smoke test (manual)

- [ ] **Step 1: From a desktop browser**

1. Visit `https://SUBDOMAIN.duckdns.org/` — landing page renders.
2. Click **Register**. Create a user. Get redirected back, see your username top-right.
3. Click **Start as User**. Drill begins. Answer some questions. Wait for time_up (or refresh after 120s).
4. Score modal appears. Click **Submit**. See the rank result.
5. Visit **Leaderboard**. See your row highlighted.
6. **Log out** from top-right. Visit Leaderboard again — your row no longer highlighted, but still present.
7. Click **Start as Guest**. Play. See the "Log in to submit" note (no modal).
8. Open **Show advanced** on landing. Eligibility badge dims. **Start as User** → play → no modal, "Custom runs aren't eligible" note.

- [ ] **Step 2: From a phone (iOS Safari + Android Chrome)**

Repeat 1–7 above. Specifically check:
- Number pad pops up on the answer input.
- Soft keyboard's Go/Done key submits the answer.
- The question/input stays on screen with the keyboard up (no jumping).
- Buttons are easy to thumb-tap.
- Both portrait and landscape work.
- Leaderboard table renders as a card list on narrow screens.

- [ ] **Step 3: Document anything that's broken**

Open follow-up issues for any mobile-layout regressions before closing the plan.

### Task 4.3: Final commit + push

- [ ] **Step 1: Confirm the GitHub remote**

Ask the user: "Where do you want to host the private repo? Once you have a GitHub remote URL, I'll add it and push. Until then, the project is committed locally."

If the user provides a URL:

```bash
git remote add origin <user-supplied URL>
git push -u origin main
```

- [ ] **Step 2: Done**

The project is live at `https://SUBDOMAIN.duckdns.org/`. The repo is at `<remote URL>`. The README links to the spec, plan, and deploy runbook.

---

## Self-review

**1. Spec coverage:**

- [x] Goals 1–7 (registration, leaderboard, guest play, default-config gating, server-authoritative, "Start as User/Guest" landing, mobile) — covered across Phases 1–2.
- [x] Non-goals respected (no password reset, no history, no friend lists, no PWA, no admin UI, no analytics).
- [x] Architecture (monorepo, nginx + Fastify + Postgres, server-authoritative game) — Phases 1 + 3.
- [x] Three play modes (logged-in default, logged-in custom, guest) — Tasks 2.3, 2.5.
- [x] Server file layout matches spec — Tasks 1.1–1.10.
- [x] Client file layout matches spec, with removals from upstream — Tasks 2.1–2.6.
- [x] Data model (users, auth_sessions, runs) verbatim — Task 1.2.
- [x] API contract (8 endpoints) — Task 1.8.
- [x] Auth-session cookies (HttpOnly, Secure, SameSite=Lax, 30-day rolling) — Task 1.7.
- [x] Rate limits (5/min register-login, 120/min answer) — Tasks 1.8, 1.9.
- [x] Idempotency on submit — Task 1.8 board route, Task 1.10 leaderboard test.
- [x] Locked default config — Task 1.3, Task 2.3.
- [x] User flows (landing, register/login, play, score modal, leaderboard) — Tasks 2.3–2.6.
- [x] Mobile usability (numeric inputmode, dvh, interactive-widget, ≥44px taps, mobile-first stylesheet) — Tasks 2.1, 2.5.
- [x] Game logic (generator, grader, session) — Tasks 1.4–1.6.
- [x] Error/edge cases (auth-expired-mid-game, server-restart-mid-game, double-submit, dup username, invalid answer, unknown session, non-default submit) — Tasks 1.7, 1.8, 1.10, 2.5.
- [x] Testing strategy (unit + integration on server, manual on client) — Tasks 1.3–1.6, 1.10, 4.2.
- [x] Deployment (Node 22, Postgres 16, nginx, certbot, systemd, DuckDNS) — Phase 3 + 4.
- [x] Deploy loop (rsync deploy.sh) — Task 3.3.
- [x] Backups (nightly pg_dump, 7-day retention) — Task 3.3.
- [x] Secrets via /etc/zetachad/env — Task 3.4.

No gaps found.

**2. Placeholder scan:** None remain. All TBDs replaced; all "see Task N" references include the code inline.

**3. Type consistency check:**
- Server uses `sessionId` in code, API uses `session_id` snake-case — translation happens in `routes/`. Consistent across `routes/`, `session.js`, and integration tests.
- `qualifies` returned by `session.finish()` matches its consumer in `board.routes.js`.
- Client `state.config` shape matches what `landing.js` builds and what `play.js` checks via `isDefaultConfig()`.
- DB column `played_at` consistently referenced in `runs` and the leaderboard query.

No mismatches found.

---

**Plan complete and saved to `C:\Users\stjia\zetachad_mul\docs\superpowers\plans\2026-04-26-zetachad_mul.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
