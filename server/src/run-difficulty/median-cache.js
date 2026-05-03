import { bucketize } from '../practice/clusters.js';

export class MedianCache {
  constructor({ pool = null, log = null } = {}) {
    this.pool = pool;
    this.log = log;
    this._map = new Map();
    this._fallback = null;
    this._refreshTimer = null;
    this._refreshing = null;
  }

  loadFromRows(rows) {
    this._map = new Map();
    for (const r of rows) {
      this._map.set(r.cluster_id, Number(r.median_ms));
    }
    this._recomputeFallback();
  }

  get(clusterId) {
    return this._map.has(clusterId) ? this._map.get(clusterId) : null;
  }

  getAll() {
    return new Map(this._map);
  }

  fallbackMedian() {
    return this._fallback;
  }

  _recomputeFallback() {
    const values = [...this._map.values()].sort((a, b) => a - b);
    if (values.length === 0) {
      this._fallback = null;
      return;
    }
    const mid = Math.floor(values.length / 2);
    this._fallback = values.length % 2 === 1
      ? values[mid]
      : Math.round((values[mid - 1] + values[mid]) / 2);
  }

  /**
   * Pure aggregation: given raw attempt rows, group by clusterId and compute median_ms + n.
   * SQL is responsible for filtering (correct = true, practice = false).
   */
  static computeFromRawAttempts(rows) {
    const buckets = new Map();
    for (const r of rows) {
      const id = bucketize(r.op, r.lhs, r.rhs);
      if (id == null) continue;
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(r.response_ms);
    }
    const out = new Map();
    for (const [id, times] of buckets) {
      times.sort((a, b) => a - b);
      const mid = Math.floor(times.length / 2);
      const median = times.length % 2 === 1
        ? times[mid]
        : Math.round((times[mid - 1] + times[mid]) / 2);
      out.set(id, { median_ms: median, n: times.length });
    }
    return out;
  }

  /**
   * Reads attempts from the DB, computes medians in JS, UPSERTs cluster_medians,
   * and reloads the in-memory map. Concurrent calls coalesce — a second invocation
   * while one is in flight returns the same promise instead of duplicating work
   * (e.g., daily timer racing with admin's manual trigger).
   */
  async refresh() {
    if (!this.pool) throw new Error('MedianCache.refresh requires a pool');
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _doRefresh() {
    const { rows } = await this.pool.query(
      `SELECT a.op, a.lhs, a.rhs, a.response_ms
       FROM attempts a
       JOIN runs r ON r.id = a.run_id
       WHERE a.correct = true
         AND COALESCE(r.practice, false) = false`
    );
    const computed = MedianCache.computeFromRawAttempts(rows);
    if (computed.size === 0) {
      // No data yet — leave existing cache as-is, but log.
      if (this.log) this.log.warn('MedianCache.refresh: no attempts to compute medians from');
      return;
    }
    // UPSERT all clusters in a single statement using VALUES.
    const params = [];
    const tuples = [];
    let i = 1;
    for (const [id, { median_ms, n }] of computed) {
      tuples.push(`($${i++}, $${i++}, $${i++})`);
      params.push(id, median_ms, n);
    }
    await this.pool.query(
      `INSERT INTO cluster_medians (cluster_id, median_ms, n) VALUES ${tuples.join(',')}
       ON CONFLICT (cluster_id) DO UPDATE SET
         median_ms = EXCLUDED.median_ms,
         n = EXCLUDED.n,
         refreshed_at = now()`,
      params
    );
    // Reload from the table so the in-memory map is exactly what is persisted.
    const { rows: reloaded } = await this.pool.query(
      `SELECT cluster_id, median_ms, n FROM cluster_medians`
    );
    this.loadFromRows(reloaded);
    if (this.log) this.log.info({ clusters: this._map.size }, 'MedianCache.refresh: complete');
  }

  scheduleDailyRefresh(intervalMs = 24 * 60 * 60 * 1000) {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        if (this.log) this.log.error({ err }, 'MedianCache.refresh failed');
      });
    }, intervalMs);
    this._refreshTimer.unref();
  }

  stop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}
