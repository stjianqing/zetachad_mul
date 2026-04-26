import { requireAuth } from '../auth.js';

export default async function boardRoutes(fastify, { pool, sessionStore }) {
  fastify.post('/api/leaderboard/submit', { preHandler: requireAuth }, async (req, reply) => {
    const { session_id } = req.body ?? {};
    if (typeof session_id !== 'string') return reply.code(400).send({ error: 'bad_request' });

    const session = sessionStore.get(session_id);
    if (!session) return reply.code(404).send({ error: 'unknown_session' });

    if (session.userId !== req.user.id) {
      return reply.code(403).send({ error: 'session_owner_mismatch' });
    }

    const finished = sessionStore.finish(session_id);
    if (!finished.qualifies) {
      return reply.code(422).send({ error: 'not_eligible', qualifies: false });
    }

    // Idempotency: a session can be submitted only once.
    if (session.submitted) {
      return { ok: true, rank: session.lastRank, idempotent: true };
    }

    const ins = await pool.query(
      `INSERT INTO runs (user_id, score, duration_ms) VALUES ($1, $2, $3)
       RETURNING id, played_at`,
      [req.user.id, finished.finalScore, finished.durationMs]
    );

    // Compute rank: number of users whose best score is strictly greater, plus 1.
    const { rows } = await pool.query(
      `WITH best AS (
         SELECT user_id, MAX(score) AS s FROM runs GROUP BY user_id
       )
       SELECT COUNT(*) + 1 AS rank
       FROM best
       WHERE s > (SELECT MAX(score) FROM runs WHERE user_id = $1)`,
      [req.user.id]
    );
    const rank = Number(rows[0].rank);

    session.submitted = true;
    session.lastRank = rank;

    return { ok: true, rank, run_id: Number(ins.rows[0].id) };
  });

  fastify.get('/api/leaderboard', async () => {
    const { rows } = await pool.query(
      `SELECT u.username, b.score, b.played_at
       FROM (
         SELECT DISTINCT ON (user_id) user_id, score, played_at
         FROM runs
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
        played_at: r.played_at.toISOString()
      }))
    };
  });
}
