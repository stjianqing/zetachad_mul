import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, makeRng } from '../../src/game/generator.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

test('generate(add) produces a + b within range with correct answer', () => {
  const cfg = {
    ops: { add: { enabled: true, min: 5, max: 7 }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(1);
  const q = generate(cfg, rng);
  assert.equal(q.op, 'add');
  assert.ok(q.a >= 5 && q.a <= 7, `a out of range: ${q.a}`);
  assert.ok(q.b >= 5 && q.b <= 7, `b out of range: ${q.b}`);
  assert.equal(q.answer, q.a + q.b);
  assert.match(q.prompt, /\+/);
});

test('generate(sub) ensures a >= b (non-negative answer)', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: true, min: 2, max: 100 }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(42);
  for (let i = 0; i < 50; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.op, 'sub');
    assert.ok(q.a >= q.b, `expected a>=b, got a=${q.a} b=${q.b}`);
    assert.equal(q.answer, q.a - q.b);
    assert.ok(q.answer >= 0);
  }
});

test('generate(mul) uses separate lhs/rhs ranges', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: false }, mul: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(7);
  for (let i = 0; i < 50; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.op, 'mul');
    assert.ok(q.a >= 2 && q.a <= 12);
    assert.ok(q.b >= 2 && q.b <= 100);
    assert.equal(q.answer, q.a * q.b);
  }
});

test('generate(div) returns integer answer; presents as dividend ÷ divisor', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: true, lhsMin: 2, lhsMax: 12, rhsMin: 2, rhsMax: 100 } },
    durationMs: 60_000
  };
  const rng = makeRng(7);
  for (let i = 0; i < 50; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.op, 'div');
    assert.ok(Number.isInteger(q.answer));
    assert.equal(q.a % q.b, 0, `a=${q.a}, b=${q.b} not integer-divisible`);
    assert.equal(q.a / q.b, q.answer);
  }
});

test('generate picks among enabled ops only', () => {
  const cfg = {
    ops: { add: { enabled: true, min: 1, max: 2 }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(99);
  for (let i = 0; i < 30; i++) {
    assert.equal(generate(cfg, rng).op, 'add');
  }
});

test('generate is reproducible with the same seed', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 10; i++) {
    const qa = generate(DEFAULT_CONFIG, a);
    const qb = generate(DEFAULT_CONFIG, b);
    assert.deepEqual(qa, qb);
  }
});

test('generate throws when no op is enabled', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  assert.throws(() => generate(cfg, makeRng(1)), /no ops enabled/i);
});

test('generate returns expectedDigits = String(answer).length', () => {
  const cfg = {
    ops: { add: { enabled: true, min: 1, max: 9 }, sub: { enabled: false }, mul: { enabled: false }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(1);
  for (let i = 0; i < 30; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.expectedDigits, String(q.answer).length, `answer=${q.answer} expectedDigits=${q.expectedDigits}`);
  }
});

test('generate expectedDigits handles multi-digit answers (mul)', () => {
  const cfg = {
    ops: { add: { enabled: false }, sub: { enabled: false }, mul: { enabled: true, lhsMin: 11, lhsMax: 12, rhsMin: 11, rhsMax: 12 }, div: { enabled: false } },
    durationMs: 60_000
  };
  const rng = makeRng(2);
  // 11*11=121, 12*12=144 — all 3-digit answers
  for (let i = 0; i < 10; i++) {
    const q = generate(cfg, rng);
    assert.equal(q.expectedDigits, 3);
  }
});
