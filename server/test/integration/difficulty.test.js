import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { computeRunDifficulty } from '../../src/run-difficulty/compute.js';

async function registerAndLogin(app, username = 'difftester', password = 'password123') {
  const reg = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username, password }
  });
  assert.equal(reg.statusCode, 200, `register failed: ${reg.payload}`);
  const cookie = cookieFromResponse(reg);
  return { cookie, username };
}

test('run insert: difficulty column populated when medianCache has data', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore, medianCache } = await freshApp();
  t.after(() => app.close());

  // Seed cluster_medians directly so the cache has a known fixed value to use.
  await pool.query(
    `INSERT INTO cluster_medians (cluster_id, median_ms, n) VALUES ('add_small', 2000, 100)`
  );
  // Reload the cache from the table.
  const { rows } = await pool.query(`SELECT cluster_id, median_ms, n FROM cluster_medians`);
  medianCache.loadFromRows(rows);

  const { cookie } = await registerAndLogin(app);

  // Start a default-config run.
  const startRes = await app.inject({
    method: 'POST', url: '/api/play/start', headers: { cookie },
    payload: { config: {
      ops: {
        add: { enabled: true, min: 2, max: 100 },
        sub: { enabled: true, min: 2, max: 100 },
        mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 },
        div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }
      },
      durationMs: 120000
    } }
  });
  assert.equal(startRes.statusCode, 200);
  const start = JSON.parse(startRes.payload);
  const sessionId = start.session_id;

  // Answer one question correctly.
  const ans1 = await app.inject({
    method: 'POST', url: '/api/play/answer', headers: { cookie },
    payload: { session_id: sessionId, answer: String(start.question.answer) }
  });
  assert.equal(ans1.statusCode, 200);

  // Force time-up and trigger the flush.
  const sess = sessionStore.get(sessionId);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  const flushRes = await app.inject({
    method: 'POST', url: '/api/play/answer', headers: { cookie },
    payload: { session_id: sessionId, answer: '' }
  });
  assert.equal(flushRes.statusCode, 200);
  assert.equal(JSON.parse(flushRes.payload).time_up, true);

  // Verify the runs row has a non-null difficulty.
  const { rows: runRows } = await pool.query(
    `SELECT difficulty FROM runs ORDER BY id DESC LIMIT 1`
  );
  assert.equal(runRows.length, 1);
  assert.notEqual(runRows[0].difficulty, null);

  // Verify it equals what computeRunDifficulty produces for the stored attempts.
  const { rows: attempts } = await pool.query(
    `SELECT op, lhs, rhs, response_ms, correct FROM attempts WHERE run_id = (SELECT MAX(id) FROM runs)`
  );
  const expected = computeRunDifficulty(attempts, medianCache);
  assert.equal(Number(runRows[0].difficulty), expected);
});

test('GET /api/leaderboard: returns difficulty per entry', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, medianCache } = await freshApp();
  t.after(() => app.close());

  await pool.query(`INSERT INTO cluster_medians (cluster_id, median_ms, n) VALUES ('add_small', 2000, 100)`);
  medianCache.loadFromRows((await pool.query(`SELECT cluster_id, median_ms, n FROM cluster_medians`)).rows);

  // Seed a user + a submitted run with a known difficulty.
  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('alice', 'x')`);
  await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, submitted_to_leaderboard, difficulty)
     VALUES ((SELECT id FROM users WHERE username='alice'), 42, 120000, true, 5.55)`
  );

  const lbRes = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  const lb = JSON.parse(lbRes.payload);
  const alice = lb.entries.find(e => e.username === 'alice');
  assert.ok(alice);
  assert.equal(alice.difficulty, 5.55);
});

test('MedianCache.refresh: roundtrip with seeded attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, medianCache } = await freshApp();
  t.after(() => app.close());

  // Seed: a non-practice user + run with 5 attempts in add_small at 2000ms each.
  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('bob', 'x')`);
  const { rows: rRow } = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice) VALUES
     ((SELECT id FROM users WHERE username='bob'), 5, 120000, false) RETURNING id`
  );
  const runId = rRow[0].id;
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
       VALUES ($1, $2, 'add', 5, 5, 10, '10', $3, true, now())`,
      [runId, i, 2000]
    );
  }
  // A practice run that should be excluded.
  const { rows: pRow } = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice) VALUES
     ((SELECT id FROM users WHERE username='bob'), 5, 120000, true) RETURNING id`
  );
  await pool.query(
    `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
     VALUES ($1, 0, 'add', 5, 5, 10, '10', 99999, true, now())`,
    [pRow[0].id]
  );
  // A wrong attempt that should be excluded.
  await pool.query(
    `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
     VALUES ($1, 5, 'add', 5, 5, 10, '11', 99999, false, now())`,
    [runId]
  );

  await medianCache.refresh();
  assert.equal(medianCache.get('add_small'), 2000);
});
