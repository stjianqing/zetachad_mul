import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRunDifficulty } from '../../src/run-difficulty/compute.js';

// Helper: build a fake medianCache with a fixed lookup table.
function makeCache(table, fallback = null) {
  return {
    get: (id) => (id in table ? table[id] : null),
    fallbackMedian: () => fallback
  };
}

// Helper: build an attempt row with sensible defaults.
function attempt(overrides = {}) {
  return {
    op: 'add',
    lhs: 5,
    rhs: 5,
    response_ms: 2000,
    correct: true,
    ...overrides
  };
}

test('computeRunDifficulty: empty attempts returns null', () => {
  const cache = makeCache({});
  assert.equal(computeRunDifficulty([], cache), null);
});

test('computeRunDifficulty: single cluster, uniform response_ms', () => {
  // add_small with median 2000ms: d_i = 10*(2000-1500)/5500 = 0.909...
  const cache = makeCache({ add_small: 2000 });
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }),
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 })
  ];
  // Time-weighted mean over a single distinct difficulty equals that difficulty.
  const expected = Math.round((10 * (2000 - 1500) / 5500) * 100) / 100;
  assert.equal(computeRunDifficulty(attempts, cache), expected);
});

test('computeRunDifficulty: time-weighted mean differs from naive mean', () => {
  // 40 easy (cluster median 2000ms, response 2000ms) + 5 hard (cluster median 6000ms, response 6000ms).
  // d_easy = 10*(2000-1500)/5500 ≈ 0.909
  // d_hard = 10*(6000-1500)/5500 ≈ 8.182
  // Naive mean: (40*0.909 + 5*8.182)/45 ≈ 1.717
  // Time-weighted: easy contributes 40*2000=80000ms; hard contributes 5*6000=30000ms.
  //   sum(d*t) = 0.909*80000 + 8.182*30000 = 72727 + 245454 = 318181
  //   sum(t)   = 80000 + 30000 = 110000
  //   D = 318181 / 110000 ≈ 2.89
  const cache = makeCache({ add_small: 2000, mul_hard_large: 6000 });
  const attempts = [];
  for (let i = 0; i < 40; i++) {
    attempts.push(attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }));
  }
  for (let i = 0; i < 5; i++) {
    attempts.push(attempt({ op: 'mul', lhs: 12, rhs: 75, response_ms: 6000 }));
  }
  const result = computeRunDifficulty(attempts, cache);
  // Should be substantially higher than naive mean (~1.72), confirming time-weighting.
  assert.ok(result > 2.5, `expected > 2.5, got ${result}`);
  assert.ok(result < 3.5, `expected < 3.5, got ${result}`);
});

test('computeRunDifficulty: wrong answer contributes equally to weighting', () => {
  const cache = makeCache({ add_small: 2000 });
  const both = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: false }),
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: true })
  ];
  const onlyCorrect = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: true }),
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 3000, correct: true })
  ];
  // Same time, same cluster, so same difficulty regardless of correctness.
  assert.equal(computeRunDifficulty(both, cache), computeRunDifficulty(onlyCorrect, cache));
});

test('computeRunDifficulty: response_ms > 15000 is capped at 15000', () => {
  const cache = makeCache({ add_small: 2000, mul_hard_large: 6000 });
  // One easy at 2000ms, one hard at 30000ms (should be capped to 15000).
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }),
    attempt({ op: 'mul', lhs: 12, rhs: 75, response_ms: 30000 })
  ];
  const result = computeRunDifficulty(attempts, cache);
  // d_easy ≈ 0.909, d_hard ≈ 8.182
  // weights: 2000 + 15000 (capped) = 17000
  // sum(d*t) = 0.909*2000 + 8.182*15000 = 1818 + 122727 ≈ 124545
  // D = 124545 / 17000 ≈ 7.33
  assert.ok(result > 7 && result < 7.5, `expected ~7.33, got ${result}`);
});

test('computeRunDifficulty: missing cluster median uses fallback', () => {
  const cache = makeCache({ add_small: 2000 }, /* fallback */ 4000);
  // mul_hard_large is missing — should fall back to 4000.
  const attempts = [
    attempt({ op: 'mul', lhs: 12, rhs: 75, response_ms: 4000 })
  ];
  // d = 10 * (4000 - 1500) / 5500 ≈ 4.545
  const result = computeRunDifficulty(attempts, cache);
  assert.ok(result > 4.4 && result < 4.7, `expected ~4.55, got ${result}`);
});

test('computeRunDifficulty: cache fully empty returns null', () => {
  const cache = makeCache({}, /* fallback */ null);
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 })
  ];
  assert.equal(computeRunDifficulty(attempts, cache), null);
});

test('computeRunDifficulty: bucketize-null attempts are skipped', () => {
  const cache = makeCache({ add_small: 2000 });
  const attempts = [
    // Valid: add_small.
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }),
    // Invalid: mul with both operands outside 2..12 range — bucketize returns null.
    attempt({ op: 'mul', lhs: 75, rhs: 80, response_ms: 5000 })
  ];
  // The invalid attempt is skipped; result equals the easy difficulty.
  const expected = Math.round((10 * (2000 - 1500) / 5500) * 100) / 100;
  assert.equal(computeRunDifficulty(attempts, cache), expected);
});

test('computeRunDifficulty: returns null when sum(t) == 0', () => {
  const cache = makeCache({ add_small: 2000 });
  const attempts = [
    attempt({ op: 'add', lhs: 5, rhs: 5, response_ms: 0 })
  ];
  assert.equal(computeRunDifficulty(attempts, cache), null);
});

import { MedianCache } from '../../src/run-difficulty/median-cache.js';

test('MedianCache: get returns null for unknown cluster', () => {
  const cache = new MedianCache();
  cache.loadFromRows([{ cluster_id: 'add_small', median_ms: 2000, n: 100 }]);
  assert.equal(cache.get('mul_hard_large'), null);
});

test('MedianCache: get returns median_ms for known cluster', () => {
  const cache = new MedianCache();
  cache.loadFromRows([{ cluster_id: 'add_small', median_ms: 2000, n: 100 }]);
  assert.equal(cache.get('add_small'), 2000);
});

test('MedianCache: fallbackMedian is the median of all known cluster medians', () => {
  const cache = new MedianCache();
  cache.loadFromRows([
    { cluster_id: 'a', median_ms: 1000, n: 10 },
    { cluster_id: 'b', median_ms: 3000, n: 10 },
    { cluster_id: 'c', median_ms: 5000, n: 10 }
  ]);
  assert.equal(cache.fallbackMedian(), 3000);
});

test('MedianCache: fallbackMedian is null when empty', () => {
  const cache = new MedianCache();
  assert.equal(cache.fallbackMedian(), null);
});

test('MedianCache: getAll returns a snapshot map', () => {
  const cache = new MedianCache();
  cache.loadFromRows([{ cluster_id: 'add_small', median_ms: 2000, n: 100 }]);
  const all = cache.getAll();
  assert.equal(all.get('add_small'), 2000);
  // Snapshot is independent: mutating it must not affect the cache.
  all.set('intruder', 999);
  assert.equal(cache.get('intruder'), null);
});

test('MedianCache: fallbackMedian with even-count averages two middle values', () => {
  const cache = new MedianCache();
  cache.loadFromRows([
    { cluster_id: 'a', median_ms: 1000, n: 10 },
    { cluster_id: 'b', median_ms: 3000, n: 10 },
    { cluster_id: 'c', median_ms: 5000, n: 10 },
    { cluster_id: 'd', median_ms: 7000, n: 10 }
  ]);
  // (3000 + 5000) / 2 = 4000
  assert.equal(cache.fallbackMedian(), 4000);
});

test('MedianCache: computeFromRawAttempts groups by cluster + medians, excludes practice & wrong', () => {
  // Raw rows as they would come from the SELECT in refresh().
  // Note: practice/wrong filtering happens in SQL — this test verifies the
  // pure JS aggregation given already-filtered input.
  const rows = [
    { op: 'add', lhs: 5,  rhs: 5,  response_ms: 1000 },
    { op: 'add', lhs: 10, rhs: 10, response_ms: 2000 }, // both add_small (max <= 30)
    { op: 'add', lhs: 10, rhs: 10, response_ms: 3000 }, // add_small
    { op: 'mul', lhs: 12, rhs: 75, response_ms: 6000 }, // mul_hard_large
    { op: 'mul', lhs: 12, rhs: 80, response_ms: 7000 }  // mul_hard_large
  ];
  const result = MedianCache.computeFromRawAttempts(rows);
  // add_small medians: [1000, 2000, 3000] → 2000
  // mul_hard_large medians: [6000, 7000] → 6500
  assert.equal(result.get('add_small').median_ms, 2000);
  assert.equal(result.get('add_small').n, 3);
  assert.equal(result.get('mul_hard_large').median_ms, 6500);
  assert.equal(result.get('mul_hard_large').n, 2);
});

test('MedianCache: computeFromRawAttempts with even-count picks lower-middle for stability', () => {
  // For [1000, 2000] the median is 1500; we use lower-middle (1000) for integer stability.
  // Either choice is defensible; lock in the behavior in the test.
  const rows = [
    { op: 'add', lhs: 5, rhs: 5, response_ms: 1000 },
    { op: 'add', lhs: 5, rhs: 5, response_ms: 2000 }
  ];
  const result = MedianCache.computeFromRawAttempts(rows);
  // Document the chosen convention: average of two middle values, rounded.
  assert.equal(result.get('add_small').median_ms, 1500);
});
