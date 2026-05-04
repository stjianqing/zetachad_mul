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
}
