import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { pathToFileURL } from 'node:url';
import { makePool, migrate } from './db.js';
import { makeAuthHook } from './auth.js';
import { createSessionStore } from './game/session.js';
import { MedianCache } from './run-difficulty/median-cache.js';
import authRoutes from './routes/auth.routes.js';
import playRoutes from './routes/play.routes.js';
import boardRoutes from './routes/board.routes.js';
import practiceRoutes from './routes/practice.routes.js';
import adminRoutes from './routes/admin.routes.js';

export async function buildApp({ pool, cookieSecret, cookieSecure = true, sessionStore, medianCache } = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cookie, { secret: cookieSecret });
  await app.register(rateLimit, { global: false });

  app.addHook('preHandler', makeAuthHook(pool, { cookieSecure }));

  await app.register(authRoutes, { pool, cookieSecure });
  await app.register(playRoutes, { sessionStore, pool, medianCache });
  await app.register(boardRoutes, { pool, sessionStore });
  await app.register(practiceRoutes, { pool, sessionStore });
  await app.register(adminRoutes, { pool, medianCache });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}

async function main() {
  const pool = makePool();
  await migrate(pool);

  const sessionStore = createSessionStore({});
  const evictTimer = setInterval(() => sessionStore.evictExpired(), 60_000);
  evictTimer.unref();

  const medianCache = new MedianCache({ pool });
  // Initial load from cluster_medians (may be empty on first boot).
  const { rows: initialRows } = await pool.query(
    `SELECT cluster_id, median_ms, n FROM cluster_medians`
  );
  medianCache.loadFromRows(initialRows);
  // First-time bootstrap: if the table is empty, do an immediate refresh
  // so new runs starting today get a meaningful difficulty.
  if (initialRows.length === 0) {
    try {
      await medianCache.refresh();
    } catch (err) {
      console.error('initial MedianCache.refresh failed:', err);
    }
  }
  medianCache.scheduleDailyRefresh();

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret || cookieSecret.length < 32) {
    throw new Error('COOKIE_SECRET must be set and >=32 chars');
  }
  const cookieSecure = (process.env.COOKIE_SECURE ?? 'true') !== 'false';

  const app = await buildApp({ pool, cookieSecret, cookieSecure, sessionStore, medianCache });

  app.log.info({ clusters: medianCache.getAll().size }, 'MedianCache loaded');

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      app.log.info(`received ${sig}, shutting down`);
      medianCache.stop();
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
