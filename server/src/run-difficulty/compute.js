import { bucketize } from '../practice/clusters.js';

const FLOOR_MS = 1500;
const CEIL_MS = 7000;
const TIME_CAP_MS = 15000;

/**
 * @param {Array<{op:string, lhs:number, rhs:number, response_ms:number, correct:boolean}>} attempts
 * @param {{get:(id:string)=>(number|null), fallbackMedian:()=>(number|null)}} medianCache
 * @returns {number|null} 0-10 time-weighted difficulty rounded to 2 decimals, or null if uncomputable.
 */
export function computeRunDifficulty(attempts, medianCache) {
  if (!attempts || attempts.length === 0) return null;
  let weightedSum = 0;
  let totalTime = 0;
  for (const a of attempts) {
    const clusterId = bucketize(a.op, a.lhs, a.rhs);
    if (clusterId == null) continue;
    let m_c = medianCache.get(clusterId);
    if (m_c == null) m_c = medianCache.fallbackMedian();
    if (m_c == null) return null;
    const t = Math.min(a.response_ms, TIME_CAP_MS);
    const d = Math.max(0, Math.min(10, 10 * (m_c - FLOOR_MS) / (CEIL_MS - FLOOR_MS)));
    weightedSum += d * t;
    totalTime += t;
  }
  if (totalTime === 0) return null;
  return Math.round((weightedSum / totalTime) * 100) / 100;
}
