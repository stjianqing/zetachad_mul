import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isDefaultConfig } from '../../src/config.js';

test('DEFAULT_CONFIG matches the locked spec', () => {
  assert.equal(DEFAULT_CONFIG.durationMs, 120_000);
  assert.equal(DEFAULT_CONFIG.ops.add.enabled, true);
  assert.equal(DEFAULT_CONFIG.ops.add.min, 2);
  assert.equal(DEFAULT_CONFIG.ops.add.max, 100);
  assert.equal(DEFAULT_CONFIG.ops.sub.min, 2);
  assert.equal(DEFAULT_CONFIG.ops.sub.max, 100);
  assert.equal(DEFAULT_CONFIG.ops.mul.lhsMax, 12);
  assert.equal(DEFAULT_CONFIG.ops.mul.rhsMax, 100);
  assert.equal(DEFAULT_CONFIG.ops.div.lhsMax, 12);
  assert.equal(DEFAULT_CONFIG.ops.div.rhsMax, 100);
});

test('isDefaultConfig: deep-equal default returns true', () => {
  const copy = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  assert.equal(isDefaultConfig(copy), true);
});

test('isDefaultConfig: any deviation returns false', () => {
  const tweaked = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  tweaked.durationMs = 60_000;
  assert.equal(isDefaultConfig(tweaked), false);

  const tweaked2 = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  tweaked2.ops.add.max = 99;
  assert.equal(isDefaultConfig(tweaked2), false);

  const tweaked3 = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  tweaked3.ops.mul.enabled = false;
  assert.equal(isDefaultConfig(tweaked3), false);
});

test('isDefaultConfig: null/undefined/non-object returns false', () => {
  assert.equal(isDefaultConfig(null), false);
  assert.equal(isDefaultConfig(undefined), false);
  assert.equal(isDefaultConfig('hello'), false);
  assert.equal(isDefaultConfig({}), false);
});
