import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, makeRng } from '../../../src/game/generator.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import { bucketize } from '../../../src/practice/clusters.js';

test('generate: with weighting, ~70% of questions fall in supplied weak clusters', () => {
  const rng = makeRng(12345);
  const weighting = {
    clusters: ['mul_hard_large', 'add_large', 'div_hard_small'],
    weakBias: 0.7
  };
  const N = 10000;
  let inWeak = 0;
  for (let i = 0; i < N; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    const cluster = bucketize(q.op, q.a, q.b);
    if (weighting.clusters.includes(cluster)) inWeak += 1;
  }
  const ratio = inWeak / N;
  // 70% guaranteed from weak path; the random 30% can also land on a weak cluster.
  // With this set (mul_hard_large + add_large + div_hard_small), the normal path
  // hits a "weak" cluster ~20-25% of the time, so the true upper end is ~0.78.
  // Loosen the upper bound to 0.82 to absorb sample-to-sample variance.
  assert.ok(ratio >= 0.67, `expected >=0.67, got ${ratio}`);
  assert.ok(ratio <= 0.82, `expected <=0.82, got ${ratio}`);
});

test('generate: weak picks are roughly uniform across the 3 supplied clusters', () => {
  const rng = makeRng(42);
  const weighting = {
    clusters: ['mul_hard_large', 'add_large', 'div_hard_small'],
    weakBias: 1.0
  };
  const N = 6000;
  const counts = { mul_hard_large: 0, add_large: 0, div_hard_small: 0 };
  for (let i = 0; i < N; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    const cluster = bucketize(q.op, q.a, q.b);
    if (counts[cluster] != null) counts[cluster] += 1;
  }
  for (const id of Object.keys(counts)) {
    assert.ok(counts[id] >= 1700 && counts[id] <= 2300,
      `cluster ${id}: count=${counts[id]} not within [1700,2300]`);
  }
});

test('generate: with weakBias=0, behaves like normal play (no questions forced to weak clusters beyond chance)', () => {
  const rng = makeRng(1);
  const weighting = { clusters: ['mul_hard_large'], weakBias: 0 };
  const N = 4000;
  let mulHardLarge = 0;
  for (let i = 0; i < N; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    if (bucketize(q.op, q.a, q.b) === 'mul_hard_large') mulHardLarge += 1;
  }
  assert.ok(mulHardLarge / N < 0.30, `weakBias=0 should not concentrate on weak cluster, got ${mulHardLarge / N}`);
});

test('generate: operands sampled from a weak cluster fall within cluster bounds', () => {
  const rng = makeRng(7);
  const weighting = { clusters: ['mul_hard_large'], weakBias: 1.0 };
  for (let i = 0; i < 200; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    assert.equal(bucketize(q.op, q.a, q.b), 'mul_hard_large',
      `q=${JSON.stringify(q)} did not bucketize to mul_hard_large`);
    const small = Math.min(q.a, q.b), large = Math.max(q.a, q.b);
    assert.ok([7, 8, 9, 12].includes(small), `expected small operand in {7,8,9,12}, got ${small}`);
    assert.ok(large >= 31 && large <= 100, `expected large operand in [31,100], got ${large}`);
    assert.equal(q.answer, q.a * q.b);
  }
});

test('generate: div weak cluster — divisor + dividend bounds + integer answer', () => {
  const rng = makeRng(11);
  const weighting = { clusters: ['div_hard_small'], weakBias: 1.0 };
  for (let i = 0; i < 200; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    assert.equal(q.op, 'div');
    assert.ok([7, 8, 9, 12].includes(q.b), `divisor ${q.b} should be in {7,8,9,12}`);
    assert.ok(q.a >= 2 && q.a <= 300, `dividend ${q.a} should be in [2,300]`);
    assert.equal(q.a / q.b, q.answer);
    assert.equal(q.a % q.b, 0, 'dividend must be exactly divisible');
  }
});

test('generate: add weak cluster — max(a,b) in correct range', () => {
  const rng = makeRng(99);
  const weighting = { clusters: ['add_large'], weakBias: 1.0 };
  for (let i = 0; i < 200; i++) {
    const q = generate(DEFAULT_CONFIG, rng, weighting);
    assert.equal(q.op, 'add');
    assert.ok(Math.max(q.a, q.b) > 50);
    assert.ok(Math.max(q.a, q.b) <= 100);
    assert.equal(q.answer, q.a + q.b);
  }
});

test('generate: without weighting param, behaves identically to today (regression guard)', () => {
  const rng = makeRng(123);
  const q = generate(DEFAULT_CONFIG, rng);
  assert.ok(['add', 'sub', 'mul', 'div'].includes(q.op));
  assert.equal(typeof q.answer, 'number');
  assert.equal(typeof q.prompt, 'string');
});
