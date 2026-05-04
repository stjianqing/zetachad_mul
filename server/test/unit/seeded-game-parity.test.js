import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, generate } from '../../src/game/generator.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

test('seeded RNG: same seed produces same first 60 questions', () => {
  const seed = 123456;
  const rngA = makeRng(seed);
  const rngB = makeRng(seed);
  for (let i = 0; i < 60; i++) {
    const qA = generate(DEFAULT_CONFIG, rngA);
    const qB = generate(DEFAULT_CONFIG, rngB);
    assert.equal(qA.prompt, qB.prompt, `mismatch at q${i}`);
    assert.equal(qA.answer, qB.answer, `mismatch at q${i}`);
  }
});
