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
}
