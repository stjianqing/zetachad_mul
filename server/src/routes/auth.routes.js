import {
  validateUsername, validatePassword,
  hashPassword, verifyPassword,
  createAuthSession, deleteAuthSession,
  setSessionCookie, clearSessionCookie, readSessionCookie
} from '../auth.js';

export default async function authRoutes(fastify, { pool, cookieSecure }) {
  const ipLimit = { max: 5, timeWindow: '1 minute' };

  fastify.post('/api/register', { config: { rateLimit: ipLimit } }, async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!validateUsername(username)) return reply.code(400).send({ error: 'invalid_username' });
    if (!validatePassword(password)) return reply.code(400).send({ error: 'invalid_password' });

    const hash = await hashPassword(password);
    let userId;
    try {
      const r = await pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
        [username, hash]
      );
      userId = Number(r.rows[0].id);
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'username_taken' });
      throw err;
    }
    const { token, expiresAt } = await createAuthSession(pool, userId);
    setSessionCookie(reply, token, expiresAt, { secure: cookieSecure });
    return { user: { id: userId, username } };
  });

  fastify.post('/api/login', { config: { rateLimit: ipLimit } }, async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });

    const { token, expiresAt } = await createAuthSession(pool, Number(user.id));
    setSessionCookie(reply, token, expiresAt, { secure: cookieSecure });
    return { user: { id: Number(user.id), username: user.username } };
  });

  fastify.post('/api/logout', async (req, reply) => {
    const token = readSessionCookie(req);
    await deleteAuthSession(pool, token);
    clearSessionCookie(reply, { secure: cookieSecure });
    return { ok: true };
  });

  fastify.get('/api/me', async (req) => {
    return { user: req.user };
  });
}
