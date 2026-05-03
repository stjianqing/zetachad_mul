import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAttempts, MIN_LIFETIME_ATTEMPTS, MIN_CLUSTER_ATTEMPTS } from '../../../src/practice/analyzer.js';

// Helper: build N synthetic attempts in a given cluster shape with a fixed responseMs.
function attempts(op, lhs, rhs, responseMs, n, correct = true) {
  return Array.from({ length: n }, () => ({ op, lhs, rhs, responseMs, correct }));
}

test('scoreAttempts: 0 attempts → need_more_data', () => {
  const r = scoreAttempts([]);
  assert.equal(r.totalAttemptsAnalyzed, 0);
  assert.deepEqual(r.topWeak, []);
  assert.equal(r.reason, 'need_more_data');
});

test('scoreAttempts: 49 attempts (just below MIN_LIFETIME_ATTEMPTS) → need_more_data', () => {
  assert.equal(MIN_LIFETIME_ATTEMPTS, 50);
  const xs = attempts('add', 5, 5, 2000, 49);
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 49);
  assert.deepEqual(r.topWeak, []);
  assert.equal(r.reason, 'need_more_data');
});

test('scoreAttempts: 50 attempts but no cluster has MIN_CLUSTER_ATTEMPTS → empty topWeak (no reason)', () => {
  // Spread 50 attempts across ~13 distinct clusters with ≤4 each so no cluster qualifies.
  const xs = [];
  for (let i = 0; i < 4; i++) xs.push({ op: 'add', lhs: 5, rhs: 5, responseMs: 1000, correct: true });   // add_small
  for (let i = 0; i < 4; i++) xs.push({ op: 'add', lhs: 30, rhs: 30, responseMs: 1000, correct: true }); // add_med
  for (let i = 0; i < 4; i++) xs.push({ op: 'add', lhs: 70, rhs: 70, responseMs: 1000, correct: true }); // add_large
  for (let i = 0; i < 4; i++) xs.push({ op: 'sub', lhs: 5, rhs: 5, responseMs: 1000, correct: true });   // sub_small
  for (let i = 0; i < 4; i++) xs.push({ op: 'sub', lhs: 30, rhs: 20, responseMs: 1000, correct: true }); // sub_med
  for (let i = 0; i < 4; i++) xs.push({ op: 'sub', lhs: 70, rhs: 30, responseMs: 1000, correct: true }); // sub_large
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 2, rhs: 5, responseMs: 1000, correct: true });   // mul_easy_small
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 3, rhs: 5, responseMs: 1000, correct: true });   // mul_med_small
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 7, rhs: 5, responseMs: 1000, correct: true });   // mul_hard_small
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 2, rhs: 50, responseMs: 1000, correct: true });  // mul_easy_large
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 3, rhs: 50, responseMs: 1000, correct: true });  // mul_med_large
  for (let i = 0; i < 4; i++) xs.push({ op: 'mul', lhs: 7, rhs: 50, responseMs: 1000, correct: true });  // mul_hard_large
  for (let i = 0; i < 2; i++) xs.push({ op: 'div', lhs: 10, rhs: 2, responseMs: 1000, correct: true });  // div_easy_small
  assert.equal(xs.length, 50);
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 50);
  assert.deepEqual(r.topWeak, []);
  assert.equal(r.reason, undefined, 'should not be need_more_data — they have enough total, just no qualifying cluster');
});

test('scoreAttempts: ranks slowest cluster (relative to global p50) first', () => {
  // 60 add attempts: 30 in add_small (fast: 1000ms) and 30 in add_large (slow: 5000ms).
  // GLOBAL_P50.add = 2125. score(add_small) = 1000 - 2125 = -1125. score(add_large) = 5000 - 2125 = 2875.
  const xs = [
    ...attempts('add', 5, 5, 1000, 30),
    ...attempts('add', 80, 80, 5000, 30)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 60);
  assert.equal(r.topWeak.length, 2);
  assert.equal(r.topWeak[0].id, 'add_large');
  assert.equal(r.topWeak[0].avgMs, 5000);
  assert.equal(r.topWeak[0].n, 30);
  assert.equal(r.topWeak[1].id, 'add_small');
});

test('scoreAttempts: normalizes across ops (8s mul beats 4s add)', () => {
  // mul_hard_large at 8000ms: score = 8000 - 2661 = 5339
  // add_large at 4000ms:      score = 4000 - 2125 = 1875
  const xs = [
    ...attempts('mul', 12, 75, 8000, 30),
    ...attempts('add', 80, 80, 4000, 30)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'mul_hard_large');
  assert.equal(r.topWeak[1].id, 'add_large');
});

test('scoreAttempts: returns at most top 3', () => {
  const xs = [
    ...attempts('mul', 12, 75, 8000, 30),
    ...attempts('mul', 9,  50, 7000, 30),
    ...attempts('add', 80, 80, 4000, 30),
    ...attempts('sub', 80, 30, 3500, 30),
    ...attempts('div', 600, 12, 6500, 30),
    ...attempts('mul', 7,  10, 2000, 30),
    ...attempts('add', 5,  5,  1000, 30)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak.length, 3);
  assert.equal(r.topWeak[0].id, 'mul_hard_large');
});

test('scoreAttempts: tie-breaking prefers larger n when scores within 50ms', () => {
  // mul_hard_large at 5000ms, n=10:  score = 5000 - 2661 = 2339
  // mul_med_large at 5030ms, n=20:   score = 5030 - 2661 = 2369  (within 50)
  // mul_med_large should win because n=20 > n=10.
  // Pad with 20 unrelated low-volume attempts (≤4 per cluster) to clear MIN_LIFETIME_ATTEMPTS=50.
  const xs = [
    ...attempts('mul', 12, 75, 5000, 10),
    ...attempts('mul', 11, 75, 5030, 20),
    ...attempts('add', 5, 5, 1000, 4),    // add_small, doesn't qualify (<5)
    ...attempts('add', 30, 30, 1000, 4),  // add_med, doesn't qualify
    ...attempts('sub', 5, 5, 1000, 4),    // sub_small, doesn't qualify
    ...attempts('sub', 30, 20, 1000, 4),  // sub_med, doesn't qualify
    ...attempts('mul', 2, 5, 1000, 4)     // mul_easy_small, doesn't qualify
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'mul_med_large');
  assert.equal(r.topWeak[1].id, 'mul_hard_large');
});

test('scoreAttempts: wrong-answer penalty (1000ms each) shifts a tie', () => {
  // Two clusters at same avgMs/n; one has 3 wrongs.
  // mul_hard_large: 10 attempts at 5000ms, all correct — score = 5000-2661 = 2339
  // mul_med_large: 7 correct + 3 wrong at 5000ms, n=10 — score = 5000-2661 + 3000 = 5339
  // Pad with low-volume non-qualifying clusters to clear MIN_LIFETIME_ATTEMPTS=50.
  const xs = [
    ...attempts('mul', 12, 75, 5000, 10),
    ...attempts('mul', 11, 75, 5000, 7, true),
    ...attempts('mul', 11, 75, 5000, 3, false),
    ...attempts('add', 5, 5, 1000, 4),
    ...attempts('add', 30, 30, 1000, 4),
    ...attempts('add', 70, 70, 1000, 4),
    ...attempts('sub', 5, 5, 1000, 4),
    ...attempts('sub', 30, 20, 1000, 4),
    ...attempts('sub', 70, 30, 1000, 2),
    ...attempts('mul', 2, 5, 1000, 4),
    ...attempts('mul', 3, 5, 1000, 4)
  ];
  assert.equal(xs.length, 50);
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'mul_med_large');
});

test('scoreAttempts: skips clusters with fewer than MIN_CLUSTER_ATTEMPTS', () => {
  assert.equal(MIN_CLUSTER_ATTEMPTS, 5);
  const xs = [
    ...attempts('mul', 12, 75, 8000, 4),
    ...attempts('add', 80, 80, 4000, 50)
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak.length, 1);
  assert.equal(r.topWeak[0].id, 'add_large');
});

test('scoreAttempts: ignores attempts that bucketize to null (defensive)', () => {
  const xs = [
    ...attempts('add', 5, 5, 1000, 50),
    { op: 'mod', lhs: 1, rhs: 1, responseMs: 1000, correct: true }
  ];
  const r = scoreAttempts(xs);
  assert.equal(r.totalAttemptsAnalyzed, 51);
  assert.equal(r.topWeak.length, 1);
  assert.equal(r.topWeak[0].id, 'add_small');
});

test('scoreAttempts: topWeak entries include label', () => {
  const xs = attempts('add', 80, 80, 4000, 50);
  const r = scoreAttempts(xs);
  assert.equal(r.topWeak[0].id, 'add_large');
  assert.equal(r.topWeak[0].label, 'Adding numbers above 50');
});
