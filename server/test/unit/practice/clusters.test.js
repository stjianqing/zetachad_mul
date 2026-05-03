import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketize, CLUSTER_LABELS, GLOBAL_P50 } from '../../../src/practice/clusters.js';

test('bucketize: mul easy small (lhs=2, rhs=15 → mul_easy_small)', () => {
  assert.equal(bucketize('mul', 2, 15), 'mul_easy_small');
  assert.equal(bucketize('mul', 5, 30), 'mul_easy_small');
  assert.equal(bucketize('mul', 10, 2), 'mul_easy_small');
});

test('bucketize: mul easy large (lhs=10, rhs=31 → mul_easy_large)', () => {
  assert.equal(bucketize('mul', 10, 31), 'mul_easy_large');
  assert.equal(bucketize('mul', 2, 100), 'mul_easy_large');
});

test('bucketize: mul medium small (lhs=3,4,6,11 with rhs<=30)', () => {
  assert.equal(bucketize('mul', 3, 5), 'mul_med_small');
  assert.equal(bucketize('mul', 4, 30), 'mul_med_small');
  assert.equal(bucketize('mul', 6, 12), 'mul_med_small');
  assert.equal(bucketize('mul', 11, 25), 'mul_med_small');
});

test('bucketize: mul hard large (lhs=7,8,9,12 with rhs>30)', () => {
  assert.equal(bucketize('mul', 7, 31), 'mul_hard_large');
  assert.equal(bucketize('mul', 8, 50), 'mul_hard_large');
  assert.equal(bucketize('mul', 9, 100), 'mul_hard_large');
  assert.equal(bucketize('mul', 12, 75), 'mul_hard_large');
});

test('bucketize: mul order-independent (treats min(lhs,rhs) as the table)', () => {
  // generator stores lhs as the table operand for mul, but if input order is reversed
  // (e.g. attempt logged with lhs=50, rhs=12), bucketize should still classify by the small one.
  assert.equal(bucketize('mul', 50, 12), 'mul_hard_large');
  assert.equal(bucketize('mul', 75, 7), 'mul_hard_large');
});

test('bucketize: div uses divisor (the small operand) for difficulty', () => {
  // attempts.lhs=dividend, attempts.rhs=divisor for div (per generator.js:55)
  assert.equal(bucketize('div', 24, 12), 'div_hard_small');  // dividend=24, divisor=12, easy/med/hard? 12 is hard. dividend<=300 → small
  assert.equal(bucketize('div', 600, 12), 'div_hard_large'); // dividend>300 → large
  assert.equal(bucketize('div', 50, 5), 'div_easy_small');   // divisor=5 is easy, dividend<=300 → small
  assert.equal(bucketize('div', 800, 10), 'div_easy_large'); // divisor=10 easy, dividend>300 → large
  assert.equal(bucketize('div', 200, 3), 'div_med_small');   // divisor=3 medium
});

test('bucketize: add by max(lhs, rhs)', () => {
  assert.equal(bucketize('add', 5, 15), 'add_small');     // max=15 ≤ 20
  assert.equal(bucketize('add', 20, 20), 'add_small');    // max=20
  assert.equal(bucketize('add', 21, 10), 'add_med');      // max=21 in 21..50
  assert.equal(bucketize('add', 50, 5), 'add_med');       // max=50
  assert.equal(bucketize('add', 51, 5), 'add_large');     // max=51 > 50
  assert.equal(bucketize('add', 90, 90), 'add_large');
});

test('bucketize: sub by max(lhs, rhs)', () => {
  assert.equal(bucketize('sub', 18, 5), 'sub_small');
  assert.equal(bucketize('sub', 30, 20), 'sub_med');
  assert.equal(bucketize('sub', 80, 30), 'sub_large');
});

test('bucketize: returns null for unknown op', () => {
  assert.equal(bucketize('mod', 5, 3), null);
});

test('bucketize: returns null for out-of-config inputs (defensive)', () => {
  // div with divisor>12 isn't possible in default config, but be defensive.
  assert.equal(bucketize('div', 100, 50), null);  // divisor=50 outside {2..12}
  // mul with both operands large isn't possible (one is always lhs ∈ 2..12)
  assert.equal(bucketize('mul', 50, 75), null);   // neither operand in 2..12
});

test('CLUSTER_LABELS has 18 entries with non-empty strings', () => {
  const ids = Object.keys(CLUSTER_LABELS);
  assert.equal(ids.length, 18);
  for (const id of ids) {
    assert.equal(typeof CLUSTER_LABELS[id], 'string');
    assert.ok(CLUSTER_LABELS[id].length > 0, `empty label for ${id}`);
  }
});

test('GLOBAL_P50 has values for all four ops', () => {
  assert.equal(GLOBAL_P50.add, 2125);
  assert.equal(GLOBAL_P50.sub, 1898);
  assert.equal(GLOBAL_P50.mul, 2661);
  assert.equal(GLOBAL_P50.div, 2820);
});
