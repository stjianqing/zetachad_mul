const FORFEIT_AGE = "interval '30 minutes'";

export async function runForfeitSweep(pool) {
  const r = await pool.query(
    `UPDATE challenges
     SET status='forfeited'
     WHERE status='accepted'
       AND recipient_run_id IS NULL
       AND COALESCE(recipient_started_at, responded_at) < now() - ${FORFEIT_AGE}`
  );
  return r.rowCount;
}

export function startForfeitSweep(pool, { intervalMs = 5 * 60 * 1000, log = console } = {}) {
  const handle = setInterval(() => {
    runForfeitSweep(pool).catch(err => log.error?.({ err }, 'forfeit-sweep failed'));
  }, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
