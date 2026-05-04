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

  // Force time-up by rewinding startedAt so the next answer triggers the flush.
  session.startedAt = Date.now() - session.durationMs - 1;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

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

test('start response includes answer on the question (used by client local grading)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG } });
  assert.equal(start.statusCode, 200);
  const body = start.json();
  assert.equal(typeof body.question.answer, 'number');

  // Sanity: matches the in-memory session
  const session = sessionStore.get(body.session_id);
  assert.equal(body.question.answer, session.currentQuestion.answer);
});

test('answer response includes answer on next_question', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG } });
  const { session_id } = start.json();
  const session = sessionStore.get(session_id);

  const ans = await app.inject({
    method: 'POST', url: '/api/play/answer',
    payload: { session_id, answer: String(session.currentQuestion.answer) }
  });
  assert.equal(ans.statusCode, 200);
  assert.equal(typeof ans.json().next_question.answer, 'number');
});

test('empty-string answer past deadline returns time_up:true (used by client timer-expiry)', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50; // 50ms drill — deadline passes quickly
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg } });
  const { session_id } = start.json();

  // Wait past the deadline.
  await new Promise(r => setTimeout(r, 80));

  const ans = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' } });
  assert.equal(ans.statusCode, 200);
  assert.equal(ans.json().time_up, true);
  assert.equal(typeof ans.json().final_score, 'number');
});

test('time-up on logged-in default-config run inserts runs + attempts in one transaction', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();

  // Answer a few questions so we have attempts to flush.
  for (let i = 0; i < 3; i++) {
    const cur = sessionStore.get(session_id).currentQuestion;
    await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  }

  // Force time-up by rewinding startedAt so the next answer triggers the flush.
  const sess = sessionStore.get(session_id);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  const tu = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });
  assert.equal(tu.statusCode, 200);
  assert.equal(tu.json().time_up, true);

  const runs = await pool.query('SELECT id, user_id, score FROM runs');
  assert.equal(runs.rows.length, 1);
  const attempts = await pool.query('SELECT run_id, q_index, op FROM attempts ORDER BY q_index');
  assert.equal(attempts.rows.length, 3);
  assert.equal(Number(attempts.rows[0].run_id), Number(runs.rows[0].id));
});

test('time-up payload on logged-in default-config run includes difficulty', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();

  // Answer a few questions so flushRunIfRecording has attempts and computes a difficulty.
  for (let i = 0; i < 3; i++) {
    const cur = sessionStore.get(session_id).currentQuestion;
    await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  }

  // Force time-up so the next answer triggers the flush + response.
  const sess = sessionStore.get(session_id);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  const tu = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

  assert.equal(tu.statusCode, 200);
  assert.equal(tu.json().time_up, true);
  // Difficulty depends on the median cache being warm. In CI it may legitimately
  // be null (no historical attempts). Either way, the field must be present and
  // either a finite number or null — never undefined.
  const body = tu.json();
  assert.ok('difficulty' in body, 'response should include `difficulty` field');
  const d = body.difficulty;
  assert.ok(d === null || (typeof d === 'number' && Number.isFinite(d)), `difficulty was ${d}`);
});

test('time-up on guest run writes nothing', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg } });
  const { session_id } = start.json();
  await new Promise(r => setTimeout(r, 80));
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' } });

  const runs = await pool.query('SELECT count(*)::int AS n FROM runs');
  const attempts = await pool.query('SELECT count(*)::int AS n FROM attempts');
  assert.equal(runs.rows[0].n, 0);
  assert.equal(attempts.rows[0].n, 0);
});

test('time-up on custom-config logged-in run writes nothing', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  cfg.ops.add.max = 50;  // makes the config non-default
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg }, headers: { cookie } });
  const { session_id } = start.json();
  await new Promise(r => setTimeout(r, 80));
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

  const runs = await pool.query('SELECT count(*)::int AS n FROM runs');
  const attempts = await pool.query('SELECT count(*)::int AS n FROM attempts');
  assert.equal(runs.rows[0].n, 0);
  assert.equal(attempts.rows[0].n, 0);
});

test('submit flips submitted_to_leaderboard; unsubmitted runs do not appear on leaderboard', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const cookie = await registerAndCookie(app, 'alice');
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();

  const cur = sessionStore.get(session_id).currentQuestion;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  // Force time-up by rewinding startedAt so the next answer triggers the flush.
  const sess = sessionStore.get(session_id);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });

  // Before submit: run exists with flag=false, leaderboard is empty.
  const before = await pool.query('SELECT submitted_to_leaderboard FROM runs');
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].submitted_to_leaderboard, false);
  const lbBefore = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  assert.equal(lbBefore.json().entries.length, 0);

  // Submit flips the flag.
  const sub = await app.inject({ method: 'POST', url: '/api/leaderboard/submit', payload: { session_id }, headers: { cookie } });
  assert.equal(sub.statusCode, 200);
  assert.equal(sub.json().rank, 1);
  const after = await pool.query('SELECT submitted_to_leaderboard FROM runs');
  assert.equal(after.rows[0].submitted_to_leaderboard, true);
  const lbAfter = await app.inject({ method: 'GET', url: '/api/leaderboard' });
  assert.equal(lbAfter.json().entries.length, 1);
  assert.equal(lbAfter.json().entries[0].username, 'alice');
});

test('time-up payload on guest run includes difficulty:null', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.durationMs = 50;
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: cfg } });
  const { session_id } = start.json();

  await new Promise(r => setTimeout(r, 80));
  const tu = await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' } });

  assert.equal(tu.statusCode, 200);
  assert.equal(tu.json().time_up, true);
  assert.equal(tu.json().difficulty, null);
});
