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

test('GET /admin/api/score-timeseries returns one point per run, ascending', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({ method: 'GET', url: '/admin/api/score-timeseries?window=all', headers: { authorization: BASIC_HEADER } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.points.length, 2);
  const p = body.points[0];
  assert.equal(typeof p.played_at, 'string');
  assert.equal(typeof p.score, 'number');
  assert.equal(typeof p.run_id, 'number');
  assert.equal(p.username, 'alice');
  assert.ok(new Date(body.points[0].played_at) <= new Date(body.points[1].played_at));
});

test('GET /admin/api/engagement returns the right shape', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const cookie = await registerAndCookie(app, 'alice');
  await playOneShortRun(app, sessionStore, cookie);

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/engagement',
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(typeof body.total_runs, 'number');
  assert.equal(typeof body.dau, 'number');
  assert.equal(typeof body.wau, 'number');
  assert.equal(typeof body.new_players_7d, 'number');
  // median may be null when there's <1 row in the 30d window; accept null too
  assert.ok(body.median_score_30d === null || typeof body.median_score_30d === 'number');
  assert.ok(Array.isArray(body.runs_per_day_30d));
  assert.equal(body.runs_per_day_30d.length, 30);
  for (const d of body.runs_per_day_30d) {
    assert.equal(typeof d.date, 'string');
    assert.equal(typeof d.count, 'number');
  }
  assert.ok(body.total_runs >= 1);
  assert.ok(body.wau >= 1);
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const todayBucket = body.runs_per_day_30d.find(d => d.date === todayKey);
  assert.ok(todayBucket, `expected today's bucket (${todayKey}) in 30-day window`);
  assert.ok(todayBucket.count >= 1, 'today\'s run should be counted in today\'s bucket');
});

test('GET /admin/api/engagement?user_id scopes to one player', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, sessionStore } = await freshApp();
  t.after(() => app.close());
  const aliceCookie = await registerAndCookie(app, 'alice');
  const bobCookie = await registerAndCookie(app, 'bob');
  await playOneShortRun(app, sessionStore, aliceCookie);
  await playOneShortRun(app, sessionStore, bobCookie);
  await playOneShortRun(app, sessionStore, bobCookie);

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/engagement?user_id=2', // bob
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.total_runs, 2);
  assert.equal(body.wau, 1);
});

test('GET /admin/api/trouble-facts?op=mul returns shape, n>=3, restricted to 2..12', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  // Seed: one user, one run, attempts spread across mul facts incl. >12 rhs
  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('seed', 'x')`);
  await pool.query(`INSERT INTO runs (user_id, score, duration_ms, played_at) VALUES (1, 50, 120000, now())`);
  // 4 attempts on (12, 7), 3 on (11, 8), 2 on (5, 5), 5 on (4, 50)
  const insert = `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
                  VALUES (1, $1, 'mul', $2, $3, $4, $5, $6, $7, now())`;
  let q = 0;
  for (let i = 0; i < 4; i++) await pool.query(insert, [q++, 12, 7, 84, '84', 3000, true]);
  for (let i = 0; i < 3; i++) await pool.query(insert, [q++, 11, 8, 88, '88', 2500, true]);
  for (let i = 0; i < 2; i++) await pool.query(insert, [q++, 5, 5, 25, '25', 800, true]);
  for (let i = 0; i < 5; i++) await pool.query(insert, [q++, 4, 50, 200, '200', 4000, true]); // rhs=50, OUT of range

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/trouble-facts?op=mul',
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.op, 'mul');
  assert.equal(typeof body.op_median_ms, 'number');
  assert.equal(typeof body.total_attempts, 'number');
  assert.ok(Array.isArray(body.facts));
  // Should include (12,7) [n=4] and (11,8) [n=3] but NOT (5,5) [n=2 < 3] or (4,50) [rhs > 12]
  const keys = body.facts.map(f => `${f.lhs}x${f.rhs}`);
  assert.ok(keys.includes('12x7'));
  assert.ok(keys.includes('11x8'));
  assert.ok(!keys.includes('5x5'));
  assert.ok(!keys.includes('4x50'));
  for (const f of body.facts) {
    assert.ok(f.lhs >= 2 && f.lhs <= 12);
    assert.ok(f.rhs >= 2 && f.rhs <= 12);
    assert.ok(f.attempts >= 3);
    assert.equal(typeof f.score, 'number');
  }
});

test('GET /admin/api/trouble-facts?op=div uses (divisor, quotient) axes', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool } = await freshApp();
  t.after(() => app.close());

  await pool.query(`INSERT INTO users (username, password_hash) VALUES ('seed', 'x')`);
  await pool.query(`INSERT INTO runs (user_id, score, duration_ms, played_at) VALUES (1, 50, 120000, now())`);
  const insert = `INSERT INTO attempts (run_id, q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at)
                  VALUES (1, $1, 'div', $2, $3, $4, $5, $6, $7, now())`;
  let q = 0;
  // 84 / 7 = 12 -> divisor=7, quotient=12 -> in range
  for (let i = 0; i < 4; i++) await pool.query(insert, [q++, 84, 7, 12, '12', 3000, true]);
  // 600 / 6 = 100 -> quotient=100 -> OUT of range
  for (let i = 0; i < 4; i++) await pool.query(insert, [q++, 600, 6, 100, '100', 5000, true]);
  // 9 / 4: not divisible (lhs % rhs != 0) - should never happen but guard anyway
  // skip - the generator never produces these.

  const r = await app.inject({
    method: 'GET',
    url: '/admin/api/trouble-facts?op=div',
    headers: { authorization: BASIC_HEADER }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  const keys = body.facts.map(f => `${f.lhs}/${f.rhs}`);
  assert.ok(keys.includes('84/7'));
  assert.ok(!keys.includes('600/6'));
});
