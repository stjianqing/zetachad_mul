import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

async function registerAndCookie(app, username) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username, password: 'password123' }
  });
  return { cookie: cookieFromResponse(r), userId: r.json().user.id };
}

async function playAndFinishStandardRun(app, cookie, sessionStore) {
  const startRes = await app.inject({
    method: 'POST',
    url: '/api/play/start',
    payload: { config: DEFAULT_CONFIG },
    headers: { cookie }
  });
  const { session_id } = startRes.json();
  const sess = sessionStore.get(session_id);
  await app.inject({
    method: 'POST',
    url: '/api/play/answer',
    payload: { session_id, answer: String(sess.currentQuestion.answer) },
    headers: { cookie }
  });
  sess.startedAt = sess.startedAt - sess.durationMs - 1000;
  const last = await app.inject({
    method: 'POST',
    url: '/api/play/answer',
    payload: { session_id, answer: '0' },
    headers: { cookie }
  });
  return { session_id, last: last.json() };
}

async function getLatestRunId(pool, userId) {
  const r = await pool.query('SELECT id FROM runs WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId]);
  return Number(r.rows[0].id);
}

test('create challenge by username — happy path', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const challengerRunId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: challengerRunId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(body.id);
  assert.equal(body.status, 'pending');
});

test('create challenge by share link — returns share_url', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const challengerRunId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: challengerRunId, share_link: true },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(body.share_url);
  assert.match(body.share_url, /\/challenge\//);
});

test('create challenge: self-challenge blocked (400)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'alice' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
});

test('create challenge: unknown recipient (404)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'ghost' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 404);
});

test('create challenge: not the run owner (400)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const aliceRunId = await getLatestRunId(pool, alice.userId);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: aliceRunId, recipient_username: 'alice' },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 400);
});

test('create challenge: legacy run (no seed) blocked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  const ins = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice) VALUES ($1, 10, 120000, false) RETURNING id`,
    [alice.userId]
  );
  const runId = Number(ins.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'ineligible_run');
});

test('create challenge: practice run blocked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  const ins = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed) VALUES ($1, 10, 120000, true, 42) RETURNING id`,
    [alice.userId]
  );
  const runId = Number(ins.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
});

test('create challenge: daily-gauntlet run blocked', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'derpy');
  const ins = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed, daily_gauntlet_date, submitted_to_leaderboard)
     VALUES ($1, 60, 240000, false, 20260504, '2026-05-04', true) RETURNING id`,
    [alice.userId]
  );
  const runId = Number(ins.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'derpy' },
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 400);
});
