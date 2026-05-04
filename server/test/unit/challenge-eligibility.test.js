import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRunChallengeEligible, assertEligible } from '../../src/challenge/eligibility.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const okRow = {
  id: 1,
  user_id: 42,
  seed: 12345,
  practice: false,
  daily_gauntlet_date: null,
  config: DEFAULT_CONFIG
};

test('eligible: default-config, non-practice, non-daily, has seed', () => {
  assert.equal(isRunChallengeEligible(okRow), true);
});

test('ineligible: no seed (legacy run)', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, seed: null }), false);
});

test('ineligible: practice run', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, practice: true }), false);
});

test('ineligible: daily-gauntlet run', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, daily_gauntlet_date: '2026-05-04' }), false);
});

test('ineligible: non-default config', () => {
  const customConfig = { ...DEFAULT_CONFIG, durationMs: 60_000 };
  assert.equal(isRunChallengeEligible({ ...okRow, config: customConfig }), false);
});

test('ineligible: missing config', () => {
  assert.equal(isRunChallengeEligible({ ...okRow, config: null }), false);
});

test('assertEligible: throws with reason on ineligible', () => {
  assert.throws(
    () => assertEligible({ ...okRow, seed: null }),
    /seed/
  );
});

test('assertEligible: returns silently on eligible', () => {
  assert.doesNotThrow(() => assertEligible(okRow));
});
