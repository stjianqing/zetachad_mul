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

  fastify.get('/admin/api/runs/:run_id/attempts', async (req, reply) => {
    const runId = Number(req.params.run_id);
    if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'bad_request' });

    const { rows: runRows } = await pool.query(
      `SELECT
         r.id::int                                                AS run_id,
         r.user_id::int                                           AS user_id,
         u.username                                               AS username,
         r.score                                                  AS score,
         r.duration_ms                                            AS duration_ms,
         r.played_at                                              AS played_at,
         r.submitted_to_leaderboard                               AS submitted_to_leaderboard,
         COUNT(a.id)::int                                         AS attempts_count,
         COALESCE(100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 0)::float AS accuracy_pct,
         COALESCE(AVG(a.response_ms), 0)::float                   AS mean_response_ms
       FROM runs r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN attempts a ON a.run_id = r.id
       WHERE r.id = $1
       GROUP BY r.id, u.username`,
      [runId]
    );
    if (runRows.length === 0) return reply.code(404).send({ error: 'unknown_run' });
    const r0 = runRows[0];

    const { rows: aRows } = await pool.query(
      `SELECT q_index, op, lhs, rhs, answer, user_answer, response_ms, correct, asked_at
       FROM attempts
       WHERE run_id = $1
       ORDER BY q_index ASC`,
      [runId]
    );

    return {
      run: {
        run_id: r0.run_id,
        user_id: r0.user_id,
        username: r0.username,
        score: r0.score,
        duration_ms: r0.duration_ms,
        played_at: r0.played_at.toISOString(),
        submitted_to_leaderboard: r0.submitted_to_leaderboard,
        attempts_count: r0.attempts_count,
        accuracy_pct: Math.round(r0.accuracy_pct * 10) / 10,
        mean_response_ms: Math.round(r0.mean_response_ms)
      },
      attempts: aRows.map(a => ({
        q_index: a.q_index,
        op: a.op,
        lhs: a.lhs,
        rhs: a.rhs,
        answer: a.answer,
        user_answer: a.user_answer,
        response_ms: a.response_ms,
        correct: a.correct,
        asked_at: a.asked_at.toISOString()
      }))
    };
  });

  fastify.get('/admin/api/per-op', async (req) => {
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    const params = [];
    let where = '';
    if (userId != null && Number.isFinite(userId)) {
      params.push(userId);
      where = 'WHERE r.user_id = $1';
    }
    const { rows } = await pool.query(
      `SELECT
         a.op                                                            AS op,
         COUNT(*)::int                                                   AS attempts,
         SUM(CASE WHEN a.correct THEN 1 ELSE 0 END)::int                 AS correct,
         (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct,
         AVG(a.response_ms)::float                                       AS mean_response_ms,
         (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.response_ms))::float AS median_response_ms
       FROM attempts a
       JOIN runs r ON r.id = a.run_id
       ${where}
       GROUP BY a.op
       ORDER BY a.op`,
      params
    );
    return {
      per_op: rows.map(r => ({
        op: r.op,
        attempts: r.attempts,
        correct: r.correct,
        accuracy_pct: Math.round(r.accuracy_pct * 10) / 10,
        mean_response_ms: Math.round(r.mean_response_ms),
        median_response_ms: Math.round(r.median_response_ms)
      }))
    };
  });

  fastify.get('/admin/api/heatmap', async (req, reply) => {
    const op = req.query.op;
    if (!['add', 'sub', 'mul', 'div'].includes(op)) {
      return reply.code(400).send({ error: 'bad_op' });
    }
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    const params = [op];
    let where = 'WHERE a.op = $1';
    if (userId != null && Number.isFinite(userId)) {
      params.push(userId);
      where += ' AND r.user_id = $2';
    }
    const { rows } = await pool.query(
      `SELECT
         a.lhs                                                          AS lhs,
         a.rhs                                                          AS rhs,
         COUNT(*)::int                                                  AS attempts,
         SUM(CASE WHEN a.correct THEN 1 ELSE 0 END)::int                AS correct,
         AVG(a.response_ms)::float                                      AS mean_response_ms,
         (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct
       FROM attempts a
       JOIN runs r ON r.id = a.run_id
       ${where}
       GROUP BY a.lhs, a.rhs
       ORDER BY a.lhs, a.rhs`,
      params
    );
    return {
      op,
      cells: rows.map(c => ({
        lhs: c.lhs,
        rhs: c.rhs,
        attempts: c.attempts,
        correct: c.correct,
        mean_response_ms: Math.round(c.mean_response_ms),
        accuracy_pct: Math.round(c.accuracy_pct * 10) / 10
      }))
    };
  });

  fastify.get('/admin/api/weak-spots', async (req) => {
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    const params = [];
    let where = '';
    if (userId != null && Number.isFinite(userId)) {
      params.push(userId);
      where = 'WHERE r.user_id = $1';
    }
    const { rows } = await pool.query(
      `SELECT
         a.op                                                          AS op,
         a.lhs                                                          AS lhs,
         a.rhs                                                          AS rhs,
         COUNT(*)::int                                                  AS attempts,
         AVG(a.response_ms)::float                                      AS mean_response_ms,
         (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct
       FROM attempts a
       JOIN runs r ON r.id = a.run_id
       ${where}
       GROUP BY a.op, a.lhs, a.rhs
       HAVING COUNT(*) >= 10`,
      params
    );

    const slowest = [...rows]
      .sort((a, b) => b.mean_response_ms - a.mean_response_ms)
      .slice(0, 10)
      .map(r => ({
        op: r.op,
        lhs: r.lhs,
        rhs: r.rhs,
        attempts: r.attempts,
        mean_response_ms: Math.round(r.mean_response_ms)
      }));
    const least_accurate = [...rows]
      .sort((a, b) => a.accuracy_pct - b.accuracy_pct)
      .slice(0, 10)
      .map(r => ({
        op: r.op,
        lhs: r.lhs,
        rhs: r.rhs,
        attempts: r.attempts,
        accuracy_pct: Math.round(r.accuracy_pct * 10) / 10
      }));

    return { slowest, least_accurate };
  });
}
