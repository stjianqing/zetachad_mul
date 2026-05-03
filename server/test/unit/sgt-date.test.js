import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todaySgtDateString, dateStringToSeed } from '../../src/game/sgt-date.js';

test('todaySgtDateString: 2026-05-04 16:00:00 UTC is 2026-05-05 in SGT', () => {
  const utc = new Date('2026-05-04T16:00:00.000Z');
  assert.equal(todaySgtDateString(utc), '2026-05-05');
});

test('todaySgtDateString: 2026-05-04 15:59:59 UTC is still 2026-05-04 in SGT', () => {
  const utc = new Date('2026-05-04T15:59:59.999Z');
  assert.equal(todaySgtDateString(utc), '2026-05-04');
});

test('todaySgtDateString: noon SGT (04:00 UTC) is the SGT date', () => {
  const utc = new Date('2026-05-04T04:00:00.000Z');
  assert.equal(todaySgtDateString(utc), '2026-05-04');
});

test('todaySgtDateString: midnight SGT exactly (16:00 UTC previous day) flips', () => {
  const utc = new Date('2026-05-04T16:00:00.000Z');
  assert.equal(todaySgtDateString(utc), '2026-05-05');
});

test('todaySgtDateString: defaults to current time when called without args', () => {
  // Just confirm it returns a YYYY-MM-DD string and doesn't throw.
  const r = todaySgtDateString();
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/);
});

test('dateStringToSeed: converts dashed date to integer', () => {
  assert.equal(dateStringToSeed('2026-05-04'), 20260504);
  assert.equal(dateStringToSeed('2099-12-31'), 20991231);
  assert.equal(dateStringToSeed('1970-01-01'), 19700101);
});

test('dateStringToSeed is deterministic', () => {
  assert.equal(dateStringToSeed('2026-05-04'), dateStringToSeed('2026-05-04'));
});
