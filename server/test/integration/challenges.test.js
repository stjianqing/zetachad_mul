import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { runForfeitSweep } from '../../src/jobs/forfeit-sweep.js';

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

test('incoming: only pending challenges for me', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'bob' },
    headers: { cookie: alice.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: '/api/challenges/incoming',
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].challenger.username, 'alice');
  assert.equal(typeof body[0].challenger_score, 'number');
});

test('outgoing: lists my sent challenges with status', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'bob');
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);

  await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: 'bob' },
    headers: { cookie: alice.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: '/api/challenges/outgoing',
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].recipient_username, 'bob');
  assert.equal(body[0].status, 'pending');
});

async function createUsernameChallenge(app, pool, sessionStore, alice, recipientUsername) {
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);
  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, recipient_username: recipientUsername },
    headers: { cookie: alice.cookie }
  });
  return r.json().id;
}

test('accept: returns seed + config + challenger_attempts', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(typeof body.seed === 'number');
  assert.ok(body.config);
  assert.ok(Array.isArray(body.challenger_attempts));
  if (body.challenger_attempts.length > 0) {
    assert.ok('q_index' in body.challenger_attempts[0]);
    assert.ok('response_ms' in body.challenger_attempts[0]);
    assert.ok('correct' in body.challenger_attempts[0]);
  }
});

test('accept: not the recipient → 404', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  await registerAndCookie(app, 'bob');
  const eve = await registerAndCookie(app, 'eve');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: eve.cookie }
  });
  assert.equal(r.statusCode, 404);
});

test('decline: status flips and shows up on outgoing', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/decline`,
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);

  const out = await app.inject({
    method: 'GET',
    url: '/api/challenges/outgoing',
    headers: { cookie: alice.cookie }
  });
  const list = out.json();
  assert.equal(list[0].status, 'declined');
});

test('submit-run: links recipient run + flips status to completed', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  const seedRow = await pool.query(
    `SELECT cr.seed FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id WHERE c.id=$1`,
    [challengeId]
  );
  const expectedSeed = Number(seedRow.rows[0].seed);

  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 50, 120000, false, $2) RETURNING id`,
    [bob.userId, expectedSeed]
  );
  const recipientRunId = Number(insRun.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: recipientRunId },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);

  const after = await pool.query('SELECT status, recipient_run_id FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(after.rows[0].status, 'completed');
  assert.equal(Number(after.rows[0].recipient_run_id), recipientRunId);
});

test('submit-run: seed mismatch → 400', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 50, 120000, false, 99999999) RETURNING id`,
    [bob.userId]
  );
  const recipientRunId = Number(insRun.rows[0].id);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: recipientRunId },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 400);
});

test('submit-run: not in accepted state → 409', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  const seedRow = await pool.query(
    `SELECT cr.seed FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id WHERE c.id=$1`,
    [challengeId]
  );
  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 50, 120000, false, $2) RETURNING id`,
    [bob.userId, Number(seedRow.rows[0].seed)]
  );

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: Number(insRun.rows[0].id) },
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 409);
});

async function createShareLinkChallenge(app, pool, sessionStore, alice) {
  await playAndFinishStandardRun(app, alice.cookie, sessionStore);
  const runId = await getLatestRunId(pool, alice.userId);
  const r = await app.inject({
    method: 'POST',
    url: '/api/challenges',
    payload: { challenger_run_id: runId, share_link: true },
    headers: { cookie: alice.cookie }
  });
  const body = r.json();
  const token = body.share_url.split('/challenge/')[1];
  return { id: body.id, token };
}

test('by-token: anonymous fetch returns challenger info while pending', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/by-token/${token}`
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.challenger.username, 'alice');
  assert.equal(body.status, 'pending');
});

test('by-token: redeemed token returns 410', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  await app.inject({
    method: 'POST',
    url: `/api/challenges/by-token/${token}/redeem`
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/by-token/${token}`
  });
  assert.equal(r.statusCode, 410);
});

test('redeem (anonymous): returns playable payload + requires_registration_to_submit', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/by-token/${token}/redeem`
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(typeof body.seed === 'number');
  assert.ok(body.config);
  assert.ok(Array.isArray(body.challenger_attempts));
  assert.equal(body.requires_registration_to_submit, true);
});

test('redeem (registered): links recipient_id, no registration required', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const { id, token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  const r = await app.inject({
    method: 'POST',
    url: `/api/challenges/by-token/${token}/redeem`,
    headers: { cookie: bob.cookie }
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().requires_registration_to_submit, false);

  const row = await pool.query('SELECT recipient_id FROM challenges WHERE id=$1', [id]);
  assert.equal(Number(row.rows[0].recipient_id), bob.userId);
});

test('redeem: second call → 410', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const { token } = await createShareLinkChallenge(app, pool, sessionStore, alice);

  await app.inject({ method: 'POST', url: `/api/challenges/by-token/${token}/redeem` });
  const r = await app.inject({ method: 'POST', url: `/api/challenges/by-token/${token}/redeem` });
  assert.equal(r.statusCode, 410);
});

test('result: challenger fetches → flips challenger_seen_result', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/decline`,
    headers: { cookie: bob.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/${challengeId}/result`,
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);

  const row = await pool.query('SELECT challenger_seen_result FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].challenger_seen_result, true);
});

test('result: third party → 403/404', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const eve = await registerAndCookie(app, 'eve');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/decline`,
    headers: { cookie: bob.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/${challengeId}/result`,
    headers: { cookie: eve.cookie }
  });
  assert.ok(r.statusCode === 403 || r.statusCode === 404);
});

test('result: completed challenge returns both runs joined', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');

  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });
  const seedRow = await pool.query(
    `SELECT cr.seed FROM challenges c JOIN runs cr ON cr.id=c.challenger_run_id WHERE c.id=$1`,
    [challengeId]
  );
  const seed = Number(seedRow.rows[0].seed);
  const insRun = await pool.query(
    `INSERT INTO runs (user_id, score, duration_ms, practice, seed)
     VALUES ($1, 60, 110000, false, $2) RETURNING id`,
    [bob.userId, seed]
  );
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/submit-run`,
    payload: { recipient_run_id: Number(insRun.rows[0].id) },
    headers: { cookie: bob.cookie }
  });

  const r = await app.inject({
    method: 'GET',
    url: `/api/challenges/${challengeId}/result`,
    headers: { cookie: alice.cookie }
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.status, 'completed');
  assert.ok(body.challenger);
  assert.ok(body.recipient);
  assert.equal(body.challenger.username, 'alice');
  assert.equal(body.recipient.username, 'bob');
  assert.ok(typeof body.winner === 'string');
});

test('forfeit sweep: accepted >30 min ago with no run flips to forfeited', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  await pool.query(
    `UPDATE challenges SET responded_at = now() - interval '31 minutes' WHERE id=$1`,
    [challengeId]
  );

  const flipped = await runForfeitSweep(pool);
  assert.equal(flipped, 1);

  const row = await pool.query('SELECT status FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].status, 'forfeited');
});

test('forfeit sweep: accepted recently is not touched', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app, pool, sessionStore } = await freshApp();
  t.after(() => app.close());

  const alice = await registerAndCookie(app, 'alice');
  const bob = await registerAndCookie(app, 'bob');
  const challengeId = await createUsernameChallenge(app, pool, sessionStore, alice, 'bob');
  await app.inject({
    method: 'POST',
    url: `/api/challenges/${challengeId}/accept`,
    headers: { cookie: bob.cookie }
  });

  const flipped = await runForfeitSweep(pool);
  assert.equal(flipped, 0);
  const row = await pool.query('SELECT status FROM challenges WHERE id=$1', [challengeId]);
  assert.equal(row.rows[0].status, 'accepted');
});
