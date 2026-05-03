import { makePool, migrate } from '../../src/db.js';
import { createSessionStore } from '../../src/game/session.js';
import { buildApp } from '../../src/index.js';
import { MedianCache } from '../../src/run-difficulty/median-cache.js';

const TEST_COOKIE_SECRET = 'a'.repeat(64);

let cachedPool;

export async function getPool() {
  if (cachedPool) return cachedPool;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  process.env.DATABASE_URL = url;
  cachedPool = makePool();
  await migrate(cachedPool);
  return cachedPool;
}

export async function freshApp({ nowFn } = {}) {
  const pool = await getPool();
  if (!pool) return null;
  await pool.query('TRUNCATE attempts, runs, auth_sessions, users, cluster_medians RESTART IDENTITY CASCADE');
  const sessionStore = createSessionStore({});
  const medianCache = new MedianCache({ pool });
  medianCache.loadFromRows([]); // empty by default; tests seed via cluster_medians directly or call refresh()
  const app = await buildApp({
    pool,
    cookieSecret: TEST_COOKIE_SECRET,
    cookieSecure: false,
    sessionStore,
    medianCache,
    nowFn
  });
  return { app, pool, sessionStore, medianCache };
}

export function cookieFromResponse(res) {
  const header = res.headers['set-cookie'];
  if (!header) return null;
  const arr = Array.isArray(header) ? header : [header];
  for (const c of arr) {
    const m = c.match(/zc_session=([^;]+)/);
    if (m) return `zc_session=${m[1]}`;
  }
  return null;
}

export function skipIfNoDb(t) {
  if (!process.env.TEST_DATABASE_URL) {
    t.skip('TEST_DATABASE_URL not set');
    return true;
  }
  return false;
}
