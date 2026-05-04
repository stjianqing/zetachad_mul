import { requireAuth } from '../auth.js';
import { assertEligible } from '../challenge/eligibility.js';
import { generateShareToken } from '../challenge/share-token.js';
import { DEFAULT_CONFIG } from '../config.js';

export default async function challengesRoutes(fastify, { pool, baseUrl = '' }) {
  fastify.post('/api/challenges', { preHandler: requireAuth }, async (req, reply) => {
    const { challenger_run_id, recipient_username, share_link } = req.body ?? {};
    if (!Number.isInteger(challenger_run_id)) {
      return reply.code(400).send({ error: 'invalid_run_id' });
    }
    if (!recipient_username && !share_link) {
      return reply.code(400).send({ error: 'recipient_required' });
    }
    if (recipient_username && share_link) {
      return reply.code(400).send({ error: 'pick_one_recipient_mode' });
    }

    const runRes = await pool.query(
      `SELECT id, user_id, seed, practice, daily_gauntlet_date FROM runs WHERE id=$1`,
      [challenger_run_id]
    );
    const run = runRes.rows[0];
    if (!run) return reply.code(400).send({ error: 'run_not_found' });
    if (Number(run.user_id) !== req.user.id) {
      return reply.code(400).send({ error: 'not_run_owner' });
    }

    try {
      assertEligible({ ...run, config: DEFAULT_CONFIG });
    } catch (err) {
      return reply.code(400).send({ error: 'ineligible_run', reason: err.reason });
    }

    if (recipient_username) {
      if (recipient_username.toLowerCase() === req.user.username.toLowerCase()) {
        return reply.code(400).send({ error: 'cannot_challenge_self' });
      }
      const userRes = await pool.query(
        'SELECT id FROM users WHERE lower(username)=lower($1)',
        [recipient_username]
      );
      const recipient = userRes.rows[0];
      if (!recipient) return reply.code(404).send({ error: 'recipient_not_found' });

      const ins = await pool.query(
        `INSERT INTO challenges (challenger_run_id, challenger_id, recipient_id, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id, status`,
        [challenger_run_id, req.user.id, recipient.id]
      );
      return { id: Number(ins.rows[0].id), status: ins.rows[0].status };
    }

    const token = generateShareToken();
    const ins = await pool.query(
      `INSERT INTO challenges (challenger_run_id, challenger_id, share_token, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, status`,
      [challenger_run_id, req.user.id, token]
    );
    return {
      id: Number(ins.rows[0].id),
      status: ins.rows[0].status,
      share_url: `${baseUrl}/challenge/${token}`
    };
  });

  fastify.get('/api/challenges/incoming', { preHandler: requireAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT c.id, c.created_at, c.status,
              r.score AS challenger_score,
              u.username AS challenger_username
       FROM challenges c
       JOIN runs r ON r.id = c.challenger_run_id
       JOIN users u ON u.id = c.challenger_id
       WHERE c.recipient_id = $1 AND c.status = 'pending'
       ORDER BY c.created_at ASC`,
      [req.user.id]
    );
    return rows.map(row => ({
      id: Number(row.id),
      challenger: { username: row.challenger_username },
      challenger_score: row.challenger_score,
      created_at: row.created_at
    }));
  });

  fastify.get('/api/challenges/outgoing', { preHandler: requireAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT c.id, c.created_at, c.status, c.share_token, c.challenger_seen_result,
              cr.score AS challenger_score,
              rr.score AS recipient_score,
              ru.username AS recipient_username
       FROM challenges c
       JOIN runs cr ON cr.id = c.challenger_run_id
       LEFT JOIN runs rr ON rr.id = c.recipient_run_id
       LEFT JOIN users ru ON ru.id = c.recipient_id
       WHERE c.challenger_id = $1
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    return rows.map(row => ({
      id: Number(row.id),
      recipient_username: row.recipient_username ?? null,
      share_token: row.share_token ?? null,
      challenger_score: row.challenger_score,
      recipient_score: row.recipient_score ?? null,
      status: row.status,
      challenger_seen_result: row.challenger_seen_result,
      created_at: row.created_at
    }));
  });

  fastify.post('/api/challenges/:id/accept', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });

    const upd = await pool.query(
      `UPDATE challenges
       SET status='accepted', responded_at=now()
       WHERE id=$1 AND recipient_id=$2 AND status='pending'
       RETURNING challenger_run_id`,
      [id, req.user.id]
    );
    if (upd.rowCount === 0) {
      return reply.code(404).send({ error: 'not_found_or_not_recipient' });
    }
    const challengerRunId = Number(upd.rows[0].challenger_run_id);

    const runRes = await pool.query('SELECT seed FROM runs WHERE id=$1', [challengerRunId]);
    const seed = runRes.rows[0].seed;

    const attRes = await pool.query(
      `SELECT q_index, response_ms, correct FROM attempts WHERE run_id=$1 ORDER BY q_index ASC`,
      [challengerRunId]
    );
    const challenger_attempts = attRes.rows.map(a => ({
      q_index: a.q_index,
      response_ms: a.response_ms,
      correct: a.correct
    }));

    return {
      seed: Number(seed),
      config: DEFAULT_CONFIG,
      challenger_attempts
    };
  });

  fastify.post('/api/challenges/:id/decline', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const upd = await pool.query(
      `UPDATE challenges
       SET status='declined', responded_at=now()
       WHERE id=$1 AND recipient_id=$2 AND status='pending'`,
      [id, req.user.id]
    );
    if (upd.rowCount === 0) {
      return reply.code(404).send({ error: 'not_found_or_not_recipient' });
    }
    return { ok: true };
  });

  fastify.post('/api/challenges/:id/submit-run', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const { recipient_run_id } = req.body ?? {};
    if (!Number.isInteger(id) || !Number.isInteger(recipient_run_id)) {
      return reply.code(400).send({ error: 'invalid_input' });
    }

    const cRes = await pool.query(
      `SELECT c.id, c.status, c.recipient_id, cr.seed AS challenger_seed
       FROM challenges c JOIN runs cr ON cr.id = c.challenger_run_id
       WHERE c.id = $1`,
      [id]
    );
    const c = cRes.rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (Number(c.recipient_id) !== req.user.id) {
      return reply.code(404).send({ error: 'not_recipient' });
    }
    if (c.status !== 'accepted') {
      return reply.code(409).send({ error: 'not_in_accepted_state' });
    }

    const rRes = await pool.query(
      'SELECT user_id, seed FROM runs WHERE id=$1',
      [recipient_run_id]
    );
    const rrun = rRes.rows[0];
    if (!rrun) return reply.code(400).send({ error: 'recipient_run_not_found' });
    if (Number(rrun.user_id) !== req.user.id) {
      return reply.code(400).send({ error: 'not_run_owner' });
    }
    if (Number(rrun.seed) !== Number(c.challenger_seed)) {
      return reply.code(400).send({ error: 'seed_mismatch' });
    }

    const upd = await pool.query(
      `UPDATE challenges
       SET status='completed', recipient_run_id=$1
       WHERE id=$2 AND status='accepted'`,
      [recipient_run_id, id]
    );
    if (upd.rowCount === 0) {
      return reply.code(409).send({ error: 'race_lost' });
    }
    return { ok: true };
  });
}
