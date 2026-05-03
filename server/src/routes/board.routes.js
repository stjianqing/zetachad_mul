import { requireAuth } from '../auth.js';
import { todaySgtDateString } from '../game/sgt-date.js';

export default async function boardRoutes(fastify, { pool, sessionStore, nowFn = () => new Date() }) {
  fastify.post('/api/leaderboard/submit', { preHandler: requireAuth }, async (req, reply) => {
    const { session_id } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });

    const session = sessionStore.get(session_id);
    if (!session) return reply.code(404).send({ error: 'unknown_session' });

    if (session.userId !== req.user.id) {
      return reply.code(403).send({ error: 'session_owner_mismatch' });
    }

    const finished = sessionStore.finish(session_id);

    if (session.practice === true) {
      return { ok: true, practice: true, run_id: session.runId, difficulty: session.difficulty ?? null };
    }

    if (!finished.qualifies) {
      return reply.code(422).send({ error: 'not_eligible', qualifies: false });
    }

    if (session.submitted) {
      return { ok: true, rank: session.lastRank, idempotent: true, difficulty: session.difficulty ?? null };
    }

    if (session.runId == null) {
      return reply.code(409).send({ error: 'not_finalized' });
    }

    await pool.query(
      'UPDATE runs SET submitted_to_leaderboard = true WHERE id = $1',
      [session.runId]
    );

    const { rows } = await pool.query(
      `WITH best AS (
         SELECT user_id, MAX(score) AS s
         FROM runs
         WHERE submitted_to_leaderboard = true
         GROUP BY user_id
       )
       SELECT COUNT(*) + 1 AS rank
       FROM best
       WHERE s > (
         SELECT MAX(score) FROM runs
         WHERE user_id = $1 AND submitted_to_leaderboard = true
       )`,
      [req.user.id]
    );
    const rank = Number(rows[0].rank);

    session.submitted = true;
    session.lastRank = rank;

    return { ok: true, rank, run_id: session.runId, difficulty: session.difficulty ?? null };
  });

  fastify.get('/api/leaderboard', async () => {
    const { rows } = await pool.query(
      `SELECT u.username, b.score, b.difficulty, b.played_at
       FROM (
         SELECT DISTINCT ON (user_id) user_id, score, difficulty, played_at
         FROM runs
         WHERE submitted_to_leaderboard = true
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
        difficulty: r.difficulty == null ? null : Number(r.difficulty),
        played_at: r.played_at.toISOString()
      }))
    };
  });

  fastify.get('/api/leaderboard/champion', async () => {
    const { rows } = await pool.query(
      `SELECT u.username, MAX(r.score) AS score
       FROM runs r JOIN users u ON u.id = r.user_id
       WHERE r.submitted_to_leaderboard = true
       GROUP BY u.username
       ORDER BY score DESC
       LIMIT 1`
    );
    if (rows.length === 0) return { champion: null };
    return { champion: { username: rows[0].username, score: Number(rows[0].score) } };
  });

  fastify.get('/api/leaderboard/speed', async () => {
    const MIN_ATTEMPTS = 50;
    const { rows } = await pool.query(
      `WITH per_user_op AS (
         SELECT u.username, a.op,
                AVG(a.response_ms)::int AS avg_ms,
                COUNT(*)::int AS n
         FROM attempts a
         JOIN runs r ON r.id = a.run_id
         JOIN users u ON u.id = r.user_id
         WHERE a.correct = true
           AND COALESCE(r.practice, false) = false
         GROUP BY u.username, a.op
         HAVING COUNT(*) >= $1
       ),
       ranked AS (
         SELECT username, op, avg_ms, n,
                ROW_NUMBER() OVER (PARTITION BY op ORDER BY avg_ms ASC) AS rk
         FROM per_user_op
       )
       SELECT op, username, avg_ms, n, rk
       FROM ranked
       WHERE rk <= 3
       ORDER BY op, rk`,
      [MIN_ATTEMPTS]
    );
    const ops = { add: [], sub: [], mul: [], div: [] };
    for (const r of rows) {
      if (ops[r.op]) ops[r.op].push({ username: r.username, avgMs: r.avg_ms, n: r.n });
    }
    return ops;
  });

  fastify.get('/api/leaderboard/daily', async (req) => {
    const today = todaySgtDateString(nowFn());
    const date = typeof req.query?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : today;

    const limit = Math.min(Number(req.query?.limit) || 100, 500);

    const { rows } = await pool.query(
      `SELECT u.username, r.duration_ms, r.played_at
       FROM runs r
       JOIN users u ON u.id = r.user_id
       WHERE r.daily_gauntlet_date = $1 AND r.submitted_to_leaderboard = true
       ORDER BY r.duration_ms ASC, r.played_at ASC
       LIMIT $2`,
      [date, limit]
    );

    return {
      date,
      entries: rows.map((r, i) => ({
        rank: i + 1,
        username: r.username,
        time_ms: Number(r.duration_ms),
        played_at: r.played_at.toISOString()
      }))
    };
  });

  fastify.get('/api/leaderboard/daily/me', { preHandler: requireAuth }, async (req) => {
    const today = todaySgtDateString(nowFn());

    const { rows } = await pool.query(
      `SELECT duration_ms, played_at
       FROM runs
       WHERE user_id = $1 AND daily_gauntlet_date = $2 AND submitted_to_leaderboard = true
       LIMIT 1`,
      [req.user.id, today]
    );

    if (rows.length === 0) {
      return { played: false };
    }

    const { duration_ms, played_at } = rows[0];

    const rankRows = await pool.query(
      `SELECT COUNT(*) + 1 AS rank
       FROM runs
       WHERE daily_gauntlet_date = $1
         AND submitted_to_leaderboard = true
         AND (duration_ms < $2 OR (duration_ms = $2 AND played_at < $3))`,
      [today, duration_ms, played_at]
    );

    const totalRows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM runs
       WHERE daily_gauntlet_date = $1 AND submitted_to_leaderboard = true`,
      [today]
    );

    return {
      played: true,
      time_ms: Number(duration_ms),
      rank: Number(rankRows.rows[0].rank),
      total_today: totalRows.rows[0].n
    };
  });
}
