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
