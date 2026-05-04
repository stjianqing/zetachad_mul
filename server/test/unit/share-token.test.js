import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateShareToken } from '../../src/challenge/share-token.js';

test('generateShareToken: returns URL-safe string', () => {
  const t = generateShareToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('generateShareToken: 16 bytes => 22 chars base64url', () => {
  const t = generateShareToken();
  assert.equal(t.length, 22);
});

test('generateShareToken: unique across many calls', () => {
  const set = new Set();
  for (let i = 0; i < 1000; i++) set.add(generateShareToken());
  assert.equal(set.size, 1000);
});
