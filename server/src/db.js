import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

export function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: url, max: 10 });
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate(pool) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(__dirname, '..', 'migrations');

  await pool.query(MIGRATIONS_TABLE);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Migrations are tracked by filename only; editing an applied migration is not detected. Write a new one instead.
  const { rows: applied } = await pool.query(
    'SELECT filename FROM schema_migrations'
  );
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`migrated: ${file}`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow rollback error to preserve original */ }
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
}

// Allow running as: `npm run migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = makePool();
  try {
    await migrate(pool);
    console.log('migrations complete');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
