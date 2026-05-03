#!/usr/bin/env node
/**
 * One-shot: compute and store difficulty for every runs row where it is null.
 * Idempotent — re-running only touches still-null rows.
 *
 * Usage on the VPS:
 *   sudo -u zetachad node --env-file=/etc/zetachad/env server/scripts/backfill-difficulty.js
 */
import { makePool } from '../src/db.js';
import { MedianCache } from '../src/run-difficulty/median-cache.js';
import { computeRunDifficulty } from '../src/run-difficulty/compute.js';

async function main() {
  const pool = makePool();
  try {
    const medianCache = new MedianCache({ pool });
    // Make sure the cache is fresh before backfilling.
    const { rows: existing } = await pool.query(`SELECT cluster_id, median_ms, n FROM cluster_medians`);
    medianCache.loadFromRows(existing);
    if (existing.length === 0) {
      console.log('cluster_medians empty — running initial refresh');
      await medianCache.refresh();
    }

    const { rows: runs } = await pool.query(
      `SELECT id FROM runs WHERE difficulty IS NULL ORDER BY id ASC`
    );
    console.log(`Found ${runs.length} runs needing backfill`);

    let updated = 0;
    let skipped = 0;
    for (const r of runs) {
      const { rows: attempts } = await pool.query(
        `SELECT op, lhs, rhs, response_ms, correct FROM attempts WHERE run_id = $1`,
        [r.id]
      );
      const d = computeRunDifficulty(attempts, medianCache);
      if (d == null) {
        skipped++;
        continue;
      }
      await pool.query(`UPDATE runs SET difficulty = $1 WHERE id = $2`, [d, r.id]);
      updated++;
      if (updated % 100 === 0) console.log(`  ${updated} updated...`);
    }
    console.log(`Backfill complete. Updated: ${updated}. Skipped: ${skipped}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
