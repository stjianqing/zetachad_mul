// Singapore is a fixed UTC+8 offset (no DST). The SGT calendar date for any
// given instant is computed by shifting the timestamp +8 hours and reading the
// UTC date of the result.

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Returns the YYYY-MM-DD string for "today" in Singapore time.
 * Optionally pass a `now` Date for testing/injection.
 */
export function todaySgtDateString(now = new Date()) {
  const sgtMs = now.getTime() + SGT_OFFSET_MS;
  return new Date(sgtMs).toISOString().slice(0, 10);
}

/**
 * Convert a YYYY-MM-DD string to a numeric seed for makeRng().
 * "2026-05-04" → 20260504. Same date → same seed.
 */
export function dateStringToSeed(dateString) {
  return Number(dateString.replace(/-/g, ''));
}
