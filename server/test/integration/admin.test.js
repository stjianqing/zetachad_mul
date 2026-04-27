import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const BASIC_HEADER = 'Basic ' + Buffer.from('stjianqing:irrelevant').toString('base64');

async function registerAndCookie(app, username) {
  const r = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password: 'password123' } });
  return cookieFromResponse(r);
}

async function playOneShortRun(app, sessionStore, cookie) {
  const start = await app.inject({ method: 'POST', url: '/api/play/start', payload: { config: DEFAULT_CONFIG }, headers: { cookie } });
  const { session_id } = start.json();
  const cur = sessionStore.get(session_id).currentQuestion;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: String(cur.answer) }, headers: { cookie } });
  const sess = sessionStore.get(session_id);
  sess.startedAt = Date.now() - sess.durationMs - 1;
  await app.inject({ method: 'POST', url: '/api/play/answer', payload: { session_id, answer: '' }, headers: { cookie } });
  return session_id;
}

test('GET /admin/api/players returns 401 without Basic header', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const r = await app.inject({ method: 'GET', url: '/admin/api/players' });
  assert.equal(r.statusCode, 401);
});

test('GET /admin/api/players returns aggregated player stats', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/players', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.players.length, 1);
  const p = body.players[0];
  assert.equal(p.username, 'alice');
  assert.equal(p.run_count, 1);
  assert.equal(typeof p.best_score, 'number');
  assert.equal(typeof p.last_played_at, 'string');
  assert.equal(typeof p.total_attempts, 'number');
  assert.ok(p.total_attempts >= 1);
});

test('GET /admin/api/runs without user_id returns all runs with aggregates', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/runs', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.total, 1);
  const run = body.runs[0];
  assert.equal(run.username, 'alice');
  assert.equal(typeof run.run_id, 'number');
  assert.equal(typeof run.score, 'number');
  assert.equal(typeof run.duration_ms, 'number');
  assert.equal(typeof run.played_at, 'string');
  assert.equal(typeof run.submitted_to_leaderboard, 'boolean');
  assert.equal(typeof run.attempts_count, 'number');
  assert.equal(typeof run.accuracy_pct, 'number');
  assert.equal(typeof run.mean_response_ms, 'number');
});

test('GET /admin/api/runs?user_id filters to a single user', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const aliceCookie = await registerAndCookie(app, 'alice');
  const bobCookie = await registerAndCookie(app, 'bob');
  await playOneShortRun(app, sessionStore, aliceCookie);
  await playOneShortRun(app, sessionStore, bobCookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/runs?user_id=1', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].username, 'alice');
});

test('GET /admin/api/runs/:id/attempts returns full question log', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const list = await app.inject({ method: 'GET', url: '/admin/api/runs', headers: { authorization: BASIC_HEADER } });
  const runId = list.json().runs[0].run_id;

  const r = await app.inject({ method: 'GET', url: `/admin/api/runs/${runId}/attempts`, headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.run.run_id, runId);
  assert.ok(body.attempts.length >= 1);
  const a = body.attempts[0];
  assert.equal(a.q_index, 0);
  assert.ok(['add', 'sub', 'mul', 'div'].includes(a.op));
  assert.equal(typeof a.lhs, 'number');
  assert.equal(typeof a.rhs, 'number');
  assert.equal(typeof a.answer, 'number');
  assert.equal(typeof a.response_ms, 'number');
  assert.equal(typeof a.correct, 'boolean');
  assert.equal(typeof a.asked_at, 'string');
});

test('GET /admin/api/runs/:id/attempts returns 404 for unknown run', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const r = await app.inject({ method: 'GET', url: '/admin/api/runs/99999/attempts', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 404);
});

test('GET /admin/api/per-op returns one row per op present in attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/per-op', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(Array.isArray(body.per_op));
  assert.ok(body.per_op.length >= 1);
  const row = body.per_op[0];
  assert.ok(['add', 'sub', 'mul', 'div'].includes(row.op));
  assert.equal(typeof row.attempts, 'number');
  assert.equal(typeof row.correct, 'number');
  assert.equal(typeof row.accuracy_pct, 'number');
  assert.equal(typeof row.mean_response_ms, 'number');
  assert.equal(typeof row.median_response_ms, 'number');
});

test('GET /admin/api/heatmap?op=mul returns cells', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  for (let i = 0; i < 5; i++) await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/heatmap?op=mul', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.op, 'mul');
  assert.ok(Array.isArray(body.cells));
  if (body.cells.length > 0) {
    const c = body.cells[0];
    assert.equal(typeof c.lhs, 'number');
    assert.equal(typeof c.rhs, 'number');
    assert.equal(typeof c.attempts, 'number');
    assert.equal(typeof c.correct, 'number');
    assert.equal(typeof c.mean_response_ms, 'number');
    assert.equal(typeof c.accuracy_pct, 'number');
  }
});

test('GET /admin/api/heatmap rejects op outside add/sub/mul/div', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());
  const r = await app.inject({ method: 'GET', url: '/admin/api/heatmap?op=junk', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 400);
});

test('GET /admin/api/weak-spots returns slowest and least_accurate arrays', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/weak-spots', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(Array.isArray(body.slowest));
  assert.ok(Array.isArray(body.least_accurate));
});
