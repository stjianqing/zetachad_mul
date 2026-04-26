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
