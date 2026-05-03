import { requireAdmin } from '../admin-auth.js';

export default async function adminRoutes(fastify, { pool, medianCache }) {
  fastify.addHook('preHandler', requireAdmin);

  fastify.post('/admin/api/refresh-medians', async (req, reply) => {
    if (!medianCache) return reply.code(503).send({ error: 'median_cache_unavailable' });
    try {
      await medianCache.refresh();
      const all = medianCache.getAll();
      return {
        ok: true,
        clusters: all.size,
        medians: Object.fromEntries(all)
      };
    } catch (err) {
      req.log.error({ err }, 'refresh-medians failed');
      return reply.code(500).send({ error: 'refresh_failed' });
    }
  });

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

  fastify.get('/admin/api/engagement', async (req) => {
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    const params = [];
    let where = '';
    if (userId != null && Number.isFinite(userId)) {
      params.push(userId);
      where = 'WHERE r.user_id = $1';
    }

    // Single roll-up query: total_runs, dau (SGT today), wau (last 7d), median (last 30d)
    const { rows: aggRows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_runs,
         COUNT(DISTINCT r.user_id) FILTER (
           WHERE (r.played_at AT TIME ZONE 'Asia/Singapore')::date
               = (now() AT TIME ZONE 'Asia/Singapore')::date
         )::int AS dau,
         COUNT(DISTINCT r.user_id) FILTER (
           WHERE r.played_at >= now() - interval '7 days'
         )::int AS wau,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.score)
           FILTER (WHERE r.played_at >= now() - interval '30 days') AS median_score_30d
       FROM runs r
       ${where}`,
      params
    );

    // New players in last 7d: users whose first run is within the window
    const { rows: newRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT user_id, MIN(played_at) AS first_run
         FROM runs r
         ${where}
         GROUP BY user_id
       ) t WHERE t.first_run >= now() - interval '7 days'`,
      params
    );

    // 30-day per-day run counts in SGT, padded to exactly 30 entries.
    const { rows: dayRows } = await pool.query(
      `SELECT
         to_char((r.played_at AT TIME ZONE 'Asia/Singapore')::date, 'YYYY-MM-DD') AS d,
         COUNT(*)::int AS c
       FROM runs r
       ${where ? where + ' AND' : 'WHERE'} r.played_at >= now() - interval '30 days'
       GROUP BY d
       ORDER BY d ASC`,
      params
    );

    const dayMap = new Map(dayRows.map(r => [r.d, r.c])); // r.d is now a 'YYYY-MM-DD' string
    const sgtDateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Singapore',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const nowMs = Date.now();
    const runs_per_day_30d = [];
    for (let i = 29; i >= 0; i--) {
      const key = sgtDateFmt.format(new Date(nowMs - i * 86400000));
      runs_per_day_30d.push({ date: key, count: dayMap.get(key) ?? 0 });
    }

    const a = aggRows[0];
    return {
      total_runs: a.total_runs,
      dau: a.dau,
      wau: a.wau,
      new_players_7d: newRows[0].n,
      median_score_30d: a.median_score_30d == null ? null : Math.round(Number(a.median_score_30d)),
      runs_per_day_30d
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

  fastify.get('/admin/api/trouble-facts', async (req, reply) => {
    const op = req.query.op;
    if (!['add', 'sub', 'mul', 'div'].includes(op)) {
      return reply.code(400).send({ error: 'bad_op' });
    }
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    const limitRaw = Number(req.query.limit ?? 8);
    const limit = Math.min(20, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 8));

    const params = [op];
    const wheres = [`a.op = $1`];
    if (userId != null && Number.isFinite(userId)) {
      params.push(userId);
      wheres.push(`r.user_id = $${params.length}`);
    }

    // Range filter: mul/div restricted to 2..12 x 2..12 (in their natural axes).
    // For mul: lhs (multiplicand) in 2..12 AND rhs (multiplier) in 2..12.
    // For div: rhs (divisor) in 2..12 AND lhs/rhs (quotient) in 2..12 AND lhs % rhs = 0.
    // For add/sub: no range filter (they don't appear in the redesigned weakness grid,
    // but the endpoint supports them for completeness/future use).
    if (op === 'mul') {
      wheres.push(`a.lhs BETWEEN 2 AND 12`);
      wheres.push(`a.rhs BETWEEN 2 AND 12`);
    } else if (op === 'div') {
      wheres.push(`a.rhs BETWEEN 2 AND 12`);
      wheres.push(`a.lhs % a.rhs = 0`);
      wheres.push(`(a.lhs / a.rhs) BETWEEN 2 AND 12`);
    }
    const whereSql = 'WHERE ' + wheres.join(' AND ');

    // Aggregate buckets that have n >= 3, plus the op-wide median and total attempts.
    const { rows: bucketRows } = await pool.query(
      `SELECT
         a.lhs                                                          AS lhs,
         a.rhs                                                          AS rhs,
         COUNT(*)::int                                                  AS attempts,
         AVG(a.response_ms)::float                                      AS mean_response_ms,
         (100.0 * SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) / COUNT(*))::float AS accuracy_pct
       FROM attempts a
       JOIN runs r ON r.id = a.run_id
       ${whereSql}
       GROUP BY a.lhs, a.rhs
       HAVING COUNT(*) >= 3`,
      params
    );

    const { rows: medianRows } = await pool.query(
      `SELECT
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.response_ms)::float AS median,
         COUNT(*)::int                                                     AS total_attempts
       FROM attempts a
       JOIN runs r ON r.id = a.run_id
       ${whereSql}`,
      params
    );

    const opMedianMs = Math.max(1, Math.round(medianRows[0].median ?? 1));

    // Score = slowness ratio + 2 * inaccuracy ratio. Higher = worse.
    const scored = bucketRows.map(b => {
      const slowness = b.mean_response_ms / opMedianMs;
      const inaccuracy = 1 - (b.accuracy_pct / 100);
      const score = slowness + 2 * inaccuracy;
      return {
        lhs: b.lhs,
        rhs: b.rhs,
        attempts: b.attempts,
        mean_response_ms: Math.round(b.mean_response_ms),
        accuracy_pct: Math.round(b.accuracy_pct * 10) / 10,
        score: Math.round(score * 1000) / 1000
      };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    return {
      op,
      op_median_ms: opMedianMs,
      total_attempts: medianRows[0].total_attempts,
      facts: scored
    };
  });

  fastify.get('/admin/api/score-timeseries', async (req, reply) => {
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    const window = req.query.window ?? 'all';
    if (!['7', '30', 'all'].includes(window)) {
      return reply.code(400).send({ error: 'bad_window' });
    }
    const params = [];
    const wheres = [];
    if (userId != null && Number.isFinite(userId)) {
      params.push(userId);
      wheres.push(`r.user_id = $${params.length}`);
    }
    if (window === '7') wheres.push(`r.played_at >= now() - interval '7 days'`);
    if (window === '30') wheres.push(`r.played_at >= now() - interval '30 days'`);
    const whereSql = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

    const { rows } = await pool.query(
      `SELECT
         r.played_at                          AS played_at,
         r.score                              AS score,
         r.id::int                            AS run_id,
         u.username                           AS username
       FROM runs r
       JOIN users u ON u.id = r.user_id
       ${whereSql}
       ORDER BY r.played_at ASC`,
      params
    );
    return {
      points: rows.map(p => ({
        played_at: p.played_at.toISOString(),
        score: p.score,
        run_id: p.run_id,
        username: p.username
      }))
    };
  });
}
