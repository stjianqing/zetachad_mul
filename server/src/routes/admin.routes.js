import { requireAdmin } from '../admin-auth.js';

export default async function adminRoutes(fastify, { pool }) {
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/admin/api/players', async () => {
    const { rows } = await pool.query(
      `SELECT
         u.id::int                             AS user_id,
         u.username                            AS username,
         COUNT(r.id)::int                      AS run_count,
         COALESCE(MAX(r.score), 0)::int        AS best_score,
         MAX(r.played_at)                      AS last_played_at,
         COALESCE(SUM(a.cnt), 0)::int          AS total_attempts
       FROM users u
       JOIN runs r ON r.user_id = u.id
       LEFT JOIN (
         SELECT run_id, COUNT(*)::int AS cnt FROM attempts GROUP BY run_id
       ) a ON a.run_id = r.id
       GROUP BY u.id, u.username
       ORDER BY run_count DESC, u.username ASC`
    );
    return {
      players: rows.map(r => ({
        user_id: r.user_id,
        username: r.username,
        run_count: r.run_count,
        best_score: r.best_score,
        last_played_at: r.last_played_at ? r.last_played_at.toISOString() : null,
        total_attempts: r.total_attempts
      }))
    };
  });

  fastify.get('/admin/api/runs', async (req) => {
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    const params = [];
    let where = '';
    if (userId != null && Number.isFinite(userId)) {
      params.push(userId);
      where = 'WHERE r.user_id = $1';
    }
    const limitOffsetIdx = params.length;
    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT
         r.id::int                                                  AS run_id,
         r.user_id::int                                             AS user_id,
         u.username                                                 AS username,
         r.score                                                    AS score,
         r.duration_ms                                              AS duration_ms,
         r.played_at                                                AS played_at,
         r.submitted_to_leaderboard                                 AS submitted_to_leaderboard,
         COALESCE(s.attempts_count, 0)::int                         AS attempts_count,
         COALESCE(s.accuracy_pct, 0)::float                         AS accuracy_pct,
         COALESCE(s.mean_response_ms, 0)::float                     AS mean_response_ms
       FROM runs r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN (
         SELECT
           run_id,
           COUNT(*)::int                                            AS attempts_count,
           100.0 * SUM(CASE WHEN correct THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS accuracy_pct,
           AVG(response_ms)                                         AS mean_response_ms
         FROM attempts
         GROUP BY run_id
       ) s ON s.run_id = r.id
       ${where}
       ORDER BY r.played_at DESC
       LIMIT $${limitOffsetIdx + 1} OFFSET $${limitOffsetIdx + 2}`,
      params
    );

    const totalParams = userId != null && Number.isFinite(userId) ? [userId] : [];
    const totalSql = userId != null && Number.isFinite(userId)
      ? 'SELECT COUNT(*)::int AS n FROM runs WHERE user_id = $1'
      : 'SELECT COUNT(*)::int AS n FROM runs';
    const { rows: tot } = await pool.query(totalSql, totalParams);

    return {
      runs: rows.map(r => ({
        run_id: r.run_id,
        user_id: r.user_id,
        username: r.username,
        score: r.score,
        duration_ms: r.duration_ms,
        played_at: r.played_at.toISOString(),
        submitted_to_leaderboard: r.submitted_to_leaderboard,
        attempts_count: r.attempts_count,
        accuracy_pct: Math.round(r.accuracy_pct * 10) / 10,
        mean_response_ms: Math.round(r.mean_response_ms)
      })),
      total: tot[0].n
    };
  });
}
