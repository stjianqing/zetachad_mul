import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade } from '../../src/game/grader.js';

const Q = { op: 'add', a: 7, b: 13, answer: 20, prompt: '7 + 13' };

test('exact match is correct', () => {
  assert.deepEqual(grade(Q, '20'), { correct: true });
});

test('whitespace is trimmed', () => {
  assert.deepEqual(grade(Q, '  20  '), { correct: true });
});

test('wrong answer is incorrect', () => {
  assert.deepEqual(grade(Q, '21'), { correct: false });
});

test('non-numeric is incorrect', () => {
  assert.deepEqual(grade(Q, 'twenty'), { correct: false });
  assert.deepEqual(grade(Q, '20a'), { correct: false });
  assert.deepEqual(grade(Q, ''), { correct: false });
  assert.deepEqual(grade(Q, '   '), { correct: false });
});

test('non-string answer is incorrect (defensive)', () => {
  assert.deepEqual(grade(Q, null), { correct: false });
  assert.deepEqual(grade(Q, undefined), { correct: false });
  assert.deepEqual(grade(Q, 20), { correct: false });
});

test('decimals are incorrect (integer answers only)', () => {
  assert.deepEqual(grade(Q, '20.0'), { correct: false });
  assert.deepEqual(grade(Q, '20.5'), { correct: false });
});

test('leading zeros are accepted', () => {
  assert.deepEqual(grade(Q, '020'), { correct: true });
});

test('negative answer matches when expected', () => {
  // Defensive — current generator never produces negative answers, but the grader should be honest.
  const negQ = { op: 'sub', a: 1, b: 2, answer: -1, prompt: '1 − 2' };
  assert.deepEqual(grade(negQ, '-1'), { correct: true });
});
