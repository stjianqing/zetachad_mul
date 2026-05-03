import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

async function registerAndLogin(app, username = 'practiceuser', password = 'password123') {
  const reg = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username, password }
  });
  assert.equal(reg.statusCode, 200, `register failed: ${reg.payload}`);
  const cookie = cookieFromResponse(reg);
  assert.ok(cookie, 'no cookie on register');
  return { cookie, username };
}

async function seedAttempts(pool, userId, attempts) {
  const { rows } = await pool.query(
    'INSERT INTO runs (user_id, score, duration_ms) VALUES ($1, $2, $3) RETURNING id',
    [userId, attempts.length, 120000]
  );
  const runId = rows[0].id;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    await pool.query(
      `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [runId, i, a.op, a.lhs, a.rhs, a.answer ?? 0, String(a.answer ?? 0), a.responseMs, a.correct ?? true]
    );
  }
}

test('GET /api/practice/diagnose: 401 when unauthenticated', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/practice/diagnose' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/practice/diagnose: need_more_data for fresh user', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const { cookie } = await registerAndLogin(app);
  const res = await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.totalAttemptsAnalyzed, 0);
  assert.deepEqual(body.topWeak, []);
  assert.equal(body.reason, 'need_more_data');
});

test('GET /api/practice/diagnose: returns top-3 for user with seeded slow attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());
  const { cookie } = await registerAndLogin(app);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  const attempts = [];
  for (let i = 0; i < 30; i++) attempts.push({ op: 'mul', lhs: 12, rhs: 75, responseMs: 8000 });
  for (let i = 0; i < 30; i++) attempts.push({ op: 'add', lhs: 5, rhs: 5, responseMs: 1000 });
  await seedAttempts(pool, userId, attempts);

  const res = await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.totalAttemptsAnalyzed, 60);
  assert.ok(body.topWeak.length >= 1);
  assert.equal(body.topWeak[0].id, 'mul_hard_large');
  assert.equal(body.topWeak[0].n, 30);
  assert.equal(body.topWeak[0].avgMs, 8000);
  assert.equal(body.topWeak[0].label, 'Multiplying 7, 8, 9 or 12 by numbers above 30');
});

test('POST /api/practice/start: 422 when need_more_data', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const { cookie } = await registerAndLogin(app);
  const res = await app.inject({ method: 'POST', url: '/api/practice/start', headers: { cookie } });
  assert.equal(res.statusCode, 422);
  const body = JSON.parse(res.payload);
  assert.equal(body.reason, 'need_more_data');
});

test('POST /api/practice/start: returns session + clusters when eligible', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());
  const { cookie } = await registerAndLogin(app);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  const attempts = [];
  for (let i = 0; i < 30; i++) attempts.push({ op: 'mul', lhs: 12, rhs: 75, responseMs: 8000 });
  for (let i = 0; i < 30; i++) attempts.push({ op: 'add', lhs: 80, rhs: 80, responseMs: 5000 });
  await seedAttempts(pool, userId, attempts);

  const res = await app.inject({ method: 'POST', url: '/api/practice/start', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.session_id === 'string');
  assert.equal(body.practice, true);
  assert.ok(Array.isArray(body.clusters));
  assert.ok(body.clusters.includes('mul_hard_large'));
  assert.equal(body.time_limit_ms, DEFAULT_CONFIG.durationMs);
  assert.ok(body.question);
  assert.ok(body.peek_question);
});

test('practice end-to-end: start → answer → time-up → submit → run.practice=true and not on leaderboard', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());
  const { cookie } = await registerAndLogin(app);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  const attempts = Array.from({ length: 60 }, () => ({ op: 'mul', lhs: 12, rhs: 75, responseMs: 8000 }));
  await seedAttempts(pool, userId, attempts);

  const startRes = await app.inject({ method: 'POST', url: '/api/practice/start', headers: { cookie } });
  assert.equal(startRes.statusCode, 200);
  const start = JSON.parse(startRes.payload);
  const sessionId = start.session_id;

  // Answer one question correctly.
  const ans1 = await app.inject({
    method: 'POST', url: '/api/play/answer', headers: { cookie },
    payload: { session_id: sessionId, answer: String(start.question.answer) }
  });
  assert.equal(ans1.statusCode, 200);

  // Force time-up by rewinding the session's startedAt.
  const session = sessionStore.get(sessionId);
  session.startedAt = Date.now() - session.durationMs - 1;
  // Trigger the flush via one more answer call.
  const flushRes = await app.inject({
    method: 'POST', url: '/api/play/answer', headers: { cookie },
    payload: { session_id: sessionId, answer: '' }
  });
  assert.equal(flushRes.statusCode, 200);
  assert.equal(JSON.parse(flushRes.payload).time_up, true);

  // Submit the practice run.
  const subRes = await app.inject({
    method: 'POST', url: '/api/leaderboard/submit', headers: { cookie },
    payload: { session_id: sessionId }
  });
  assert.equal(subRes.statusCode, 200);
  const sub = JSON.parse(subRes.payload);
  assert.equal(sub.practice, true);
  assert.equal(sub.ok, true);

  // Verify a runs row was inserted with practice=true.
  const runRows = (await pool.query(
    'SELECT practice, submitted_to_leaderboard FROM runs WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [userId]
  )).rows;
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0].practice, true);
  assert.equal(runRows[0].submitted_to_leaderboard, false);

  // Verify the practice user does NOT appear on the leaderboard.
  const lbRes = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  const lb = JSON.parse(lbRes.payload);
  const found = lb.entries.find((e) => e.username === 'practiceuser');
  assert.equal(found, undefined, 'practice user should not appear on leaderboard');
});

test('practice attempts feed back into next diagnose call', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());
  const { cookie } = await registerAndLogin(app);
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['practiceuser']);
  const userId = rows[0].id;
  const seed = Array.from({ length: 60 }, () => ({ op: 'add', lhs: 80, rhs: 80, responseMs: 6000 }));
  await seedAttempts(pool, userId, seed);

  const r1 = JSON.parse((await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } })).payload);
  assert.equal(r1.totalAttemptsAnalyzed, 60);

  // Simulate practice attempts feeding back by inserting more.
  const more = Array.from({ length: 20 }, () => ({ op: 'mul', lhs: 12, rhs: 90, responseMs: 9000 }));
  await seedAttempts(pool, userId, more);

  const r2 = JSON.parse((await app.inject({ method: 'GET', url: '/api/practice/diagnose', headers: { cookie } })).payload);
  assert.equal(r2.totalAttemptsAnalyzed, 80);
  assert.equal(r2.topWeak[0].id, 'mul_hard_large');
});
