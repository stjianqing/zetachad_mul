import { bucketize, CLUSTER_LABELS, GLOBAL_P50 } from './clusters.js';

export const RECENT_WINDOW = 500;
export const MIN_LIFETIME_ATTEMPTS = 50;
export const MIN_CLUSTER_ATTEMPTS = 5;
export const TIE_TOLERANCE_MS = 50;
export const WRONG_PENALTY_MS = 1000;
export const TOP_N = 3;

export function scoreAttempts(attempts) {
  const total = attempts.length;
  if (total < MIN_LIFETIME_ATTEMPTS) {
    return { totalAttemptsAnalyzed: total, topWeak: [], reason: 'need_more_data' };
  }

  const groups = new Map();
  for (const a of attempts) {
    const id = bucketize(a.op, a.lhs, a.rhs);
    if (id == null) continue;
    let g = groups.get(id);
    if (!g) { g = { sumMs: 0, n: 0, wrongCount: 0, op: a.op }; groups.set(id, g); }
    g.sumMs += a.responseMs;
    g.n += 1;
    if (!a.correct) g.wrongCount += 1;
  }

  const candidates = [];
  for (const [id, g] of groups) {
    if (g.n < MIN_CLUSTER_ATTEMPTS) continue;
    const avgMs = Math.round(g.sumMs / g.n);
    const score = avgMs - GLOBAL_P50[g.op] + g.wrongCount * WRONG_PENALTY_MS;
    candidates.push({ id, label: CLUSTER_LABELS[id], n: g.n, avgMs, score, wrongCount: g.wrongCount });
  }

  candidates.sort((a, b) => {
    if (Math.abs(a.score - b.score) <= TIE_TOLERANCE_MS) return b.n - a.n;
    return b.score - a.score;
  });

  const topWeak = candidates.slice(0, TOP_N).map(({ id, label, n, avgMs }) => ({ id, label, n, avgMs }));
  return { totalAttemptsAnalyzed: total, topWeak };
}

export async function analyzeUser(userId, pool) {
  const { rows } = await pool.query(
    `SELECT a.op, a.lhs, a.rhs, a.response_ms AS "responseMs", a.correct
     FROM attempts a
     JOIN runs r ON r.id = a.run_id
     WHERE r.user_id = $1
     ORDER BY a.id DESC
     LIMIT $2`,
    [userId, RECENT_WINDOW]
  );
  return scoreAttempts(rows);
}
