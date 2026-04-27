import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

const COOKIE_NAME = 'zc_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const PASSWORD_MIN = 8;

export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

export function validatePassword(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN;
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function makeAuthSessionToken() {
  return randomBytes(32).toString('base64url');
}

export async function createAuthSession(pool, userId) {
  const token = makeAuthSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await pool.query(
    'INSERT INTO auth_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiresAt]
  );
  return { token, expiresAt };
}

export async function lookupAuthSession(pool, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.token, s.user_id, s.expires_at, u.username
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return rows[0] ?? null;
}

export async function bumpAuthSession(pool, token) {
  const newExpiry = new Date(Date.now() + SESSION_LIFETIME_MS);
  await pool.query('UPDATE auth_sessions SET expires_at = $1 WHERE token = $2', [newExpiry, token]);
  return newExpiry;
}

export async function deleteAuthSession(pool, token) {
  if (!token) return;
  await pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
}

export function setSessionCookie(reply, token, expiresAt, { secure = true } = {}) {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    expires: expiresAt
  });
}

export function clearSessionCookie(reply, { secure = true } = {}) {
  reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, secure, sameSite: 'lax' });
}

export function readSessionCookie(req) {
  return req.cookies?.[COOKIE_NAME] ?? null;
}

// Fastify decorator-style: req.user is set if cookie is valid.
const BUMP_MIN_INTERVAL_MS = 60 * 1000;
const lastBumpAt = new Map();

export function makeAuthHook(pool, { cookieSecure = true } = {}) {
  return async function authHook(req, reply) {
    const token = readSessionCookie(req);
    let sess;
    try {
      sess = await lookupAuthSession(pool, token);
    } catch (err) {
      req.log.error({ err }, 'auth: session lookup failed');
      req.user = null;
      return;
    }
    if (sess) {
      req.user = { id: Number(sess.user_id), username: sess.username, sessionToken: token };
      const now = Date.now();
      const last = lastBumpAt.get(token) ?? 0;
      if (now - last >= BUMP_MIN_INTERVAL_MS) {
        lastBumpAt.set(token, now);
        bumpAuthSession(pool, token)
          .then((newExpiry) => setSessionCookie(reply, token, newExpiry, { secure: cookieSecure }))
          .catch((err) => req.log.warn({ err }, 'auth: session bump failed'));
      }
    } else {
      req.user = null;
    }
  };
}

export async function requireAuth(req, reply) {
  if (!req.user) {
    reply.code(401).send({ error: 'auth_required' });
    return reply;
  }
}
